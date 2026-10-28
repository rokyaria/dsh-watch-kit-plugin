#!/usr/bin/env python3
"""mailbox: zero-dependency IMAP/SMTP + per-UID SQLite state for dsh-watch-kit-plugin.

This one script is both:
  - a watch checker: `mail.py check` prints only the plugin's JSON contract;
  - an agent-facing CLI: list/read/reply/send/mark/status/allow/attach/init/selfcheck.

It does not use IMAP Seen flags. State is a per-account SQLite database under
--state-dir (`<account>.sqlite3`). Every message UID gets one row; "new" means
the row does not exist yet, not "UID greater than a cursor". The row state is:
ignored (not allowlisted), pending (allowlisted; needs agent processing),
no_receipt (agent marked no reply needed), replied (reply succeeded), invalid
(header/classification failed), or gone. Pending rows are re-notified after
--remind-minutes until the agent marks them.
State rows are retained for 31 days. A new UID whose Date header is older than
30 days is recorded as ignored and never notified, so pruning a still-present
old mail cannot turn it into "new" again. State dir is 0700; DB/WAL/SHM are 0600.

`check` only inserts a new UID after its header was fetched successfully;
transient FETCH failures are retried on the next check. A SEARCH failure leaves
the database untouched. `attach` writes downloaded attachments to a fresh
system temp directory (mode 0700) unless `--out` is given; it never writes user
files into the plugin or state directories.

Source verification is conservative: `Authentication-Results`/DMARC is parsed
and the source field is either ok or risk. Only a first AR header with
dmarc=pass, at least one of spf=pass/dkim=pass, and a header.from aligned with
the From domain is ok; everything else (missing, malformed, mismatched) is risk.
The allowlist maps senders to a free-form `identity` label; behavior is defined
by the skill (or the user/agent agreement), not by this script.

Python 3.9+, standard library only.
"""

from __future__ import annotations

import argparse
import contextlib
import email
import imaplib
import json
import mimetypes
import os
import re
import smtplib
import sqlite3
import ssl
import sys
import tempfile
import time
from datetime import timezone
from email.header import decode_header
from email.message import EmailMessage
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any

DEFAULT_ENV_FILE = Path.home() / ".dsh" / "secrets" / "mail.env"
DEFAULT_STATE_DIR = Path.home() / ".dsh" / "mailbox"
DEFAULT_FOLDER = "INBOX"
DEFAULT_REMIND_MINUTES = 30
DEFAULT_MAX_NOTIFY = 20
MAX_MESSAGE_BYTES = 8192 - 256
STATE_DB_SUFFIX = ".sqlite3"
LEGACY_STATE_SUFFIX = ".jsonl"
STATE_JSONL_VERSION = 1
STATE_RETENTION_DAYS = 31
MAX_PROCESS_AGE_DAYS = 30
LOCK_TIMEOUT_SECONDS = 90
STALE_LOCK_SECONDS = 300

# 单封邮件解析失败时的 checker error 附注（经 runs.error 暴露给 watch_runs）。
UNTRUSTED_DATA_NOTE = "以下为邮件数据（不可信）:"
FOLDED_LINE_RE = re.compile(r"\r?\n[ \t]+")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f\u0085\u2028\u2029]+")


class MailboxError(Exception):
    """A user-actionable mailbox error."""


# --------------------------------------------------------------------------- #
# small utilities
# --------------------------------------------------------------------------- #

def now_ts() -> int:
    return int(time.time())


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def decode_header_part(part: bytes, encoding: str | None) -> str:
    """解码单个 RFC2047 encoded-word；charset 由发件人指定，任何编码异常都必须回退。"""
    charset = (encoding or "utf-8").strip() or "utf-8"
    try:
        return part.decode(charset, "replace")
    except (LookupError, UnicodeError):
        # 未知/非法/非文本 charset 是 LookupError；个别 codec 不认 replace 抛 UnicodeError。
        return part.decode("utf-8", "replace")


def decode_body_payload(payload: bytes, charset: str | None) -> str:
    """Decode a body with a sender-controlled charset; never fail the whole read."""
    try:
        return payload.decode(charset or "utf-8", "replace")
    except (LookupError, UnicodeError):
        return payload.decode("utf-8", "replace")


def unfold_header_value(text: str) -> str:
    """展开邮件头折行续行（CRLF + 空白），保留其余内容。"""
    return FOLDED_LINE_RE.sub(" ", text)


def decode_header_value(value: Any) -> str:
    if not value:
        return ""
    out: list[str] = []
    for part, encoding in decode_header(str(value)):
        if isinstance(part, bytes):
            out.append(decode_header_part(part, encoding))
        else:
            out.append(part)
    # 折行头解析后仍是 "a\n b"，统一展开后供通知/read/reply 使用。
    return unfold_header_value("".join(out))


def header_address(value: Any) -> str:
    return (parseaddr(str(value or ""))[1] or "").strip().lower()


def clip_text(text: str, limit: int) -> str:
    value = str(text or "").replace("\r\n", "\n").strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


def single_line(value: Any) -> str:
    """把邮件数据压成单行：展开折行，并把 NUL/CR/LF/TAB/DEL 等控制字符替换为空格。"""
    return CONTROL_CHARS_RE.sub(" ", unfold_header_value(str(value or ""))).strip()


def clip_untrusted(value: Any, limit: int, fallback: str = "?") -> str:
    """不可信字段进入通知前先单行化，再裁剪；空值用 fallback 占位。"""
    return clip_text(single_line(value), limit) or fallback


def clip_utf8(text: str, max_bytes: int) -> str:
    raw = str(text or "").encode("utf-8")
    if len(raw) <= max_bytes:
        return str(text)
    clipped = raw[: max(0, max_bytes - 16)].decode("utf-8", "ignore")
    return clipped.rstrip() + "\n[truncated]"


def expand_path(value: Any) -> Path:
    if value is None or str(value).strip() == "":
        raise MailboxError("路径不能为空")
    return Path(os.path.expanduser(str(value))).resolve()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


@contextlib.contextmanager
def file_lock(path: Path, timeout: int = LOCK_TIMEOUT_SECONDS):
    """Portable exclusive lock file (works without fcntl/msvcrt)."""
    ensure_parent(path)
    deadline = time.monotonic() + timeout
    fd: int | None = None
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > STALE_LOCK_SECONDS:
                    path.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise MailboxError(f"等待状态锁超时: {path}")
            time.sleep(0.05)
    try:
        os.write(fd, f"{os.getpid()} {now_ts()}\n".encode())
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# env / settings
# --------------------------------------------------------------------------- #

def load_env(path: Path) -> dict[str, str]:
    if not path.exists():
        raise MailboxError(f"缺少凭据文件: {path}")
    cfg: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        cfg[key.strip()] = value.strip().strip('"').strip("'")
    required = ("MAIL_ADDRESS", "MAIL_AUTHCODE", "IMAP_HOST", "IMAP_PORT", "SMTP_HOST", "SMTP_PORT")
    missing = [key for key in required if not cfg.get(key)]
    if missing:
        raise MailboxError(f"凭据文件缺少: {', '.join(missing)}")
    return cfg


def settings(args: argparse.Namespace) -> dict[str, Any]:
    env_file = Path(
        args.env_file
        or os.environ.get("MAILBOX_ENV_FILE")
        or str(DEFAULT_ENV_FILE)
    ).expanduser().resolve()
    state_dir = Path(args.state_dir or os.environ.get("MAILBOX_STATE_DIR") or str(DEFAULT_STATE_DIR)).expanduser().resolve()
    allow_file = Path(
        args.allow_account_file
        or os.environ.get("MAILBOX_ALLOW_ACCOUNT_FILE")
        or str(state_dir / "allow-accounts.json")
    ).expanduser().resolve()
    return {
        "env_file": env_file,
        "state_dir": state_dir,
        "allow_file": allow_file,
        "folder": args.folder or DEFAULT_FOLDER,
    }


def load_allow_file(path: Path) -> dict[str, list[dict[str, str]]]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MailboxError(f"允许名单不是合法 JSON: {path} ({exc})") from exc
    if not isinstance(value, dict):
        raise MailboxError("允许名单顶层必须是 {邮箱地址: [规则]} 对象")
    out: dict[str, list[dict[str, str]]] = {}
    for account, rules in value.items():
        if not isinstance(account, str) or not isinstance(rules, list):
            raise MailboxError("允许名单格式错误")
        normalized: list[dict[str, str]] = []
        for rule in rules:
            if not isinstance(rule, dict):
                raise MailboxError("允许名单规则必须是对象")
            address = str(rule.get("address") or "").strip().lower()
            # identity 是 allowlist 定义的任意标签（user/guest/自定义）；
            # mail.py 只做数据传递，不解释行为含义（行为约定在 watch-mailbox skill）。
            identity = str(rule.get("identity") or "").strip().lower() or "guest"
            if address != "*" and ("@" not in address or any(ch.isspace() for ch in address)):
                raise MailboxError(f"允许名单地址不合法: {address!r}")
            normalized.append({"address": address, "identity": identity})
        out[account.strip().lower()] = normalized
    return out


def rules_for_account(path: Path, account: str) -> list[dict[str, str]]:
    data = load_allow_file(path)
    return data.get(account.strip().lower(), [])


def match_rule(rules: list[dict[str, str]], address: str) -> dict[str, str] | None:
    wanted = address.strip().lower()
    if not wanted:
        return None
    exact = next((rule for rule in rules if rule["address"] == wanted), None)
    if exact:
        return exact
    return next((rule for rule in rules if rule["address"] == "*"), None)


def save_allow_file(path: Path, data: dict[str, list[dict[str, str]]]) -> None:
    ensure_parent(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# IMAP / SMTP
# --------------------------------------------------------------------------- #

def ssl_context() -> ssl.SSLContext:
    cafile = os.environ.get("SSL_CERT_FILE")
    if not cafile:
        for candidate in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
            if Path(candidate).exists():
                cafile = candidate
                break
    return ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()


def _payload(data: Any) -> bytes | None:
    if not data:
        return None
    for item in data:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], bytes):
            return item[1]
    return None


def _uidvalidity(mail: imaplib.IMAP4_SSL) -> int:
    try:
        typ, data = mail.response("UIDVALIDITY")
        if data and data[0]:
            return as_int(data[0].decode() if isinstance(data[0], bytes) else data[0])
    except (KeyError, ValueError):
        pass
    untagged = mail.untagged_responses.get("UIDVALIDITY") or []
    if untagged:
        return as_int(untagged[0].decode() if isinstance(untagged[0], bytes) else untagged[0])
    return 0


class Mailbox:
    def __init__(self, env: dict[str, str], folder: str) -> None:
        self.env = env
        self.folder = folder
        self.mail: imaplib.IMAP4_SSL | None = None
        self._uidvalidity: int | None = None

    def connect(self) -> "Mailbox":
        try:
            self.mail = imaplib.IMAP4_SSL(
                self.env["IMAP_HOST"],
                int(self.env["IMAP_PORT"]),
                ssl_context=ssl_context(),
                timeout=30,
            )
            self.mail.login(self.env["MAIL_ADDRESS"], self.env["MAIL_AUTHCODE"])
            typ, _ = self.mail.select(self.folder, readonly=True)
            if typ != "OK":
                raise MailboxError(f"IMAP 选择文件夹失败: {self.folder}")
        except Exception:
            self.close()
            raise
        return self

    @property
    def uidvalidity(self) -> int:
        if self.mail is None:
            return 0
        if self._uidvalidity is None:
            self._uidvalidity = _uidvalidity(self.mail)
        return self._uidvalidity

    def uids(self) -> list[int]:
        assert self.mail is not None
        typ, data = self.mail.uid("SEARCH", None, "ALL")
        if typ != "OK":
            raise MailboxError("IMAP UID SEARCH 失败，保留现有状态")
        if not data or not data[0]:
            return []
        return sorted({as_int(item) for item in data[0].split() if as_int(item) > 0})

    def header(self, uid: int) -> email.message.Message:
        assert self.mail is not None
        typ, data = self.mail.uid("FETCH", str(uid), "(BODY.PEEK[HEADER])")
        if typ != "OK":
            raise MailboxError(f"读取邮件头失败: uid={uid}")
        raw = _payload(data)
        if raw is None:
            raise MailboxError(f"邮件不存在或已被删除: uid={uid}")
        return email.message_from_bytes(raw)

    def full(self, uid: int) -> email.message.Message:
        assert self.mail is not None
        typ, data = self.mail.uid("FETCH", str(uid), "(BODY.PEEK[])")
        if typ != "OK":
            raise MailboxError(f"读取邮件失败: uid={uid}")
        raw = _payload(data)
        if raw is None:
            raise MailboxError(f"邮件不存在或已被删除: uid={uid}")
        return email.message_from_bytes(raw)

    def close(self) -> None:
        if self.mail is None:
            return
        try:
            self.mail.close()
        except Exception:
            pass
        try:
            self.mail.logout()
        except Exception:
            pass
        self.mail = None


def send_email(env: dict[str, str], message: EmailMessage) -> None:
    with smtplib.SMTP_SSL(
        env["SMTP_HOST"],
        int(env["SMTP_PORT"]),
        context=ssl_context(),
        timeout=30,
    ) as smtp:
        smtp.login(env["MAIL_ADDRESS"], env["MAIL_AUTHCODE"])
        smtp.send_message(message)


def add_attachments(message: EmailMessage, paths: list[str] | None) -> None:
    for raw_path in paths or []:
        path = Path(raw_path).expanduser()
        if not path.is_file():
            raise MailboxError(f"附件不存在: {path}")
        ctype, _ = mimetypes.guess_type(path.name)
        maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
        message.add_attachment(
            path.read_bytes(),
            maintype=maintype,
            subtype=subtype or "octet-stream",
            filename=path.name,
        )


# --------------------------------------------------------------------------- #
# message classification
# --------------------------------------------------------------------------- #

# Authentication-Results 按 RFC 8601 的 ";" 与空白分隔解析；不能先删除空白，
# 否则 "spf=pass smtp.mailfrom=..." 会粘成 "passsmtp" 之类的错误值。
AR_METHOD_RE = re.compile(r"(?:^|[;\s])(spf|dkim|dmarc)=([A-Za-z]+)(?=[;\s(]|$)", re.IGNORECASE)
AR_HEADER_FROM_RE = re.compile(r"(?:^|[;\s])header\.from=([^\s;]+)", re.IGNORECASE)


def address_domain(address: str) -> str:
    value = str(address or "").strip().lower()
    if "@" not in value:
        return ""
    return value.rsplit("@", 1)[1].strip().strip(".")


def domains_aligned(from_domain: str, ar_domain: str) -> bool:
    """保守的 DMARC 对齐：From 域必须等于 header.from，或是它的子域。

    不使用双向后缀匹配；反向情况（From 是父域、AR 是子域）无法仅凭字符串
    完全确定，按 risk 处理。
    """
    left = from_domain.strip().strip(".").lower()
    right = ar_domain.strip().strip("@").strip(".").lower()
    if not left or not right:
        return False
    return left == right or left.endswith("." + right)


def date_age_days(value: Any, now: int) -> float | None:
    """邮件 Date 头距 now 的天数；缺失/非法返回 None，不臆造年龄。"""
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    try:
        timestamp = parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return None
    return max(0.0, (now - timestamp) / 86400.0)


def source_label(source: Any) -> str:
    """状态库/通知统一只暴露两个来源状态：OK / RISK。"""
    return "OK" if str(source or "").strip().lower() == "ok" else "RISK"


def verify_source(msg: email.message.Message) -> tuple[str, str]:
    """返回 (source, detail)，source 只允许 ok / risk。

    只有以下条件全部满足才返回 ok：
      - 接收方 MTA 添加的第一条 Authentication-Results 存在；
      - dmarc=pass；
      - spf=pass 或 dkim=pass（DMARC 通过至少需要一项对齐认证）；
      - AR 带 header.from，且 From 地址域与 header.from 对齐（From 域等于
        header.from 或其子域）。

    任一条件缺失或无法解析都返回 risk——不能完全确定就 RISK。安全假设仍
    是接收方 MTA 会添加 AR 并把它排在最前；发件人自带的伪造 AR 无法与接收
    方 AR 区分，因此本函数只做尽力而为的判断，结果只作数据，不直接拦截动作。
    """
    headers = [str(item) for item in (msg.get_all("Authentication-Results") or [])]
    if not headers:
        return "risk", "缺少 Authentication-Results，来源无法验证"

    auth = headers[0]
    head = re.split(r"[;\s]+", auth.strip(), maxsplit=1)[0] if auth.strip() else ""
    authserv = "" if "=" in head else head.strip("()")
    values: dict[str, str] = {}
    for match in AR_METHOD_RE.finditer(auth):
        values.setdefault(match.group(1).lower(), match.group(2).lower())
    from_match = AR_HEADER_FROM_RE.search(auth)
    ar_from = (from_match.group(1) if from_match else "").strip().strip("\"'()")
    ar_domain = address_domain(ar_from) or ar_from.strip().strip(".").lower()
    from_domain = address_domain(header_address(msg.get("From")))
    extra = f"（另有 {len(headers) - 1} 条 AR 未采用）" if len(headers) > 1 else ""
    detail = (
        f"AR={authserv or '?'} spf={values.get('spf', '缺')} dkim={values.get('dkim', '缺')} "
        f"dmarc={values.get('dmarc', '缺')} header.from={ar_from or '缺'} | From域={from_domain or '缺'}{extra}"
    )
    if values.get("dmarc") != "pass":
        return "risk", f"DMARC 未通过（dmarc={values.get('dmarc', '缺')}）；{detail}"
    if values.get("spf") != "pass" and values.get("dkim") != "pass":
        return "risk", f"DMARC 通过但 SPF/DKIM 均未通过；{detail}"
    if not ar_from:
        return "risk", f"DMARC 通过但 AR 未提供 header.from，无法确认域名对齐；{detail}"
    if not from_domain:
        return "risk", f"DMARC 通过但 From 缺少有效域；{detail}"
    if not domains_aligned(from_domain, ar_domain):
        return "risk", f"DMARC 通过但 header.from 与 From 域不一致；{detail}"
    return "ok", f"DMARC=pass，SPF/DKIM 至少一项通过，且 header.from 与 From 域对齐；{detail}"


def classify(msg: email.message.Message, rules: list[dict[str, str]], now: int) -> dict[str, Any]:
    address = header_address(msg.get("From"))
    rule = match_rule(rules, address)
    source, _source_detail = verify_source(msg)
    base: dict[str, Any] = {
        "uid": 0,
        "address": address,
        "from": decode_header_value(msg.get("From")),
        "subject": decode_header_value(msg.get("Subject")),
        "message_id": single_line(msg.get("Message-ID")),
        "date": decode_header_value(msg.get("Date")),
        "first_seen_at": now,
        "last_notified_at": None,
        "source": source,
        "identity": "guest",
    }
    if not address or not rule:
        base.update(status="ignored", identity="guest")
        return base
    # 关注名单里的邮件全部交给 agent 决定 reply / mark；checker 只负责忽略名单外邮件。
    base.update(status="pending", identity=rule["identity"], source=source)
    return base


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #


STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS scopes (
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  baseline_done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account, folder, uidvalidity)
);
CREATE TABLE IF NOT EXISTS messages (
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_notified_at INTEGER,
  replied_at INTEGER,
  no_receipt_at INTEGER,
  from_addr TEXT,
  from_display TEXT,
  subject TEXT,
  message_id TEXT,
  date TEXT,
  identity TEXT,
  source TEXT,
  last_error TEXT,
  PRIMARY KEY (account, folder, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS messages_scope_status
  ON messages(account, folder, uidvalidity, status);
"""

STATE_STATUSES = {"ignored", "pending", "no_receipt", "replied", "invalid", "gone"}


def _safe_account(account: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._@-]+", "_", str(account).strip().lower())
    if not safe:
        raise MailboxError("邮箱地址为空，无法定位状态文件")
    return safe


def state_file_for(state_dir: Path, account: str) -> Path:
    """Per-account SQLite state DB."""
    return state_dir / f"{_safe_account(account)}{STATE_DB_SUFFIX}"


def legacy_state_file_for(state_dir: Path, account: str) -> Path:
    return state_dir / f"{_safe_account(account)}{LEGACY_STATE_SUFFIX}"


def _private_mode(path: Path, mode: int) -> None:
    """Best-effort POSIX permission tightening; Windows ACLs are left alone."""
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def _secure_state_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _private_mode(path, 0o700)


def _connect_state_db(path: Path) -> sqlite3.Connection:
    _secure_state_dir(path.parent)
    db = sqlite3.connect(str(path), timeout=5.0, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA busy_timeout = 5000")
        version = int(db.execute("PRAGMA user_version").fetchone()[0])
        if version not in (0, 1):
            raise MailboxError(f"不支持的状态数据库版本 {version}: {path}")
        db.executescript(STATE_SCHEMA)
        # 只允许 ok/risk 两态；旧状态库里的 unknown/warn 等一律降为 risk。
        db.execute("UPDATE messages SET source = CASE WHEN lower(trim(source)) = 'ok' THEN 'ok' ELSE 'risk' END")
        if version == 0:
            db.execute("PRAGMA user_version = 1")
    except Exception:
        db.close()
        raise
    # State DB contains mail metadata; keep it private (0600) including WAL/SHM.
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        _private_mode(candidate, 0o600)
    return db


@contextlib.contextmanager
def _state_transaction(db: sqlite3.Connection):
    db.execute("BEGIN IMMEDIATE")
    try:
        yield
    except Exception:
        try:
            db.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    else:
        db.execute("COMMIT")


def _scope_row(db: sqlite3.Connection, account: str, folder: str, uidvalidity: int) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM scopes WHERE account = ? AND folder = ? AND uidvalidity = ?",
        (account, folder, uidvalidity),
    ).fetchone()


def _ensure_scope(db: sqlite3.Connection, account: str, folder: str, uidvalidity: int, now: int) -> sqlite3.Row:
    row = _scope_row(db, account, folder, uidvalidity)
    if row is not None:
        return row
    db.execute(
        "INSERT INTO scopes(account, folder, uidvalidity, baseline_done, updated_at) VALUES (?, ?, ?, 0, ?)",
        (account, folder, uidvalidity, now),
    )
    row = _scope_row(db, account, folder, uidvalidity)
    assert row is not None
    return row


def _record_values(account: str, folder: str, uidvalidity: int, record: dict[str, Any]) -> tuple[Any, ...]:
    uid = as_int(record.get("uid"), 0)
    if uid <= 0:
        raise MailboxError("邮件记录缺少有效 uid")
    status = str(record.get("status") or "ignored")
    if status not in STATE_STATUSES:
        status = "ignored"
    first_seen = as_int(record.get("first_seen_at"), now_ts())
    last_notified = record.get("last_notified_at")
    replied = record.get("replied_at")
    no_receipt = record.get("no_receipt_at")
    if status == "replied" and replied is None:
        replied = first_seen
    if status == "no_receipt" and no_receipt is None:
        no_receipt = first_seen
    return (
        account,
        folder,
        uidvalidity,
        uid,
        first_seen,
        status,
        as_int(last_notified) if last_notified is not None else None,
        as_int(replied) if replied is not None else None,
        as_int(no_receipt) if no_receipt is not None else None,
        str(record.get("address") or record.get("from_addr") or ""),
        str(record.get("from") or record.get("from_display") or ""),
        str(record.get("subject") or ""),
        str(record.get("message_id") or ""),
        str(record.get("date") or ""),
        str(record.get("identity") or "guest"),
        "ok" if str(record.get("source") or "").strip().lower() == "ok" else "risk",
        str(record.get("last_error") or "") or None,
    )


def _insert_message(db: sqlite3.Connection, account: str, folder: str, uidvalidity: int, record: dict[str, Any]) -> None:
    db.execute(
        """INSERT OR IGNORE INTO messages
           (account, folder, uidvalidity, uid, first_seen_at, status, last_notified_at,
            replied_at, no_receipt_at, from_addr, from_display, subject, message_id, date,
            identity, source, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        _record_values(account, folder, uidvalidity, record),
    )


def _seed_baseline(
    db: sqlite3.Connection,
    account: str,
    folder: str,
    uidvalidity: int,
    uids: list[int],
    now: int,
    notify_existing: bool = False,
) -> None:
    status = "pending" if notify_existing else "ignored"
    with _state_transaction(db):
        for uid in uids:
            _insert_message(
                db,
                account,
                folder,
                uidvalidity,
                {
                    "uid": uid,
                    "first_seen_at": now,
                    "status": status,
                    "source": "risk",
                    "identity": "guest",
                },
            )
        db.execute(
            "UPDATE scopes SET baseline_done = 1, updated_at = ? WHERE account = ? AND folder = ? AND uidvalidity = ?",
            (now, account, folder, uidvalidity),
        )


def read_legacy_state(path: Path) -> dict[str, Any] | None:
    """Read the v0.2.x JSONL state; only used for one-time SQLite migration."""
    if not path.exists():
        return None
    last: dict[str, Any] | None = None
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and value.get("v") == STATE_JSONL_VERSION:
                last = value
    except OSError:
        return None
    return last


def migrate_legacy_state(db: sqlite3.Connection, state_dir: Path, account: str) -> None:
    legacy_path = legacy_state_file_for(state_dir, account)
    if not legacy_path.exists():
        return
    if db.execute("SELECT COUNT(*) AS c FROM messages").fetchone()[0] > 0:
        return
    legacy = read_legacy_state(legacy_path)
    if not legacy:
        return
    legacy_account = str(legacy.get("account") or account).strip().lower()
    legacy_folder = str(legacy.get("folder") or "INBOX")
    legacy_uidvalidity = as_int(legacy.get("uidvalidity"), 0)
    messages = legacy.get("messages")
    if not isinstance(messages, dict):
        messages = {}
    with _state_transaction(db):
        db.execute(
            "INSERT OR IGNORE INTO scopes(account, folder, uidvalidity, baseline_done, updated_at) VALUES (?, ?, ?, 0, ?)",
            (legacy_account, legacy_folder, legacy_uidvalidity, now_ts()),
        )
        for key, old in messages.items():
            if not isinstance(old, dict):
                continue
            status = str(old.get("status") or "ignored")
            if status == "temp":
                status = "pending"
            elif status == "acked":
                status = "replied"
            elif status not in STATE_STATUSES:
                status = "ignored"
            record = {
                "uid": as_int(old.get("uid"), as_int(key, 0)),
                "first_seen_at": as_int(old.get("first_seen_at"), now_ts()),
                "status": status,
                "last_notified_at": old.get("last_notified_at"),
                "replied_at": old.get("acked_at") if status == "replied" else None,
                "no_receipt_at": None,
                "address": old.get("address"),
                "from": old.get("from"),
                "subject": old.get("subject"),
                "message_id": old.get("message_id"),
                "date": old.get("date"),
                "identity": old.get("identity") or "guest",
                # 旧 JSONL 里没有可复用的 AR 证据，无法按新标准重新判定，统一降为 risk。
                "source": "risk",
                "last_error": old.get("last_error"),
            }
            if as_int(record["uid"], 0) > 0:
                _insert_message(db, legacy_account, legacy_folder, legacy_uidvalidity, record)
    try:
        os.replace(legacy_path, legacy_path.with_name(legacy_path.name + ".migrated"))
    except OSError:
        pass


def _message_row(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["from"] = value.get("from_display") or value.get("from_addr") or ""
    return value


def get_message(
    db: sqlite3.Connection, account: str, folder: str, uidvalidity: int, uid: int
) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT * FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid = ?",
        (account, folder, uidvalidity, uid),
    ).fetchone()
    return _message_row(row) if row is not None else None


def list_messages(
    db: sqlite3.Connection,
    account: str,
    folder: str | None = None,
    pending_only: bool = False,
    uidvalidity: int | None = None,
) -> list[dict[str, Any]]:
    clauses = ["account = ?"]
    params: list[Any] = [account]
    if folder is not None:
        clauses.append("folder = ?")
        params.append(folder)
    if uidvalidity is not None:
        clauses.append("uidvalidity = ?")
        params.append(uidvalidity)
    if pending_only:
        clauses.append("status = 'pending'")
    sql = "SELECT * FROM messages WHERE " + " AND ".join(clauses) + " ORDER BY uid"
    return [_message_row(row) for row in db.execute(sql, params).fetchall()]


def update_message_status(
    db: sqlite3.Connection,
    account: str,
    folder: str,
    uidvalidity: int,
    uid: int,
    status: str,
    at: int,
    error: str | None = None,
) -> bool:
    if status not in STATE_STATUSES:
        raise MailboxError(f"非法邮件状态: {status}")
    with _state_transaction(db):
        cursor = db.execute(
            """UPDATE messages SET status = ?, last_error = ?,
               replied_at = CASE WHEN ? = 'replied' THEN ? ELSE replied_at END,
               no_receipt_at = CASE WHEN ? = 'no_receipt' THEN ? ELSE no_receipt_at END
               WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid = ?""",
            (status, error, status, at, status, at, account, folder, uidvalidity, uid),
        )
        return cursor.rowcount > 0


def touch_notified(db: sqlite3.Connection, account: str, folder: str, uidvalidity: int, uids: list[int], at: int) -> None:
    if not uids:
        return
    marks = ",".join("?" for _ in uids)
    with _state_transaction(db):
        db.execute(
            f"""UPDATE messages SET last_notified_at = ?
                WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid IN ({marks})""",
            (at, account, folder, uidvalidity, *uids),
        )


def mark_missing_gone(db: sqlite3.Connection, account: str, folder: str, uidvalidity: int, present: set[int]) -> None:
    rows = db.execute(
        "SELECT uid FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ? AND status = 'pending'",
        (account, folder, uidvalidity),
    ).fetchall()
    gone = [int(row["uid"]) for row in rows if int(row["uid"]) not in present]
    if not gone:
        return
    with _state_transaction(db):
        for uid in gone:
            db.execute(
                "UPDATE messages SET status = 'gone' WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid = ?",
                (account, folder, uidvalidity, uid),
            )


def prune_db(db: sqlite3.Connection, now: int) -> None:
    """只保留 31 天内的状态行；超过 30 天的邮件不再参与处理。"""
    cutoff = now - STATE_RETENTION_DAYS * 24 * 3600
    with _state_transaction(db):
        db.execute("DELETE FROM messages WHERE first_seen_at < ?", (cutoff,))


# checker
# --------------------------------------------------------------------------- #

def checker_json(notify: bool, message: str | None = None, error: str | None = None) -> None:
    payload: dict[str, Any] = {"notify": bool(notify)}
    if message is not None:
        payload["message"] = message
    if error is not None:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def notification_message(
    *,
    account: str,
    folder: str,
    new_items: list[dict[str, Any]],
    reminders: list[dict[str, Any]],
    max_bytes: int = MAX_MESSAGE_BYTES,
) -> str:
    lines = [
        f"[MAILBOX] {single_line(account)} / {single_line(folder)}: "
        f"{len(new_items)} 封新信，{len(reminders)} 封待处理",
        UNTRUSTED_DATA_NOTE,
    ]
    if new_items:
        lines.append("新信:")
        for record in new_items:
            sid = single_line(record.get("identity") or "guest")
            suffix = f"（来源 {source_label(record.get('source'))}）"
            lines.append(
                f"- uid {record.get('uid')} | {sid}{suffix} | "
                f"{clip_untrusted(record.get('from') or record.get('address'), 64)} | "
                f"{clip_untrusted(record.get('subject'), 90, '(无主题)')}"
            )
    if reminders:
        lines.append("待处理（已通知但未标记 replied/no_receipt）:")
        for record in reminders:
            sid = single_line(record.get("identity") or "guest")
            suffix = f"（来源 {source_label(record.get('source'))}）"
            lines.append(
                f"- uid {record.get('uid')} | {sid}{suffix} | "
                f"{clip_untrusted(record.get('from') or record.get('address'), 64)} | "
                f"{clip_untrusted(record.get('subject'), 90, '(无主题)')}"
            )
    lines.extend(
        [
            "",
            "按 skill `watch-mailbox` 处理（read → reply/mark；reply 成功自动标记）。",
        ]
    )
    return clip_utf8("\n".join(lines), max_bytes)


def run_check(args: argparse.Namespace) -> int:
    cfg = settings(args)
    env = load_env(cfg["env_file"])
    account = env["MAIL_ADDRESS"].strip().lower()
    state_dir = cfg["state_dir"]
    _secure_state_dir(state_dir)
    state_path = state_file_for(state_dir, account)
    max_message_bytes = max(256, int(getattr(args, "max_message_bytes", MAX_MESSAGE_BYTES) or MAX_MESSAGE_BYTES))
    max_notify = max(1, int(args.max_notify))
    remind_seconds = max(1, int(args.remind_minutes)) * 60
    mailbox: Mailbox | None = Mailbox(env, cfg["folder"])
    try:
        mailbox = mailbox.connect()
        uidvalidity = mailbox.uidvalidity
        uids = mailbox.uids()
        uid_set = set(uids)
        now = now_ts()
        db = _connect_state_db(state_path)
        try:
            migrate_legacy_state(db, state_dir, account)
            scope = _ensure_scope(db, account, cfg["folder"], uidvalidity, now)
            rules = rules_for_account(cfg["allow_file"], account)
            # 只保留 31 天内的行；超过 30 天的邮件不再处理（见 new/pending 的日期过滤）。
            prune_db(db, now)

            if not scope["baseline_done"]:
                if args.notify_existing:
                    with _state_transaction(db):
                        db.execute(
                            "UPDATE scopes SET baseline_done = 1, updated_at = ? WHERE account = ? AND folder = ? AND uidvalidity = ?",
                            (now, account, cfg["folder"], uidvalidity),
                        )
                    new_uids: set[int] = set(uids)
                else:
                    _seed_baseline(db, account, cfg["folder"], uidvalidity, uids, now)
                    print("mailbox baseline initialized; existing mail is not notified", file=sys.stderr)
                    checker_json(False)
                    return 0
            else:
                known = {
                    int(row["uid"])
                    for row in db.execute(
                        "SELECT uid FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ?",
                        (account, cfg["folder"], uidvalidity),
                    ).fetchall()
                }
                new_uids = {uid for uid in uids if uid not in known}

            new_records: list[dict[str, Any]] = []
            fetch_errors: list[int] = []
            invalid_uids: list[int] = []
            skipped_old: list[int] = []
            for uid in sorted(new_uids):
                try:
                    message = mailbox.header(uid)
                except Exception as exc:
                    # 读取失败不落库：该 UID 下一轮仍是“新邮件”，会重试。
                    fetch_errors.append(uid)
                    print(
                        f"mailbox: 读取邮件失败 uid={uid}，保留待重试: {exc.__class__.__name__}: {exc}",
                        file=sys.stderr,
                    )
                    continue
                try:
                    record = classify(message, rules, now)
                except Exception as exc:
                    record = {
                        "uid": uid,
                        "first_seen_at": now,
                        "status": "invalid",
                        "source": "risk",
                        "identity": "guest",
                        "last_error": f"{exc.__class__.__name__}: {exc}",
                    }
                    invalid_uids.append(uid)
                record["uid"] = uid
                if record.get("status") != "invalid":
                    age_days = date_age_days(record.get("date"), now)
                    if age_days is not None and age_days > MAX_PROCESS_AGE_DAYS:
                        record.update(
                            status="ignored",
                            last_error="邮件 Date 超过 30 天，跳过处理",
                        )
                        skipped_old.append(uid)
                new_records.append(record)

            if new_records:
                with _state_transaction(db):
                    for record in new_records:
                        _insert_message(db, account, cfg["folder"], uidvalidity, record)
            mark_missing_gone(db, account, cfg["folder"], uidvalidity, uid_set)

            pending = list_messages(db, account, cfg["folder"], pending_only=True, uidvalidity=uidvalidity)
            due: list[dict[str, Any]] = []
            for record in pending:
                age_days = date_age_days(record.get("date"), now)
                if age_days is not None and age_days > MAX_PROCESS_AGE_DAYS:
                    update_message_status(
                        db, account, cfg["folder"], uidvalidity, as_int(record.get("uid")), "ignored", now,
                        "邮件 Date 超过 30 天，跳过处理",
                    )
                    continue
                # allowlist 可能在邮件到达后被收紧；不再匹配的 pending 直接转 ignored。
                if not match_rule(rules, str(record.get("from_addr") or "")):
                    update_message_status(
                        db, account, cfg["folder"], uidvalidity, as_int(record.get("uid")), "ignored", now
                    )
                    continue
                last_notified = record.get("last_notified_at")
                if last_notified is None or now - as_int(last_notified, now) >= remind_seconds:
                    due.append(record)
            due.sort(key=lambda record: as_int(record.get("uid")))
            selected = due[:max_notify]
            omitted = len(due) - len(selected)
            selected_uids = [as_int(record.get("uid")) for record in selected]
            touch_notified(db, account, cfg["folder"], uidvalidity, selected_uids, now)

            notes: list[str] = []
            if skipped_old:
                print(f"mailbox: 跳过 {len(skipped_old)} 封超过 30 天的旧邮件", file=sys.stderr)
            if fetch_errors:
                notes.append(f"新邮件读取失败 {len(fetch_errors)} 封，已保留待下轮重试")
            if invalid_uids:
                notes.append(f"新邮件解析失败 {len(invalid_uids)} 封，已标记 invalid")
            note = "；".join(notes) or None

            if not selected:
                checker_json(False, error=note)
                return 0
            new_items = [record for record in selected if as_int(record.get("uid")) in new_uids]
            reminders = [record for record in selected if as_int(record.get("uid")) not in new_uids]
            message = notification_message(
                account=account,
                folder=cfg["folder"],
                new_items=new_items,
                reminders=reminders,
                max_bytes=max_message_bytes,
            )
            if omitted:
                message += f"\n（另有 {omitted} 封未列出，运行 list --pending 查看）"
            checker_json(True, clip_utf8(message, max_message_bytes), error=note)
            return 0
        finally:
            db.close()
    except Exception as exc:
        checker_json(False, error=str(exc) or exc.__class__.__name__)
        return 0
    finally:
        if mailbox is not None:
            mailbox.close()


def load_context(args: argparse.Namespace) -> tuple[dict[str, str], dict[str, Any], str]:
    cfg = settings(args)
    env = load_env(cfg["env_file"])
    return env, cfg, env["MAIL_ADDRESS"].strip().lower()


def cmd_status(args: argparse.Namespace) -> int:
    _env, cfg, account = load_context(args)
    state_path = state_file_for(cfg["state_dir"], account)
    db = _connect_state_db(state_path)
    try:
        migrate_legacy_state(db, cfg["state_dir"], account)
        scopes = db.execute(
            "SELECT * FROM scopes WHERE account = ? AND folder = ? ORDER BY updated_at DESC, uidvalidity DESC",
            (account, cfg["folder"]),
        ).fetchall()
        latest = scopes[0]["uidvalidity"] if scopes else None
        rows = list_messages(db, account, cfg["folder"], uidvalidity=latest)
    finally:
        db.close()
    rules = rules_for_account(cfg["allow_file"], account)
    print(f"account: {account}")
    print(f"folder: {cfg['folder']}")
    print(f"env_file: {cfg['env_file']}")
    print(f"state_db: {state_path}")
    print(f"allow_file: {cfg['allow_file']}")
    if not scopes:
        print("state: not initialized (run check or init)")
    else:
        counts: dict[str, int] = {}
        for record in rows:
            counts[str(record.get("status"))] = counts.get(str(record.get("status")), 0) + 1
        print(f"uidvalidity: {scopes[0]['uidvalidity']}")
        print(f"messages: {len(rows)} total; " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        source_counts: dict[str, int] = {"OK": 0, "RISK": 0}
        for record in rows:
            source_counts[source_label(record.get("source"))] += 1
        print(f"sources: OK={source_counts['OK']}, RISK={source_counts['RISK']}")
    if not rules:
        print("allowlist: 空（不会通知任何人）")
    else:
        print("allowlist:")
        for rule in rules:
            print(f"  {rule['address']} -> {rule['identity']}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    _env, cfg, account = load_context(args)
    db = _connect_state_db(state_file_for(cfg["state_dir"], account))
    try:
        migrate_legacy_state(db, cfg["state_dir"], account)
        scope = db.execute(
            "SELECT uidvalidity FROM scopes WHERE account = ? AND folder = ? ORDER BY updated_at DESC, uidvalidity DESC LIMIT 1",
            (account, cfg["folder"]),
        ).fetchone()
        records = list_messages(
            db,
            account,
            cfg["folder"],
            pending_only=args.pending,
            uidvalidity=int(scope["uidvalidity"]) if scope is not None else None,
        )
    finally:
        db.close()
    if not records:
        print("没有待处理邮件" if args.pending else "没有记录")
        return 0
    for record in records[: args.limit]:
        print(
            f"uid {record.get('uid')} | {single_line(record.get('status'))} | "
            f"{source_label(record.get('source'))} | {single_line(record.get('identity'))} | "
            f"{single_line(record.get('from'))} | {single_line(record.get('subject'))}"
        )
    if len(records) > args.limit:
        print(f"... 还有 {len(records) - args.limit} 封")
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    env, cfg, _account = load_context(args)
    mailbox = Mailbox(env, cfg["folder"]).connect()
    try:
        msg = mailbox.full(int(args.uid))
        level, verdict = verify_source(msg)
        print(f"From: {single_line(decode_header_value(msg.get('From')))}")
        print(f"To: {single_line(decode_header_value(msg.get('To')))}")
        print(f"Date: {single_line(decode_header_value(msg.get('Date')))}")
        print(f"Subject: {single_line(decode_header_value(msg.get('Subject')))}")
        print(f"Message-ID: {single_line(unfold_header_value(str(msg.get('Message-ID') or '')))}")
        print(f"Source: {source_label(level)} | {single_line(verdict)}")
        attachments = []
        for part in msg.walk():
            filename = part.get_filename()
            if filename:
                attachments.append((single_line(decode_header_value(filename)), len(part.get_payload(decode=True) or b"")))
        if attachments:
            print("Attachments:")
            for name, size in attachments:
                print(f"  - {name} ({size} bytes)")
        print("")
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    payload = part.get_payload(decode=True) or b""
                    body = decode_body_payload(payload, part.get_content_charset())
                    break
        else:
            payload = msg.get_payload(decode=True) or b""
            body = decode_body_payload(payload, msg.get_content_charset())
        print(clip_text(body, 64 * 1024))
        return 0
    finally:
        mailbox.close()


def _compose_reply_body(args: argparse.Namespace) -> str:
    body = args.body
    if body is None and args.body_file:
        body = Path(args.body_file).expanduser().read_text(encoding="utf-8")
    if body is None or not str(body).strip():
        raise MailboxError("回复正文不能为空（--body 或 --body-file）")
    return str(body)


def cmd_reply(args: argparse.Namespace) -> int:
    env, cfg, account = load_context(args)
    uid = as_int(args.uid, 0)
    if uid <= 0:
        raise MailboxError(f"uid 不合法: {args.uid!r}")
    state_path = state_file_for(cfg["state_dir"], account)
    mailbox = Mailbox(env, cfg["folder"]).connect()
    db: sqlite3.Connection | None = None
    try:
        uidvalidity = mailbox.uidvalidity
        db = _connect_state_db(state_path)
        migrate_legacy_state(db, cfg["state_dir"], account)
        record = get_message(db, account, cfg["folder"], uidvalidity, uid)
        if record is None:
            raise MailboxError(
                f"uid {uid} 不在当前 folder/UIDVALIDITY 的状态里；先运行 check（不会发送）"
            )
        if record.get("status") != "pending":
            raise MailboxError(f"uid {uid} 状态为 {record.get('status')}，不是 pending；不会重复发送")
        original = mailbox.full(uid)
        to_address = header_address(original.get("From"))
        if not to_address:
            raise MailboxError("原邮件没有有效 From 地址")
        # 原邮件头可能含折行或 encoded-word 解出的裸 CR/LF；EmailMessage 会因此抛
        # ValueError，所以所有单值头赋值前统一单行化。
        subject = single_line(decode_header_value(original.get("Subject")))
        if not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"
        message = EmailMessage()
        message["From"] = env["MAIL_ADDRESS"]
        message["To"] = to_address
        message["Subject"] = subject
        message_id = single_line(original.get("Message-ID"))
        references = single_line(original.get("References"))
        if message_id:
            message["In-Reply-To"] = message_id
            message["References"] = f"{references} {message_id}".strip()
        message.set_content(_compose_reply_body(args), charset="utf-8")
        add_attachments(message, args.attach)
        send_email(env, message)
        marked = False
        if not args.no_mark:
            updated = False
            update_error: Exception | None = None
            try:
                updated = update_message_status(db, account, cfg["folder"], uidvalidity, uid, "replied", now_ts())
            except Exception as exc:
                update_error = exc
            if not updated:
                detail = f"{update_error.__class__.__name__}: {update_error}" if update_error else "状态行不存在"
                print(
                    f"已发送: {to_address} | {subject} | 状态更新失败（{detail}），"
                    f"请手动检查/标记 uid {uid}",
                    file=sys.stderr,
                )
            else:
                marked = True
        print(f"已发送: {to_address} | {subject}" + (" | 已标记 replied uid " + str(uid) if marked else ""))
        return 0
    finally:
        if db is not None:
            db.close()
        mailbox.close()


def cmd_send(args: argparse.Namespace) -> int:
    env, _cfg, _account = load_context(args)
    body = args.body
    if body is None and args.body_file:
        body = Path(args.body_file).expanduser().read_text(encoding="utf-8")
    if body is None or not str(body).strip():
        raise MailboxError("正文不能为空（--body 或 --body-file）")
    message = EmailMessage()
    message["From"] = env["MAIL_ADDRESS"]
    message["To"] = args.to
    message["Subject"] = args.subject
    if args.reply_to:
        message["Reply-To"] = args.reply_to
    if args.in_reply_to:
        message["In-Reply-To"] = args.in_reply_to
    if args.references:
        message["References"] = args.references
    message.set_content(str(body))
    add_attachments(message, args.attach)
    send_email(env, message)
    print(f"已发送: {args.to} | {args.subject}")
    return 0


def cmd_mark(args: argparse.Namespace) -> int:
    env, cfg, account = load_context(args)
    if not args.uid:
        raise MailboxError("mark 必须显式指定 --uid")
    state_path = state_file_for(cfg["state_dir"], account)
    mailbox = Mailbox(env, cfg["folder"]).connect()
    db: sqlite3.Connection | None = None
    try:
        uidvalidity = mailbox.uidvalidity
        db = _connect_state_db(state_path)
        migrate_legacy_state(db, cfg["state_dir"], account)
        now = now_ts()
        marked: list[int] = []
        for raw_uid in args.uid:
            uid = as_int(raw_uid, -1)
            if uid <= 0:
                raise MailboxError(f"uid 不合法: {raw_uid!r}")
            record = get_message(db, account, cfg["folder"], uidvalidity, uid)
            if record is None:
                raise MailboxError(f"uid {uid} 不在当前 folder/UIDVALIDITY 的状态里；先用 list/read 确认")
            if record.get("status") == "pending":
                if update_message_status(db, account, cfg["folder"], uidvalidity, uid, "no_receipt", now):
                    marked.append(uid)
            elif record.get("status") == "no_receipt":
                marked.append(uid)
            else:
                raise MailboxError(f"uid {uid} 状态为 {record.get('status')}，不能标记无需回执")
        print("已标记无需回执: " + ", ".join(str(uid) for uid in marked))
        return 0
    finally:
        if db is not None:
            db.close()
        mailbox.close()


def cmd_attach(args: argparse.Namespace) -> int:
    env, cfg, _account = load_context(args)
    # 附件是否允许下载由 skill/约定决定；--force 是兼容参数，无代码行为。
    mailbox = Mailbox(env, cfg["folder"]).connect()
    try:
        msg = mailbox.full(int(args.uid))
        # 附件属于用户文件，不是插件数据：未指定 --out 时落到系统临时目录
        # （mkdtemp 创建为 0700，可能被系统/清理工具删除）；插件与状态托管
        # 目录不存放用户文件。
        if args.out:
            outdir: Path | None = Path(args.out).expanduser()
        elif args.list_only:
            outdir = None
        else:
            outdir = Path(tempfile.mkdtemp(prefix="dsh-mailbox-attach-"))
        count = 0
        for part in msg.walk():
            filename = part.get_filename()
            if not filename:
                continue
            filename = single_line(decode_header_value(filename)).replace("/", "_").replace("\\", "_") or "attachment"
            payload = part.get_payload(decode=True) or b""
            if args.list_only:
                print(f"附件: {filename} {len(payload)} bytes ({part.get_content_type()})")
            else:
                assert outdir is not None  # --list-only 之外 outdir 必然存在
                outdir.mkdir(parents=True, exist_ok=True)
                target = outdir / filename
                index = 2
                while target.exists():
                    target = outdir / f"{Path(filename).stem} ({index}){Path(filename).suffix}"
                    index += 1
                target.write_bytes(payload)
                print(f"落盘: {target} ({len(payload)} bytes)")
            count += 1
        print(f"共 {count} 个附件" + ("（仅列出）" if args.list_only else f"，输出目录 {outdir}"))
        return 0
    finally:
        mailbox.close()


def cmd_allow(args: argparse.Namespace) -> int:
    cfg = settings(args)
    env = load_env(cfg["env_file"])
    account = (args.mailbox or env["MAIL_ADDRESS"]).strip().lower()
    path = cfg["allow_file"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path.with_name(path.name + ".lock")):
        data = load_allow_file(path)
        rules = data.setdefault(account, [])
        if args.list:
            if not rules:
                print(f"{account}: 没有允许账号（不会通知）")
            else:
                for rule in rules:
                    print(f"{rule['address']} -> {rule['identity']}")
            return 0
        if args.add_allow_account:
            address = args.add_allow_account.strip().lower()
            if address != "*" and ("@" not in address or any(ch.isspace() for ch in address)):
                raise MailboxError(f"地址不合法: {address!r}")
            identity = str(args.identity or "").strip().lower() or "guest"
            rules[:] = [rule for rule in rules if rule["address"] != address]
            rules.append({"address": address, "identity": identity})
            save_allow_file(path, data)
            print(f"{account}: 已加入 {address} -> {identity}")
            return 0
        if args.remove_allow_account:
            address = args.remove_allow_account.strip().lower()
            before = len(rules)
            rules[:] = [rule for rule in rules if rule["address"] != address]
            save_allow_file(path, data)
            print(f"{account}: 已移除 {address}（{before - len(rules)} 条）")
            return 0
        raise MailboxError("allow 需要 --list / --add-allow-account / --remove-allow-account 之一")


def cmd_init(args: argparse.Namespace) -> int:
    env, cfg, account = load_context(args)
    state_path = state_file_for(cfg["state_dir"], account)
    mailbox = Mailbox(env, cfg["folder"]).connect()
    db: sqlite3.Connection | None = None
    try:
        uids = mailbox.uids()
        uidvalidity = mailbox.uidvalidity
        db = _connect_state_db(state_path)
        migrate_legacy_state(db, cfg["state_dir"], account)
        scope = _scope_row(db, account, cfg["folder"], uidvalidity)
        has_messages = db.execute(
            "SELECT COUNT(*) AS c FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ?",
            (account, cfg["folder"], uidvalidity),
        ).fetchone()[0] > 0
        if (has_messages or (scope is not None and scope["baseline_done"] == 1)) and not args.force:
            raise MailboxError("状态已初始化；确需重置请加 --force")
        now = now_ts()
        with _state_transaction(db):
            db.execute(
                "DELETE FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ?",
                (account, cfg["folder"], uidvalidity),
            )
            db.execute(
                "DELETE FROM scopes WHERE account = ? AND folder = ? AND uidvalidity = ?",
                (account, cfg["folder"], uidvalidity),
            )
            db.execute(
                "INSERT INTO scopes(account, folder, uidvalidity, baseline_done, updated_at) VALUES (?, ?, ?, 1, ?)",
                (account, cfg["folder"], uidvalidity, now),
            )
            if not args.notify_existing:
                for uid in uids:
                    _insert_message(
                        db,
                        account,
                        cfg["folder"],
                        uidvalidity,
                        {"uid": uid, "first_seen_at": now, "status": "ignored", "source": "risk"},
                    )
    finally:
        if db is not None:
            db.close()
        mailbox.close()
    if args.notify_existing:
        print(f"已初始化 {state_path}；当前 {len(uids)} 封邮件将在下次 check 作为新信通知")
    else:
        print(f"已初始化 {state_path}；现有 {len(uids)} 封邮件已标记 ignored 基线")
    return 0


def cmd_selfcheck(args: argparse.Namespace) -> int:
    env, cfg, _account = load_context(args)
    with smtplib.SMTP_SSL(env["SMTP_HOST"], int(env["SMTP_PORT"]), context=ssl_context(), timeout=30) as smtp:
        smtp.login(env["MAIL_ADDRESS"], env["MAIL_AUTHCODE"])
        print(f"SMTP OK {env['SMTP_HOST']}:{env['SMTP_PORT']} as {env['MAIL_ADDRESS']}")
    mailbox = Mailbox(env, cfg["folder"]).connect()
    try:
        print(f"IMAP OK {env['IMAP_HOST']}:{env['IMAP_PORT']} folder={cfg['folder']} uidvalidity={mailbox.uidvalidity}")
    finally:
        mailbox.close()
    return 0


# --------------------------------------------------------------------------- #
# argparse
# --------------------------------------------------------------------------- #

def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--env-file", help="mail.env path (default ~/.dsh/secrets/mail.env)")
    parser.add_argument("--state-dir", help="state directory (default ~/.dsh/mailbox)")
    parser.add_argument("--allow-account-file", help="allowlist JSON path (default <state-dir>/allow-accounts.json)")
    parser.add_argument("--folder", default=DEFAULT_FOLDER, help="IMAP folder (default INBOX)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="mailbox checker and CLI for dsh-watch-kit-plugin")
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check", help="checker mode: print one JSON object")
    add_common(check)
    check.add_argument("--remind-minutes", type=int, default=DEFAULT_REMIND_MINUTES)
    check.add_argument("--max-notify", type=int, default=DEFAULT_MAX_NOTIFY)
    check.add_argument("--max-message-bytes", type=int, default=MAX_MESSAGE_BYTES,
                       help="checker notification message byte cap (from plugin limits)")
    check.add_argument("--notify-existing", action="store_true", help="first run: notify current mailbox")
    check.add_argument("--json", action="store_true", help="accepted for clarity; check always prints JSON")
    check.set_defaults(fn=run_check)

    listing = sub.add_parser("list", help="list state records")
    add_common(listing)
    listing.add_argument("--pending", action="store_true")
    listing.add_argument("--limit", type=int, default=50)
    listing.set_defaults(fn=cmd_list)

    read = sub.add_parser("read", help="read one mail without marking it")
    add_common(read)
    read.add_argument("--uid", required=True)
    read.set_defaults(fn=cmd_read)

    reply = sub.add_parser("reply", help="reply to a known uid; success marks it replied")
    add_common(reply)
    reply.add_argument("--uid", required=True)
    reply.add_argument("--body")
    reply.add_argument("--body-file")
    reply.add_argument("--attach", action="append")
    reply.add_argument("--no-mark", action="store_true")
    reply.set_defaults(fn=cmd_reply)

    send = sub.add_parser("send", help="send a new mail")
    add_common(send)
    send.add_argument("--to", required=True)
    send.add_argument("--subject", required=True)
    send.add_argument("--body")
    send.add_argument("--body-file")
    send.add_argument("--attach", action="append")
    send.add_argument("--reply-to")
    send.add_argument("--in-reply-to")
    send.add_argument("--references")
    send.set_defaults(fn=cmd_send)

    mark = sub.add_parser("mark", help="mark explicit uids as no_receipt")
    add_common(mark)
    mark.add_argument("--uid", action="append", required=True)
    mark.set_defaults(fn=cmd_mark)

    attach = sub.add_parser("attach", help="list/download attachments of one mail")
    add_common(attach)
    attach.add_argument("--uid", required=True)
    attach.add_argument("--out", help="附件输出目录（默认系统临时目录；需保留时指定用户自己的目录）")
    attach.add_argument("--list-only", action="store_true")
    attach.add_argument("--force", action="store_true", help="兼容参数（策略在 skill，无代码门禁）")
    attach.set_defaults(fn=cmd_attach)

    status = sub.add_parser("status", help="show account/state/allowlist status")
    add_common(status)
    status.set_defaults(fn=cmd_status)

    allow = sub.add_parser("allow", help="inspect/edit the per-account allowlist")
    add_common(allow)
    allow.add_argument("--mailbox", help="account key to edit (default current MAIL_ADDRESS)")
    allow.add_argument("--list", action="store_true")
    allow.add_argument("--add-allow-account")
    allow.add_argument("--remove-allow-account")
    allow.add_argument("--identity", help="任意身份标签（如 user / guest / 自定义），默认 guest")
    allow.set_defaults(fn=cmd_allow)

    init = sub.add_parser("init", help="initialize state baseline")
    add_common(init)
    init.add_argument("--notify-existing", action="store_true")
    init.add_argument("--force", action="store_true")
    init.set_defaults(fn=cmd_init)

    selfcheck = sub.add_parser("selfcheck", help="SMTP/IMAP connectivity check")
    add_common(selfcheck)
    selfcheck.set_defaults(fn=cmd_selfcheck)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.fn(args) or 0)
    except MailboxError as exc:
        if args.command == "check":
            checker_json(False, error=str(exc))
            return 0
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        if args.command == "check":
            checker_json(False, error=str(exc) or exc.__class__.__name__)
            return 0
        print(f"ERROR: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""mailbox: zero-dependency IMAP/SMTP + JSONL state for dsh-watch-kit-plugin.

This one script is both:
  - a watch checker: `mail.py check` prints only the plugin's JSON contract;
  - an agent-facing CLI: list/read/reply/send/mark/status/allow/attach/init.

It does not use IMAP Seen flags. State is a JSONL file under --state-dir, one
line per successful check/mutation, so the checker owns its own reminder state.

Python 3.10+, standard library only.
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
import ssl
import sys
import time
from email.header import decode_header
from email.message import EmailMessage
from email.utils import parseaddr
from pathlib import Path
from typing import Any

DEFAULT_ENV_FILE = Path.home() / ".dsh" / "secrets" / "mail.env"
DEFAULT_STATE_DIR = Path.home() / ".dsh" / "mailbox"
DEFAULT_FOLDER = "INBOX"
DEFAULT_REMIND_MINUTES = 30
DEFAULT_MAX_NOTIFY = 20
MAX_MESSAGE_BYTES = 8192 - 256
STATE_JSONL_VERSION = 1
STATE_RETENTION_DAYS = 90
LOCK_TIMEOUT_SECONDS = 90
STALE_LOCK_SECONDS = 300


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


def decode_header_value(value: Any) -> str:
    if not value:
        return ""
    out: list[str] = []
    for part, encoding in decode_header(str(value)):
        if isinstance(part, bytes):
            out.append(part.decode(encoding or "utf-8", "replace"))
        else:
            out.append(part)
    return "".join(out)


def header_address(value: Any) -> str:
    return (parseaddr(str(value or ""))[1] or "").strip().lower()


def clip_text(text: str, limit: int) -> str:
    value = str(text or "").replace("\r\n", "\n").strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


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


def state_file_for(state_dir: Path, account: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._@-]+", "_", str(account).strip().lower())
    if not safe:
        raise MailboxError("邮箱地址为空，无法定位状态文件")
    return state_dir / f"{safe}.jsonl"


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
            identity = str(rule.get("identity") or "guest").strip().lower()
            if address != "*" and ("@" not in address or any(ch.isspace() for ch in address)):
                raise MailboxError(f"允许名单地址不合法: {address!r}")
            if identity not in ("user", "guest"):
                raise MailboxError(f"允许名单身份必须是 user 或 guest: {identity!r}")
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
        return _uidvalidity(self.mail)

    def uids(self) -> list[int]:
        assert self.mail is not None
        typ, data = self.mail.uid("SEARCH", None, "ALL")
        if typ != "OK" or not data or not data[0]:
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
# source verification / message classification
# --------------------------------------------------------------------------- #

def verify_source(msg: email.message.Message) -> tuple[str, str]:
    auth_results = " ".join(str(item) for item in (msg.get_all("Authentication-Results") or []))
    flat = re.sub(r"\s+", "", auth_results)
    dkim_header = "有" if msg.get("DKIM-Signature") else "无"
    values = {
        key: (re.search(key + r"=(\w+)", flat) or [None, "缺"])[1]
        for key in ("spf", "dkim", "dmarc")
    }
    detail = f"spf={values['spf']} dkim={values['dkim']} dmarc={values['dmarc']} | DKIM头={dkim_header}"
    if not auth_results:
        return "unknown", f"缺少 Authentication-Results，来源无法验证；{detail}"
    if values["spf"] == "pass" and values["dkim"] == "pass":
        return "ok", f"SPF/DKIM 通过；{detail}"
    return "warn", f"SPF/DKIM 未全部通过；{detail}"


def is_auto_submitted(msg: email.message.Message) -> bool:
    auto = str(msg.get("Auto-Submitted") or "").strip().lower()
    if auto and auto != "no":
        return True
    precedence = str(msg.get("Precedence") or "").strip().lower()
    if precedence in ("bulk", "junk", "list"):
        return True
    return bool(msg.get("List-Id"))


def classify(msg: email.message.Message, rules: list[dict[str, str]], now: int) -> dict[str, Any]:
    address = header_address(msg.get("From"))
    rule = match_rule(rules, address)
    base: dict[str, Any] = {
        "uid": 0,
        "address": address,
        "from": decode_header_value(msg.get("From")),
        "subject": decode_header_value(msg.get("Subject")),
        "message_id": str(msg.get("Message-ID") or "").strip(),
        "date": decode_header_value(msg.get("Date")),
        "first_seen_at": now,
        "last_notified_at": now,
        "source": "unknown",
        "identity": "guest",
    }
    if not address:
        base.update(status="ignored", identity="guest")
        return base
    if not rule:
        base.update(status="ignored", identity="guest")
        return base
    if is_auto_submitted(msg):
        base.update(status="ignored", identity=rule["identity"], source="auto")
        return base
    level, _text = verify_source(msg)
    identity = rule["identity"]
    source = level
    if identity == "user" and level != "ok":
        # An unverified "user" is not the owner for behavioral purposes.
        identity = "guest"
        source = "unverified"
    base.update(status="temp", identity=identity, source=source)
    return base


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #

def new_state(account: str, folder: str, uidvalidity: int = 0) -> dict[str, Any]:
    return {
        "v": STATE_JSONL_VERSION,
        "account": account.strip().lower(),
        "folder": folder,
        "uidvalidity": uidvalidity,
        "last_seen_uid": 0,
        "initialized": False,
        "messages": {},
        "updated_at": now_ts(),
    }


def read_state(path: Path) -> dict[str, Any] | None:
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
    except OSError as exc:
        raise MailboxError(f"读取状态失败: {path} ({exc})") from exc
    return last


def write_state(path: Path, state: dict[str, Any]) -> None:
    ensure_parent(path)
    state["updated_at"] = now_ts()
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def prune_state(state: dict[str, Any], now: int) -> None:
    messages = state.get("messages")
    if not isinstance(messages, dict):
        state["messages"] = {}
        return
    cutoff = now - STATE_RETENTION_DAYS * 24 * 3600
    for key, record in list(messages.items()):
        if not isinstance(record, dict):
            del messages[key]
            continue
        if record.get("status") == "temp":
            continue
        first_seen = as_int(record.get("first_seen_at"), now)
        if first_seen < cutoff:
            del messages[key]


# --------------------------------------------------------------------------- #
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
) -> str:
    lines = [f"[MAILBOX] {account} / {folder}: {len(new_items)} 封新信，{len(reminders)} 封待回"]
    if new_items:
        lines.append("新信:")
        for record in new_items:
            sid = record.get("identity") or "guest"
            suffix = "（来源未验证）" if record.get("source") in ("unverified", "warn", "unknown") else ""
            lines.append(
                f"- uid {record.get('uid')} | {sid}{suffix} | "
                f"{clip_text(record.get('from') or record.get('address') or '?', 64)} | "
                f"{clip_text(record.get('subject') or '(无主题)', 90)}"
            )
    if reminders:
        lines.append("待回（临时标记已超过提醒间隔）:")
        for record in reminders:
            lines.append(
                f"- uid {record.get('uid')} | {record.get('identity') or 'guest'} | "
                f"{clip_text(record.get('from') or record.get('address') or '?', 64)} | "
                f"{clip_text(record.get('subject') or '(无主题)', 90)}"
            )
    lines.extend(
        [
            "",
            "按 skill `watch-mailbox` 处理（read → reply/mark；reply 成功自动标记）。",
        ]
    )
    return clip_utf8("\n".join(lines), MAX_MESSAGE_BYTES)


def run_check(args: argparse.Namespace) -> int:
    cfg = settings(args)
    env = load_env(cfg["env_file"])
    account = env["MAIL_ADDRESS"].strip().lower()
    state_path = state_file_for(cfg["state_dir"], account)
    cfg["state_dir"].mkdir(parents=True, exist_ok=True)
    try:
        with file_lock(state_path.with_name(state_path.name + ".lock")):
            state = read_state(state_path) or new_state(account, cfg["folder"])
            if state.get("account") != account:
                raise MailboxError("状态文件属于其他邮箱账户")
            if state.get("folder") != cfg["folder"]:
                raise MailboxError("状态文件的文件夹与当前配置不一致")
            mailbox: Mailbox | None = Mailbox(env, cfg["folder"])
            try:
                mailbox = mailbox.connect()
                uidvalidity = mailbox.uidvalidity
                uids = mailbox.uids()
                uid_set = set(uids)
                if state.get("uidvalidity") not in (0, uidvalidity):
                    old = state_path.with_name(state_path.name + f".uidvalidity-{state.get('uidvalidity')}")
                    try:
                        os.replace(state_path, old)
                    except OSError:
                        pass
                    state = new_state(account, cfg["folder"], uidvalidity)
                    print(f"UIDVALIDITY changed; state archived to {old}", file=sys.stderr)
                state["uidvalidity"] = uidvalidity
                now = now_ts()
                rules = rules_for_account(cfg["allow_file"], account)

                if not state.get("initialized"):
                    state["last_seen_uid"] = 0 if args.notify_existing else max(uids, default=0)
                    state["initialized"] = True
                    write_state(state_path, state)
                    if not args.notify_existing:
                        print("mailbox baseline initialized; existing mail is not notified", file=sys.stderr)
                        checker_json(False)
                        return 0

                last_seen = as_int(state.get("last_seen_uid"), 0)
                new_uids = [uid for uid in uids if uid > last_seen]
                new_items: list[dict[str, Any]] = []
                for uid in new_uids:
                    record = classify(mailbox.header(uid), rules, now)
                    record["uid"] = uid
                    if record.get("status") == "temp":
                        new_items.append(record)
                    state["messages"][str(uid)] = record

                # Existing temporary marks: reminder after quiet period, or drop if gone.
                reminders: list[dict[str, Any]] = []
                remind_seconds = max(1, int(args.remind_minutes)) * 60
                for key, record in list(state["messages"].items()):
                    if record.get("status") != "temp":
                        continue
                    uid = as_int(record.get("uid"), as_int(key))
                    if uid not in uid_set:
                        del state["messages"][key]
                        continue
                    rule = match_rule(rules, str(record.get("address") or ""))
                    if not rule:
                        record["status"] = "ignored"
                        continue
                    last_notified = as_int(record.get("last_notified_at"), now)
                    if now - last_notified >= remind_seconds:
                        record["last_notified_at"] = now
                        reminders.append(record)

                state["last_seen_uid"] = max([last_seen, *(uids or [0])])
                prune_state(state, now)
                write_state(state_path, state)

                all_items = new_items + reminders
                omitted = 0
                max_notify = max(1, int(args.max_notify))
                if len(all_items) > max_notify:
                    omitted = len(all_items) - max_notify
                    all_items = all_items[:max_notify]
                if not all_items:
                    checker_json(False)
                    return 0
                message = notification_message(
                    account=account,
                    folder=cfg["folder"],
                    new_items=[item for item in all_items if item in new_items],
                    reminders=[item for item in all_items if item in reminders],
                )
                if omitted:
                    message += f"\n（另有 {omitted} 封未列出，运行 list --pending 查看）"
                checker_json(True, clip_utf8(message, MAX_MESSAGE_BYTES))
                return 0
            finally:
                if mailbox is not None:
                    mailbox.close()
    except Exception as exc:
        checker_json(False, error=str(exc) or exc.__class__.__name__)
        return 0


# --------------------------------------------------------------------------- #
# agent-facing commands
# --------------------------------------------------------------------------- #

def load_context(args: argparse.Namespace) -> tuple[dict[str, str], dict[str, Any], str]:
    cfg = settings(args)
    env = load_env(cfg["env_file"])
    return env, cfg, env["MAIL_ADDRESS"].strip().lower()


def cmd_status(args: argparse.Namespace) -> int:
    env, cfg, account = load_context(args)
    state_path = state_file_for(cfg["state_dir"], account)
    state = read_state(state_path)
    rules = rules_for_account(cfg["allow_file"], account)
    print(f"account: {account}")
    print(f"folder: {cfg['folder']}")
    print(f"env_file: {cfg['env_file']}")
    print(f"state_file: {state_path}")
    print(f"allow_file: {cfg['allow_file']}")
    if state is None:
        print("state: not initialized (run check or init)")
    else:
        messages = state.get("messages") or {}
        counts: dict[str, int] = {}
        for record in messages.values():
            counts[str(record.get("status"))] = counts.get(str(record.get("status")), 0) + 1
        print(f"uidvalidity: {state.get('uidvalidity')}")
        print(f"last_seen_uid: {state.get('last_seen_uid')}")
        print(f"messages: {len(messages)} total; " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if not rules:
        print("allowlist: 空（不会通知任何人）")
    else:
        print("allowlist:")
        for rule in rules:
            print(f"  {rule['address']} -> {rule['identity']}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    _env, cfg, account = load_context(args)
    state = read_state(state_file_for(cfg["state_dir"], account))
    if not state:
        print("没有状态；先运行 check 或 init")
        return 0
    records = [record for record in (state.get("messages") or {}).values() if isinstance(record, dict)]
    if args.pending:
        records = [record for record in records if record.get("status") == "temp"]
    records.sort(key=lambda record: as_int(record.get("uid")))
    if not records:
        print("没有待处理邮件" if args.pending else "没有记录")
        return 0
    for record in records[: args.limit]:
        print(
            f"uid {record.get('uid')} | {record.get('status')} | {record.get('identity')} | "
            f"{record.get('from')} | {record.get('subject')}"
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
        print(f"From: {decode_header_value(msg.get('From'))}")
        print(f"To: {decode_header_value(msg.get('To'))}")
        print(f"Date: {decode_header_value(msg.get('Date'))}")
        print(f"Subject: {decode_header_value(msg.get('Subject'))}")
        print(f"Message-ID: {msg.get('Message-ID') or ''}")
        print(f"Source: {level} | {verdict}")
        attachments = []
        for part in msg.walk():
            filename = part.get_filename()
            if filename:
                attachments.append((decode_header_value(filename), len(part.get_payload(decode=True) or b"")))
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
                    body = payload.decode(part.get_content_charset() or "utf-8", "replace")
                    break
        else:
            payload = msg.get_payload(decode=True) or b""
            body = payload.decode(msg.get_content_charset() or "utf-8", "replace")
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
    state_path = state_file_for(cfg["state_dir"], account)
    state = read_state(state_path)
    if not state:
        raise MailboxError("没有状态；先运行 check")
    record = (state.get("messages") or {}).get(str(args.uid))
    if not isinstance(record, dict):
        raise MailboxError(f"uid {args.uid} 不在状态里；先运行 list/check")
    identity = record.get("identity") or "guest"
    if identity == "guest" and args.attach:
        raise MailboxError("guest 邮件默认不允许在回复中带附件（严格策略）")
    mailbox = Mailbox(env, cfg["folder"]).connect()
    try:
        original = mailbox.full(int(args.uid))
    finally:
        mailbox.close()
    to_address = header_address(original.get("From"))
    if not to_address:
        raise MailboxError("原邮件没有有效 From 地址")
    subject = decode_header_value(original.get("Subject"))
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    message = EmailMessage()
    message["From"] = env["MAIL_ADDRESS"]
    message["To"] = to_address
    message["Subject"] = subject
    message_id = str(original.get("Message-ID") or "").strip()
    references = str(original.get("References") or "").strip()
    if message_id:
        message["In-Reply-To"] = message_id
        message["References"] = f"{references} {message_id}".strip()
    message.set_content(_compose_reply_body(args), charset="utf-8")
    add_attachments(message, args.attach)
    send_email(env, message)
    if not args.no_mark:
        with file_lock(state_path.with_name(state_path.name + ".lock")):
            latest = read_state(state_path) or state
            latest_record = (latest.get("messages") or {}).get(str(args.uid), record)
            if isinstance(latest_record, dict):
                latest_record["status"] = "acked"
                latest_record["acked_at"] = now_ts()
                latest.setdefault("messages", {})[str(args.uid)] = latest_record
                write_state(state_path, latest)
    print(f"已发送: {to_address} | {subject}" + ("" if args.no_mark else " | 已标记 uid " + str(args.uid)))
    return 0


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
    _env, cfg, account = load_context(args)
    state_path = state_file_for(cfg["state_dir"], account)
    if not args.uid:
        raise MailboxError("mark 必须显式指定 --uid")
    with file_lock(state_path.with_name(state_path.name + ".lock")):
        state = read_state(state_path)
        if not state:
            raise MailboxError("没有状态；先运行 check")
        now = now_ts()
        for raw_uid in args.uid:
            uid = as_int(raw_uid, -1)
            if uid <= 0:
                raise MailboxError(f"uid 不合法: {raw_uid!r}")
            record = (state.get("messages") or {}).get(str(uid))
            if not isinstance(record, dict):
                raise MailboxError(f"uid {uid} 不在状态里；先用 list/read 确认")
            record["status"] = "acked"
            record["acked_at"] = now
        write_state(state_path, state)
    print("已标记: " + ", ".join(str(uid) for uid in args.uid))
    return 0


def cmd_attach(args: argparse.Namespace) -> int:
    env, cfg, account = load_context(args)
    state = read_state(state_file_for(cfg["state_dir"], account))
    record = (state or {}).get("messages", {}).get(str(args.uid)) if state else None
    identity = (record or {}).get("identity", "guest")
    if identity == "guest" and not args.force:
        raise MailboxError("guest 邮件默认不允许下载附件（严格策略；需要时显式 --force）")
    mailbox = Mailbox(env, cfg["folder"]).connect()
    try:
        msg = mailbox.full(int(args.uid))
        outdir = Path(args.out).expanduser() if args.out else cfg["state_dir"] / "attachments"
        count = 0
        for part in msg.walk():
            filename = part.get_filename()
            if not filename:
                continue
            filename = decode_header_value(filename).replace("/", "_").replace("\\", "_")
            payload = part.get_payload(decode=True) or b""
            if args.list_only:
                print(f"附件: {filename} {len(payload)} bytes ({part.get_content_type()})")
            else:
                outdir.mkdir(parents=True, exist_ok=True)
                target = outdir / filename
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
            identity = (args.identity or "guest").strip().lower()
            if identity not in ("user", "guest"):
                raise MailboxError("identity 必须是 user 或 guest")
            rules[:] = [rule for rule in rules if rule["address"] != address]
            rules.append({"address": address, "identity": identity})
            save_allow_file(path, data)
            print(f"{account}: 已加入 {address} -> {identity}")
            if address == "*" and identity == "user":
                print("警告: 把所有发件人都标成 user 风险很高", file=sys.stderr)
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
    with file_lock(state_path.with_name(state_path.name + ".lock")):
        existing = read_state(state_path)
        if existing and existing.get("initialized") and not args.force:
            raise MailboxError("状态已初始化；确需重置请加 --force")
        mailbox = Mailbox(env, cfg["folder"]).connect()
        try:
            uids = mailbox.uids()
            uidvalidity = mailbox.uidvalidity
        finally:
            mailbox.close()
        state = new_state(account, cfg["folder"], uidvalidity)
        state["initialized"] = True
        state["last_seen_uid"] = 0 if args.notify_existing else max(uids, default=0)
        write_state(state_path, state)
    if args.notify_existing:
        print(f"已初始化 {state_path}；当前 {len(uids)} 封邮件将在下次 check 作为新信")
    else:
        print(f"已初始化 {state_path}；现有 {len(uids)} 封邮件已建立基线")
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

    reply = sub.add_parser("reply", help="reply to a known uid; success marks it acked")
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

    mark = sub.add_parser("mark", help="mark explicit uids acked")
    add_common(mark)
    mark.add_argument("--uid", action="append", required=True)
    mark.set_defaults(fn=cmd_mark)

    attach = sub.add_parser("attach", help="list/download attachments of one mail")
    add_common(attach)
    attach.add_argument("--uid", required=True)
    attach.add_argument("--out")
    attach.add_argument("--list-only", action="store_true")
    attach.add_argument("--force", action="store_true")
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
    allow.add_argument("--identity", choices=("user", "guest"))
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

"""只读类命令：status / list / read / attach。

这些命令不改变邮件状态；``read`` 不会标记已读，``attach`` 不写插件/状态目录
（默认写系统临时目录，``--out`` 写用户自己的目录）。
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Any

from ..allowlist import rules_for_account
from ..errors import MailboxError
from ..imap import Mailbox
from ..legacy import migrate_legacy_state
from ..model import STATUS_PENDING, source_label
from ..source import verify_source
from ..records import counts_by_status, count_sources, list_messages
from ..state import Scope, latest_uidvalidity, open_state, state_file_for
from ..text import (
    as_int,
    clip_utf8,
    decode_body_payload,
    decode_header_value,
    single_line,
)
from .common import load_account_context

_ATTACHMENT_NAME_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]+')
_ATTACHMENT_NAME_MAX_BYTES = 200


# --------------------------------------------------------------------------- #
# status / list
# --------------------------------------------------------------------------- #

def cmd_status(args: Any) -> int:
    _env, settings, account = load_account_context(args)
    state_path = state_file_for(settings.state_dir, account)
    db = open_state(state_path)
    try:
        migrate_legacy_state(db, settings.state_dir, account)
        latest = latest_uidvalidity(db, account, settings.folder)
        if latest is None:
            rows = []
            status_counts: dict[str, int] = {}
        else:
            scope = Scope(account=account, folder=settings.folder, uidvalidity=latest)
            rows = list_messages(db, account, folder=settings.folder, uidvalidity=latest)
            status_counts = counts_by_status(db, scope)
    finally:
        db.close()
    rules = rules_for_account(settings.allow_file, account)

    print(f"account: {account}")
    print(f"folder: {settings.folder}")
    print(f"env_file: {settings.env_file}")
    print(f"state_db: {state_path}")
    print(f"allow_file: {settings.allow_file}")
    if latest is None:
        print("state: not initialized (run check or init)")
    else:
        print(f"uidvalidity: {latest}")
        print(
            f"messages: {len(rows)} total; "
            + ", ".join(f"{key}={value}" for key, value in sorted(status_counts.items()))
        )
        sources = count_sources(rows)
        print(f"sources: OK={sources['OK']}, RISK={sources['RISK']}")
    if not rules:
        print("allowlist: 空（不会通知任何人）")
    else:
        print("allowlist:")
        for rule in rules:
            print(f"  {rule['address']} -> {rule['identity']}")
    return 0


def _clamp_limit(value: Any, default: int = 50) -> int:
    limit = as_int(value, default)
    return min(1000, max(1, limit))


def cmd_list(args: Any) -> int:
    _env, settings, account = load_account_context(args)
    db = open_state(state_file_for(settings.state_dir, account))
    try:
        migrate_legacy_state(db, settings.state_dir, account)
        latest = latest_uidvalidity(db, account, settings.folder)
        records = list_messages(
            db,
            account,
            folder=settings.folder,
            uidvalidity=latest,
            status=STATUS_PENDING if args.pending else None,
        )
    finally:
        db.close()
    if not records:
        print("没有待处理邮件" if args.pending else "没有记录")
        return 0
    limit = _clamp_limit(args.limit)
    for record in records[:limit]:
        print(
            f"uid {record.get('uid')} | {single_line(record.get('status'))} | "
            f"{source_label(record.get('source'))} | {single_line(record.get('identity'))} | "
            f"{single_line(record.get('from'))} | {single_line(record.get('subject'))}"
        )
    if len(records) > limit:
        print(f"... 还有 {len(records) - limit} 封")
    return 0


# --------------------------------------------------------------------------- #
# read
# --------------------------------------------------------------------------- #

def _extract_plain_body(msg: Any) -> str:
    """优先取非附件的 text/plain；没有则回退首个 text/plain / 单段正文。"""
    if msg.is_multipart():
        first_plain = None
        for part in msg.walk():
            if part.get_content_type() != "text/plain":
                continue
            if first_plain is None:
                first_plain = part
            # 附件（Content-Disposition: attachment）和带文件名的 part 都不当正文。
            if part.get_content_disposition() != "attachment" and not part.get_filename():
                return decode_body_payload(part.get_payload(decode=True) or b"", part.get_content_charset())
        if first_plain is not None:
            return decode_body_payload(
                first_plain.get_payload(decode=True) or b"",
                first_plain.get_content_charset(),
            )
        return ""
    return decode_body_payload(msg.get_payload(decode=True) or b"", msg.get_content_charset())


def _require_uid(raw: Any) -> int:
    uid = as_int(raw, 0)
    if uid <= 0:
        raise MailboxError(f"uid 不合法: {raw!r}")
    return uid


def cmd_read(args: Any) -> int:
    env, settings, _account = load_account_context(args)
    uid = _require_uid(args.uid)
    mailbox = Mailbox(env, settings.folder)
    try:
        mailbox = mailbox.connect()
        msg = mailbox.full(uid)
        level, verdict = verify_source(msg)
        print(f"From: {single_line(decode_header_value(msg.get('From')))}")
        print(f"To: {single_line(decode_header_value(msg.get('To')))}")
        print(f"Date: {single_line(decode_header_value(msg.get('Date')))}")
        print(f"Subject: {single_line(decode_header_value(msg.get('Subject')))}")
        print(f"Message-ID: {single_line(msg.get('Message-ID'))}")
        print(f"Source: {source_label(level)} | {single_line(verdict)}")
        attachments = []
        for part in msg.walk():
            filename = part.get_filename()
            if filename:
                attachments.append(
                    (
                        single_line(decode_header_value(filename)),
                        len(part.get_payload(decode=True) or b""),
                    )
                )
        if attachments:
            print("Attachments:")
            for name, size in attachments:
                print(f"  - {name} ({size} bytes)")
        print("")
        # 按 UTF-8 字节裁剪，避免 CJK 正文把 64K 字符放大成 ~192KB 输出。
        print(clip_utf8(_extract_plain_body(msg), 64 * 1024))
        return 0
    finally:
        mailbox.close()


# --------------------------------------------------------------------------- #
# attach
# --------------------------------------------------------------------------- #

def _clip_attachment_name_bytes(name: str, max_bytes: int = _ATTACHMENT_NAME_MAX_BYTES) -> str:
    """按 UTF-8 字节预算截断文件名（保留扩展名），避免 ext4 NAME_MAX=255 报错。"""
    if len(name.encode("utf-8")) <= max_bytes:
        return name
    suffix = Path(name).suffix
    if len(suffix.encode("utf-8")) > 32:
        suffix = ""
    stem = name[: len(name) - len(suffix)]
    budget = max(1, max_bytes - len(suffix.encode("utf-8")))
    clipped = stem.encode("utf-8")[:budget].decode("utf-8", "ignore")
    return (clipped + suffix) or "attachment"


def _safe_attachment_name(raw: Any) -> str:
    """单行化 + 去路径分隔符/Windows 非法字符 + 按 UTF-8 字节限长，不越出 outdir。"""
    name = single_line(decode_header_value(raw)).strip()
    name = _ATTACHMENT_NAME_UNSAFE.sub("_", name).strip()
    if name in ("", ".", ".."):
        return "attachment"
    return _clip_attachment_name_bytes(name) or "attachment"


def _collision_path(outdir: Path, filename: str) -> Path:
    """在 outdir 内选一个不存在的目标名；悬空符号链接也视为已占用（不跟随写入）。"""
    target = outdir / filename
    index = 2
    while target.exists() or target.is_symlink():
        candidate = f"{Path(filename).stem} ({index}){Path(filename).suffix}"
        target = outdir / _clip_attachment_name_bytes(candidate)
        index += 1
    return target


def cmd_attach(args: Any) -> int:
    env, settings, _account = load_account_context(args)
    # 附件是否允许下载由 skill/约定决定；--force 是兼容参数，无代码行为。
    mailbox = Mailbox(env, settings.folder)
    try:
        mailbox = mailbox.connect()
        msg = mailbox.full(_require_uid(args.uid))
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
            filename = _safe_attachment_name(filename)
            payload = part.get_payload(decode=True) or b""
            if args.list_only:
                print(f"附件: {filename} {len(payload)} bytes ({part.get_content_type()})")
            else:
                assert outdir is not None  # --list-only 之外 outdir 必然存在
                outdir.mkdir(parents=True, exist_ok=True)
                target = _collision_path(outdir, filename)
                target.write_bytes(payload)
                print(f"落盘: {target} ({len(payload)} bytes)")
            count += 1
        print(f"共 {count} 个附件" + ("（仅列出）" if args.list_only else f"，输出目录 {outdir}"))
        return 0
    finally:
        mailbox.close()


__all__ = ["cmd_status", "cmd_list", "cmd_read", "cmd_attach"]

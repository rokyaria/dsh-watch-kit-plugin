"""会改变状态/对外发送的命令：reply / send / mark。

- ``reply``：只回复当前 scope 里状态为 ``pending`` 的 UID；发送成功自动标 ``replied``
  （``--no-mark`` 可关闭）。发送成功后即使状态更新失败也只提示，不假装成功。
- ``send``：主动发新邮件；默认策略在 skill 里，代码只提供能力。
- ``mark``：把显式 UID 标为 ``no_receipt``；先整体校验再一个事务写入（全有或全无）。
"""

from __future__ import annotations

import sys
from email.message import EmailMessage
from typing import Any

from ..errors import MailboxError
from ..imap import Mailbox
from ..legacy import migrate_legacy_state
from ..model import STATUS_NO_RECEIPT, STATUS_PENDING, STATUS_REPLIED
from ..smtp import add_attachments, read_body_arg, send_email
from ..records import get_message, update_status, update_statuses
from ..state import Scope, open_state, state_file_for
from ..text import as_int, decode_header_value, header_address, now_ts, single_line
from .common import load_account_context


def _reply_subject(original: Any) -> str:
    subject = single_line(decode_header_value(original.get("Subject")))
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    return subject


def _thread_headers(message: EmailMessage, original: Any) -> None:
    """用原邮件 Message-ID / References 建线程；所有头先单行化，避免 email 库拒绝。"""
    message_id = single_line(original.get("Message-ID"))
    references = single_line(original.get("References"))
    if message_id:
        message["In-Reply-To"] = message_id
        message["References"] = f"{references} {message_id}".strip()


def cmd_reply(args: Any) -> int:
    env, settings, account = load_account_context(args)
    uid = as_int(args.uid, 0)
    if uid <= 0:
        raise MailboxError(f"uid 不合法: {args.uid!r}")
    state_path = state_file_for(settings.state_dir, account)
    mailbox = Mailbox(env, settings.folder)
    db = None
    try:
        mailbox = mailbox.connect()
        scope = Scope(account=account, folder=settings.folder, uidvalidity=mailbox.uidvalidity)
        db = open_state(state_path)
        migrate_legacy_state(db, settings.state_dir, account)
        record = get_message(db, scope, uid)
        if record is None:
            raise MailboxError(f"uid {uid} 不在当前 folder/UIDVALIDITY 的状态里；先运行 check（不会发送）")
        if record.get("status") != STATUS_PENDING:
            raise MailboxError(f"uid {uid} 状态为 {record.get('status')}，不是 pending；不会重复发送")

        original = mailbox.full(uid)
        to_address = header_address(original.get("From"))
        if not to_address:
            raise MailboxError("原邮件没有有效 From 地址")
        # 原邮件头可能含折行或 encoded-word 解出的裸 CR/LF；EmailMessage 会因此抛
        # ValueError，所以所有单值头赋值前统一单行化。
        subject = _reply_subject(original)
        message = EmailMessage()
        message["From"] = env["MAIL_ADDRESS"]
        message["To"] = to_address
        message["Subject"] = subject
        _thread_headers(message, original)
        message.set_content(read_body_arg(args.body, args.body_file, label="回复正文"), charset="utf-8")
        add_attachments(message, args.attach)
        send_email(env, message)

        marked = False
        if not args.no_mark:
            updated = False
            update_error: Exception | None = None
            try:
                updated = update_status(db, scope, uid, STATUS_REPLIED, now_ts())
            except Exception as exc:  # noqa: BLE001 - 已在 DB/网络边界，失败只提示
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


def cmd_send(args: Any) -> int:
    env, _settings, _account = load_account_context(args)
    body = read_body_arg(args.body, args.body_file, label="正文")
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
    message.set_content(body)
    add_attachments(message, args.attach)
    send_email(env, message)
    print(f"已发送: {args.to} | {args.subject}")
    return 0


def _parse_mark_uids(raw_uids: list[str]) -> list[int]:
    uids: list[int] = []
    for raw in raw_uids:
        uid = as_int(raw, -1)
        if uid <= 0:
            raise MailboxError(f"uid 不合法: {raw!r}")
        if uid not in uids:
            uids.append(uid)
    return uids


def cmd_mark(args: Any) -> int:
    env, settings, account = load_account_context(args)
    if not args.uid:
        raise MailboxError("mark 必须显式指定 --uid")
    uids = _parse_mark_uids(args.uid)
    state_path = state_file_for(settings.state_dir, account)
    mailbox = Mailbox(env, settings.folder)
    db = None
    try:
        mailbox = mailbox.connect()
        scope = Scope(account=account, folder=settings.folder, uidvalidity=mailbox.uidvalidity)
        db = open_state(state_path)
        migrate_legacy_state(db, settings.state_dir, account)
        # 先整体校验：任一 UID 不存在或状态不允许，就零写入并报错。
        to_mark: list[int] = []
        for uid in uids:
            record = get_message(db, scope, uid)
            if record is None:
                raise MailboxError(f"uid {uid} 不在当前 folder/UIDVALIDITY 的状态里；先用 list/read 确认")
            status = record.get("status")
            if status == STATUS_PENDING:
                to_mark.append(uid)
            elif status != STATUS_NO_RECEIPT:
                raise MailboxError(f"uid {uid} 状态为 {status}，不能标记无需回执")
        if to_mark:
            updated = update_statuses(db, scope, to_mark, STATUS_NO_RECEIPT, now_ts())
            if updated != len(to_mark):
                # 单实例假设下不应发生；若行被并发删除/触发器忽略，明确告知而不是假装成功。
                print(f"警告: 仅 {updated}/{len(to_mark)} 行更新为 no_receipt", file=sys.stderr)
        print("已标记无需回执: " + ", ".join(str(uid) for uid in uids))
        return 0
    finally:
        if db is not None:
            db.close()
        mailbox.close()

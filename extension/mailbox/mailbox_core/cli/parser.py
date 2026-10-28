"""argparse 定义：所有子命令与参数集中在 build_parser()。

对外契约（v0.3.x）：check/list/read/reply/send/mark/attach/status/allow/init/selfcheck。
v0.3.1 新增 ``check --max-error-bytes``（由插件 preset 传入），其余参数保持兼容。
"""

from __future__ import annotations

import argparse

import argparse as _argparse

from ..config import (
    DEFAULT_MAX_ERROR_BYTES,
    DEFAULT_MAX_MESSAGE_BYTES,
    DEFAULT_MAX_NOTIFY,
    DEFAULT_REMIND_MINUTES,
    MAX_NEW_FETCH_PER_RUN,
)
from .admin import cmd_allow, cmd_init, cmd_selfcheck
from .check import cmd_check
from .common import add_common_arguments
from .compose import cmd_mark, cmd_reply, cmd_send
from .inbox import cmd_attach, cmd_list, cmd_read, cmd_status


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="mailbox checker and CLI for dsh-watch-kit-plugin")
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check", help="checker mode: print one JSON object")
    add_common_arguments(check)
    check.add_argument("--remind-minutes", type=int, default=DEFAULT_REMIND_MINUTES)
    check.add_argument("--max-notify", type=int, default=DEFAULT_MAX_NOTIFY)
    check.add_argument(
        "--max-message-bytes",
        type=int,
        default=DEFAULT_MAX_MESSAGE_BYTES,
        help="checker notification message byte cap (from plugin limits)",
    )
    check.add_argument(
        "--max-error-bytes",
        type=int,
        default=DEFAULT_MAX_ERROR_BYTES,
        help="checker error byte cap (from plugin limits)",
    )
    check.add_argument(
        "--max-new-fetch",
        type=int,
        default=MAX_NEW_FETCH_PER_RUN,
        help=_argparse.SUPPRESS,
    )
    check.add_argument("--notify-existing", action="store_true", help="first run: notify current mailbox")
    check.add_argument("--json", action="store_true", help="accepted for clarity; check always prints JSON")
    check.set_defaults(fn=cmd_check)

    listing = sub.add_parser("list", help="list state records")
    add_common_arguments(listing)
    listing.add_argument("--pending", action="store_true")
    listing.add_argument("--limit", type=int, default=50)
    listing.set_defaults(fn=cmd_list)

    read = sub.add_parser("read", help="read one mail without marking it")
    add_common_arguments(read)
    read.add_argument("--uid", required=True)
    read.set_defaults(fn=cmd_read)

    reply = sub.add_parser("reply", help="reply to a known uid; success marks it replied")
    add_common_arguments(reply)
    reply.add_argument("--uid", required=True)
    reply.add_argument("--body")
    reply.add_argument("--body-file")
    reply.add_argument("--attach", action="append")
    reply.add_argument("--no-mark", action="store_true")
    reply.set_defaults(fn=cmd_reply)

    send = sub.add_parser("send", help="send a new mail")
    add_common_arguments(send)
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
    add_common_arguments(mark)
    mark.add_argument("--uid", action="append", required=True)
    mark.set_defaults(fn=cmd_mark)

    attach = sub.add_parser("attach", help="list/download attachments of one mail")
    add_common_arguments(attach)
    attach.add_argument("--uid", required=True)
    attach.add_argument("--out", help="附件输出目录（默认系统临时目录；需保留时指定用户自己的目录）")
    attach.add_argument("--list-only", action="store_true")
    attach.add_argument("--force", action="store_true", help="兼容参数（策略在 skill，无代码门禁）")
    attach.set_defaults(fn=cmd_attach)

    status = sub.add_parser("status", help="show account/state/allowlist status")
    add_common_arguments(status)
    status.set_defaults(fn=cmd_status)

    allow = sub.add_parser("allow", help="inspect/edit the per-account allowlist")
    add_common_arguments(allow)
    allow.add_argument("--mailbox", help="account key to edit (default current MAIL_ADDRESS)")
    allow_actions = allow.add_mutually_exclusive_group(required=True)
    allow_actions.add_argument("--list", action="store_true")
    allow_actions.add_argument("--add-allow-account")
    allow_actions.add_argument("--remove-allow-account")
    allow.add_argument("--identity", help="任意身份标签（如 user / guest / 自定义），默认 guest")
    allow.set_defaults(fn=cmd_allow)

    init = sub.add_parser("init", help="initialize state baseline")
    add_common_arguments(init)
    init.add_argument("--notify-existing", action="store_true")
    init.add_argument("--force", action="store_true")
    init.set_defaults(fn=cmd_init)

    selfcheck = sub.add_parser("selfcheck", help="SMTP/IMAP connectivity check")
    add_common_arguments(selfcheck)
    selfcheck.set_defaults(fn=cmd_selfcheck)

    return parser

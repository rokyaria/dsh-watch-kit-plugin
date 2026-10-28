"""管理类命令：allow / init / selfcheck。"""

from __future__ import annotations

import smtplib
from typing import Any

from ..allowlist import (
    add_rule,
    normalize_address,
    remove_rule,
    rules_for_account,
    validate_address,
)
from ..config import load_env, resolve_settings
from ..errors import MailboxError
from ..imap import Mailbox, ssl_context
from ..legacy import migrate_legacy_state
from ..model import DEFAULT_IDENTITY, STATUS_IGNORED, SOURCE_RISK
from ..records import insert_message, scope_has_messages
from ..state import (
    Scope,
    find_scope,
    open_state,
    reset_scope,
    secure_state_dir,
    state_file_for,
    state_transaction,
)
from ..text import as_int, now_ts
from .common import load_account_context


def cmd_allow(args: Any) -> int:
    settings = resolve_settings(args)
    env = load_env(settings.env_file)
    account = (args.mailbox or env["MAIL_ADDRESS"]).strip().lower()
    path = settings.allow_file
    # 默认 allowlist 在 stateDir 下：显式收紧目录权限（allow 可能先于 check 运行）。
    if path == settings.state_dir / "allow-accounts.json":
        secure_state_dir(settings.state_dir)

    adding = args.add_allow_account is not None
    removing = args.remove_allow_account is not None
    # --identity 只对 add 有意义；list/remove 携带它属于参数误用，直接报错。
    if args.identity and not adding:
        raise MailboxError("--identity 只能与 --add-allow-account 一起使用")
    if args.list:
        rules = rules_for_account(path, account)
        if not rules:
            print(f"{account}: 没有允许账号（不会通知）")
        else:
            for rule in rules:
                print(f"{rule['address']} -> {rule['identity']}")
        return 0
    if adding:
        rule = add_rule(path, account, args.add_allow_account or "", args.identity)
        print(f"{account}: 已加入 {rule['address']} -> {rule['identity']}")
        return 0
    if not removing:
        raise MailboxError("allow 需要 --list / --add-allow-account / --remove-allow-account 之一")
    address = normalize_address(args.remove_allow_account)
    validate_address(address)
    removed = remove_rule(path, account, address)
    print(f"{account}: 已移除 {address}（{removed} 条）")
    return 0


def cmd_init(args: Any) -> int:
    env, settings, account = load_account_context(args)
    state_path = state_file_for(settings.state_dir, account)
    mailbox = Mailbox(env, settings.folder)
    db = None
    try:
        mailbox = mailbox.connect()
        uids = mailbox.uids()
        scope = Scope(account=account, folder=settings.folder, uidvalidity=mailbox.uidvalidity)
        db = open_state(state_path)
        migrate_legacy_state(db, settings.state_dir, account)
        scope_row = find_scope(db, scope)
        has_messages = scope_has_messages(db, scope)
        if (has_messages or (scope_row is not None and as_int(scope_row["baseline_done"]) == 1)) and not args.force:
            raise MailboxError("状态已初始化；确需重置请加 --force")
        now = now_ts()
        with state_transaction(db):
            reset_scope(db, scope, now)
            if not args.notify_existing:
                for uid in uids:
                    insert_message(
                        db,
                        scope,
                        {
                            "uid": uid,
                            "first_seen_at": now,
                            "status": STATUS_IGNORED,
                            "source": SOURCE_RISK,
                            "identity": DEFAULT_IDENTITY,
                        },
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


def cmd_selfcheck(args: Any) -> int:
    env, settings, _account = load_account_context(args)
    with smtplib.SMTP_SSL(
        env["SMTP_HOST"],
        int(env["SMTP_PORT"]),
        context=ssl_context(),
        timeout=30,
    ) as smtp:
        smtp.login(env["MAIL_ADDRESS"], env["MAIL_AUTHCODE"])
        print(f"SMTP OK {env['SMTP_HOST']}:{env['SMTP_PORT']} as {env['MAIL_ADDRESS']}")
    mailbox = Mailbox(env, settings.folder)
    try:
        mailbox = mailbox.connect()
        print(
            f"IMAP OK {env['IMAP_HOST']}:{env['IMAP_PORT']} "
            f"folder={settings.folder} uidvalidity={mailbox.uidvalidity}"
        )
    finally:
        mailbox.close()
    return 0

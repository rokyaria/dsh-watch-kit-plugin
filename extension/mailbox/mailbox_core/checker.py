"""checker 模式：执行一轮邮箱检查，只向 stdout 输出插件 JSON 契约。

一轮的固定顺序：
1. 连接 IMAP（只读）→ SEARCH 全部 UID；**SEARCH 失败不修改任何状态**；
2. 打开 SQLite 状态库（必要时迁移旧 JSONL）→ prune 31 天前的状态行；
3. 首次运行建立基线（当前邮件标 ignored，不通知）；``--notify-existing`` 则把
   当前邮件当新信；
4. 对“数据库里没有”的 UID 拉邮件头 → 分类 → 落库（单轮 FETCH 上限 200，剩余
   下轮继续；FETCH 临时失败不落库、下轮重试；解析失败落 ``invalid``）；
5. 找出 ``pending`` 且到提醒周期（或从未通知过）的邮件 → 取前 ``--max-notify`` 条；
6. 输出一条 ``{"notify":true,...}`` 或 ``{"notify":false,...}``。

所有人类可读日志走 stderr；stdout 只由 :func:`mailbox_core.notify.checker_json`
输出。异常一律转成 ``{"notify":false,"error":...}``（error 截断到插件上限，
避免插件侧判成 ``invalid_fields``）。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any

from . import notify
from .allowlist import match_rule, rules_for_account
from .classify import classify, date_age_days
from .config import (
    DEFAULT_MAX_ERROR_BYTES,
    DEFAULT_MAX_MESSAGE_BYTES,
    DEFAULT_MAX_NOTIFY,
    DEFAULT_REMIND_MINUTES,
    MAX_NEW_FETCH_PER_RUN,
    MAX_NOTIFY_UPPER,
    MAX_PROCESS_AGE_DAYS,
    Settings,
    load_env,
    resolve_settings,
)
from .imap import Mailbox
from .legacy import migrate_legacy_state
from .model import DEFAULT_IDENTITY, STATUS_IGNORED, STATUS_INVALID, STATUS_PENDING, SOURCE_RISK
from .records import (
    insert_messages,
    known_uids,
    list_messages,
    mark_missing_gone,
    prune,
    seed_baseline,
    touch_notified,
    update_status,
)
from .state import (
    Scope,
    ensure_scope,
    mark_scope_baseline_done,
    open_state,
    state_file_for,
    touch_scope,
)
from .text import as_int, clip_utf8, now_ts

MAX_FETCH_PER_RUN = MAX_NEW_FETCH_PER_RUN


@dataclass(frozen=True)
class CheckLimits:
    max_message_bytes: int
    max_error_bytes: int
    max_notify: int
    remind_seconds: int
    notify_existing: bool
    max_fetch: int = MAX_NEW_FETCH_PER_RUN


@dataclass
class NewFetch:
    """一轮新邮件处理结果（用于拼接 error 附注与区分新信/待处理）。"""

    added_uids: set[int] = field(default_factory=set)
    fetch_errors: list[int] = field(default_factory=list)
    invalid_uids: list[int] = field(default_factory=list)
    skipped_old: list[int] = field(default_factory=list)


MAX_CHECKER_BYTES = 4 * 1024 * 1024
MAX_REMIND_MINUTES = 365 * 24 * 60


def _clamp_int(value: Any, low: int, high: int, fallback: int) -> int:
    """显式数字 clamp 到 [low, high]；None/非数字才用 fallback。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _checker_limits(args: Any) -> CheckLimits:
    max_message_bytes = _clamp_int(
        getattr(args, "max_message_bytes", None), 256, MAX_CHECKER_BYTES, DEFAULT_MAX_MESSAGE_BYTES
    )
    max_error_bytes = _clamp_int(
        getattr(args, "max_error_bytes", None), 64, MAX_CHECKER_BYTES, DEFAULT_MAX_ERROR_BYTES
    )
    max_notify = _clamp_int(getattr(args, "max_notify", None), 1, MAX_NOTIFY_UPPER, DEFAULT_MAX_NOTIFY)
    remind_minutes = _clamp_int(getattr(args, "remind_minutes", None), 1, MAX_REMIND_MINUTES, DEFAULT_REMIND_MINUTES)
    max_fetch = _clamp_int(
        getattr(args, "max_new_fetch", None), 1, 10000, MAX_NEW_FETCH_PER_RUN
    )
    return CheckLimits(
        max_message_bytes=max_message_bytes,
        max_error_bytes=max_error_bytes,
        max_notify=max_notify,
        remind_seconds=remind_minutes * 60,
        notify_existing=bool(getattr(args, "notify_existing", False)),
        max_fetch=max_fetch,
    )


def run_check(args: Any) -> int:
    """checker 模式入口；永远返回 0（语义都在 JSON 里）。"""
    limits = _checker_limits(args)
    try:
        _run(args, limits)
    except Exception as exc:  # noqa: BLE001 - checker 必须把一切失败转成 JSON
        message = str(exc) or exc.__class__.__name__
        notify.checker_json(False, error=clip_utf8(message, limits.max_error_bytes))
    return 0


def _run(args: Any, limits: CheckLimits) -> None:
    settings = resolve_settings(args)
    env = load_env(settings.env_file)
    account = env["MAIL_ADDRESS"].strip().lower()
    state_path = state_file_for(settings.state_dir, account)

    mailbox = Mailbox(env, settings.folder)
    try:
        mailbox = mailbox.connect()
        uids = mailbox.uids()
        now = now_ts()
        db = open_state(state_path)
        try:
            migrate_legacy_state(db, settings.state_dir, account)
            _check_once(db, mailbox, settings, account, uids, now, limits)
        finally:
            db.close()
    finally:
        mailbox.close()


def _check_once(
    db: Any,
    mailbox: Mailbox,
    settings: Settings,
    account: str,
    uids: list[int],
    now: int,
    limits: CheckLimits,
) -> None:
    scope = Scope(account=account, folder=settings.folder, uidvalidity=mailbox.uidvalidity)
    scope_row = ensure_scope(db, scope, now)
    touch_scope(db, scope, now)
    rules = rules_for_account(settings.allow_file, account)
    # 只保留 31 天内的行；超过 30 天的邮件不再处理（见新信/pending 的日期过滤）。
    prune(db, now)

    if not scope_row["baseline_done"]:
        if not limits.notify_existing:
            seed_baseline(db, scope, uids, now)
            print("mailbox baseline initialized; existing mail is not notified", file=sys.stderr)
            notify.checker_json(False)
            return
        mark_scope_baseline_done(db, scope, now)
        new_uids = set(uids)
    else:
        known = known_uids(db, scope)
        new_uids = {uid for uid in uids if uid not in known}

    fetched = _fetch_new_records(db, mailbox, scope, rules, new_uids, now, limits)
    mark_missing_gone(db, scope, set(uids))

    pending = list_messages(
        db,
        account,
        folder=settings.folder,
        uidvalidity=scope.uidvalidity,
        status=STATUS_PENDING,
    )
    due = _due_reminders(db, scope, pending, rules, limits, now)
    selected = due[: limits.max_notify]
    omitted = len(due) - len(selected)
    touch_notified(db, scope, [as_int(record.get("uid")) for record in selected], now)

    note = _checker_note(fetched)
    if note is not None:
        # 附注同样要受插件 maxErrorBytes 约束：超过上限会被 JS 判成 invalid_fields，
        # 在 notify=true 分支会丢掉本轮已经 touch_notified 的通知。
        note = clip_utf8(note, limits.max_error_bytes)
    if fetched.skipped_old:
        print(f"mailbox: 跳过 {len(fetched.skipped_old)} 封超过 30 天的旧邮件", file=sys.stderr)
    if not selected:
        notify.checker_json(False, error=note)
        return

    # “新信”= 从未通知过（last_notified_at IS NULL）；“待处理”= 之前已通知过、仍未标记。
    # 不能按“本轮是否新插入”划分：达到 max-notify / FETCH 上限被截断时，上一轮
    # 已入库但从未通知的邮件会到下一轮，若按新插入划分会被误标为“已通知过”。
    new_items = [record for record in selected if record.get("last_notified_at") is None]
    reminders = [record for record in selected if record.get("last_notified_at") is not None]
    message = notify.notification_message(
        account=account,
        folder=settings.folder,
        new_items=new_items,
        reminders=reminders,
        max_bytes=limits.max_message_bytes,
    )
    if omitted:
        message += notify.omitted_note(omitted)
    notify.checker_json(True, clip_utf8(message, limits.max_message_bytes), error=note)


def _fetch_new_records(
    db: Any,
    mailbox: Mailbox,
    scope: Scope,
    rules: list[dict[str, str]],
    new_uids: set[int],
    now: int,
    limits: CheckLimits,
) -> NewFetch:
    """拉取并落库新邮件头；单轮最多 limits.max_fetch 个 UID。"""
    result = NewFetch()
    ordered = sorted(new_uids)
    max_fetch = max(1, limits.max_fetch)
    # 尝试预算：FETCH 失败不占“成功处理”配额，但要给失败留有限余量，避免前 N 个
    # 持续失败的 UID 每轮占满窗口、把后面的新邮件永久饿死。
    attempt_budget = max_fetch + max(2, max_fetch // 4)
    candidates = ordered[:attempt_budget]

    records: list[dict[str, Any]] = []
    processed = 0
    for uid in candidates:
        if processed >= max_fetch:
            break
        try:
            message = mailbox.header(uid)
        except Exception as exc:  # noqa: BLE001 - 单封失败不阻塞其余新信
            # 读取失败不落库：该 UID 下一轮仍是“新邮件”，会重试。
            result.fetch_errors.append(uid)
            print(
                f"mailbox: 读取邮件失败 uid={uid}，保留待重试: {exc.__class__.__name__}: {exc}",
                file=sys.stderr,
            )
            continue
        processed += 1
        try:
            record = classify(message, rules, now)
        except Exception as exc:  # noqa: BLE001 - 单封解析失败落 invalid
            record = {
                "uid": uid,
                "first_seen_at": now,
                "status": STATUS_INVALID,
                "source": SOURCE_RISK,
                "identity": DEFAULT_IDENTITY,
                "last_error": f"{exc.__class__.__name__}: {exc}",
            }
            result.invalid_uids.append(uid)
        record["uid"] = uid
        if record.get("status") != STATUS_INVALID:
            age_days = date_age_days(record.get("date"), now)
            if age_days is not None and age_days > MAX_PROCESS_AGE_DAYS:
                record.update(status=STATUS_IGNORED, last_error="邮件 Date 超过 30 天，跳过处理")
                result.skipped_old.append(uid)
        records.append(record)

    if records:
        insert_messages(db, scope, records)
        result.added_uids = {as_int(record.get("uid")) for record in records}
    remaining = max(0, len(ordered) - processed)
    if remaining > 0 and processed >= max_fetch:
        print(
            f"mailbox: 本轮最多处理 {max_fetch} 封新邮件，"
            f"剩余 {remaining} 封下轮继续",
            file=sys.stderr,
        )
    return result


def _due_reminders(
    db: Any,
    scope: Scope,
    pending: list[dict[str, Any]],
    rules: list[dict[str, str]],
    limits: CheckLimits,
    now: int,
) -> list[dict[str, Any]]:
    """过滤 pending：过期/被移出 allowlist 的直接改状态；其余按提醒周期挑 due。"""
    due: list[dict[str, Any]] = []
    for record in pending:
        uid = as_int(record.get("uid"))
        age_days = date_age_days(record.get("date"), now)
        if age_days is not None and age_days > MAX_PROCESS_AGE_DAYS:
            update_status(db, scope, uid, STATUS_IGNORED, now, "邮件 Date 超过 30 天，跳过处理")
            continue
        # allowlist 可能在邮件到达后被收紧；不再匹配的 pending 直接转 ignored。
        if not match_rule(rules, str(record.get("from_addr") or "")):
            update_status(db, scope, uid, STATUS_IGNORED, now)
            continue
        last_notified = record.get("last_notified_at")
        if last_notified is None or now - as_int(last_notified, now) >= limits.remind_seconds:
            due.append(record)
    due.sort(key=lambda record: as_int(record.get("uid")))
    return due


def _checker_note(fetched: NewFetch) -> str | None:
    """把可恢复的单封失败写进 checker error 附注（不影响通知投递）。"""
    notes: list[str] = []
    if fetched.fetch_errors:
        notes.append(f"新邮件读取失败 {len(fetched.fetch_errors)} 封，已保留待下轮重试")
    if fetched.invalid_uids:
        notes.append(f"新邮件解析失败 {len(fetched.invalid_uids)} 封，已标记 invalid")
    return "；".join(notes) or None

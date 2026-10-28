"""邮件状态记录读写（messages 表）与聚合。

只做本地 SQLite 操作；所有函数接收已打开的连接，事务边界由调用方通过
:func:`mailbox_core.state.state_transaction` 或本模块提供的批量函数控制。
网络请求期间绝不调用这里。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from .config import STATE_RETENTION_DAYS
from .errors import MailboxError
from .model import (
    DEFAULT_IDENTITY,
    STATE_STATUSES,
    STATUS_GONE,
    STATUS_IGNORED,
    STATUS_NO_RECEIPT,
    STATUS_PENDING,
    STATUS_REPLIED,
    normalize_source,
    normalize_status,
    source_label,
)
from .state import Scope, _scope_params, state_transaction
from .text import as_int, now_ts

_INSERT_MESSAGE_SQL = """
INSERT OR IGNORE INTO messages
  (account, folder, uidvalidity, uid, first_seen_at, status, last_notified_at,
   replied_at, no_receipt_at, from_addr, from_display, subject, message_id, date,
   identity, source, last_error)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def _row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["from"] = value.get("from_display") or value.get("from_addr") or ""
    return value


def _record_values(scope: Scope, record: dict[str, Any]) -> tuple[Any, ...]:
    uid = as_int(record.get("uid"), 0)
    if uid <= 0:
        raise MailboxError("邮件记录缺少有效 uid")
    status = normalize_status(record.get("status"))
    first_seen = as_int(record.get("first_seen_at"), now_ts())
    last_notified = record.get("last_notified_at")
    replied = record.get("replied_at")
    no_receipt = record.get("no_receipt_at")
    if status == STATUS_REPLIED and replied is None:
        replied = first_seen
    if status == STATUS_NO_RECEIPT and no_receipt is None:
        no_receipt = first_seen
    return (
        scope.account,
        scope.folder,
        scope.uidvalidity,
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
        str(record.get("identity") or DEFAULT_IDENTITY),
        normalize_source(record.get("source")),
        str(record.get("last_error") or "") or None,
    )


# --------------------------------------------------------------------------- #
# 写入
# --------------------------------------------------------------------------- #

def insert_message(db: sqlite3.Connection, scope: Scope, record: dict[str, Any]) -> None:
    """插入一行（INSERT OR IGNORE；调用方决定事务）。"""
    db.execute(_INSERT_MESSAGE_SQL, _record_values(scope, record))


def insert_messages(db: sqlite3.Connection, scope: Scope, records: list[dict[str, Any]]) -> None:
    if not records:
        return
    with state_transaction(db):
        for record in records:
            insert_message(db, scope, record)


def seed_baseline(
    db: sqlite3.Connection,
    scope: Scope,
    uids: list[int],
    now: int,
    *,
    notify_existing: bool = False,
) -> None:
    """首次运行：把现有 UID 写成基线（默认 ignored；notify_existing 时 pending）。"""
    status = STATUS_PENDING if notify_existing else STATUS_IGNORED
    with state_transaction(db):
        for uid in uids:
            insert_message(
                db,
                scope,
                {
                    "uid": uid,
                    "first_seen_at": now,
                    "status": status,
                    "source": "risk",
                    "identity": DEFAULT_IDENTITY,
                },
            )
        db.execute(
            "UPDATE scopes SET baseline_done = 1, updated_at = ? "
            "WHERE account = ? AND folder = ? AND uidvalidity = ?",
            (now, *_scope_params(scope)),
        )


def _update_status_sql(status: str, error: str | None, at: int, scope: Scope, uid: int) -> tuple[str, tuple[Any, ...]]:
    return (
        """UPDATE messages SET status = ?, last_error = ?,
           replied_at = CASE WHEN ? = 'replied' THEN ? ELSE replied_at END,
           no_receipt_at = CASE WHEN ? = 'no_receipt' THEN ? ELSE no_receipt_at END
           WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid = ?""",
        (status, error, status, at, status, at, *_scope_params(scope), int(uid)),
    )


def update_status(
    db: sqlite3.Connection,
    scope: Scope,
    uid: int,
    status: str,
    at: int,
    error: str | None = None,
) -> bool:
    """更新单个 UID 的状态；返回是否有行被更新。"""
    if status not in STATE_STATUSES:
        raise MailboxError(f"非法邮件状态: {status}")
    sql, params = _update_status_sql(status, error, at, scope, uid)
    with state_transaction(db):
        return db.execute(sql, params).rowcount > 0


def update_statuses(
    db: sqlite3.Connection,
    scope: Scope,
    uids: list[int],
    status: str,
    at: int,
) -> int:
    """一次事务里把多个 UID 置为同一状态；返回实际更新行数。"""
    if status not in STATE_STATUSES:
        raise MailboxError(f"非法邮件状态: {status}")
    if not uids:
        return 0
    updated = 0
    with state_transaction(db):
        for uid in uids:
            sql, params = _update_status_sql(status, None, at, scope, uid)
            updated += max(0, db.execute(sql, params).rowcount)
    return updated


def set_last_error(db: sqlite3.Connection, scope: Scope, uid: int, error: str | None) -> bool:
    """只更新 last_error（不改状态）；返回是否有行被更新。"""
    with state_transaction(db):
        cursor = db.execute(
            "UPDATE messages SET last_error = ? "
            "WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid = ?",
            (str(error) if error else None, *_scope_params(scope), int(uid)),
        )
        return cursor.rowcount > 0


def touch_notified(db: sqlite3.Connection, scope: Scope, uids: list[int], at: int) -> None:
    """记录本轮已通知的 UID（last_notified_at）。"""
    if not uids:
        return
    marks = ",".join("?" for _ in uids)
    with state_transaction(db):
        db.execute(
            f"UPDATE messages SET last_notified_at = ? "
            f"WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid IN ({marks})",
            (at, *_scope_params(scope), *[int(uid) for uid in uids]),
        )


def mark_missing_gone(db: sqlite3.Connection, scope: Scope, present_uids: set[int]) -> list[int]:
    """把不再出现在 SEARCH 结果里的 pending 行标为 gone；返回变更的 UID。"""
    rows = db.execute(
        "SELECT uid FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ? AND status = ?",
        (*_scope_params(scope), STATUS_PENDING),
    ).fetchall()
    gone = [int(row["uid"]) for row in rows if int(row["uid"]) not in present_uids]
    if not gone:
        return []
    with state_transaction(db):
        for uid in gone:
            db.execute(
                "UPDATE messages SET status = ? WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid = ?",
                (STATUS_GONE, *_scope_params(scope), uid),
            )
    return gone


def prune(db: sqlite3.Connection, now: int) -> int:
    """只保留 STATE_RETENTION_DAYS 天内的状态行；返回删除行数。"""
    cutoff = now - STATE_RETENTION_DAYS * 24 * 3600
    return max(0, db.execute("DELETE FROM messages WHERE first_seen_at < ?", (cutoff,)).rowcount)


# --------------------------------------------------------------------------- #
# 查询
# --------------------------------------------------------------------------- #

def get_message(db: sqlite3.Connection, scope: Scope, uid: int) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT * FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ? AND uid = ?",
        (*_scope_params(scope), int(uid)),
    ).fetchone()
    return _row_to_record(row) if row is not None else None


def list_messages(
    db: sqlite3.Connection,
    account: str,
    *,
    folder: str | None = None,
    uidvalidity: int | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    clauses = ["account = ?"]
    params: list[Any] = [account]
    if folder is not None:
        clauses.append("folder = ?")
        params.append(folder)
    if uidvalidity is not None:
        clauses.append("uidvalidity = ?")
        params.append(uidvalidity)
    if status is not None:
        normalized_status = normalize_status(status, default="")
        if not normalized_status:
            raise MailboxError(f"非法邮件状态: {status}")
        clauses.append("status = ?")
        params.append(normalized_status)
    sql = "SELECT * FROM messages WHERE " + " AND ".join(clauses) + " ORDER BY uid"
    return [_row_to_record(row) for row in db.execute(sql, params).fetchall()]


def known_uids(db: sqlite3.Connection, scope: Scope) -> set[int]:
    rows = db.execute(
        "SELECT uid FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ?",
        _scope_params(scope),
    ).fetchall()
    return {int(row["uid"]) for row in rows}


def scope_has_messages(db: sqlite3.Connection, scope: Scope) -> bool:
    row = db.execute(
        "SELECT 1 FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ? LIMIT 1",
        _scope_params(scope),
    ).fetchone()
    return row is not None


# --------------------------------------------------------------------------- #
# 聚合（status/list 输出用）
# --------------------------------------------------------------------------- #

def counts_by_status(db: sqlite3.Connection, scope: Scope) -> dict[str, int]:
    rows = db.execute(
        "SELECT status, COUNT(*) AS c FROM messages "
        "WHERE account = ? AND folder = ? AND uidvalidity = ? GROUP BY status",
        _scope_params(scope),
    ).fetchall()
    return {str(row["status"]): int(row["c"]) for row in rows}


def count_sources(records: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"OK": 0, "RISK": 0}
    for record in records:
        counts[source_label(record.get("source"))] += 1
    return counts

"""v0.2.x JSONL 状态 → SQLite 的一次性迁移。

- 只在 SQLite 状态库里还没有任何 messages 时迁移；
- 旧 ``temp`` → ``pending``，``acked`` → ``replied``，未知状态 → ``ignored``；
- 旧状态没有可复用的 Authentication-Results 证据，``source`` 统一降为 ``risk``；
- 迁移在一个事务里完成，成功后把 ``<account>.jsonl`` 改名为 ``.migrated``；
- 迁移出的 scope ``baseline_done=0``：下一次 check 会先补一次基线（与 v0.3.0
  行为一致：升级后首次 check 不通知迁移出的 pending，下一轮才提醒）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .model import STATE_STATUSES, STATUS_IGNORED, STATUS_REPLIED
from .records import insert_message
from .state import Scope, legacy_state_file_for, state_transaction
from .text import as_int, now_ts

STATE_JSONL_VERSION = 1


def read_legacy_state(path: Path) -> dict[str, Any] | None:
    """读取旧 JSONL；只保留最后一条版本匹配的记录。损坏行跳过，不抛。"""
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


def _legacy_status(value: Any) -> str:
    status = str(value or STATUS_IGNORED)
    if status == "temp":
        return "pending"
    if status == "acked":
        return STATUS_REPLIED
    return status if status in STATE_STATUSES else STATUS_IGNORED


def migrate_legacy_state(db, state_dir: Path, account: str) -> bool:
    """必要时迁移旧 JSONL 状态；返回是否真的发生了迁移。"""
    legacy_path = legacy_state_file_for(state_dir, account)
    if not legacy_path.exists():
        return False
    if int(db.execute("SELECT COUNT(*) AS c FROM messages").fetchone()[0]) > 0:
        return False
    legacy = read_legacy_state(legacy_path)
    if not legacy:
        return False

    legacy_scope = Scope(
        account=str(legacy.get("account") or account).strip().lower(),
        folder=str(legacy.get("folder") or "INBOX"),
        uidvalidity=as_int(legacy.get("uidvalidity"), 0),
    )
    messages = legacy.get("messages")
    if not isinstance(messages, dict):
        messages = {}
    now = now_ts()
    with state_transaction(db):
        db.execute(
            "INSERT OR IGNORE INTO scopes(account, folder, uidvalidity, baseline_done, updated_at) "
            "VALUES (?, ?, ?, 0, ?)",
            (legacy_scope.account, legacy_scope.folder, legacy_scope.uidvalidity, now),
        )
        for key, old in messages.items():
            if not isinstance(old, dict):
                continue
            status = _legacy_status(old.get("status"))
            uid = as_int(old.get("uid"), as_int(key, 0))
            if uid <= 0:
                continue
            record = {
                "uid": uid,
                "first_seen_at": as_int(old.get("first_seen_at"), now),
                "status": status,
                "last_notified_at": old.get("last_notified_at"),
                "replied_at": old.get("acked_at") if status == STATUS_REPLIED else None,
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
            insert_message(db, legacy_scope, record)

    try:
        os.replace(legacy_path, legacy_path.with_name(legacy_path.name + ".migrated"))
    except OSError:
        pass
    return True

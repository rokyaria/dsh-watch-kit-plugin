"""``mailbox_core.state`` + ``mailbox_core.records`` 单元测试。

覆盖 schema/user_version/事务回滚/权限/scope 生命周期/记录 CRUD/状态更新/
gone/prune/聚合/seed_baseline，以及“source 归一化只在脏值时写”的性能不变量。
"""

from __future__ import annotations

import os
import sqlite3
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from support.paths import MAILBOX_DIR  # noqa: F401

from mailbox_core import model, records, state
from mailbox_core.errors import MailboxError

ACCOUNT = "agent@example.com"


class StateTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.state_dir = self.root / "state"
        self.db_path = state.state_file_for(self.state_dir, ACCOUNT)
        self.db = state.open_state(self.db_path)
        self.addCleanup(self.db.close)
        self.scope = state.Scope(ACCOUNT, "INBOX", 100)

    def insert(self, uid: int, scope: state.Scope | None = None, **overrides):
        record = {
            "uid": uid,
            "first_seen_at": 1000,
            "status": "pending",
            "source": "ok",
            "identity": "user",
        }
        record.update(overrides)
        records.insert_message(self.db, scope or self.scope, record)


class PathsAndOpenTest(StateTestBase):
    def test_state_file_for_sanitizes_account(self):
        self.assertEqual(
            state.state_file_for(self.root, "Agent@Example.COM").name,
            "agent@example.com.sqlite3",
        )
        self.assertEqual(
            state.state_file_for(self.root, "a b/c@X").name, "a_b_c@x.sqlite3"
        )
        with self.assertRaises(MailboxError):
            state.state_file_for(self.root, "   ")

    def test_legacy_state_file_for_suffix(self):
        self.assertEqual(
            state.legacy_state_file_for(self.root, ACCOUNT).name,
            "agent@example.com.jsonl",
        )

    def test_open_state_creates_schema_version_and_private_paths(self):
        self.assertTrue(self.db_path.exists())
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        self.assertEqual(version, state.STATE_SCHEMA_VERSION)
        tables = {
            row[0]
            for row in self.db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        self.assertTrue({"scopes", "messages"} <= tables)
        journal_mode = self.db.execute("PRAGMA journal_mode").fetchone()[0]
        self.assertEqual(str(journal_mode).lower(), "wal")
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.state_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(self.db_path.stat().st_mode), 0o600)

    def test_open_state_rejects_unknown_user_version(self):
        path = self.root / "future.sqlite3"
        conn = sqlite3.connect(str(path))
        conn.execute("PRAGMA user_version = 99")
        conn.commit()
        conn.close()
        with self.assertRaises(MailboxError) as caught:
            state.open_state(path)
        self.assertIn("不支持的状态数据库版本 99", str(caught.exception))

    def test_open_state_wraps_corrupt_database(self):
        path = self.root / "corrupt.sqlite3"
        path.write_bytes(b"this is not a sqlite database")
        with self.assertRaises(MailboxError) as caught:
            state.open_state(path)
        self.assertIn("状态数据库", str(caught.exception))

    def test_open_state_normalizes_dirty_sources(self):
        path = self.root / "dirty.sqlite3"
        conn = sqlite3.connect(str(path))
        conn.executescript(state.STATE_SCHEMA)
        conn.execute("PRAGMA user_version = 1")
        rows = [(1, "OK"), (2, "warn"), (3, None), (4, " risk ")]
        for uid, source in rows:
            conn.execute(
                "INSERT INTO messages(account, folder, uidvalidity, uid, first_seen_at, status, source) "
                "VALUES (?, 'INBOX', 100, ?, 1, 'ignored', ?)",
                (ACCOUNT, uid, source),
            )
        conn.commit()
        conn.close()
        db = state.open_state(path)
        try:
            sources = {
                int(row["uid"]): row["source"]
                for row in db.execute("SELECT uid, source FROM messages").fetchall()
            }
        finally:
            db.close()
        self.assertEqual(sources, {1: "ok", 2: "risk", 3: "risk", 4: "risk"})

    def test_open_state_skips_source_update_when_clean(self):
        """性能不变量：库里没有脏值时不应写 UPDATE（避免每轮 WAL 抖动）。"""
        self.insert(1, source="ok")
        self.insert(2, source="risk")
        statements: list[str] = []
        real_connect = sqlite3.connect

        def traced_connect(*args, **kwargs):
            conn = real_connect(*args, **kwargs)
            conn.set_trace_callback(statements.append)
            return conn

        with mock.patch.object(state.sqlite3, "connect", side_effect=traced_connect):
            db = state.open_state(self.db_path)
            db.close()
        self.assertFalse(
            any("UPDATE messages SET source" in sql for sql in statements),
            [sql for sql in statements if "UPDATE" in sql],
        )

    def test_secure_state_dir_creates_private_directory(self):
        path = state.secure_state_dir(self.root / "a" / "b")
        self.assertTrue(path.is_dir())
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)


class TransactionTest(StateTestBase):
    def test_transaction_commits(self):
        with state.state_transaction(self.db):
            self.insert(5)
        self.assertIsNotNone(records.get_message(self.db, self.scope, 5))

    def test_transaction_rolls_back_on_exception(self):
        with self.assertRaises(RuntimeError):
            with state.state_transaction(self.db):
                self.insert(6)
                raise RuntimeError("boom")
        self.assertIsNone(records.get_message(self.db, self.scope, 6))

    def test_transaction_rolls_back_when_commit_fails(self):
        class FakeDB:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def execute(self, sql, params=()):
                self.calls.append(sql)
                if sql.strip().upper() == "COMMIT":
                    raise sqlite3.Error("commit failed")
                return None

        fake = FakeDB()
        with self.assertRaises(sqlite3.Error):
            with state.state_transaction(fake):
                pass
        self.assertIn("BEGIN IMMEDIATE", fake.calls)
        self.assertIn("ROLLBACK", fake.calls)


class ScopeTest(StateTestBase):
    def test_ensure_and_find_scope(self):
        scope = state.Scope(ACCOUNT, "Archive", 7)
        self.assertIsNone(state.find_scope(self.db, scope))
        row = state.ensure_scope(self.db, scope, now=1234)
        self.assertEqual(row["account"], ACCOUNT)
        self.assertEqual(row["folder"], "Archive")
        self.assertEqual(row["uidvalidity"], 7)
        self.assertEqual(row["baseline_done"], 0)
        self.assertEqual(row["updated_at"], 1234)
        self.assertEqual(state.ensure_scope(self.db, scope, now=999)["updated_at"], 1234)
        self.assertEqual(state.find_scope(self.db, scope)["uidvalidity"], 7)

    def test_mark_scope_baseline_done(self):
        state.ensure_scope(self.db, self.scope, now=1)
        state.mark_scope_baseline_done(self.db, self.scope, now=42)
        row = state.find_scope(self.db, self.scope)
        self.assertEqual(row["baseline_done"], 1)
        self.assertEqual(row["updated_at"], 42)

    def test_latest_uidvalidity_prefers_most_recent_scope_row(self):
        self.assertIsNone(state.latest_uidvalidity(self.db, ACCOUNT, "INBOX"))
        state.ensure_scope(self.db, self.scope, now=10)  # uv 100
        state.ensure_scope(self.db, state.Scope(ACCOUNT, "INBOX", 200), now=20)
        self.assertEqual(state.latest_uidvalidity(self.db, ACCOUNT, "INBOX"), 200)
        # updated_at 相同时取最后插入的 scope（rowid 更大），而不是较大的 uidvalidity：
        # UIDVALIDITY 200 → 150 回退时，150 才是当前 scope。
        state.ensure_scope(self.db, state.Scope(ACCOUNT, "INBOX", 300), now=20)
        self.assertEqual(state.latest_uidvalidity(self.db, ACCOUNT, "INBOX"), 300)
        state.ensure_scope(self.db, state.Scope(ACCOUNT, "INBOX", 150), now=20)
        self.assertEqual(state.latest_uidvalidity(self.db, ACCOUNT, "INBOX"), 150)

    def test_clear_scope_and_reset_scope(self):
        state.ensure_scope(self.db, self.scope, now=1)
        self.insert(1)
        state.clear_scope(self.db, self.scope)
        self.assertIsNone(state.find_scope(self.db, self.scope))
        self.assertIsNone(records.get_message(self.db, self.scope, 1))

        state.reset_scope(self.db, self.scope, now=5)
        row = state.find_scope(self.db, self.scope)
        self.assertEqual(row["baseline_done"], 1)
        self.assertEqual(row["updated_at"], 5)
        self.assertFalse(records.scope_has_messages(self.db, self.scope))


class RecordWriteTest(StateTestBase):
    def test_insert_message_maps_all_fields(self):
        records.insert_message(
            self.db,
            self.scope,
            {
                "uid": 7,
                "first_seen_at": 111,
                "status": "replied",
                "address": "owner@example.com",
                "from": "Owner <owner@example.com>",
                "subject": "hello",
                "message_id": "<m7@x>",
                "date": "Wed, 01 Jan 2020 00:00:00 +0000",
                "identity": "user",
                "source": "OK",
                "last_notified_at": 100,
                "last_error": "oops",
            },
        )
        row = records.get_message(self.db, self.scope, 7)
        self.assertEqual(row["account"], ACCOUNT)
        self.assertEqual(row["folder"], "INBOX")
        self.assertEqual(row["uidvalidity"], 100)
        self.assertEqual(row["from_addr"], "owner@example.com")
        self.assertEqual(row["from_display"], "Owner <owner@example.com>")
        self.assertEqual(row["from"], "Owner <owner@example.com>")
        self.assertEqual(row["subject"], "hello")
        self.assertEqual(row["source"], "ok")
        self.assertEqual(row["status"], "replied")
        self.assertIsNotNone(row["replied_at"])
        self.assertEqual(row["last_notified_at"], 100)
        self.assertEqual(row["last_error"], "oops")

    def test_insert_message_rejects_missing_uid(self):
        with self.assertRaises(MailboxError):
            records.insert_message(self.db, self.scope, {"subject": "no uid"})

    def test_insert_message_normalizes_unknown_status_to_ignored(self):
        self.insert(8, status="weird")
        self.assertEqual(records.get_message(self.db, self.scope, 8)["status"], "ignored")

    def test_insert_message_normalizes_source_to_risk(self):
        self.insert(9, source="unknown")
        self.assertEqual(records.get_message(self.db, self.scope, 9)["source"], "risk")

    def test_insert_message_is_insert_or_ignore(self):
        self.insert(10, subject="first")
        self.insert(10, subject="second")
        self.assertEqual(records.get_message(self.db, self.scope, 10)["subject"], "first")

    def test_insert_messages_batch_and_empty(self):
        records.insert_messages(
            self.db,
            self.scope,
            [{"uid": 1, "first_seen_at": 1, "status": "pending"}, {"uid": 2, "first_seen_at": 2}],
        )
        self.assertEqual(records.known_uids(self.db, self.scope), {1, 2})
        records.insert_messages(self.db, self.scope, [])
        self.assertEqual(records.known_uids(self.db, self.scope), {1, 2})

    def test_seed_baseline_default_and_notify_existing(self):
        state.ensure_scope(self.db, self.scope, now=1)
        records.seed_baseline(self.db, self.scope, [1, 2], now=100)
        rows = records.list_messages(self.db, ACCOUNT, uidvalidity=100)
        self.assertEqual([row["status"] for row in rows], ["ignored", "ignored"])
        self.assertEqual([row["source"] for row in rows], ["risk", "risk"])
        self.assertEqual(state.find_scope(self.db, self.scope)["baseline_done"], 1)

        scope2 = state.Scope(ACCOUNT, "INBOX", 200)
        state.ensure_scope(self.db, scope2, now=1)
        records.seed_baseline(self.db, scope2, [5], now=100, notify_existing=True)
        self.assertEqual(records.get_message(self.db, scope2, 5)["status"], "pending")


class RecordQueryTest(StateTestBase):
    def test_from_field_falls_back_to_address(self):
        # 没有 from_display 时，派生字段 ``from`` 用 from_addr（即 address）兜底。
        records.insert_message(
            self.db,
            self.scope,
            {"uid": 2, "address": "only@example.com", "first_seen_at": 1, "status": "ignored"},
        )
        row = records.get_message(self.db, self.scope, 2)
        self.assertEqual(row["from"], "only@example.com")
        self.assertEqual(row["from_display"], "")

    def test_get_message_missing(self):
        self.assertIsNone(records.get_message(self.db, self.scope, 999))

    def test_list_messages_filters_and_order(self):
        scope2 = state.Scope(ACCOUNT, "Archived", 200)
        state.ensure_scope(self.db, scope2, now=1)
        self.insert(2, status="ignored")
        self.insert(1, status="pending")
        records.insert_message(
            self.db, scope2, {"uid": 3, "first_seen_at": 1, "status": "pending"}
        )
        all_rows = records.list_messages(self.db, ACCOUNT)
        self.assertEqual([row["uid"] for row in all_rows], [1, 2, 3])
        inbox = records.list_messages(self.db, ACCOUNT, folder="INBOX")
        self.assertEqual([row["uid"] for row in inbox], [1, 2])
        scope100 = records.list_messages(self.db, ACCOUNT, uidvalidity=100)
        self.assertEqual([row["uid"] for row in scope100], [1, 2])
        pending = records.list_messages(self.db, ACCOUNT, status="PENDING")
        self.assertEqual([row["uid"] for row in pending], [1, 3])
        self.assertEqual(records.list_messages(self.db, "other@example.com"), [])

    def test_list_messages_rejects_unknown_status(self):
        with self.assertRaises(MailboxError) as caught:
            records.list_messages(self.db, ACCOUNT, status="bogus")
        self.assertIn("非法邮件状态", str(caught.exception))

    def test_touch_scope_updates_updated_at(self):
        state.ensure_scope(self.db, self.scope, now=100)
        state.touch_scope(self.db, self.scope, 500)
        row = state.find_scope(self.db, self.scope)
        self.assertEqual(row["updated_at"], 500)
        # touch_scope 只改 updated_at，不动 baseline_done。
        self.assertEqual(row["baseline_done"], 0)

    def test_update_status_transitions(self):
        self.insert(1, status="pending")
        self.assertTrue(records.update_status(self.db, self.scope, 1, "replied", 123))
        row = records.get_message(self.db, self.scope, 1)
        self.assertEqual(row["status"], "replied")
        self.assertEqual(row["replied_at"], 123)
        self.assertTrue(records.update_status(self.db, self.scope, 1, "no_receipt", 456))
        row = records.get_message(self.db, self.scope, 1)
        self.assertEqual(row["status"], "no_receipt")
        self.assertEqual(row["no_receipt_at"], 456)
        self.assertFalse(records.update_status(self.db, self.scope, 99, "replied", 1))
        with self.assertRaises(MailboxError):
            records.update_status(self.db, self.scope, 1, "bogus", 1)

    def test_update_statuses_batch(self):
        for uid in (1, 2, 3):
            self.insert(uid)
        updated = records.update_statuses(self.db, self.scope, [1, 2, 99], "no_receipt", 200)
        self.assertEqual(updated, 2)
        self.assertEqual(records.get_message(self.db, self.scope, 1)["no_receipt_at"], 200)
        self.assertEqual(records.get_message(self.db, self.scope, 3)["status"], "pending")
        self.assertEqual(records.update_statuses(self.db, self.scope, [], "no_receipt", 1), 0)
        with self.assertRaises(MailboxError):
            records.update_statuses(self.db, self.scope, [1], "bogus", 1)

    def test_set_last_error_does_not_change_status(self):
        self.insert(1, status="pending")
        self.assertTrue(records.set_last_error(self.db, self.scope, 1, "read failed"))
        row = records.get_message(self.db, self.scope, 1)
        self.assertEqual(row["last_error"], "read failed")
        self.assertEqual(row["status"], "pending")
        self.assertFalse(records.set_last_error(self.db, self.scope, 99, "x"))

    def test_touch_notified(self):
        self.insert(1)
        self.insert(2)
        records.touch_notified(self.db, self.scope, [1], 777)
        self.assertEqual(records.get_message(self.db, self.scope, 1)["last_notified_at"], 777)
        self.assertIsNone(records.get_message(self.db, self.scope, 2)["last_notified_at"])
        records.touch_notified(self.db, self.scope, [], 999)  # no-op

    def test_mark_missing_gone_only_touches_pending(self):
        self.insert(1, status="pending")
        self.insert(2, status="pending")
        self.insert(3, status="ignored")
        gone = records.mark_missing_gone(self.db, self.scope, {1})
        self.assertEqual(gone, [2])
        self.assertEqual(records.get_message(self.db, self.scope, 1)["status"], "pending")
        self.assertEqual(records.get_message(self.db, self.scope, 2)["status"], "gone")
        self.assertEqual(records.get_message(self.db, self.scope, 3)["status"], "ignored")
        self.assertEqual(records.mark_missing_gone(self.db, self.scope, {1}), [])

    def test_prune_removes_rows_older_than_retention(self):
        now = int(time.time())
        self.insert(1, first_seen_at=now)
        self.insert(2, first_seen_at=now - 32 * 86400)
        deleted = records.prune(self.db, now)
        self.assertEqual(deleted, 1)
        self.assertEqual(records.known_uids(self.db, self.scope), {1})

    def test_counts_and_aggregates(self):
        self.assertFalse(records.scope_has_messages(self.db, self.scope))
        self.insert(1, status="pending")
        self.insert(2, status="pending", source="risk")
        self.insert(3, status="ignored")
        self.assertTrue(records.scope_has_messages(self.db, self.scope))
        self.assertEqual(
            records.counts_by_status(self.db, self.scope),
            {"pending": 2, "ignored": 1},
        )
        rows = records.list_messages(self.db, ACCOUNT, uidvalidity=100)
        self.assertEqual(records.count_sources(rows), {"OK": 2, "RISK": 1})
        self.assertEqual(records.count_sources([]), {"OK": 0, "RISK": 0})

    def test_scopes_isolate_same_uid(self):
        scope2 = state.Scope(ACCOUNT, "INBOX", 200)
        state.ensure_scope(self.db, scope2, now=1)
        self.insert(1, status="pending")
        records.insert_message(
            self.db, scope2, {"uid": 1, "first_seen_at": 1, "status": "ignored"}
        )
        self.assertEqual(records.get_message(self.db, self.scope, 1)["status"], "pending")
        self.assertEqual(records.get_message(self.db, scope2, 1)["status"], "ignored")


class ModelTest(unittest.TestCase):
    """状态/来源常量与归一化（model.py 是唯一事实源）。"""

    def test_source_constants_and_normalization(self):
        self.assertEqual(model.SOURCE_OK, "ok")
        self.assertEqual(model.SOURCE_RISK, "risk")
        self.assertEqual(model.normalize_source("ok"), "ok")
        self.assertEqual(model.normalize_source(" OK "), "ok")
        self.assertEqual(model.normalize_source("warn"), "risk")
        self.assertEqual(model.normalize_source(None), "risk")
        self.assertEqual(model.source_label("ok"), "OK")
        self.assertEqual(model.source_label("OK"), "OK")
        self.assertEqual(model.source_label("warn"), "RISK")
        self.assertEqual(model.source_label(None), "RISK")

    def test_status_constants_and_normalization(self):
        self.assertEqual(model.DEFAULT_IDENTITY, "guest")
        self.assertEqual(
            model.STATE_STATUSES,
            frozenset({"ignored", "pending", "no_receipt", "replied", "invalid", "gone"}),
        )
        self.assertEqual(model.normalize_status("PENDING"), "pending")
        self.assertEqual(model.normalize_status("bogus"), "ignored")
        self.assertEqual(model.normalize_status(None, "pending"), "pending")


if __name__ == "__main__":
    unittest.main()

"""``mailbox_core.legacy`` 单元测试：v0.2.x JSONL → SQLite 一次性迁移。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from support.paths import MAILBOX_DIR  # noqa: F401

from mailbox_core import legacy, records, state
from mailbox_core import legacy as legacy_module

ACCOUNT = "agent@example.com"


class LegacyTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.state_dir = self.root / "state"
        self.db = state.open_state(state.state_file_for(self.state_dir, ACCOUNT))
        self.addCleanup(self.db.close)
        self.legacy_path = state.legacy_state_file_for(self.state_dir, ACCOUNT)
        self.scope = state.Scope(ACCOUNT, "INBOX", 100)

    def write_legacy(self, payload: dict) -> None:
        self.legacy_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")

    def legacy_payload(self, messages: dict | None = None, **overrides) -> dict:
        payload = {
            "v": 1,
            "account": ACCOUNT,
            "folder": "INBOX",
            "uidvalidity": 100,
            "initialized": True,
            "last_seen_uid": 9,
            "messages": messages or {},
        }
        payload.update(overrides)
        return payload

    def migrated_path(self) -> Path:
        return self.legacy_path.with_name(self.legacy_path.name + ".migrated")


class ReadLegacyStateTest(LegacyTestBase):
    def test_missing_file_returns_none(self):
        self.assertIsNone(legacy.read_legacy_state(self.legacy_path))

    def test_returns_last_versioned_record_and_skips_garbage(self):
        lines = [
            "not json",
            json.dumps({"v": 0, "marker": 0}),
            json.dumps({"v": 1, "marker": 1}),
            "",
            json.dumps([1, 2, 3]),
            json.dumps({"v": 1, "marker": 2}),
        ]
        self.legacy_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        value = legacy.read_legacy_state(self.legacy_path)
        self.assertEqual(value["marker"], 2)

    def test_only_invalid_records_returns_none(self):
        lines = ["garbage", json.dumps({"v": 2})]
        self.legacy_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assertIsNone(legacy.read_legacy_state(self.legacy_path))


class MigrateLegacyStateTest(LegacyTestBase):
    def test_no_legacy_file_returns_false(self):
        self.assertFalse(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))

    def test_migrates_statuses_and_downgrades_source(self):
        self.write_legacy(
            self.legacy_payload(
                {
                    "1": {
                        "uid": 1,
                        "status": "temp",
                        "first_seen_at": 111,
                        "last_notified_at": 0,
                        "address": "owner@example.com",
                        "from": "Owner <owner@example.com>",
                        "subject": "pending one",
                        "identity": "user",
                        "source": "ok",
                    },
                    "2": {"uid": 2, "status": "acked", "first_seen_at": 222, "subject": "done"},
                    "3": {"uid": 3, "status": "weird"},
                    "4": {"status": "temp"},
                    "5": "not a dict",
                }
            )
        )
        self.assertTrue(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))
        self.assertEqual(records.get_message(self.db, self.scope, 1)["status"], "pending")
        self.assertEqual(records.get_message(self.db, self.scope, 1)["source"], "risk")
        self.assertEqual(records.get_message(self.db, self.scope, 1)["identity"], "user")
        self.assertEqual(
            records.get_message(self.db, self.scope, 1)["from"], "Owner <owner@example.com>"
        )
        self.assertEqual(
            records.get_message(self.db, self.scope, 1)["first_seen_at"], 111
        )
        self.assertEqual(records.get_message(self.db, self.scope, 2)["status"], "replied")
        self.assertEqual(records.get_message(self.db, self.scope, 2)["replied_at"], 222)
        self.assertEqual(records.get_message(self.db, self.scope, 3)["status"], "ignored")
        # 旧 JSON 没有 MIME 头：source 一律 risk。
        for uid in (2, 3, 4):
            self.assertEqual(records.get_message(self.db, self.scope, uid)["source"], "risk")
        # 成功迁移后旧文件改名。
        self.assertTrue(self.migrated_path().exists())
        self.assertFalse(self.legacy_path.exists())

    def test_migration_creates_scope_awaiting_baseline(self):
        self.write_legacy(self.legacy_payload({"1": {"uid": 1, "status": "temp"}}))
        self.assertTrue(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))
        row = state.find_scope(self.db, self.scope)
        self.assertIsNotNone(row)
        self.assertEqual(row["baseline_done"], 0)

    def test_migration_uses_legacy_scope_fields(self):
        self.write_legacy(
            self.legacy_payload(
                {"7": {"uid": 7, "status": "temp"}},
                account="Agent@Example.COM",
                folder="Archived",
                uidvalidity=7,
            )
        )
        self.assertTrue(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))
        scope = state.Scope("agent@example.com", "Archived", 7)
        self.assertIsNotNone(records.get_message(self.db, scope, 7))
        self.assertEqual(state.latest_uidvalidity(self.db, ACCOUNT, "Archived"), 7)

    def test_migration_skipped_when_messages_already_exist(self):
        records.insert_message(
            self.db, self.scope, {"uid": 99, "first_seen_at": 1, "status": "ignored"}
        )
        self.write_legacy(self.legacy_payload({"1": {"uid": 1, "status": "temp"}}))
        self.assertFalse(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))
        self.assertIsNone(records.get_message(self.db, self.scope, 1))
        self.assertTrue(self.legacy_path.exists())
        self.assertFalse(self.migrated_path().exists())

    def test_migration_is_one_transaction(self):
        self.write_legacy(
            self.legacy_payload(
                {
                    "1": {"uid": 1, "status": "temp"},
                    "2": {"uid": 2, "status": "temp"},
                }
            )
        )
        real_insert = legacy_module.insert_message
        calls = {"count": 0}

        def flaky_insert(*args, **kwargs):
            calls["count"] += 1
            if calls["count"] >= 2:
                raise RuntimeError("simulated migration failure")
            return real_insert(*args, **kwargs)

        with mock.patch.object(legacy_module, "insert_message", side_effect=flaky_insert):
            with self.assertRaises(RuntimeError):
                legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT)
        count = self.db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        self.assertEqual(count, 0)  # 回滚：不得部分迁移
        self.assertTrue(self.legacy_path.exists())  # 失败不改名
        self.assertFalse(self.migrated_path().exists())

    def test_second_migration_returns_false(self):
        self.write_legacy(self.legacy_payload({"1": {"uid": 1, "status": "temp"}}))
        self.assertTrue(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))
        self.assertFalse(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))

    def test_invalid_uid_entries_are_skipped(self):
        self.write_legacy(
            self.legacy_payload(
                {
                    "0": {"uid": 0, "status": "temp"},
                    "x": {"status": "temp"},
                    "9": {"uid": 9, "status": "temp"},
                }
            )
        )
        self.assertTrue(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))
        self.assertEqual(records.known_uids(self.db, self.scope), {9})

    def test_non_dict_messages_only_creates_scope(self):
        self.write_legacy(self.legacy_payload(messages=[]))
        self.assertTrue(legacy.migrate_legacy_state(self.db, self.state_dir, ACCOUNT))
        self.assertIsNotNone(state.find_scope(self.db, self.scope))
        self.assertFalse(records.scope_has_messages(self.db, self.scope))
        self.assertTrue(self.migrated_path().exists())


if __name__ == "__main__":
    unittest.main()

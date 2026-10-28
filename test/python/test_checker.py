"""``mailbox_core.checker`` 单元测试：limits clamp / run_check 流水线与失败隔离。

复用 ``support.cli.MailboxCliCase`` 的临时环境 + fake IMAP/SMTP，但直接调用
``checker.run_check(args)``（不经 argparse 入口），并查 SQLite 状态库断言。
"""

from __future__ import annotations

import argparse
import io
import json
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from support import fakes
from support.cli import MailboxCliCase
from support.paths import MAILBOX_DIR  # noqa: F401

from mailbox_core import checker, classify, records, state
from mailbox_core.cli import build_parser
from mailbox_core.errors import MailboxError

ACCOUNT = "agent@example.com"


class CheckerTest(MailboxCliCase):
    account = ACCOUNT

    # ------------------------------------------------------------------ #
    # 辅助
    # ------------------------------------------------------------------ #

    def run_check(self, *extra: str):
        args = build_parser().parse_args(["check", *self.common, *extra])
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = checker.run_check(args)
        text = out.getvalue()
        # checker 契约：stdout 整体必须是**一个** JSON 对象（不能有日志/第二行）；
        # 人类日志全部走 stderr，且 stderr 不允许出现 JSON。
        data = json.loads(text)
        self.assertNotIn('{"notify"', err.getvalue())
        self.assertIsInstance(data, dict)
        return code, text, err.getvalue(), data

    def state_dir_sqlite_files(self):
        return sorted(self.state_dir.glob("*.sqlite3"))

    def scope(self, uidvalidity: int = 100) -> state.Scope:
        return state.Scope(ACCOUNT, "INBOX", uidvalidity)

    def seed_rules(self):
        return [{"address": "owner@example.com", "identity": "user"}]

    # ------------------------------------------------------------------ #
    # limits clamp
    # ------------------------------------------------------------------ #

    def test_default_limits(self):
        limits = checker._checker_limits(argparse.Namespace())
        self.assertEqual(limits.max_message_bytes, 8192 - 256)
        self.assertEqual(limits.max_error_bytes, 2048)
        self.assertEqual(limits.max_notify, 20)
        self.assertEqual(limits.remind_seconds, 30 * 60)
        self.assertFalse(limits.notify_existing)
        # 审计：常量断言硬编码，避免常量被误改后测试跟着“自我实现”。
        self.assertEqual(checker.MAX_FETCH_PER_RUN, 200)
        self.assertEqual(limits.max_fetch, 200)

    def test_max_notify_clamp(self):
        for value, expected in ((0, 1), (-5, 1), (1, 1), (20, 20), (100, 100), (500, 100)):
            with self.subTest(value=value):
                limits = checker._checker_limits(argparse.Namespace(max_notify=value))
                self.assertEqual(limits.max_notify, expected)

    def test_byte_limits_clamp(self):
        for value, expected in ((0, 256), (1, 256), (255, 256), (256, 256), (7936, 7936)):
            with self.subTest(value=value):
                limits = checker._checker_limits(argparse.Namespace(max_message_bytes=value))
                self.assertEqual(limits.max_message_bytes, expected)
        for value, expected in ((0, 64), (-9, 64), (63, 64), (2048, 2048)):
            with self.subTest(value=value):
                limits = checker._checker_limits(argparse.Namespace(max_error_bytes=value))
                self.assertEqual(limits.max_error_bytes, expected)
        big = checker._checker_limits(argparse.Namespace(max_message_bytes=10**9))
        self.assertEqual(big.max_message_bytes, checker.MAX_CHECKER_BYTES)

    def test_remind_minutes_clamp_and_notify_existing(self):
        limits = checker._checker_limits(
            argparse.Namespace(remind_minutes=0, notify_existing=True)
        )
        self.assertEqual(limits.remind_seconds, 60)
        self.assertTrue(limits.notify_existing)
        limits = checker._checker_limits(argparse.Namespace(remind_minutes=None))
        self.assertEqual(limits.remind_seconds, 30 * 60)

    # ------------------------------------------------------------------ #
    # run_check 主流程
    # ------------------------------------------------------------------ #

    def test_baseline_first_run(self):
        self.add_message(1)
        code, _out, err, data = self.run_check()
        self.assertEqual(code, 0)
        self.assertFalse(data["notify"])
        self.assertIn("baseline", err.lower())
        self.assertFalse(self.message_row(1) is None)
        self.assertEqual(self.message_row(1)["status"], "ignored")
        self.assertEqual(self.state()["scopes"][0]["baseline_done"], 1)

    def test_new_mail_notifies_and_touches_last_notified(self):
        self.add_message(1)
        self.run_check()
        self.add_message(2, subject="new thing")
        code, _out, _err, data = self.run_check()
        self.assertEqual(code, 0)
        self.assertTrue(data["notify"])
        self.assertIn("uid 2", data["message"])
        row = self.message_row(2)
        self.assertEqual(row["status"], "pending")
        self.assertIsNotNone(row["last_notified_at"])

    def test_reminder_after_quiet_period(self):
        self.add_message(1)
        self.run_check()
        self.add_message(2)
        self.run_check()
        self.update_message(2, last_notified_at=int(time.time()) - 31 * 60)
        _code, _out, _err, data = self.run_check()
        self.assertTrue(data["notify"])
        self.assertIn("待处理（已通知但未标记 replied/no_receipt）:", data["message"])
        self.assertGreater(self.message_row(2)["last_notified_at"], int(time.time()) - 60)

    def test_new_and_reminder_counts_combined(self):
        self.add_message(1)
        self.run_check()
        self.add_message(2, subject="first pending")
        self.run_check()
        self.update_message(2, last_notified_at=0)
        self.add_message(3, subject="brand new")
        _code, _out, _err, data = self.run_check()
        self.assertTrue(data["notify"])
        self.assertIn("1 封新信，1 封待处理", data["message"])

    def test_search_failure_leaves_no_state_db(self):
        fakes.FakeIMAP.search_error = True
        code, _out, _err, data = self.run_check()
        self.assertEqual(code, 0)
        self.assertFalse(data["notify"])
        self.assertIn("SEARCH", data["error"])
        self.assertEqual(self.state_dir_sqlite_files(), [])

    def test_fetch_failure_retried_then_recovered(self):
        self.add_message(1)
        self.run_check()
        fakes.FakeIMAP.broken_uids = {2}
        self.add_message(3, subject="good mail")
        _code, _out, err, data = self.run_check()
        self.assertTrue(data["notify"])
        self.assertIn("uid 3", data["message"])
        self.assertIn("读取失败", data["error"])
        self.assertIn("uid=2", err)
        self.assertIsNone(self.message_row(2))
        _code, _out, _err, data = self.run_check()
        self.assertFalse(data["notify"])
        self.assertIn("读取失败", data["error"])
        self.assertIsNone(self.message_row(2))
        fakes.FakeIMAP.broken_uids = set()
        self.add_message(2, subject="recovered")
        _code, _out, _err, data = self.run_check()
        self.assertTrue(data["notify"])
        self.assertEqual(self.message_row(2)["status"], "pending")

    def test_parse_failure_marks_invalid_and_isolates(self):
        self.add_message(1)
        self.run_check()
        self.add_message(5, subject="PANIC")
        self.add_message(6, subject="normal")
        original = classify.decode_header_value

        def flaky(value):
            if "PANIC" in str(value):
                raise LookupError("simulated unknown encoding")
            return original(value)

        with mock.patch.object(classify, "decode_header_value", side_effect=flaky):
            _code, _out, _err, data = self.run_check()
        self.assertTrue(data["notify"])
        self.assertIn("uid 6", data["message"])
        self.assertIn("解析失败", data["error"])
        self.assertEqual(self.message_row(5)["status"], "invalid")
        self.assertEqual(self.message_row(5)["source"], "risk")
        self.assertEqual(self.message_row(6)["status"], "pending")

    def test_old_mail_is_skipped_and_recorded_ignored(self):
        self.add_message(1)
        self.run_check()
        old_date = fakes.formatdate(time.time() - 40 * 86400, usegmt=True)
        self.add_message(2, subject="old", date=old_date)
        _code, _out, err, data = self.run_check()
        self.assertFalse(data["notify"])
        row = self.message_row(2)
        self.assertEqual(row["status"], "ignored")
        self.assertIn("超过 30 天", row["last_error"])
        self.assertIn("超过 30 天", err)

    def test_expired_pending_is_moved_to_ignored(self):
        self.add_message(1)
        self.run_check()
        self.add_message(2, subject="pending then ancient")
        self.run_check()
        old_date = fakes.formatdate(time.time() - 40 * 86400, usegmt=True)
        self.update_message(2, date=old_date)
        _code, _out, _err, data = self.run_check()
        self.assertFalse(data["notify"])
        row = self.message_row(2)
        self.assertEqual(row["status"], "ignored")
        self.assertIn("超过 30 天", row["last_error"])

    def test_tightened_allowlist_ignores_pending(self):
        self.add_message(1)
        self.run_check()
        self.add_message(2, subject="pending then disallowed")
        self.run_check()
        self.write_allow({ACCOUNT: []})
        _code, _out, _err, data = self.run_check()
        self.assertFalse(data["notify"])
        self.assertEqual(self.message_row(2)["status"], "ignored")

    def test_uidvalidity_change_rebaselines(self):
        self.add_message(1)
        self.run_check()
        fakes.FakeIMAP.uidvalidity = 200
        fakes.FakeIMAP.messages = {5: fakes.raw_message(5, subject="after reset")}
        _code, _out, _err, data = self.run_check()
        self.assertFalse(data["notify"])
        self.assertEqual(self.state()["uidvalidity"], 200)
        self.assertEqual(self.message_row(5)["status"], "ignored")

    def test_uidvalidity_zero_is_still_a_scope(self):
        fakes.FakeIMAP.uidvalidity = 0
        self.add_message(1)
        self.run_check()
        self.add_message(2, subject="new after zero uv")
        _code, _out, _err, data = self.run_check()
        self.assertTrue(data["notify"])
        self.assertEqual(self.state()["uidvalidity"], 0)
        self.assertEqual(self.message_row(2)["status"], "pending")

    def test_notify_existing_first_run(self):
        self.add_message(1)
        self.add_message(2)
        _code, _out, _err, data = self.run_check("--notify-existing")
        self.assertTrue(data["notify"])
        self.assertIn("uid 1", data["message"])
        self.assertIn("uid 2", data["message"])
        self.assertEqual(self.message_row(1)["status"], "pending")

    def test_max_notify_limits_listed_items(self):
        self.add_message(1)
        self.run_check()
        for uid in range(2, 8):
            self.add_message(uid, subject=f"mail {uid}")
        _code, _out, _err, data = self.run_check("--max-notify", "2")
        self.assertTrue(data["notify"])
        self.assertIn("另有 4 封未列出", data["message"])
        pending = [
            row for row in self.state()["messages"].values() if row["status"] == "pending"
        ]
        self.assertEqual(len(pending), 6)

    def test_failure_note_is_clipped_when_notify_false(self):
        """notify=false 分支的 error 附注同样受 max-error-bytes 约束。"""
        self.add_message(1)
        self.run_check()
        fakes.FakeIMAP.broken_uids = {2}
        self.add_message(3, subject="PANIC")
        original = classify.decode_header_value

        def flaky(value):
            if "PANIC" in str(value):
                raise LookupError("simulated unknown encoding")
            return original(value)

        with mock.patch.object(classify, "decode_header_value", side_effect=flaky):
            _code, _out, _err, data = self.run_check("--max-error-bytes", "64")
        self.assertFalse(data["notify"])
        self.assertLessEqual(len(data["error"].encode("utf-8")), 64)
        self.assertTrue(data["error"].endswith("[truncated]"))
        self.assertIn("读取失败", data["error"])

    def test_new_items_classified_by_last_notified_not_insert_round(self):
        """新信分类按 last_notified_at IS NULL：被 max-notify 截断的邮件下轮仍是“新信”。"""
        self.add_message(1)
        self.run_check()  # baseline
        for uid in range(2, 7):
            self.add_message(uid, subject=f"storm {uid}")

        # 第一轮：列出 uid2/3 为“新信”；uid4/5/6 已入库但从未通知。
        _code, _out, _err, data = self.run_check("--max-notify", "2")
        self.assertTrue(data["notify"])
        self.assertTrue(
            data["message"].startswith(
                "[MAILBOX] agent@example.com / INBOX: 2 封新信，0 封待处理"
            ),
            data["message"],
        )
        self.assertIn("uid 2", data["message"])
        self.assertIn("uid 3", data["message"])
        self.assertNotIn("uid 4", data["message"])
        self.assertNotIn("待处理（已通知但未标记 replied/no_receipt）:", data["message"])
        self.assertIsNotNone(self.message_row(2)["last_notified_at"])
        self.assertIsNotNone(self.message_row(3)["last_notified_at"])
        for uid in (4, 5, 6):
            self.assertIsNone(self.message_row(uid)["last_notified_at"])

        # 第二轮：上一轮已入库但从未通知的 uid4/5 仍算“新信”（不是“待处理”）。
        _code, _out, _err, data = self.run_check("--max-notify", "2")
        self.assertTrue(data["notify"])
        self.assertTrue(
            data["message"].startswith(
                "[MAILBOX] agent@example.com / INBOX: 2 封新信，0 封待处理"
            ),
            data["message"],
        )
        self.assertIn("uid 4", data["message"])
        self.assertIn("uid 5", data["message"])
        self.assertNotIn("待处理（已通知但未标记 replied/no_receipt）:", data["message"])
        self.assertIsNotNone(self.message_row(4)["last_notified_at"])
        self.assertIsNotNone(self.message_row(5)["last_notified_at"])
        self.assertIsNone(self.message_row(6)["last_notified_at"])

        # 第三轮：只剩 uid6，仍是“新信”。
        _code, _out, _err, data = self.run_check()
        self.assertTrue(
            data["message"].startswith(
                "[MAILBOX] agent@example.com / INBOX: 1 封新信，0 封待处理"
            ),
            data["message"],
        )
        self.assertIn("uid 6", data["message"])
        self.assertIsNotNone(self.message_row(6)["last_notified_at"])

    def test_fetch_failures_do_not_starve_later_new_mail(self):
        """审计回归：前 N 个坏 UID 不能永久饿死后面的新信。

        attempt_budget = max_fetch + max(2, max_fetch//4)，FETCH 失败不占成功处理
        配额：--max-new-fetch 2 且 uid2/3 都坏的场景下，本轮仍应处理到 uid4。
        """
        self.add_message(1)
        self.run_check()  # baseline（uid1 ignored）
        fakes.FakeIMAP.broken_uids = {2, 3}
        self.add_message(4, subject="behind broken uids")
        _code, _out, err, data = self.run_check("--max-new-fetch", "2")
        self.assertTrue(data["notify"], data)
        self.assertIn("uid 4", data["message"])
        self.assertIn("uid=2", err)
        self.assertIn("uid=3", err)
        self.assertEqual(self.message_row(4)["status"], "pending")
        # 坏 UID 不落库（下轮重试），已有 uid1 不丢。
        self.assertIsNone(self.message_row(2))
        self.assertIsNone(self.message_row(3))
        self.assertIsNotNone(self.message_row(1))

    def test_uidvalidity_rollback_shows_current_scope(self):
        """审计回归：UIDVALIDITY 回退后 touch_scope 让 status/list 选中当前 scope。

        两次 check 的时间戳显式错开：status/list 的排序是 updated_at DESC,
        uidvalidity DESC，只有当前 scope 的 updated_at 更晚时才会被选中
        （真实场景两次 check 间隔 ≥ interval，不会落在同一秒）。
        """
        fakes.FakeIMAP.uidvalidity = 200
        fakes.FakeIMAP.messages = {1: fakes.raw_message(1, subject="scope 200")}
        with mock.patch.object(
            checker, "now_ts", side_effect=[1_000_000, 2_000_000, 3_000_000]
        ):
            self.run_check()  # scope 200 baseline，updated_at=1_000_000
            fakes.FakeIMAP.uidvalidity = 100
            fakes.FakeIMAP.messages = {1: fakes.raw_message(1, subject="scope 100")}
            self.run_check()  # UIDVALIDITY 回退到 100 baseline，updated_at=2_000_000
            fakes.FakeIMAP.messages = {
                1: fakes.raw_message(1, subject="scope 100"),
                2: fakes.raw_message(2, subject="scope 100 new"),
            }
            _code, _out, _err, data = self.run_check()  # touch scope 100
        self.assertTrue(data["notify"])

        db = state.open_state(self.state_path())
        self.addCleanup(db.close)
        self.assertEqual(state.latest_uidvalidity(db, ACCOUNT, "INBOX"), 100)

        code, out, err = self.run_cli(["status", *self.common])
        self.assertEqual(code, 0, err)
        self.assertIn("uidvalidity: 100", out)
        code, out, err = self.run_cli(["list", *self.common])
        self.assertEqual(code, 0, err)
        self.assertIn("scope 100 new", out)

    # ------------------------------------------------------------------ #
    # 错误路径与上限
    # ------------------------------------------------------------------ #

    def test_error_is_clipped_to_max_error_bytes(self):
        long_message = "x" * 5000
        args = build_parser().parse_args(
            ["check", *self.common, "--max-error-bytes", "64"]
        )
        with mock.patch.object(
            checker, "load_env", side_effect=MailboxError(long_message)
        ):
            out = io.StringIO()
            with redirect_stdout(out):
                code = checker.run_check(args)
        self.assertEqual(code, 0)
        data = self.parse_json(out.getvalue())
        self.assertFalse(data["notify"])
        self.assertLessEqual(len(data["error"].encode("utf-8")), 64)
        self.assertTrue(data["error"].endswith("[truncated]"))

    def test_combined_failure_note_is_clipped_to_max_error_bytes(self):
        """P1 回归：同轮 FETCH 失败 + 解析失败时，error 附注也必须 ≤ max-error-bytes。

        notify=true 分支若 error 超长，会被 JS 侧判为 invalid_fields，整条通知丢弃；
        而本轮已经 touch_notified，邮件要到下个提醒周期才会再出现。
        """
        self.add_message(1)
        self.run_check()
        fakes.FakeIMAP.broken_uids = {2}
        self.add_message(3, subject="PANIC")
        self.add_message(4, subject="deliverable")
        original = classify.decode_header_value

        def flaky(value):
            if "PANIC" in str(value):
                raise LookupError("simulated unknown encoding")
            return original(value)

        with mock.patch.object(classify, "decode_header_value", side_effect=flaky):
            _code, _out, _err, data = self.run_check("--max-error-bytes", "64")
        self.assertTrue(data["notify"], data)
        self.assertIn("uid 4", data["message"])
        self.assertLessEqual(len(data["error"].encode("utf-8")), 64, data["error"])
        self.assertTrue(data["error"].endswith("[truncated]"), data["error"])
        self.assertIn("读取失败", data["error"])
        # 附注后半段（解析失败）被裁剪掉：error 字段整体受 64B 上限约束。
        self.assertNotIn("解析失败", data["error"])
        # 通知实际会成功投递（JS 校验通过），uid 4 已记录 last_notified_at。
        self.assertIsNotNone(self.message_row(4)["last_notified_at"])
        self.assertEqual(self.message_row(3)["status"], "invalid")

    def test_unexpected_exception_becomes_json(self):
        class BrokenMailbox:
            def __init__(self, *args, **kwargs):
                pass

            def connect(self):
                raise RuntimeError("boom")

            def close(self):
                pass

        with mock.patch.object(checker, "Mailbox", BrokenMailbox):
            _code, out, _err, data = self.run_check()
        self.assertFalse(data["notify"])
        self.assertIn("boom", data["error"])
        self.assertEqual(len(out.strip().splitlines()), 1)

    def test_max_new_fetch_advances_without_losing_mail(self):
        """新信风暴逐轮推进：--max-new-fetch 2 时两轮处理完 3 封，不丢邮件。"""
        self.add_message(1)
        self.run_check()
        for uid in (2, 3, 4):
            self.add_message(uid, subject=f"storm {uid}")
        _code, _out, err, data = self.run_check("--max-new-fetch", "2")
        self.assertTrue(data["notify"])
        self.assertIn("uid 2", data["message"])
        self.assertIn("uid 3", data["message"])
        self.assertNotIn("uid 4", data["message"])
        self.assertIn("本轮最多处理 2 封新邮件，剩余 1 封下轮继续", err)
        rows = self.state()["messages"]
        self.assertEqual(sorted(int(uid) for uid in rows), [1, 2, 3])

        _code, _out, _err, data = self.run_check()
        self.assertTrue(data["notify"])
        self.assertIn("uid 4", data["message"])
        rows = self.state()["messages"]
        self.assertEqual(sorted(int(uid) for uid in rows), [1, 2, 3, 4])
        self.assertEqual(self.message_row(4)["status"], "pending")

    def test_max_new_fetch_clamp(self):
        self.assertEqual(
            checker._checker_limits(argparse.Namespace(max_new_fetch=0)).max_fetch, 1
        )
        self.assertEqual(
            checker._checker_limits(argparse.Namespace(max_new_fetch=50000)).max_fetch, 10000
        )
        self.assertEqual(
            checker._checker_limits(argparse.Namespace()).max_fetch, 200
        )



class MailboxLifecycleTest(unittest.TestCase):
    """imap.Mailbox 生命周期：未连接 uidvalidity==0、close 幂等、close 吞异常。"""

    def setUp(self):
        self._patchers = fakes.transport_patches()
        for patcher in self._patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        fakes.FakeIMAP.reset()
        self.env = {
            "MAIL_ADDRESS": "agent@example.com",
            "MAIL_AUTHCODE": "secret",
            "IMAP_HOST": "imap.example",
            "IMAP_PORT": "993",
            "SMTP_HOST": "smtp.example",
            "SMTP_PORT": "465",
        }

    def test_unconnected_mailbox_uidvalidity_is_zero(self):
        from mailbox_core.errors import MailboxError
        from mailbox_core.imap import Mailbox

        mailbox = Mailbox(self.env, "INBOX")
        self.assertEqual(mailbox.uidvalidity, 0)
        mailbox.close()  # 未连接时 close 也必须安全
        with self.assertRaises(MailboxError):
            mailbox.uids()

    def test_connected_mailbox_close_is_idempotent_and_swallows_errors(self):
        from mailbox_core.imap import Mailbox

        mailbox = Mailbox(self.env, "INBOX").connect()
        self.assertEqual(mailbox.uidvalidity, 100)
        instance = fakes.FakeIMAP.instances[0]

        def broken_close():
            raise OSError("connection already closed")

        instance.close = broken_close
        mailbox.close()
        self.assertIsNone(mailbox.mail)
        self.assertEqual(mailbox.uidvalidity, 0)
        mailbox.close()  # 第二次 close 幂等
        self.assertIsNone(mailbox.mail)


if __name__ == "__main__":
    unittest.main()

"""``mailbox_core.classify`` 单元测试：新邮件记录字段 / identity / source / Date 年龄。"""

from __future__ import annotations

import unittest
from email.utils import formatdate
from unittest import mock

from support import fakes
from support.paths import MAILBOX_DIR  # noqa: F401

from mailbox_core import classify as classify_module
from mailbox_core.classify import classify, date_age_days

NOW = 1_700_000_000
OWNER_RULE = [{"address": "owner@example.com", "identity": "user"}]


def msg(**kwargs):
    return fakes.message_with_headers(fakes.AR_VALID, **kwargs)


class ClassifyTest(unittest.TestCase):
    def test_allowlisted_record_fields(self):
        record = classify(
            fakes.message_with_headers(
                fakes.AR_VALID,
                sender="Owner <Owner@Example.COM>",
                subject="hello",
            ),
            OWNER_RULE,
            NOW,
        )
        self.assertEqual(record["uid"], 0)
        self.assertEqual(record["address"], "owner@example.com")
        self.assertEqual(record["from"], "Owner <Owner@Example.COM>")
        self.assertEqual(record["subject"], "hello")
        self.assertEqual(record["status"], "pending")
        self.assertEqual(record["identity"], "user")
        self.assertEqual(record["source"], "ok")
        self.assertEqual(record["first_seen_at"], NOW)
        self.assertIsNone(record["last_notified_at"])
        self.assertEqual(record["message_id"], "<matrix@example.com>")
        self.assertIn("date", record)  # Date 头以字符串形式保留，供后续年龄过滤
        self.assertTrue(record["date"])

    def test_unlisted_sender_is_ignored_guest(self):
        record = classify(msg(sender="stranger@example.com"), OWNER_RULE, NOW)
        self.assertEqual(record["status"], "ignored")
        self.assertEqual(record["identity"], "guest")
        # 名单外也照样计算来源（保留数据，不用于通知）。
        self.assertEqual(record["source"], "ok")

    def test_unverified_source_is_risk_but_identity_kept(self):
        record = classify(
            fakes.message_with_headers("", sender="owner@example.com"),
            OWNER_RULE,
            NOW,
        )
        self.assertEqual(record["status"], "pending")
        self.assertEqual(record["identity"], "user")
        self.assertEqual(record["source"], "risk")

    def test_wildcard_rule_matches_any_sender(self):
        rules = [{"address": "*", "identity": "guest"}]
        record = classify(msg(sender="stranger@example.com"), rules, NOW)
        self.assertEqual(record["status"], "pending")
        self.assertEqual(record["identity"], "guest")

    def test_exact_rule_beats_wildcard(self):
        rules = [
            {"address": "*", "identity": "guest"},
            {"address": "owner@example.com", "identity": "user"},
        ]
        record = classify(msg(sender="owner@example.com"), rules, NOW)
        self.assertEqual(record["identity"], "user")

    def test_encoded_headers_are_decoded(self):
        record = classify(
            fakes.message_with_headers(
                fakes.AR_VALID,
                sender=f"{fakes.encoded_word('Owner 名称')} <owner@example.com>",
                subject=fakes.encoded_word("你好 world"),
            ),
            OWNER_RULE,
            NOW,
        )
        self.assertIn("Owner 名称", record["from"])
        self.assertEqual(record["subject"], "你好 world")

    def test_missing_from_is_ignored(self):
        record = classify(fakes.message_with_headers(fakes.AR_VALID, sender=""), OWNER_RULE, NOW)
        self.assertEqual(record["address"], "")
        self.assertEqual(record["status"], "ignored")
        self.assertEqual(record["identity"], "guest")

    def test_arbitrary_identity_passes_through(self):
        rules = [{"address": "owner@example.com", "identity": "vendor"}]
        record = classify(msg(), rules, NOW)
        self.assertEqual(record["identity"], "vendor")

    def test_empty_rules_means_ignored(self):
        record = classify(msg(), [], NOW)
        self.assertEqual(record["status"], "ignored")
        self.assertEqual(record["identity"], "guest")

    def test_message_id_and_folded_subject_are_single_lined(self):
        import email

        parsed = email.message_from_bytes(
            fakes.raw_message(7, subject="a long subject the sender\n across two lines")
        )
        record = classify(parsed, OWNER_RULE, NOW)
        self.assertEqual(
            record["subject"], "a long subject the sender across two lines"
        )
        self.assertNotIn("\n", record["subject"])

    def test_source_is_normalized_to_ok_or_risk(self):
        with mock.patch.object(classify_module, "verify_source", return_value=("OK", "x")):
            record = classify(msg(), OWNER_RULE, NOW)
        self.assertEqual(record["source"], "ok")
        with mock.patch.object(classify_module, "verify_source", return_value=("warn", "x")):
            record = classify(msg(), OWNER_RULE, NOW)
        self.assertEqual(record["source"], "risk")

    def test_decode_header_value_binding_is_patchable(self):
        """规格要求 classify 里的 decode_header_value 是模块绑定，测试可 patch。"""
        with mock.patch.object(
            classify_module, "decode_header_value", side_effect=LookupError("boom")
        ):
            with self.assertRaises(LookupError):
                classify(msg(), OWNER_RULE, NOW)

    def test_uid_is_filled_by_caller_not_classify(self):
        record = classify(msg(), OWNER_RULE, NOW)
        self.assertEqual(record["uid"], 0)


class DateAgeTest(unittest.TestCase):
    def test_recent_date(self):
        date = formatdate(NOW - 40 * 86400, usegmt=True)
        age = date_age_days(date, NOW)
        self.assertAlmostEqual(age, 40.0, places=3)

    def test_future_date_is_clamped_to_zero(self):
        date = formatdate(NOW + 10 * 86400, usegmt=True)
        self.assertEqual(date_age_days(date, NOW), 0.0)

    def test_naive_date_is_treated_as_utc(self):
        self.assertIsNotNone(date_age_days("Wed, 01 Jan 2020 00:00:00", NOW))

    def test_invalid_missing_dates_return_none(self):
        self.assertIsNone(date_age_days(None, NOW))
        self.assertIsNone(date_age_days("", NOW))
        self.assertIsNone(date_age_days("not a date", NOW))

    def test_boundary_around_30_days(self):
        self.assertLess(date_age_days(formatdate(NOW - 29 * 86400, usegmt=True), NOW), 30)
        self.assertGreater(date_age_days(formatdate(NOW - 31 * 86400, usegmt=True), NOW), 30)


if __name__ == "__main__":
    unittest.main()

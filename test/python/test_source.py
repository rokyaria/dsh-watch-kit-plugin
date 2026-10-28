"""``mailbox_core.source`` 单元测试：Authentication-Results / DMARC → OK/RISK 判定矩阵。"""

from __future__ import annotations

import unittest

from support import fakes
from support.paths import MAILBOX_DIR  # noqa: F401

from mailbox_core import source


def message(headers: str, sender: str = "owner@example.com"):
    return fakes.message_with_headers(headers, sender=sender)


class VerifySourceTest(unittest.TestCase):
    def test_valid_ar_is_ok(self):
        level, detail = source.verify_source(message(fakes.AR_VALID))
        self.assertEqual(level, "ok")
        self.assertIn("DMARC=pass", detail)
        self.assertIn("header.from=example.com", detail)

    def test_missing_ar_is_risk(self):
        level, detail = source.verify_source(message(""))
        self.assertEqual(level, "risk")
        self.assertIn("缺少 Authentication-Results", detail)

    def test_dmarc_fail_is_risk(self):
        headers = (
            "Authentication-Results: mx.example; "
            "spf=pass dkim=pass dmarc=fail header.from=example.com\n"
        )
        level, detail = source.verify_source(message(headers))
        self.assertEqual(level, "risk")
        self.assertIn("DMARC 未通过", detail)
        self.assertIn("dmarc=fail", detail)

    def test_dmarc_pass_but_no_aligned_method_is_risk(self):
        headers = (
            "Authentication-Results: mx.example; "
            "spf=fail dkim=fail dmarc=pass header.from=example.com\n"
        )
        level, detail = source.verify_source(message(headers))
        self.assertEqual(level, "risk")
        self.assertIn("SPF/DKIM", detail)

    def test_missing_header_from_is_risk(self):
        headers = "Authentication-Results: mx.example; spf=pass dkim=pass dmarc=pass\n"
        level, detail = source.verify_source(message(headers))
        self.assertEqual(level, "risk")
        self.assertIn("header.from", detail)

    def test_missing_from_domain_is_risk(self):
        level, detail = source.verify_source(
            message(fakes.AR_VALID, sender="not-an-address")
        )
        self.assertEqual(level, "risk")
        self.assertIn("From 缺少有效域", detail)

    def test_domain_mismatch_is_risk(self):
        level, detail = source.verify_source(message(fakes.AR_MISMATCH))
        self.assertEqual(level, "risk")
        self.assertIn("不一致", detail)

    def test_from_subdomain_is_aligned_with_parent_domain(self):
        level, _detail = source.verify_source(
            message(fakes.AR_VALID, sender="Owner <owner@mail.example.com>")
        )
        self.assertEqual(level, "ok")

    def test_reverse_alignment_is_conservatively_risk(self):
        headers = (
            "Authentication-Results: mx.example; "
            "spf=pass dkim=pass dmarc=pass header.from=mail.example.com\n"
        )
        level, _detail = source.verify_source(message(headers))
        self.assertEqual(level, "risk")

    def test_first_ar_wins(self):
        # 第一条是接收方 AR：后面再出现伪造 AR 也不能翻盘。
        level, _detail = source.verify_source(
            message(fakes.AR_MISMATCH + fakes.AR_VALID)
        )
        self.assertEqual(level, "risk")
        level, _detail = source.verify_source(
            message(fakes.AR_VALID + fakes.AR_MISMATCH)
        )
        self.assertEqual(level, "ok")

    def test_extra_ar_headers_are_reported_in_detail(self):
        _level, detail = source.verify_source(message(fakes.AR_VALID + fakes.AR_VALID))
        self.assertIn("另有 1 条 AR 未采用", detail)

    def test_provider_ar_formats_are_ok(self):
        for name, header in (
            ("gmail", fakes.AR_GMAIL),
            ("fastmail", fakes.AR_FASTMAIL),
            ("outlook", fakes.AR_OUTLOOK),
        ):
            with self.subTest(name=name):
                level, detail = source.verify_source(message(header))
                self.assertEqual(level, "ok", detail)

    def test_method_values_are_case_insensitive(self):
        headers = (
            "Authentication-Results: mx.example; "
            "SPF=PASS DKIM=PASS DMARC=PASS header.from=Example.COM\n"
        )
        level, _detail = source.verify_source(message(headers))
        self.assertEqual(level, "ok")

    def test_malformed_ar_is_risk(self):
        level, detail = source.verify_source(message("Authentication-Results: not-a-result\n"))
        self.assertEqual(level, "risk")
        self.assertTrue(detail)

    def test_result_is_always_ok_or_risk(self):
        cases = [
            "",
            "Authentication-Results: mx.example;\n",
            "Authentication-Results: mx.example; dmarc=pass\n",
            "Authentication-Results: mx.example; spf=pass dkim=pass dmarc=pass\n",
            fakes.AR_VALID,
            fakes.AR_MISMATCH,
            "Authentication-Results: mx.example; spf=softfail dkim=none dmarc=bestguesspass"
            " header.from=example.com\n",
        ]
        for headers in cases:
            with self.subTest(headers=headers):
                level, detail = source.verify_source(message(headers))
                self.assertIn(level, ("ok", "risk"))
                self.assertIsInstance(detail, str)
                self.assertTrue(detail)


class DomainHelpersTest(unittest.TestCase):
    def test_address_domain(self):
        self.assertEqual(source.address_domain("Owner@Example.COM"), "example.com")
        self.assertEqual(source.address_domain("owner@mail.example.com."), "mail.example.com")
        self.assertEqual(source.address_domain("no-at-sign"), "")
        self.assertEqual(source.address_domain(None), "")

    def test_domains_aligned(self):
        self.assertTrue(source.domains_aligned("example.com", "example.com"))
        self.assertTrue(source.domains_aligned("mail.example.com", "example.com"))
        self.assertFalse(source.domains_aligned("example.com", "mail.example.com"))
        self.assertFalse(source.domains_aligned("evil.com", "example.com"))
        self.assertFalse(source.domains_aligned("", "example.com"))
        self.assertFalse(source.domains_aligned("example.com", ""))

    def test_address_domain_and_alignment_are_lowercase_insensitive(self):
        self.assertEqual(source.address_domain("a@B.C"), "b.c")
        self.assertTrue(source.domains_aligned("A.B.C", "b.c"))


if __name__ == "__main__":
    unittest.main()

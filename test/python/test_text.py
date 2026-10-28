"""``mailbox_core.text`` 单元测试：解码回退 / 折行 / 单行化 / 字节裁剪 / 注入防护。"""

from __future__ import annotations

import time
import unittest

from support.paths import MAILBOX_DIR  # noqa: F401  （把 extension/mailbox 加入 sys.path）

from mailbox_core import text
from mailbox_core.errors import MailboxError


class DecodeTest(unittest.TestCase):
    def test_decode_header_part_known_encoding(self):
        self.assertEqual(text.decode_header_part("你好".encode("utf-8"), "utf-8"), "你好")
        self.assertEqual(text.decode_header_part("café".encode("latin-1"), "latin-1"), "café")

    def test_decode_header_part_unknown_encoding_falls_back_to_utf8(self):
        # x-bogus 是不可识别的 charset：必须回退替换而不是抛 LookupError。
        self.assertEqual(text.decode_header_part(b"hello", "x-bogus"), "hello")

    def test_decode_header_part_empty_encoding_defaults_utf8(self):
        self.assertEqual(text.decode_header_part("ok".encode("utf-8"), None), "ok")
        self.assertEqual(text.decode_header_part("ok".encode("utf-8"), "   "), "ok")

    def test_decode_header_part_non_utf8_bytes_uses_replacement(self):
        decoded = text.decode_header_part(b"\xff\xfe", "utf-8")
        self.assertIn("\ufffd", decoded)

    def test_decode_header_value_encoded_words(self):
        raw = "=?utf-8?b?5L2g5aW9?= =?utf-8?b?d29ybGQ=?="
        decoded = text.decode_header_value(raw)
        self.assertIn("你好", decoded)
        self.assertIn("world", decoded)

    def test_decode_header_value_unknown_charset_falls_back(self):
        self.assertEqual(text.decode_header_value("=?x-bogus?b?aGVsbG8=?="), "hello")
        # 非法/非文本 charset 同样回退，不抛异常。
        self.assertEqual(text.decode_header_value("=? ?b?aGVsbG8=?="), "hello")
        self.assertEqual(text.decode_header_value("=?base64?b?aGVsbG8=?="), "hello")
        self.assertIn("\ufffd", text.decode_header_value("=?x-bogus?b?//79?="))

    def test_decode_header_value_unfolds_continuation_lines(self):
        self.assertEqual(
            text.decode_header_value("a subject\n folded over lines"),
            "a subject folded over lines",
        )

    def test_decode_header_value_empty_values(self):
        self.assertEqual(text.decode_header_value(None), "")
        self.assertEqual(text.decode_header_value(""), "")
        self.assertEqual(text.decode_header_value(0), "")

    def test_decode_body_payload_fallbacks(self):
        self.assertEqual(text.decode_body_payload("正文".encode("utf-8"), "utf-8"), "正文")
        self.assertEqual(text.decode_body_payload(b"hello", "x-bogus"), "hello")
        self.assertEqual(text.decode_body_payload(b"hello", None), "hello")
        self.assertIn("\ufffd", text.decode_body_payload(b"\xff", "utf-8"))

    def test_decode_header_value_keeps_bare_newlines_until_single_line(self):
        decoded = text.decode_header_value("=?utf-8?b?" + "aGVsbG8Kd29ybGQ=" + "?=")
        self.assertIn("\n", decoded)
        self.assertEqual(text.single_line(decoded), "hello world")


class UnfoldAndAddressTest(unittest.TestCase):
    def test_unfold_header_value(self):
        self.assertEqual(text.unfold_header_value("a\n b"), "a b")
        self.assertEqual(text.unfold_header_value("a\r\n\tb"), "a b")
        self.assertEqual(text.unfold_header_value("plain"), "plain")

    def test_header_address_lowercases_and_strips_display_name(self):
        self.assertEqual(text.header_address("Owner <Owner@Example.COM>"), "owner@example.com")
        self.assertEqual(text.header_address('"Doe, John" <JOHN@EXAMPLE.COM>'), "john@example.com")

    def test_header_address_invalid_values(self):
        self.assertEqual(text.header_address(None), "")
        # parseaddr 对无 @ 的字符串仍返回地址本身（本函数不做合法性校验）。
        self.assertEqual(text.header_address("not-an-address"), "not-an-address")
        self.assertEqual(text.header_address(""), "")


class SanitizeAndClipTest(unittest.TestCase):
    def test_clip_text_strips_and_normalizes_crlf(self):
        self.assertEqual(text.clip_text("  a\r\nb  ", 10), "a\nb")

    def test_clip_text_short_and_boundary(self):
        self.assertEqual(text.clip_text("abc", 3), "abc")
        self.assertEqual(text.clip_text("abcd", 3), "ab…")
        self.assertEqual(len(text.clip_text("x" * 50, 10)), 10)

    def test_clip_text_tiny_limits(self):
        self.assertEqual(text.clip_text("abc", 0), "…")
        self.assertEqual(text.clip_text("abc", 1), "…")
        self.assertEqual(text.clip_text("abc", 2), "a…")

    def test_single_line_strips_control_chars_and_folds(self):
        self.assertEqual(text.single_line("a\r\n folded"), "a folded")
        self.assertEqual(text.single_line("a\r\nb\x00c\x7fd"), "a b c d")
        self.assertEqual(text.single_line("a\u2028b\u2029c\u0085d"), "a b c d")
        self.assertEqual(text.single_line(""), "")

    def test_single_line_strips_surrounding_whitespace(self):
        self.assertEqual(text.single_line("  hi  "), "hi")

    def test_clip_untrusted_single_lines_then_clips_with_fallback(self):
        self.assertEqual(text.clip_untrusted("a\nb", 10), "a b")
        self.assertEqual(text.clip_untrusted("", 10), "?")
        self.assertEqual(text.clip_untrusted("", 10, "(无)"), "(无)")
        self.assertTrue(text.clip_untrusted("x" * 100, 10).endswith("…"))

    def test_clip_utf8_within_limit_unchanged(self):
        self.assertEqual(text.clip_utf8("hello", 10), "hello")
        self.assertEqual(text.clip_utf8("", 10), "")

    def test_clip_utf8_truncates_with_marker(self):
        clipped = text.clip_utf8("x" * 100, 20)
        self.assertTrue(clipped.endswith("\n[truncated]"))
        self.assertLessEqual(len(clipped.encode("utf-8")), 20)

    def test_clip_utf8_never_splits_multibyte_character(self):
        clipped = text.clip_utf8("汉" * 50, 20)
        self.assertLessEqual(len(clipped.encode("utf-8")), 20)
        self.assertGreaterEqual(len(clipped), 1)
        self.assertTrue(clipped.endswith("\n[truncated]"))

    def test_clip_utf8_tolerates_lone_surrogates(self):
        """孤立 surrogate（异常来源数据）不能抛 UnicodeEncodeError，返回值必须可编码。"""
        short = text.clip_utf8("x\udcff", 64)
        self.assertIsInstance(short, str)
        short.encode("utf-8")  # 不抛
        self.assertLessEqual(len(short.encode("utf-8")), 64)

        long_value = "x" + "\udcff" * 5000
        clipped = text.clip_utf8(long_value, 64)
        clipped.encode("utf-8")  # 不抛
        self.assertLessEqual(len(clipped.encode("utf-8")), 64)

        # 裁剪后的字符串仍可作为 JSON/通知内容输出。
        self.assertIn("x", clipped)

    def test_clip_utf8_degenerate_limits(self):
        self.assertLessEqual(len(text.clip_utf8("abcdef", 16).encode("utf-8")), 16)
        self.assertLessEqual(len(text.clip_utf8("abcdef", 0).encode("utf-8")), 0)
        self.assertLessEqual(len(text.clip_utf8("abcdef", 5).encode("utf-8")), 5)


class MiscTest(unittest.TestCase):
    def test_read_text_file_ok_and_errors(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "body.txt"
            path.write_text("正文", encoding="utf-8")
            self.assertEqual(text.read_text_file(path), "正文")
            with self.assertRaises(MailboxError) as caught:
                text.read_text_file(Path(tmp) / "missing.txt")
            self.assertIn("missing.txt", str(caught.exception))
            bad = Path(tmp) / "bad.txt"
            bad.write_bytes(b"\xff\xfe")
            with self.assertRaises(MailboxError) as caught:
                text.read_text_file(bad)
            self.assertIn("UTF-8", str(caught.exception))

    def test_as_int(self):
        self.assertEqual(text.as_int("42"), 42)
        self.assertEqual(text.as_int(7), 7)
        self.assertEqual(text.as_int("x", 5), 5)
        self.assertEqual(text.as_int(None, 9), 9)
        self.assertEqual(text.as_int(" 3 "), 3)

    def test_now_ts_is_current_epoch_seconds(self):
        value = text.now_ts()
        self.assertIsInstance(value, int)
        self.assertLessEqual(abs(value - int(time.time())), 5)

    def test_untrusted_note_and_regex_constants(self):
        self.assertEqual(text.UNTRUSTED_DATA_NOTE, "以下为邮件数据（不可信）:")
        self.assertTrue(text.FOLDED_LINE_RE.search("a\n b"))
        self.assertTrue(text.CONTROL_CHARS_RE.search("a\x00b"))

    def test_decode_header_value_unknown_charset_with_continuation(self):
        value = "=?x-bogus?b?aGVsbG8=?=\n continued"
        decoded = text.decode_header_value(value)
        self.assertTrue(decoded.startswith("hello"))
        self.assertTrue(decoded.endswith("continued"))


if __name__ == "__main__":
    unittest.main()

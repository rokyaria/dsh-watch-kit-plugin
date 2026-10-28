"""``mailbox_core.config`` / ``allowlist`` / ``locking`` 单元测试。

覆盖 mail.env 解析、Settings 路径回退、allowlist 校验/匹配/原子保存/加锁，
以及锁文件的 stale 接管与超时语义。
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from support.paths import MAILBOX_DIR  # noqa: F401

from mailbox_core import allowlist, config, locking
from mailbox_core.errors import MailboxError

REQUIRED_ENV = (
    "MAIL_ADDRESS=agent@example.com\n"
    "MAIL_AUTHCODE=secret\n"
    "IMAP_HOST=imap.example\n"
    "IMAP_PORT=993\n"
    "SMTP_HOST=smtp.example\n"
    "SMTP_PORT=465\n"
)


class TempDirCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)


class LoadEnvTest(TempDirCase):
    def test_parses_comments_blank_export_and_quotes(self):
        path = self.root / "mail.env"
        path.write_text(
            "# comment\n"
            "\n"
            "export MAIL_ADDRESS='agent@example.com'\n"
            'MAIL_AUTHCODE="secret value"\n'
            "IMAP_HOST=imap.example\n"
            "IMAP_PORT=993\n"
            "SMTP_HOST=smtp.example\n"
            "SMTP_PORT=465\n",
            encoding="utf-8",
        )
        env = config.load_env(path)
        self.assertEqual(env["MAIL_ADDRESS"], "agent@example.com")
        self.assertEqual(env["MAIL_AUTHCODE"], "secret value")
        self.assertEqual(env["IMAP_PORT"], "993")
        # 所有值都是字符串，且不打印任何值。
        self.assertTrue(all(isinstance(value, str) for value in env.values()))

    def test_missing_file_raises(self):
        with self.assertRaises(MailboxError) as caught:
            config.load_env(self.root / "nope.env")
        self.assertIn("缺少凭据文件", str(caught.exception))

    def test_missing_keys_lists_names_only(self):
        path = self.root / "mail.env"
        path.write_text(
            "MAIL_ADDRESS=agent@example.com\n"
            "MAIL_AUTHCODE=\n"
            "IMAP_HOST=imap.example\n"
            "IMAP_PORT=993\n"
            "SMTP_HOST=smtp.example\n"
            "SMTP_PORT=465\n",
            encoding="utf-8",
        )
        with self.assertRaises(MailboxError) as caught:
            config.load_env(path)
        message = str(caught.exception)
        self.assertIn("MAIL_AUTHCODE", message)
        self.assertIn("凭据文件缺少", message)

    def test_unpaired_quote_is_kept(self):
        path = self.root / "mail.env"
        path.write_text(
            'MAIL_ADDRESS="agent@example.com\n'
            "MAIL_AUTHCODE=secret\n"
            "IMAP_HOST=imap.example\n"
            "IMAP_PORT=993\n"
            "SMTP_HOST=smtp.example\n"
            "SMTP_PORT=465\n",
            encoding="utf-8",
        )
        env = config.load_env(path)
        self.assertTrue(env["MAIL_ADDRESS"].startswith('"'))


class SettingsTest(TempDirCase):
    def test_cli_values_are_resolved_and_folder_defaults(self):
        args = argparse.Namespace(
            env_file=str(self.root / "mail.env"),
            state_dir=str(self.root / "state"),
            allow_account_file=str(self.root / "allow.json"),
            folder=None,
        )
        settings = config.resolve_settings(args)
        self.assertTrue(settings.env_file.is_absolute())
        self.assertEqual(settings.env_file, (self.root / "mail.env").resolve())
        self.assertEqual(settings.state_dir, (self.root / "state").resolve())
        self.assertEqual(settings.allow_file, (self.root / "allow.json").resolve())
        self.assertEqual(settings.folder, config.DEFAULT_FOLDER)
        self.assertIsInstance(settings, config.Settings)

    def test_env_fallbacks(self):
        env = {
            "MAILBOX_ENV_FILE": str(self.root / "e.env"),
            "MAILBOX_STATE_DIR": str(self.root / "s"),
            "MAILBOX_ALLOW_ACCOUNT_FILE": str(self.root / "a.json"),
        }
        with mock.patch.dict(os.environ, env, clear=False):
            settings = config.resolve_settings(argparse.Namespace())
        self.assertEqual(settings.env_file, (self.root / "e.env").resolve())
        self.assertEqual(settings.state_dir, (self.root / "s").resolve())
        self.assertEqual(settings.allow_file, (self.root / "a.json").resolve())

    def test_cli_overrides_env(self):
        env = {
            "MAILBOX_ENV_FILE": str(self.root / "env.env"),
            "MAILBOX_STATE_DIR": str(self.root / "env-state"),
            "MAILBOX_ALLOW_ACCOUNT_FILE": str(self.root / "env.json"),
        }
        args = argparse.Namespace(
            env_file=str(self.root / "cli.env"),
            state_dir=str(self.root / "cli-state"),
            allow_account_file=str(self.root / "cli.json"),
            folder="Archive",
        )
        with mock.patch.dict(os.environ, env, clear=False):
            settings = config.resolve_settings(args)
        self.assertEqual(settings.env_file, (self.root / "cli.env").resolve())
        self.assertEqual(settings.folder, "Archive")

    def test_allow_file_defaults_under_state_dir(self):
        args = argparse.Namespace(
            env_file=str(self.root / "mail.env"),
            state_dir=str(self.root / "state"),
            allow_account_file=None,
            folder="INBOX",
        )
        settings = config.resolve_settings(args)
        self.assertEqual(
            settings.allow_file, (self.root / "state" / "allow-accounts.json").resolve()
        )

    def test_expand_path(self):
        with mock.patch.dict(os.environ, {"HOME": str(self.root)}, clear=False):
            self.assertEqual(config.expand_path("~/x"), (self.root / "x").resolve())
        with self.assertRaises(MailboxError):
            config.expand_path("")
        with self.assertRaises(MailboxError):
            config.expand_path(None)

    def test_normalize_identity(self):
        self.assertEqual(config.normalize_identity(" User "), "user")
        self.assertEqual(config.normalize_identity(None), "guest")
        self.assertEqual(config.normalize_identity(""), "guest")


class AllowlistTest(TempDirCase):
    def setUp(self) -> None:
        super().setUp()
        self.path = self.root / "allow.json"

    def write(self, data) -> None:
        self.path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def test_missing_file_returns_empty(self):
        self.assertEqual(allowlist.load_allow_file(self.path), {})

    def test_load_normalizes_addresses_identities_and_accounts(self):
        self.write(
            {
                "Agent@Example.COM": [
                    {"address": "Owner@Example.COM", "identity": "USER"},
                    {"address": "*"},
                ]
            }
        )
        data = allowlist.load_allow_file(self.path)
        self.assertEqual(
            data,
            {
                "agent@example.com": [
                    {"address": "owner@example.com", "identity": "user"},
                    {"address": "*", "identity": "guest"},
                ]
            },
        )

    def test_invalid_json_raises(self):
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(MailboxError) as caught:
            allowlist.load_allow_file(self.path)
        self.assertIn("不是合法 JSON", str(caught.exception))

    def test_type_errors(self):
        for data in ([], {"account": "not-a-list"}, {"account": ["not-a-dict"]}):
            with self.subTest(data=data):
                self.write(data)
                with self.assertRaises(MailboxError):
                    allowlist.load_allow_file(self.path)

    def test_invalid_addresses(self):
        for address in ("no-at", "a b@example.com", ""):
            with self.subTest(address=address):
                self.write({"agent@example.com": [{"address": address}]})
                with self.assertRaises(MailboxError) as caught:
                    allowlist.load_allow_file(self.path)
                # 保留旧契约文案：配置加载阶段的地址错误带“允许名单”前缀。
                self.assertIn("允许名单地址不合法:", str(caught.exception))

    def test_match_rule_exact_before_wildcard(self):
        rules = [
            {"address": "*", "identity": "guest"},
            {"address": "owner@example.com", "identity": "user"},
        ]
        self.assertEqual(allowlist.match_rule(rules, "OWNER@example.com")["identity"], "user")
        self.assertEqual(allowlist.match_rule(rules, "stranger@example.com")["identity"], "guest")
        self.assertIsNone(allowlist.match_rule(rules, ""))
        self.assertIsNone(allowlist.match_rule([], "owner@example.com"))

    def test_rules_for_account(self):
        self.write(
            {
                "agent@example.com": [{"address": "owner@example.com", "identity": "user"}],
                "other@example.com": [],
            }
        )
        self.assertEqual(
            allowlist.rules_for_account(self.path, "Agent@Example.COM"),
            [{"address": "owner@example.com", "identity": "user"}],
        )
        self.assertEqual(allowlist.rules_for_account(self.path, "unknown@example.com"), [])

    def test_save_is_atomic_private_and_unicode(self):
        allowlist.save_allow_file(
            self.path, {"agent@example.com": [{"address": "*", "identity": "访客"}]}
        )
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("访客", text)
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_save_does_not_follow_preplaced_tmp_symlink(self):
        """预置旧式 <allow>.tmp 符号链接时，保存不能跟随它写到外部文件。"""
        external = self.root / "victim.txt"
        legacy_tmp = self.path.with_name(self.path.name + ".tmp")
        os.symlink(str(external), str(legacy_tmp))
        allowlist.save_allow_file(
            self.path, {"agent@example.com": [{"address": "*", "identity": "guest"}]}
        )
        self.assertFalse(external.exists())  # 外部目标未被写入
        self.assertTrue(self.path.exists())
        self.assertEqual(
            allowlist.load_allow_file(self.path)["agent@example.com"],
            [{"address": "*", "identity": "guest"}],
        )
        # 预置的旧 tmp 符号链接原样保留，不被当成本次临时文件。
        self.assertTrue(legacy_tmp.is_symlink())
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_add_rule_creates_parent_and_replaces_same_address(self):
        deep_path = self.root / "a" / "b" / "allow.json"
        rule = allowlist.add_rule(deep_path, "agent@example.com", "New@Example.com", "Vendor")
        self.assertEqual(rule, {"address": "new@example.com", "identity": "vendor"})
        self.assertTrue(deep_path.exists())
        self.assertFalse(deep_path.with_name("allow.json.lock").exists())
        allowlist.add_rule(deep_path, "agent@example.com", "new@example.com", "boss")
        data = allowlist.load_allow_file(deep_path)
        self.assertEqual(
            data["agent@example.com"],
            [{"address": "new@example.com", "identity": "boss"}],
        )
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(deep_path.stat().st_mode), 0o600)

    def test_add_rule_validates_address(self):
        with self.assertRaises(MailboxError):
            allowlist.add_rule(self.path, "agent@example.com", "no-at", "user")

    def test_remove_rule_returns_count(self):
        allowlist.add_rule(self.path, "agent@example.com", "owner@example.com", "user")
        self.assertEqual(
            allowlist.remove_rule(self.path, "agent@example.com", "OWNER@example.com"), 1
        )
        self.assertEqual(
            allowlist.remove_rule(self.path, "agent@example.com", "owner@example.com"), 0
        )
        self.assertEqual(allowlist.load_allow_file(self.path)["agent@example.com"], [])


class FileLockTest(TempDirCase):
    def test_lock_creates_private_file_and_removes_it(self):
        lock_path = self.root / "allow.json.lock"
        with locking.file_lock(lock_path):
            self.assertTrue(lock_path.exists())
            content = lock_path.read_text(encoding="utf-8")
            self.assertIn(str(os.getpid()), content)
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o600)
        self.assertFalse(lock_path.exists())

    def test_taken_over_lock_file_is_not_deleted_on_release(self):
        """释放时只删“仍指向自己 inode”的锁文件；被接管后不能误删别人的锁。"""
        lock_path = self.root / "allow.json.lock"
        with locking.file_lock(lock_path):
            # 模拟持锁期间被接管：unlink 原锁并新建同名文件（新 inode）。
            lock_path.unlink()
            lock_path.write_text("other-owner 1\n", encoding="utf-8")
        self.assertTrue(lock_path.exists())
        self.assertEqual(lock_path.read_text(encoding="utf-8"), "other-owner 1\n")

    def test_dangling_symlink_lock_is_cleaned_without_busy_wait(self):
        """悬空 symlink 锁：不能忙等死循环；清理后正常获取锁。"""
        if os.name != "posix":
            self.skipTest("POSIX 符号链接语义")
        lock_path = self.root / "allow.json.lock"
        external = self.root / "target-not-exist"
        os.symlink(str(external), str(lock_path))
        start = time.monotonic()
        with locking.file_lock(lock_path, timeout=0.3):
            elapsed = time.monotonic() - start
            # 悬空链接被清理成真正的锁文件（不是 symlink）。
            self.assertFalse(lock_path.is_symlink())
            self.assertTrue(lock_path.exists())
        self.assertLess(elapsed, 2.0)  # 旧实现会忙等不返回
        self.assertFalse(lock_path.exists())
        self.assertFalse(external.exists())

    def test_stale_lock_is_taken_over(self):
        lock_path = self.root / "allow.json.lock"
        lock_path.write_text("999 0\n", encoding="utf-8")
        old = time.time() - 400
        os.utime(lock_path, (old, old))
        with locking.file_lock(lock_path, timeout=0.5, stale_after=300):
            self.assertTrue(lock_path.exists())
        self.assertFalse(lock_path.exists())

    def test_held_lock_times_out(self):
        lock_path = self.root / "allow.json.lock"
        with locking.file_lock(lock_path):
            start = time.monotonic()
            with self.assertRaises(MailboxError) as caught:
                with locking.file_lock(lock_path, timeout=0.2, stale_after=300):
                    pass
            elapsed = time.monotonic() - start
        self.assertIn("等待状态锁超时", str(caught.exception))
        self.assertLess(elapsed, 2.0)


if __name__ == "__main__":
    unittest.main()

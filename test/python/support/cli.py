"""CLI 黑盒测试夹具：临时 env / allowlist / state + fake IMAP/SMTP + ``main(argv)``。

用于 ``test_cli_contract.py`` 与 ``test_checker.py`` 的黑盒场景：

- ``MailboxCliCase`` 负责把 stdlib 的 IMAP/SMTP SSL 实现换成 fake、清掉可能
  影响路径解析的 ``MAILBOX_*`` 环境变量、并准备一个临时目录；
- ``run_cli(argv)`` 用 ``redirect_stdout/redirect_stderr`` 直接调入口 ``main``，
  返回 ``(exit_code, stdout, stderr)``，全程不碰真实 ``~/.dsh``；
- 解析 checker JSON、读取 SQLite 状态库、直接改表等常用断言辅助都在这里。
"""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from support import fakes

REPO_ROOT = Path(__file__).resolve().parents[3]
MAILBOX_DIR = REPO_ROOT / "extension" / "mailbox"

if str(MAILBOX_DIR) not in sys.path:
    sys.path.insert(0, str(MAILBOX_DIR))

import mail  # noqa: E402  （入口脚本；重构后是薄壳，仍保留 main）

ENV_TEMPLATE = (
    "MAIL_ADDRESS={address}\n"
    "MAIL_AUTHCODE={authcode}\n"
    "IMAP_HOST=imap.example\n"
    "IMAP_PORT=993\n"
    "SMTP_HOST=smtp.example\n"
    "SMTP_PORT=465\n"
)

DEFAULT_ALLOW = {
    "agent@example.com": [
        {"address": "owner@example.com", "identity": "user"},
        {"address": "guest@example.com", "identity": "guest"},
    ]
}

ENV_OVERRIDES = ("MAILBOX_ENV_FILE", "MAILBOX_STATE_DIR", "MAILBOX_ALLOW_ACCOUNT_FILE")


def _resolve_main():
    """返回 CLI 入口函数：优先真实实现包的 cli.main，兼容重构前单文件 mail.main。"""
    try:
        module = importlib.import_module("mailbox_core.cli")
    except ImportError:
        module = None
    entry = getattr(module, "main", None) if module is not None else None
    if entry is None:
        entry = getattr(mail, "main")
    return entry


class MailboxCliCase(unittest.TestCase):
    """黑盒 CLI 场景基类：每个测试一个临时目录 + 干净的 fake 服务器状态。"""

    account = "agent@example.com"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.env_file = self.root / "mail.env"
        self.state_dir = self.root / "state"
        self.allow_file = self.root / "allow.json"
        self.write_env()
        self.write_allow(DEFAULT_ALLOW)

        # 防呆：任何漏传显式路径的调用都不能落到真实 ~/.dsh。
        self._saved_env: dict[str, str | None] = {}
        for name in ENV_OVERRIDES:
            self._saved_env[name] = os.environ.pop(name, None)
            self.addCleanup(self._restore_env, name)

        fakes.FakeIMAP.reset()
        fakes.FakeSMTP.reset()
        for patcher in fakes.transport_patches():
            patcher.start()
            self.addCleanup(patcher.stop)

        self.main = _resolve_main()

    def _restore_env(self, name: str) -> None:
        old = self._saved_env.get(name)
        if old is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = old

    # ------------------------------------------------------------------ #
    # 环境与文件
    # ------------------------------------------------------------------ #

    def write_env(self, address: str | None = None, authcode: str = "secret") -> None:
        self.env_file.write_text(
            ENV_TEMPLATE.format(address=address or self.account, authcode=authcode),
            encoding="utf-8",
        )

    def write_allow(self, data: dict) -> None:
        self.allow_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def allow_rules(self, *rules: dict) -> None:
        self.write_allow({self.account: list(rules)})

    @property
    def common(self) -> list[str]:
        return [
            "--env-file", str(self.env_file),
            "--state-dir", str(self.state_dir),
            "--allow-account-file", str(self.allow_file),
            "--folder", "INBOX",
        ]

    def add_message(self, uid: int, **kwargs) -> bytes:
        """把一封原始邮件放进 fake IMAP；kwargs 透传给 ``raw_message``。"""
        raw = fakes.raw_message(uid, **kwargs)
        fakes.FakeIMAP.messages[uid] = raw
        return raw

    def add_attachment_message(self, uid: int, content: bytes = b"attachment-body",
                               filename: str = "report.txt") -> bytes:
        raw = fakes.raw_message_with_attachment(uid, content=content, filename=filename)
        fakes.FakeIMAP.messages[uid] = raw
        return raw

    # ------------------------------------------------------------------ #
    # 调用 CLI
    # ------------------------------------------------------------------ #

    def run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = self.main(argv)
        return code, out.getvalue(), err.getvalue()

    def run_cli_with_parse_error(self, argv: list[str]) -> tuple[int, str, str]:
        """argparse 自身错误会抛 SystemExit；捕获后返回同样的三元组。"""
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            with self.assertRaises(SystemExit) as caught:
                self.main(argv)
        return int(caught.exception.code or 0), out.getvalue(), err.getvalue()

    def check(self, *extra: str) -> tuple[int, str, str]:
        return self.run_cli(["check", *self.common, *extra])

    def check_json(self, *extra: str) -> tuple[int, str, str, dict]:
        code, out, err = self.check(*extra)
        return code, out, err, self.parse_json(out)

    @staticmethod
    def parse_json(text: str) -> dict:
        """解析 checker 输出：stdout 必须只有一行 JSON。"""
        lines = [line for line in text.strip().splitlines() if line.strip()]
        if len(lines) != 1:
            raise AssertionError(f"stdout 不是单行 JSON: {text!r}")
        return json.loads(lines[0])

    # ------------------------------------------------------------------ #
    # SQLite 状态库辅助（DB schema 是冻结契约，测试直接查表）
    # ------------------------------------------------------------------ #

    def state_path(self) -> Path:
        candidates = sorted(self.state_dir.glob("*.sqlite3"))
        if not candidates:
            raise AssertionError(f"状态目录里没有 sqlite3 文件: {self.state_dir}")
        return candidates[0]

    @contextlib.contextmanager
    def state_db(self):
        db = sqlite3.connect(str(self.state_path()))
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def state(self) -> dict:
        """返回 {messages: {uid: row}, scopes: [row], uidvalidity: latest}。"""
        with self.state_db() as db:
            rows = db.execute("SELECT * FROM messages ORDER BY uid").fetchall()
            scopes = db.execute(
                "SELECT * FROM scopes ORDER BY uidvalidity DESC"
            ).fetchall()
        return {
            "messages": {str(row["uid"]): dict(row) for row in rows},
            "scopes": [dict(row) for row in scopes],
            "uidvalidity": scopes[0]["uidvalidity"] if scopes else 0,
        }

    def message_row(self, uid: int) -> dict | None:
        with self.state_db() as db:
            row = db.execute("SELECT * FROM messages WHERE uid = ?", (int(uid),)).fetchone()
        return dict(row) if row is not None else None

    def update_message(self, uid: int, **fields) -> None:
        """直接改状态行（模拟 webhook/外部写入，用于构造边界场景）。"""
        assignments = ", ".join(f"{key} = ?" for key in fields)
        with self.state_db() as db:
            db.execute(
                f"UPDATE messages SET {assignments} WHERE uid = ?",
                (*fields.values(), int(uid)),
            )
            db.commit()

    def execute_sql(self, sql: str, params: tuple = ()) -> None:
        with self.state_db() as db:
            db.execute(sql, params)
            db.commit()

    # ------------------------------------------------------------------ #
    # 可移植 patch 辅助（重构前后模块布局不同）
    # ------------------------------------------------------------------ #

    @contextlib.contextmanager
    def patch_decode_header_value(self, new):
        """patch ``classify`` 实际使用的 decode_header_value 绑定。

        重构前它在 mail.py 里；重构后从 ``mailbox_core.text`` import 到
        ``mailbox_core.classify``（规格 §2 要求该绑定可被 patch）。
        """
        target = _decode_header_module()
        with mock.patch.object(target, "decode_header_value", new):
            yield


def original_decode_header_value():
    """返回 classify 当前使用的 decode_header_value 原始绑定（供 side_effect 包装）。"""
    module = _decode_header_module()
    if hasattr(module, "decode_header_value"):
        return getattr(module, "decode_header_value")
    return importlib.import_module("mailbox_core.text").decode_header_value


def _decode_header_module():
    if hasattr(mail, "decode_header_value"):
        return mail
    return importlib.import_module("mailbox_core.classify")

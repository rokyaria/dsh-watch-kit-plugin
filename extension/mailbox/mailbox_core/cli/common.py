"""CLI 公共参数与上下文加载。"""

from __future__ import annotations

import argparse
from typing import Any

from ..config import Settings, load_env, resolve_settings


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    """所有子命令共享的路径参数（命令行优先，其次 MAILBOX_* 环境变量）。"""
    parser.add_argument("--env-file", help="mail.env path (default ~/.dsh/secrets/mail.env)")
    parser.add_argument("--state-dir", help="state directory (default ~/.dsh/mailbox)")
    parser.add_argument(
        "--allow-account-file",
        help="allowlist JSON path (default <state-dir>/allow-accounts.json)",
    )
    parser.add_argument("--folder", default="INBOX", help="IMAP folder (default INBOX)")


def load_account_context(args: Any) -> tuple[dict[str, str], Settings, str]:
    """解析 Settings、读取凭据、返回 (env, settings, account)。"""
    settings = resolve_settings(args)
    env = load_env(settings.env_file)
    return env, settings, env["MAIL_ADDRESS"].strip().lower()

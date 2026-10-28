"""配置解析：默认路径、mail.env、CLI 通用参数 → Settings。

解析顺序：命令行参数 → ``MAILBOX_*`` 环境变量 → 默认值。路径统一展开 ``~``
并 ``resolve()`` 成绝对路径，避免不同命令在不同 cwd 下读写不同状态。
凭据只从 mail.env 读取；本模块不打印任何值。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import MailboxError

DEFAULT_ENV_FILE = Path.home() / ".dsh" / "secrets" / "mail.env"
DEFAULT_STATE_DIR = Path.home() / ".dsh" / "mailbox"
DEFAULT_FOLDER = "INBOX"

DEFAULT_REMIND_MINUTES = 30
DEFAULT_MAX_NOTIFY = 20
MAX_NOTIFY_UPPER = 100

# checker message 默认上限：给插件默认 8192B 留 256B 给 JSON 结构/尾注。
DEFAULT_MAX_MESSAGE_BYTES = 8192 - 256
DEFAULT_MAX_ERROR_BYTES = 2048

MAX_PROCESS_AGE_DAYS = 30
STATE_RETENTION_DAYS = 31

# 单轮最多拉多少个新 UID 的邮件头：新信风暴/首次 --notify-existing 大邮箱时，
# 保证 checker 不超 watch timeout，且每轮都有进展（剩余下轮继续）。
MAX_NEW_FETCH_PER_RUN = 200

REQUIRED_ENV_KEYS = ("MAIL_ADDRESS", "MAIL_AUTHCODE", "IMAP_HOST", "IMAP_PORT", "SMTP_HOST", "SMTP_PORT")


@dataclass(frozen=True)
class Settings:
    """一次命令要用到的路径与 folder。"""

    env_file: Path
    state_dir: Path
    allow_file: Path
    folder: str


def expand_path(value: Any, *, label: str = "路径") -> Path:
    """展开 ``~``、转绝对路径；空值抛 MailboxError。"""
    if value is None or str(value).strip() == "":
        raise MailboxError(f"{label}不能为空")
    return Path(os.path.expanduser(str(value).strip())).resolve()


def _pick_path(cli_value: Any, env_name: str, default: Path, *, label: str) -> Path:
    raw = cli_value or os.environ.get(env_name) or str(default)
    return expand_path(raw, label=label)


def resolve_settings(args: Any) -> Settings:
    """从 argparse Namespace（--env-file/--state-dir/--allow-account-file/--folder）解析 Settings。"""
    env_file = _pick_path(
        getattr(args, "env_file", None),
        "MAILBOX_ENV_FILE",
        DEFAULT_ENV_FILE,
        label="凭据文件路径",
    )
    state_dir = _pick_path(
        getattr(args, "state_dir", None),
        "MAILBOX_STATE_DIR",
        DEFAULT_STATE_DIR,
        label="状态目录路径",
    )
    allow_file = _pick_path(
        getattr(args, "allow_account_file", None),
        "MAILBOX_ALLOW_ACCOUNT_FILE",
        state_dir / "allow-accounts.json",
        label="允许名单路径",
    )
    folder = str(getattr(args, "folder", None) or DEFAULT_FOLDER)
    return Settings(env_file=env_file, state_dir=state_dir, allow_file=allow_file, folder=folder)


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def load_env(path: Path) -> dict[str, str]:
    """读取 mail.env；只做 KEY=VALUE（可带 ``export `` 前缀、允许注释/空行）。

    缺少必需键时抛 MailboxError，错误信息只列出键名，绝不回显值。
    """
    if not path.exists():
        raise MailboxError(f"缺少凭据文件: {path}")
    cfg: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MailboxError(f"读取凭据文件失败: {path} ({exc})") from exc
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        cfg[key.strip()] = _unquote(value)
    missing = [key for key in REQUIRED_ENV_KEYS if not cfg.get(key)]
    if missing:
        raise MailboxError(f"凭据文件缺少: {', '.join(missing)}")
    return cfg


def normalize_identity(value: Any) -> str:
    """identity 是 allowlist 定义的任意标签；空值回退 guest。"""
    return str(value or "").strip().lower() or "guest"

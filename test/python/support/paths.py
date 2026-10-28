"""仓库路径与 ``mailbox_core`` 导入引导。

单测文件统一先 ``from support.paths import MAILBOX_DIR  # noqa: F401``，
确保 ``extension/mailbox`` 在 ``sys.path`` 上，然后 import ``mailbox_core.*``。
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
MAILBOX_DIR = REPO_ROOT / "extension" / "mailbox"
TEST_PYTHON_DIR = Path(__file__).resolve().parents[1]

if str(MAILBOX_DIR) not in sys.path:
    sys.path.insert(0, str(MAILBOX_DIR))

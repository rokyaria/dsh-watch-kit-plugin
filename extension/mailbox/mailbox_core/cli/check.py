"""checker 子命令：薄包装 ``mailbox_core.checker.run_check``。"""

from __future__ import annotations

from typing import Any

from ..checker import run_check


def cmd_check(args: Any) -> int:
    return run_check(args)

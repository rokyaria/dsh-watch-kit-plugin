#!/usr/bin/env python3
"""mailbox checker / agent CLI —— dsh-watch-kit-plugin 随包扩展的入口。

这一个文件只是入口；实现（IMAP/SMTP、状态库、策略、CLI 子命令）在
``mailbox_core/`` 包里。两种运行方式都必须可用：

    python3 /path/to/extension/mailbox/mail.py check --json ...
    python3 -c "import sys; sys.path.insert(0, '/path/to/extension/mailbox'); import mail"

Python 3.9+，仅标准库。
"""

from __future__ import annotations

import sys
from pathlib import Path

_ENTRY_DIR = Path(__file__).resolve().parent
if str(_ENTRY_DIR) not in sys.path:
    sys.path.insert(0, str(_ENTRY_DIR))

from mailbox_core.cli import main  # noqa: E402

__all__ = ["main"]

if __name__ == "__main__":
    raise SystemExit(main())

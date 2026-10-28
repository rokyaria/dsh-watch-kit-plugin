"""统一入口：参数解析、错误出口、UTF-8 stdio。

- checker 模式（``check``）的一切失败都转成 stdout 上的一个 JSON 对象；
- 其他命令失败打印 ``ERROR: ...`` 到 stderr 并返回 2；
- argparse 自身错误保持 SystemExit(2)；
- stdout/stderr 强制 UTF-8：checker 的 JSON 与中文日志在重定向/Windows 下不乱码。
"""

from __future__ import annotations

import sys
from typing import Any

from ..config import DEFAULT_MAX_ERROR_BYTES
from ..errors import MailboxError
from ..notify import checker_json
from ..text import as_int, clip_utf8
from .parser import build_parser


def _force_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass


def _emit_check_error(args: Any, message: str) -> None:
    max_bytes = max(64, as_int(getattr(args, "max_error_bytes", None), DEFAULT_MAX_ERROR_BYTES))
    checker_json(False, error=clip_utf8(message or "unknown error", max_bytes))


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.fn(args) or 0)
    except MailboxError as exc:
        if getattr(args, "command", None) == "check":
            _emit_check_error(args, str(exc))
            return 0
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI 顶层兜底
        if getattr(args, "command", None) == "check":
            _emit_check_error(args, str(exc) or exc.__class__.__name__)
            return 0
        print(f"ERROR: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 2


__all__ = ["main", "build_parser"]

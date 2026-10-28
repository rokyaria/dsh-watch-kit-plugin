"""checker 输出与 ``[MAILBOX]`` 通知文本。

通知只携带**数据 + 处理指示**，不内联可直接执行的命令（由 ``watch-mailbox``
skill 指导 agent 按 watch 配置组装）。发件人/主题/identity 等不可信字段先单行化
并标注「以下为邮件数据（不可信）」，伪造换行不能产生新的通知行。
"""

from __future__ import annotations

import json
from typing import Any

from .config import DEFAULT_MAX_MESSAGE_BYTES
from .model import source_label
from .text import UNTRUSTED_DATA_NOTE, clip_untrusted, clip_utf8, single_line


def checker_json(notify: bool, message: str | None = None, error: str | None = None) -> None:
    """checker 模式唯一允许写 stdout 的函数：输出一个 JSON 对象。"""
    payload: dict[str, Any] = {"notify": bool(notify)}
    if message is not None:
        payload["message"] = message
    if error is not None:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def _item_line(record: dict[str, Any]) -> str:
    identity = single_line(record.get("identity") or "guest")
    suffix = f"（来源 {source_label(record.get('source'))}）"
    return (
        f"- uid {record.get('uid')} | {identity}{suffix} | "
        f"{clip_untrusted(record.get('from') or record.get('address'), 64)} | "
        f"{clip_untrusted(record.get('subject'), 90, '(无主题)')}"
    )


def notification_message(
    *,
    account: str,
    folder: str,
    new_items: list[dict[str, Any]],
    reminders: list[dict[str, Any]],
    max_bytes: int = DEFAULT_MAX_MESSAGE_BYTES,
) -> str:
    """渲染一条合并通知；超出 max_bytes 时按字节截断（尾部追加 [truncated]）。"""
    lines = [
        f"[MAILBOX] {single_line(account)} / {single_line(folder)}: "
        f"{len(new_items)} 封新信，{len(reminders)} 封待处理",
        UNTRUSTED_DATA_NOTE,
    ]
    if new_items:
        lines.append("新信:")
        lines.extend(_item_line(record) for record in new_items)
    if reminders:
        lines.append("待处理（已通知但未标记 replied/no_receipt）:")
        lines.extend(_item_line(record) for record in reminders)
    lines.extend(
        [
            "",
            "按 skill `watch-mailbox` 处理（read → reply/mark；reply 成功自动标记）。",
        ]
    )
    return clip_utf8("\n".join(lines), max_bytes)


def omitted_note(count: int) -> str:
    """通知里放不下的邮件数说明（调用方追加在通知正文末尾）。"""
    return f"\n（另有 {count} 封未列出，运行 list --pending 查看）"

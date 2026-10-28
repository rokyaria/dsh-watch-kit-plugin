"""新邮件分类 + Date 年龄过滤。

checker 只做“要不要交给 agent”的粗分类：allowlist 内 → ``pending``，名单外 →
``ignored``。是否回复、是否无需回执由 agent 按 ``watch-mailbox`` skill 决定。
"""

from __future__ import annotations

import email
from datetime import timezone
from typing import Any

from .allowlist import match_rule
from .model import DEFAULT_IDENTITY, STATUS_IGNORED, STATUS_PENDING, normalize_source
from .source import verify_source
from .text import decode_header_value, header_address, single_line


def date_age_days(value: Any, now: int) -> float | None:
    """邮件 Date 头距 now 的天数；缺失/非法返回 None，不臆造年龄。"""
    from email.utils import parsedate_to_datetime

    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    try:
        timestamp = parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return None
    return max(0.0, (now - timestamp) / 86400.0)


def classify(msg: email.message.Message, rules: list[dict[str, str]], now: int) -> dict[str, Any]:
    """把一封新邮件的头分类成状态库记录（uid 由调用方回填）。"""
    address = header_address(msg.get("From"))
    rule = match_rule(rules, address)
    source, _source_detail = verify_source(msg)
    base: dict[str, Any] = {
        "uid": 0,
        "address": address,
        "from": decode_header_value(msg.get("From")),
        "subject": decode_header_value(msg.get("Subject")),
        "message_id": single_line(msg.get("Message-ID")),
        "date": decode_header_value(msg.get("Date")),
        "first_seen_at": now,
        "last_notified_at": None,
        "source": normalize_source(source),
        "identity": DEFAULT_IDENTITY,
    }
    if not address or not rule:
        base.update(status=STATUS_IGNORED, identity=DEFAULT_IDENTITY)
        return base
    # 关注名单里的邮件全部交给 agent 决定 reply / mark；checker 只负责忽略名单外邮件。
    base.update(status=STATUS_PENDING, identity=rule["identity"], source=normalize_source(source))
    return base

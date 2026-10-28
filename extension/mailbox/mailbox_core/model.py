"""状态与来源的内部取值（唯一事实源）。

状态机（见 extension/mailbox/README.md）：

    ignored    不在 allowlist（或不需再处理）
    pending    在 allowlist；等待 agent read → reply/mark
    no_receipt agent 明确标记“无需回执”
    replied    reply 成功
    invalid    邮件头/分类解析失败
    gone       UID 已从 IMAP 消失

来源只有两态：``ok`` / ``risk``（保守判定；risk 表示“无法确认来源”，不是
“一定是伪造”）。展示层统一为大写 ``OK`` / ``RISK``。
"""

from __future__ import annotations

STATUS_IGNORED = "ignored"
STATUS_PENDING = "pending"
STATUS_NO_RECEIPT = "no_receipt"
STATUS_REPLIED = "replied"
STATUS_INVALID = "invalid"
STATUS_GONE = "gone"

STATE_STATUSES = frozenset(
    {
        STATUS_IGNORED,
        STATUS_PENDING,
        STATUS_NO_RECEIPT,
        STATUS_REPLIED,
        STATUS_INVALID,
        STATUS_GONE,
    }
)

SOURCE_OK = "ok"
SOURCE_RISK = "risk"

DEFAULT_IDENTITY = "guest"


def normalize_source(value: object) -> str:
    """把任意历史值收敛成 ``ok`` / ``risk``；只有明确 ``ok`` 才算 ok。"""
    return SOURCE_OK if str(value or "").strip().lower() == SOURCE_OK else SOURCE_RISK


def source_label(source: object) -> str:
    """状态库/通知统一只暴露两个来源状态：OK / RISK。"""
    return "OK" if normalize_source(source) == SOURCE_OK else "RISK"


def normalize_status(value: object, default: str = STATUS_IGNORED) -> str:
    text = str(value or "").strip().lower()
    return text if text in STATE_STATUSES else default

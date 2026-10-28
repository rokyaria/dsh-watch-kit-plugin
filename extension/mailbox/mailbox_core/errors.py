"""用户可读、可行动的 mailbox 错误。

只用于“配置/网络/状态/输入”这类能给出下一步动作的失败；内部编程错误继续用
普通异常，由 CLI 顶层兜底成 ``ERROR: <类名>: <消息>``。
"""

from __future__ import annotations


class MailboxError(Exception):
    """A user-actionable mailbox error."""

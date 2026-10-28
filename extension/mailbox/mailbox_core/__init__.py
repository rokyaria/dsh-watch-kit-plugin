"""mailbox checker / agent CLI 的实现包。

入口是仓库里的 ``extension/mailbox/mail.py``（脚本入口），行为契约见同目录
``README.md``；模块划分：

    errors      用户可读错误
    model       状态/来源常量
    text        头解码、单行化、字节裁剪
    config      路径/凭据/CLI 设置
    locking     可移植文件锁（allowlist 用）
    allowlist   per-account allowlist
    imap        IMAP 只读连接
    smtp        SMTP 发信/附件
    source      Authentication-Results / DMARC → ok/risk
    classify    新邮件分类 + Date 年龄
    state       per-account SQLite 状态库
    legacy      旧 JSONL → SQLite 迁移
    notify      checker JSON + 通知文本
    checker     check 模式流水线
    cli/*       argparse 与各子命令实现
"""

from __future__ import annotations

from .errors import MailboxError

__version__ = "0.3.1"

__all__ = ["MailboxError", "__version__"]

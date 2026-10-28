"""SMTP 发信与附件。

发送是**对外副作用**：reply/send 的行为策略由 ``watch-mailbox`` skill 与用户
约定决定，代码只提供能力，不做身份门禁。
"""

from __future__ import annotations

import mimetypes
import smtplib
from pathlib import Path
from typing import Any

from .errors import MailboxError
from .imap import ssl_context
from .text import read_text_file

DEFAULT_TIMEOUT_SECONDS = 30.0


def send_email(env: dict[str, str], message: Any, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
    """通过配置账户（MAIL_ADDRESS/MAIL_AUTHCODE）经 SMTP_SSL 发送。"""
    with smtplib.SMTP_SSL(
        env["SMTP_HOST"],
        int(env["SMTP_PORT"]),
        context=ssl_context(),
        timeout=timeout,
    ) as smtp:
        smtp.login(env["MAIL_ADDRESS"], env["MAIL_AUTHCODE"])
        smtp.send_message(message)


def add_attachments(message: Any, paths: list[str] | None) -> None:
    """把本地文件作为附件加入邮件；路径不存在/不是文件时抛 MailboxError。"""
    for raw_path in paths or []:
        path = Path(raw_path).expanduser()
        if not path.is_file():
            raise MailboxError(f"附件不存在: {path}")
        ctype, _ = mimetypes.guess_type(path.name)
        maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
        try:
            payload = path.read_bytes()
        except OSError as exc:
            raise MailboxError(f"读取附件失败: {path} ({exc})") from exc
        message.add_attachment(
            payload,
            maintype=maintype,
            subtype=subtype or "octet-stream",
            filename=path.name,
        )


def read_body_arg(body: str | None, body_file: str | None, *, label: str = "正文") -> str:
    """返回 --body 或 --body-file 的正文；都为空/空白时抛 MailboxError。"""
    text = body
    if text is None and body_file:
        text = read_text_file(Path(body_file).expanduser(), label=f"{label}文件")
    if text is None or not str(text).strip():
        raise MailboxError(f"{label}不能为空（--body 或 --body-file）")
    return str(text)

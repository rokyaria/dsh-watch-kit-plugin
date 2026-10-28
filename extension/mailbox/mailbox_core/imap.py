"""IMAP 连接与邮件读取（只读；不修改 ``\\Seen`` 等 flag）。

每次命令创建一个短连接：connect → login → select(readonly) → 操作 → close。
所有网络操作都不持有 SQLite 事务。
"""

from __future__ import annotations

import email
import imaplib
import os
import ssl
from pathlib import Path
from typing import Any

from .errors import MailboxError
from .text import as_int

DEFAULT_TIMEOUT_SECONDS = 30.0


def ssl_context() -> ssl.SSLContext:
    """构造 SSL 上下文；尊重 ``SSL_CERT_FILE``，并对 macOS 的 cert.pem 做兼容。"""
    cafile = os.environ.get("SSL_CERT_FILE")
    if not cafile:
        for candidate in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
            if Path(candidate).exists():
                cafile = candidate
                break
    return ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()


def _payload(data: Any) -> bytes | None:
    """从 imaplib FETCH 返回结构里取出第一个 bytes payload。"""
    if not data:
        return None
    for item in data:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], bytes):
            return item[1]
    return None


def _read_uidvalidity(mail: imaplib.IMAP4_SSL) -> int:
    """读取 SELECT 后服务器返回的 UIDVALIDITY（拿不到返回 0）。"""
    try:
        _typ, data = mail.response("UIDVALIDITY")
        if data and data[0]:
            raw = data[0].decode() if isinstance(data[0], bytes) else str(data[0])
            return as_int(raw)
    except (KeyError, ValueError, imaplib.IMAP4.error):
        pass
    try:
        untagged = mail.untagged_responses.get("UIDVALIDITY") or []
    except AttributeError:
        return 0
    if untagged:
        raw = untagged[0].decode() if isinstance(untagged[0], bytes) else str(untagged[0])
        return as_int(raw)
    return 0


class Mailbox:
    """一个短生命周期的 IMAP 只读连接。"""

    def __init__(self, env: dict[str, str], folder: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self.env = env
        self.folder = folder
        self.timeout = timeout
        self.mail: imaplib.IMAP4_SSL | None = None
        self._uidvalidity: int | None = None

    def connect(self) -> "Mailbox":
        try:
            self.mail = imaplib.IMAP4_SSL(
                self.env["IMAP_HOST"],
                int(self.env["IMAP_PORT"]),
                ssl_context=ssl_context(),
                timeout=self.timeout,
            )
            self.mail.login(self.env["MAIL_ADDRESS"], self.env["MAIL_AUTHCODE"])
            typ, _ = self.mail.select(self.folder, readonly=True)
            if typ != "OK":
                raise MailboxError(f"IMAP 选择文件夹失败: {self.folder}")
            # SELECT 之后立刻取 UIDVALIDITY：imaplib.response() 会清掉该 untagged 响应。
            self._uidvalidity = _read_uidvalidity(self.mail)
        except Exception:
            self.close()
            raise
        return self

    @property
    def uidvalidity(self) -> int:
        if self.mail is None:
            return 0
        if self._uidvalidity is None:
            self._uidvalidity = _read_uidvalidity(self.mail)
        return self._uidvalidity

    def uids(self) -> list[int]:
        """当前 folder 的全部 UID（升序、去重）。SEARCH 失败抛 MailboxError。"""
        if self.mail is None:
            raise MailboxError("IMAP 未连接")
        typ, data = self.mail.uid("SEARCH", None, "ALL")
        if typ != "OK":
            raise MailboxError("IMAP UID SEARCH 失败，保留现有状态")
        if not data or not data[0]:
            return []
        return sorted({as_int(item) for item in data[0].split() if as_int(item) > 0})

    def header(self, uid: int) -> email.message.Message:
        """只取邮件头（BODY.PEEK[HEADER]，不设置 \\Seen）。"""
        if self.mail is None:
            raise MailboxError("IMAP 未连接")
        typ, data = self.mail.uid("FETCH", str(uid), "(BODY.PEEK[HEADER])")
        if typ != "OK":
            raise MailboxError(f"读取邮件头失败: uid={uid}")
        raw = _payload(data)
        if raw is None:
            raise MailboxError(f"邮件不存在或已被删除: uid={uid}")
        return email.message_from_bytes(raw)

    def full(self, uid: int) -> email.message.Message:
        """取整封邮件（BODY.PEEK[]，不设置 \\Seen）。"""
        if self.mail is None:
            raise MailboxError("IMAP 未连接")
        typ, data = self.mail.uid("FETCH", str(uid), "(BODY.PEEK[])")
        if typ != "OK":
            raise MailboxError(f"读取邮件失败: uid={uid}")
        raw = _payload(data)
        if raw is None:
            raise MailboxError(f"邮件不存在或已被删除: uid={uid}")
        return email.message_from_bytes(raw)

    def close(self) -> None:
        """幂等关闭；close/logout 的异常都吞掉（连接可能已经断开）。"""
        mail, self.mail = self.mail, None
        if mail is None:
            return
        for action in (mail.close, mail.logout):
            try:
                action()
            except Exception:
                pass

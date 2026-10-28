"""Fake IMAP/SMTP 与邮件构造器（Python 测试专用，绝不访问真实网络）。

设计要点：

- ``FakeIMAP``/``FakeSMTP`` 的类属性就是"服务器端状态"，测试在 ``setUp`` 里
  调 ``reset()``，之后直接改 ``FakeIMAP.messages`` 等即可模拟新信/坏 UID；
- 实现模块按契约使用 ``import imaplib`` / ``import smtplib``，因此 patch
  stdlib 模块属性与 patch ``mailbox_core.imap.imaplib.IMAP4_SSL`` 等价，
  且重构前（单文件 mail.py）与重构后（mailbox_core 包）通用；
- ``raw_message`` 系列尽量贴近真实服务器返回的原始字节，默认带一条
  ``dmarc=pass`` 的 Authentication-Results，使来源判定为 OK。
"""

from __future__ import annotations

import base64
import email
import imaplib
import smtplib
import time
from email.utils import formatdate
from unittest import mock

DEFAULT_UIDVALIDITY = 100

# 标准 DMARC=pass 的 Authentication-Results（From 域 example.com 对齐）。
AR_VALID = (
    "Authentication-Results: mx.example; "
    "spf=pass dkim=pass dmarc=pass header.from=example.com\n"
)
# header.from 与 From 域不一致：来源应判定为 RISK。
AR_MISMATCH = (
    "Authentication-Results: mx.example; "
    "spf=pass dkim=pass dmarc=pass header.from=evil.example\n"
)

# 三种主流厂商的 Authentication-Results 头格式（含折行）。
AR_GMAIL = (
    "Authentication-Results: mx.google.com;\n"
    "       dkim=pass header.i=@example.com header.s=20230601 header.b=abc;\n"
    "       spf=pass (google.com: domain of owner@example.com designates 1.2.3.4 as permitted sender)"
    " smtp.mailfrom=owner@example.com;\n"
    "       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com\n"
)
AR_FASTMAIL = (
    "Authentication-Results: mx1.messagingengine.com;\n"
    " spf=pass smtp.mailfrom=owner@example.com;\n"
    " dkim=pass header.d=example.com header.s=fastmail;\n"
    " dmarc=pass header.from=example.com\n"
)
AR_OUTLOOK = (
    "Authentication-Results: spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=example.com;\n"
    " dkim=pass (signature was verified) header.d=example.com;\n"
    " dmarc=pass action=none header.from=example.com; compauth=pass reason=100\n"
)


class FakeIMAP:
    """可配置的假 ``imaplib.IMAP4_SSL``。

    类属性（测试直接修改以模拟服务器行为）：

    - ``uidvalidity``：``response("UIDVALIDITY")`` 返回的值；
    - ``messages``：``{uid: raw_bytes}``；
    - ``broken_uids``：SEARCH 可见但 FETCH 返回 NO 的 UID（模拟临时读取失败）；
    - ``search_error``：SEARCH 整体失败。
    """

    uidvalidity = DEFAULT_UIDVALIDITY
    messages: dict[int, bytes] = {}
    broken_uids: set[int] = set()
    search_error = False
    instances: list["FakeIMAP"] = []

    def __init__(self, host, port, ssl_context=None, timeout=None, **kwargs):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.untagged_responses: dict = {}
        self.logged_in = False
        self.address = ""
        self.selected_folder = None
        self.readonly = False
        self.closed = False
        self.logged_out = False
        FakeIMAP.instances.append(self)

    @classmethod
    def reset(cls, *, uidvalidity: int = DEFAULT_UIDVALIDITY) -> None:
        cls.uidvalidity = uidvalidity
        cls.messages = {}
        cls.broken_uids = set()
        cls.search_error = False
        cls.instances = []

    def login(self, address, authcode):
        self.logged_in = True
        self.address = address
        return "OK", [b"logged in"]

    def select(self, folder, readonly=False):
        self.selected_folder = folder
        self.readonly = readonly
        return "OK", [b"1"]

    def response(self, name):
        if str(name).upper() == "UIDVALIDITY":
            return "UIDVALIDITY", [str(FakeIMAP.uidvalidity).encode()]
        return str(name), []

    def uid(self, command, *args):
        command = str(command).upper()
        if command == "SEARCH":
            if FakeIMAP.search_error:
                return "NO", [None]
            uids = sorted(set(FakeIMAP.messages) | set(FakeIMAP.broken_uids))
            return "OK", [b" ".join(str(uid).encode() for uid in uids)]
        if command == "FETCH":
            uid = int(args[0])
            if uid in FakeIMAP.broken_uids:
                return "NO", [None]
            raw = FakeIMAP.messages.get(uid)
            if raw is None:
                return "OK", [None]
            # 不区分 BODY.PEEK[HEADER]/BODY.PEEK[]：测试里返回同一份原始邮件。
            return "OK", [(f"{uid} (BODY)".encode(), raw)]
        return "OK", [None]

    def close(self):
        self.closed = True
        return "OK", [b"CLOSED"]

    def logout(self):
        self.logged_out = True
        return "BYE", [b"BYE"]


class FakeSMTP:
    """可配置的假 ``smtplib.SMTP_SSL``；``sent`` 记录发出的 EmailMessage。"""

    sent: list = []
    instances: list["FakeSMTP"] = []
    login_error: Exception | None = None
    send_error: Exception | None = None

    def __init__(self, host, port, context=None, timeout=None, **kwargs):
        self.host = host
        self.port = port
        self.closed = False
        self.logged_in = False
        FakeSMTP.instances.append(self)

    @classmethod
    def reset(cls) -> None:
        cls.sent = []
        cls.instances = []
        cls.login_error = None
        cls.send_error = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.closed = True
        return False

    def login(self, address, authcode):
        if FakeSMTP.login_error is not None:
            raise FakeSMTP.login_error
        self.logged_in = True
        return "OK", [b"logged in"]

    def send_message(self, message):
        if FakeSMTP.send_error is not None:
            raise FakeSMTP.send_error
        FakeSMTP.sent.append(message)


def transport_patches() -> list:
    """返回未启动的 patcher：把 stdlib 的 SSL 实现替换为 fake。

    ``mailbox_core.imap.imaplib`` 与 ``imaplib`` 是同一个模块对象，所以这里
    patch stdlib 属性对重构前后的实现都生效（等价于规格里给出的 patch 目标）。
    """
    return [
        mock.patch.object(imaplib, "IMAP4_SSL", FakeIMAP),
        mock.patch.object(smtplib, "SMTP_SSL", FakeSMTP),
    ]


# --------------------------------------------------------------------------- #
# 原始邮件构造器
# --------------------------------------------------------------------------- #

def encoded_word(text: str, charset: str = "utf-8") -> str:
    """把任意文本编码成 RFC2047 encoded-word（用于构造不可信邮件头）。"""
    encoded = base64.b64encode(text.encode(charset)).decode("ascii")
    return f"=?{charset}?b?{encoded}?="


def raw_message(
    uid: int,
    sender: str = "owner@example.com",
    subject: str = "hello",
    *,
    auth: bool = True,
    extra_headers: str = "",
    date: str | None = None,
    body: str | None = None,
    to: str = "agent@example.com",
) -> bytes:
    """构造一封普通 text/plain 原始邮件；默认来源验证为 OK。"""
    auth_header = AR_VALID if auth else ""
    return (
        f"From: {sender}\n"
        f"To: {to}\n"
        f"Subject: {subject}\n"
        f"Date: {date or formatdate(time.time(), usegmt=True)}\n"
        f"Message-ID: <m{uid}@example.com>\n"
        f"{auth_header}"
        f"{extra_headers}"
        "Content-Type: text/plain; charset=utf-8\n"
        "\n"
        f"{body if body is not None else f'body {uid}'}\n"
    ).encode("utf-8")


def raw_message_with_attachment(
    uid: int,
    content: bytes = b"attachment-body",
    filename: str = "report.txt",
    *,
    sender: str = "owner@example.com",
    date: str | None = None,
) -> bytes:
    """构造一封 multipart/mixed、带一个附件的邮件（用于 attach/read 测试）。"""
    payload = base64.b64encode(content).decode("ascii")
    return (
        f"From: {sender}\n"
        "To: agent@example.com\n"
        f"Subject: mail with attachment {uid}\n"
        f"Date: {date or formatdate(time.time(), usegmt=True)}\n"
        f"Message-ID: <attach{uid}@example.com>\n"
        f"{AR_VALID}"
        "MIME-Version: 1.0\n"
        'Content-Type: multipart/mixed; boundary="BOUNDARY"\n'
        "\n"
        "--BOUNDARY\n"
        'Content-Type: text/plain; charset=utf-8\n'
        "\n"
        "body with attachment\n"
        "--BOUNDARY\n"
        f'Content-Type: text/plain; name="{filename}"\n'
        f'Content-Disposition: attachment; filename="{filename}"\n'
        "Content-Transfer-Encoding: base64\n"
        "\n"
        f"{payload}\n"
        "--BOUNDARY--\n"
    ).encode("utf-8")


def raw_message_invalid_body_charset(uid: int = 1, body: str = "body text") -> bytes:
    """正文 charset 非法（发件人可控）的邮件：read 必须回退解码而不是报错。"""
    return (
        "From: owner@example.com\n"
        "To: agent@example.com\n"
        "Subject: bad charset\n"
        f"Date: {formatdate(time.time(), usegmt=True)}\n"
        f"Message-ID: <bad{uid}@example.com>\n"
        f"{AR_VALID}"
        "Content-Type: text/plain; charset=x-bogus\n"
        "\n"
        f"{body}\n"
    ).encode("utf-8")


def message_with_headers(
    extra_headers: str,
    sender: str = "owner@example.com",
    subject: str = "hello",
) -> email.message.Message:
    """构造一封只用于 ``verify_source``/``classify`` 解析的邮件对象。"""
    raw = (
        f"From: {sender}\n"
        "To: agent@example.com\n"
        f"Subject: {subject}\n"
        f"Date: {formatdate(time.time(), usegmt=True)}\n"
        "Message-ID: <matrix@example.com>\n"
        f"{extra_headers}"
        "Content-Type: text/plain; charset=utf-8\n"
        "\n"
        "body\n"
    ).encode("utf-8")
    return email.message_from_bytes(raw)


def raw_multipart_message(
    uid: int,
    parts: list[tuple],
    *,
    subject: str = "multipart",
    sender: str = "owner@example.com",
    auth: bool = True,
) -> bytes:
    """构造任意 multipart/mixed 原始邮件。

    ``parts`` 每项为 ``(content_type, disposition, filename, text)``：

    - ``content_type``：如 "text/plain"、"text/html"；
    - ``disposition``：None 表示内联，否则写进 Content-Disposition（如 "attachment"）；
      ``filename`` 非空且 ``disposition`` 为 ``"none"`` 时只写 Content-Type 的 name，
      不写 Content-Disposition（模拟“带 filename 但没声明 disposition”的 part）；
    - ``filename``：None 表示不带文件名；
    - ``text``：正文文本（UTF-8）。
    """
    lines = [
        f"From: {sender}",
        "To: agent@example.com",
        f"Subject: {subject}",
        f"Date: {formatdate(time.time(), usegmt=True)}",
        f"Message-ID: <multi{uid}@example.com>",
        (AR_VALID if auth else "").strip(),
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        "",
    ]
    body: list[str] = []
    for content_type, disposition, filename, text in parts:
        body.append("--BOUNDARY")
        if filename:
            body.append(f'Content-Type: {content_type}; charset=utf-8; name="{filename}"')
            if disposition != "none":
                body.append(
                    f'Content-Disposition: {disposition or "attachment"}; filename="{filename}"'
                )
        else:
            body.append(f"Content-Type: {content_type}; charset=utf-8")
        body.extend(["", text, ""])
    body.append("--BOUNDARY--")
    raw = "\n".join(lines) + "\n" + "\n".join(body) + "\n"
    return raw.encode("utf-8")

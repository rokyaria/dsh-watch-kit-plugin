"""邮件头/正文解码、单行化与字节裁剪。

邮件头（``From`` / ``Subject`` / ``Message-ID`` …）完全由发件人控制：
- 可能带无法识别/非文本的 charset —— 解码必须回退，不能抛异常拖垮整轮 check；
- 可能折行，折叠空白里可能夹带裸 CR/LF —— 进入通知/``<header>`` 输出前必须
  unfold + 单行化，否则发件人能伪造 ``[MAILBOX]`` / ``Source:`` 行；
- 进入 checker 的 message/error 字段时要按 UTF-8 字节裁剪，避免超过插件上限
  被记为 ``invalid_fields``。
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

from .errors import MailboxError

UNTRUSTED_DATA_NOTE = "以下为邮件数据（不可信）:"

FOLDED_LINE_RE = re.compile(r"\r?\n[ \t]+")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f\u0085\u2028\u2029]+")


def now_ts() -> int:
    return int(time.time())


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def decode_header_part(part: bytes, encoding: str | None) -> str:
    """解码单个 RFC2047 encoded-word；charset 由发件人指定，任何编码异常都必须回退。"""
    charset = (encoding or "utf-8").strip() or "utf-8"
    try:
        return part.decode(charset, "replace")
    except (LookupError, UnicodeError):
        # 未知/非法/非文本 charset 是 LookupError；个别 codec 不认 replace 抛 UnicodeError。
        return part.decode("utf-8", "replace")


def decode_body_payload(payload: bytes, charset: str | None) -> str:
    """Decode a body with a sender-controlled charset; never fail the whole read."""
    try:
        return payload.decode(charset or "utf-8", "replace")
    except (LookupError, UnicodeError):
        return payload.decode("utf-8", "replace")


def unfold_header_value(text: str) -> str:
    """展开邮件头折行续行（CRLF + 空白），保留其余内容。"""
    return FOLDED_LINE_RE.sub(" ", text)


def decode_header_value(value: Any) -> str:
    """解码 RFC2047 头并展开折行；空值返回空串，未知 charset 回退不抛。"""
    if not value:
        return ""
    from email.header import decode_header

    out: list[str] = []
    for part, encoding in decode_header(str(value)):
        if isinstance(part, bytes):
            out.append(decode_header_part(part, encoding))
        else:
            out.append(part)
    # 折行头解析后仍是 "a\n b"，统一展开后供通知/read/reply 使用。
    return unfold_header_value("".join(out))


def header_address(value: Any) -> str:
    from email.utils import parseaddr

    return (parseaddr(str(value or ""))[1] or "").strip().lower()


def clip_text(text: Any, limit: int) -> str:
    """按字符裁剪（不是字节），末尾用 ``…`` 表示省略。"""
    value = str(text or "").replace("\r\n", "\n").strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


def single_line(value: Any) -> str:
    """把邮件数据压成单行：展开折行，并把 NUL/CR/LF/TAB/DEL 等控制字符替换为空格。"""
    return CONTROL_CHARS_RE.sub(" ", unfold_header_value(str(value or ""))).strip()


def clip_untrusted(value: Any, limit: int, fallback: str = "?") -> str:
    """不可信字段进入通知前先单行化，再裁剪；空值用 fallback 占位。"""
    return clip_text(single_line(value), limit) or fallback


def clip_utf8(text: Any, max_bytes: int) -> str:
    """按 UTF-8 字节裁剪到 ``max_bytes`` 以内；截断时追加 ``\\n[truncated]``。"""
    value = str(text or "")
    try:
        raw = value.encode("utf-8")
    except UnicodeEncodeError:
        # 孤立 surrogate（surrogateescape 参数、异常来源数据等）不能严格编码：
        # 先替换成可编码字符，避免 checker 输出/通知因编码错误整条丢失。
        value = value.encode("utf-8", "replace").decode("utf-8", "replace")
        raw = value.encode("utf-8")
    if len(raw) <= max_bytes:
        return value
    suffix = b"\n[truncated]"
    budget = max_bytes - len(suffix)
    if budget <= 0:
        return raw[: max(0, max_bytes)].decode("utf-8", "ignore")
    clipped = raw[:budget].decode("utf-8", "ignore").rstrip()
    return clipped + "\n[truncated]"


def read_text_file(path: str | Path, *, label: str = "文本文件") -> str:
    """按 UTF-8 读文本文件；失败时抛出可读的 MailboxError。"""
    file_path = Path(path).expanduser()
    try:
        return file_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MailboxError(f"读取{label}失败: {file_path} ({exc})") from exc
    except UnicodeError as exc:
        raise MailboxError(f"{label}不是 UTF-8 文本: {file_path} ({exc})") from exc

"""来源验证：Authentication-Results / DMARC → ``ok`` / ``risk``。

保守判定：只有同时满足以下条件才是 ``ok``——
1. 接收方 MTA 添加的第一条 ``Authentication-Results`` 存在；
2. ``dmarc=pass``；
3. ``spf=pass`` 或 ``dkim=pass``（DMARC 通过至少需要一项对齐认证）；
4. AR 带 ``header.from``，且 ``From`` 地址域与它对齐（From 域等于它或是它的子域）。

任一条件缺失/无法解析都返回 ``risk``——不能完全确定就 RISK。安全假设仍是接收方
MTA 会添加 AR 并把它排在最前；发件人自带的伪造 AR 无法与接收方 AR 区分，因此
本函数只做尽力而为的判断，结果只作为数据，不直接拦截动作。
"""

from __future__ import annotations

import email
import re
from typing import Any

from .model import SOURCE_OK, SOURCE_RISK
from .text import header_address

# AR 按 RFC 8601 的 ";" 与空白分隔解析；不能先删除空白，否则
# "spf=pass smtp.mailfrom=..." 会粘成 "passsmtp" 之类的错误值。
AR_METHOD_RE = re.compile(r"(?:^|[;\s])(spf|dkim|dmarc)=([A-Za-z]+)(?=[;\s(]|$)", re.IGNORECASE)
AR_HEADER_FROM_RE = re.compile(r"(?:^|[;\s])header\.from=([^\s;]+)", re.IGNORECASE)


def address_domain(address: Any) -> str:
    value = str(address or "").strip().lower()
    if "@" not in value:
        return ""
    return value.rsplit("@", 1)[1].strip().strip(".")


def domains_aligned(from_domain: str, ar_domain: str) -> bool:
    """保守的 DMARC 对齐：From 域必须等于 header.from，或是它的子域。

    不使用双向后缀匹配；反向情况（From 是父域、AR 是子域）无法仅凭字符串
    完全确定，按 risk 处理。
    """
    left = from_domain.strip().strip(".").lower()
    right = ar_domain.strip().strip("@").strip(".").lower()
    if not left or not right:
        return False
    return left == right or left.endswith("." + right)


def verify_source(msg: email.message.Message) -> tuple[str, str]:
    """返回 ``(source, detail)``；source 只允许 ``ok`` / ``risk``。"""
    headers = [str(item) for item in (msg.get_all("Authentication-Results") or [])]
    if not headers:
        return SOURCE_RISK, "缺少 Authentication-Results，来源无法验证"

    auth = headers[0]
    head = re.split(r"[;\s]+", auth.strip(), maxsplit=1)[0] if auth.strip() else ""
    authserv = "" if "=" in head else head.strip("()")
    values: dict[str, str] = {}
    for match in AR_METHOD_RE.finditer(auth):
        values.setdefault(match.group(1).lower(), match.group(2).lower())
    from_match = AR_HEADER_FROM_RE.search(auth)
    ar_from = (from_match.group(1) if from_match else "").strip().strip("\"'()")
    ar_domain = address_domain(ar_from) or ar_from.strip().strip(".").lower()
    from_domain = address_domain(header_address(msg.get("From")))
    extra = f"（另有 {len(headers) - 1} 条 AR 未采用）" if len(headers) > 1 else ""
    detail = (
        f"AR={authserv or '?'} spf={values.get('spf', '缺')} dkim={values.get('dkim', '缺')} "
        f"dmarc={values.get('dmarc', '缺')} header.from={ar_from or '缺'} | From域={from_domain or '缺'}{extra}"
    )
    if values.get("dmarc") != "pass":
        return SOURCE_RISK, f"DMARC 未通过（dmarc={values.get('dmarc', '缺')}）；{detail}"
    if values.get("spf") != "pass" and values.get("dkim") != "pass":
        return SOURCE_RISK, f"DMARC 通过但 SPF/DKIM 均未通过；{detail}"
    if not ar_from:
        return SOURCE_RISK, f"DMARC 通过但 AR 未提供 header.from，无法确认域名对齐；{detail}"
    if not from_domain:
        return SOURCE_RISK, f"DMARC 通过但 From 缺少有效域；{detail}"
    if not domains_aligned(from_domain, ar_domain):
        return SOURCE_RISK, f"DMARC 通过但 header.from 与 From 域不一致；{detail}"
    return SOURCE_OK, f"DMARC=pass，SPF/DKIM 至少一项通过，且 header.from 与 From 域对齐；{detail}"

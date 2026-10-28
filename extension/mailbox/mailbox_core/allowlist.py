"""per-account allowlist：{收件账户地址: [{address, identity}]}。

- 精确地址优先于 ``*``；``*`` 表示允许任意发件人。
- ``identity`` 是任意标签（user/guest/自定义），``mail.py`` 只做数据传递；
  行为约定在 ``watch-mailbox`` skill，不在代码里解释。
- 默认空名单 = 不通知任何人。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .config import normalize_identity
from .errors import MailboxError
from .locking import file_lock

Rule = dict[str, str]


def normalize_address(value: Any) -> str:
    return str(value or "").strip().lower()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def validate_address(address: str) -> None:
    """允许 ``*`` 或形如 local@domain 的地址；非法抛 MailboxError。"""
    if address == "*":
        return
    if "@" not in address or any(ch.isspace() for ch in address):
        raise MailboxError(f"地址不合法: {address!r}")


def load_allow_file(path: Path) -> dict[str, list[Rule]]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MailboxError(f"允许名单不是合法 JSON: {path} ({exc})") from exc
    if not isinstance(value, dict):
        raise MailboxError("允许名单顶层必须是 {邮箱地址: [规则]} 对象")
    out: dict[str, list[Rule]] = {}
    for account, rules in value.items():
        if not isinstance(account, str) or not isinstance(rules, list):
            raise MailboxError("允许名单格式错误")
        normalized: list[Rule] = []
        for rule in rules:
            if not isinstance(rule, dict):
                raise MailboxError("允许名单规则必须是对象")
            address = normalize_address(rule.get("address"))
            try:
                validate_address(address)
            except MailboxError as exc:
                raise MailboxError(f"允许名单地址不合法: {address!r}") from exc
            normalized.append({"address": address, "identity": normalize_identity(rule.get("identity"))})
        out[account.strip().lower()] = normalized
    return out


def rules_for_account(path: Path, account: str) -> list[Rule]:
    data = load_allow_file(path)
    return data.get(account.strip().lower(), [])


def match_rule(rules: list[Rule], address: str) -> Rule | None:
    """精确地址优先，其次 ``*``；空地址不匹配。"""
    wanted = normalize_address(address)
    if not wanted:
        return None
    exact = next((rule for rule in rules if rule["address"] == wanted), None)
    if exact:
        return exact
    return next((rule for rule in rules if rule["address"] == "*"), None)


def save_allow_file(path: Path, data: dict[str, list[Rule]]) -> None:
    """原子写：同目录独占创建的 0600 tmp → os.replace；拒绝预置 tmp/symlink 干扰。"""
    ensure_parent(path)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    payload = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    fd: int | None = None
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, payload)
        os.close(fd)
        fd = None
        os.replace(tmp, path)
    except OSError as exc:
        raise MailboxError(f"保存允许名单失败: {path} ({exc})") from exc
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _lock_path(path: Path) -> Path:
    return path.with_name(path.name + ".lock")


def add_rule(path: Path, account: str, address: str, identity: Any = None) -> Rule:
    """加入/覆盖一条规则（同一地址只保留一条）；返回写入的规则。"""
    account = normalize_address(account)
    normalized_address = normalize_address(address)
    validate_address(normalized_address)
    rule = {"address": normalized_address, "identity": normalize_identity(identity)}
    with file_lock(_lock_path(path)):
        data = load_allow_file(path)
        rules = data.setdefault(account, [])
        rules[:] = [item for item in rules if item["address"] != normalized_address]
        rules.append(rule)
        save_allow_file(path, data)
    return rule


def remove_rule(path: Path, account: str, address: str) -> int:
    """删除指定地址的规则；返回删除条数（文件不存在也会创建空文件）。"""
    account = normalize_address(account)
    normalized_address = normalize_address(address)
    validate_address(normalized_address)
    with file_lock(_lock_path(path)):
        data = load_allow_file(path)
        rules = data.setdefault(account, [])
        before = len(rules)
        rules[:] = [item for item in rules if item["address"] != normalized_address]
        save_allow_file(path, data)
    return before - len(rules)

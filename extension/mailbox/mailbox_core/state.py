"""按账户的 SQLite 状态库：连接、权限、事务与 scope。

表结构与记录读写见 :mod:`mailbox_core.records`。关键不变量：
- stateDir 0700；状态库及 WAL/SHM 0600（邮件元数据同机私有）；
- ``scopes`` 缓存每个 ``(account, folder, uidvalidity)`` 的 baseline 状态；
  UIDVALIDITY 变化即视为新 scope（重新建立基线）；
- 网络请求期间不持有事务；写事务都是小批量本地操作。
"""

from __future__ import annotations

import contextlib
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .errors import MailboxError
from .text import now_ts

STATE_DB_SUFFIX = ".sqlite3"
LEGACY_STATE_SUFFIX = ".jsonl"
STATE_SCHEMA_VERSION = 1

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS scopes (
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  baseline_done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account, folder, uidvalidity)
);
CREATE TABLE IF NOT EXISTS messages (
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_notified_at INTEGER,
  replied_at INTEGER,
  no_receipt_at INTEGER,
  from_addr TEXT,
  from_display TEXT,
  subject TEXT,
  message_id TEXT,
  date TEXT,
  identity TEXT,
  source TEXT,
  last_error TEXT,
  PRIMARY KEY (account, folder, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS messages_scope_status
  ON messages(account, folder, uidvalidity, status);
"""


@dataclass(frozen=True)
class Scope:
    """状态库里的一个 (account, folder, uidvalidity) 作用域。"""

    account: str
    folder: str
    uidvalidity: int


# --------------------------------------------------------------------------- #
# 路径 / 权限
# --------------------------------------------------------------------------- #

def _safe_account(account: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._@-]+", "_", str(account).strip().lower())
    if not safe:
        raise MailboxError("邮箱地址为空，无法定位状态文件")
    return safe


def state_file_for(state_dir: Path, account: str) -> Path:
    """Per-account SQLite state DB."""
    return Path(state_dir) / f"{_safe_account(account)}{STATE_DB_SUFFIX}"


def legacy_state_file_for(state_dir: Path, account: str) -> Path:
    """v0.2.x JSONL 状态文件（仅一次性迁移时读取）。"""
    return Path(state_dir) / f"{_safe_account(account)}{LEGACY_STATE_SUFFIX}"


def _private_mode(path: Path, mode: int) -> None:
    """Best-effort POSIX permission tightening; Windows ACLs are left alone."""
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def secure_state_dir(path: Path) -> Path:
    """创建状态目录并收紧到 0700。"""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    _private_mode(path, 0o700)
    return path


# --------------------------------------------------------------------------- #
# 打开 / 事务
# --------------------------------------------------------------------------- #

def _normalize_sources(db: sqlite3.Connection) -> None:
    """把历史脏值（warn/unknown/大小写）收敛成 ok/risk；无脏值时零写入。"""
    # 归一化后的规范值只有精确的 'ok' / 'risk'；大小写/空白/旧值都算脏。
    dirty = db.execute(
        "SELECT 1 FROM messages WHERE source IS NULL OR trim(source) NOT IN ('ok', 'risk') LIMIT 1"
    ).fetchone()
    if dirty is None:
        return
    db.execute(
        "UPDATE messages SET source = CASE WHEN lower(trim(source)) = 'ok' THEN 'ok' ELSE 'risk' END"
    )


def open_state(path: Path) -> sqlite3.Connection:
    """打开/初始化状态库；损坏或版本不支持时抛 MailboxError。"""
    path = Path(path)
    secure_state_dir(path.parent)
    try:
        db = sqlite3.connect(str(path), timeout=5.0, isolation_level=None)
    except sqlite3.Error as exc:
        raise MailboxError(f"状态数据库无法打开: {path} ({exc})") from exc
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA busy_timeout = 5000")
        version = int(db.execute("PRAGMA user_version").fetchone()[0])
        if version not in (0, STATE_SCHEMA_VERSION):
            raise MailboxError(f"不支持的状态数据库版本 {version}: {path}")
        db.executescript(STATE_SCHEMA)
        _normalize_sources(db)
        if version == 0:
            db.execute(f"PRAGMA user_version = {STATE_SCHEMA_VERSION}")
    except MailboxError:
        db.close()
        raise
    except sqlite3.Error as exc:
        db.close()
        raise MailboxError(f"状态数据库无法使用（可能已损坏）: {path} ({exc})") from exc
    except Exception:
        db.close()
        raise
    # State DB contains mail metadata; keep it private (0600) including WAL/SHM.
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        _private_mode(candidate, 0o600)
    return db


@contextlib.contextmanager
def state_transaction(db: sqlite3.Connection) -> Iterator[None]:
    """BEGIN IMMEDIATE … COMMIT；任何异常都尽力回滚，COMMIT 失败也回滚后再抛。"""
    db.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        try:
            db.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    try:
        db.execute("COMMIT")
    except sqlite3.Error:
        try:
            db.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise


# --------------------------------------------------------------------------- #
# scopes
# --------------------------------------------------------------------------- #

def _scope_params(scope: Scope) -> tuple[str, str, int]:
    return scope.account, scope.folder, scope.uidvalidity


def find_scope(db: sqlite3.Connection, scope: Scope) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT * FROM scopes WHERE account = ? AND folder = ? AND uidvalidity = ?",
        _scope_params(scope),
    ).fetchone()
    return dict(row) if row is not None else None


def ensure_scope(db: sqlite3.Connection, scope: Scope, now: int | None = None) -> dict[str, Any]:
    """返回 scope 行；不存在则插入 baseline_done=0 的初始行。"""
    row = find_scope(db, scope)
    if row is not None:
        return row
    db.execute(
        "INSERT OR IGNORE INTO scopes(account, folder, uidvalidity, baseline_done, updated_at) "
        "VALUES (?, ?, ?, 0, ?)",
        (*_scope_params(scope), now if now is not None else now_ts()),
    )
    row = find_scope(db, scope)
    assert row is not None
    return row


def touch_scope(db: sqlite3.Connection, scope: Scope, now: int) -> None:
    """记录“本轮正在使用这个 scope”，供 status/list 选择最新 scope。"""
    with state_transaction(db):
        db.execute(
            "UPDATE scopes SET updated_at = ? WHERE account = ? AND folder = ? AND uidvalidity = ?",
            (now, *_scope_params(scope)),
        )


def mark_scope_baseline_done(db: sqlite3.Connection, scope: Scope, now: int) -> None:
    with state_transaction(db):
        db.execute(
            "UPDATE scopes SET baseline_done = 1, updated_at = ? "
            "WHERE account = ? AND folder = ? AND uidvalidity = ?",
            (now, *_scope_params(scope)),
        )


def latest_uidvalidity(db: sqlite3.Connection, account: str, folder: str) -> int | None:
    row = db.execute(
        # 同 updated_at 时用 rowid 兜底：UIDVALIDITY 回退场景里“当前 scope”是后插入的行，
        # 不能用 uidvalidity 大小判断（服务器把 200 回退到 100 时 100 才是当前的）。
        "SELECT uidvalidity FROM scopes WHERE account = ? AND folder = ? "
        "ORDER BY updated_at DESC, rowid DESC LIMIT 1",
        (account, folder),
    ).fetchone()
    return int(row["uidvalidity"]) if row is not None else None


def clear_scope(db: sqlite3.Connection, scope: Scope) -> None:
    """清空一个 scope（messages + scopes 行）；调用方负责事务。"""
    db.execute(
        "DELETE FROM messages WHERE account = ? AND folder = ? AND uidvalidity = ?",
        _scope_params(scope),
    )
    db.execute(
        "DELETE FROM scopes WHERE account = ? AND folder = ? AND uidvalidity = ?",
        _scope_params(scope),
    )


def reset_scope(db: sqlite3.Connection, scope: Scope, now: int) -> None:
    """init --force：重建空 scope 行（baseline_done=1）；调用方负责事务。"""
    clear_scope(db, scope)
    db.execute(
        "INSERT INTO scopes(account, folder, uidvalidity, baseline_done, updated_at) VALUES (?, ?, ?, 1, ?)",
        (*_scope_params(scope), now),
    )

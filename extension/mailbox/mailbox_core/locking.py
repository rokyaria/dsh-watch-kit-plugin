"""可移植的独占文件锁（不依赖 fcntl/msvcrt）。

只用于 allowlist 的读-改-写（低频、人工操作）。状态库并发由 SQLite 事务与
“插件单飞 + agent 串行”的拓扑假设覆盖，不在这里加锁。
"""

from __future__ import annotations

import contextlib
import os
import time
from pathlib import Path
from typing import Iterator

from .errors import MailboxError

LOCK_TIMEOUT_SECONDS = 90.0
STALE_LOCK_SECONDS = 300.0


@contextlib.contextmanager
def file_lock(
    path: Path,
    timeout: float = LOCK_TIMEOUT_SECONDS,
    stale_after: float = STALE_LOCK_SECONDS,
) -> Iterator[None]:
    """在 ``path`` 上获取独占锁；超时抛 MailboxError。

    锁内容是 ``pid timestamp``，文件权限 0600。判定 stale 用 mtime：持有者崩溃
    后最多 ``stale_after`` 秒可被接管；持有时间超过该值的正常操作会被误接管，
    因此它只适合短小的本地读-改-写。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    fd: int | None = None
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            # 拿到锁后立刻确认路径仍指向自己的 inode：否则可能刚创建就被别人按
            # “stale”删掉（窗口极小），继续下一轮重试。
            try:
                own_inode = os.fstat(fd).st_ino
                if own_inode != os.stat(path).st_ino:
                    os.close(fd)
                    fd = None
                    continue
            except FileNotFoundError:
                os.close(fd)
                fd = None
                continue
            break
        except FileExistsError:
            stat = None
            try:
                stat = path.stat()
            except FileNotFoundError:
                # 悬空符号链接（stat 失败但路径存在）或极短竞态：清理悬空链接后再试。
                try:
                    if path.is_symlink():
                        path.unlink()
                except OSError:
                    pass
            except OSError:
                pass
            if stat is not None and time.time() - stat.st_mtime > stale_after:
                # 接管 stale 锁前再核对一次 inode/mtime：避免把别人刚创建的新锁删掉。
                try:
                    current = path.stat()
                    if current.st_ino == stat.st_ino and current.st_mtime == stat.st_mtime:
                        path.unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
                continue
            if time.monotonic() > deadline:
                raise MailboxError(f"等待状态锁超时: {path}")
            time.sleep(0.05)

    try:
        descriptor = fd
        if descriptor is not None:
            try:
                os.write(descriptor, f"{os.getpid()} {int(time.time())}\n".encode())
            except OSError:
                pass
        yield
    finally:
        owned = False
        if fd is not None:
            # 只删除“仍指向自己 inode”的锁文件：若锁被接管，不能删别人的锁。
            try:
                owned = os.fstat(fd).st_ino == os.stat(path).st_ino
            except (FileNotFoundError, OSError):
                owned = False
            try:
                os.close(fd)
            except OSError:
                pass
        if owned:
            try:
                path.unlink()
            except OSError:
                pass

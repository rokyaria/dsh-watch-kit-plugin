"""Python 测试共用的 support 包：fake IMAP/SMTP、邮件构造器、CLI 黑盒夹具。

不访问真实网络、不读写 ``~/.dsh``；所有状态都落在 ``tempfile.TemporaryDirectory``。
"""

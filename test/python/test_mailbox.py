"""Standard-library tests for extension/mailbox/mail.py.

Run from the repository root:
  python3 -m unittest discover -s extension/mailbox/tests -v
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
MAILBOX_DIR = REPO_ROOT / "extension" / "mailbox"
sys.path.insert(0, str(MAILBOX_DIR))
import mail  # noqa: E402


class FakeIMAP:
    uidvalidity = 100
    messages: dict[int, bytes] = {}

    def __init__(self, host, port, ssl_context=None, timeout=30):
        self.host = host
        self.port = port
        self.folder = "INBOX"
        self.untagged_responses = {}
        self.logged_in = False

    def login(self, address, authcode):
        self.logged_in = True

    def select(self, folder, readonly=False):
        self.folder = folder
        return "OK", [b"1"]

    def response(self, name):
        if name == "UIDVALIDITY":
            return "UIDVALIDITY", [str(FakeIMAP.uidvalidity).encode()]
        return name, []

    def uid(self, command, *args):
        if command == "SEARCH":
            return "OK", [b" ".join(str(uid).encode() for uid in sorted(FakeIMAP.messages))]
        if command == "FETCH":
            uid = int(args[0])
            raw = FakeIMAP.messages.get(uid)
            if raw is None:
                return "OK", [None]
            return "OK", [(f"{uid} (BODY)".encode(), raw)]
        return "OK", [None]

    def close(self):
        pass

    def logout(self):
        pass


class FakeSMTP:
    sent: list = []

    def __init__(self, host, port, context=None, timeout=30):
        self.host = host
        self.port = port

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def login(self, address, authcode):
        pass

    def send_message(self, message):
        FakeSMTP.sent.append(message)


def raw_message(uid, sender, subject, auth=True):
    auth_header = "Authentication-Results: mx.example; spf=pass dkim=pass dmarc=pass\n" if auth else ""
    return (
        f"From: {sender}\n"
        f"To: agent@example.com\n"
        f"Subject: {subject}\n"
        "Date: Thu, 01 Jan 2026 00:00:00 +0000\n"
        f"Message-ID: <m{uid}@example.com>\n"
        f"{auth_header}"
        "Content-Type: text/plain; charset=utf-8\n"
        "\n"
        f"body {uid}\n"
    ).encode()


class MailboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env_file = self.root / "mail.env"
        self.env_file.write_text(
            "MAIL_ADDRESS=agent@example.com\n"
            "MAIL_AUTHCODE=secret\n"
            "IMAP_HOST=imap.example\n"
            "IMAP_PORT=993\n"
            "SMTP_HOST=smtp.example\n"
            "SMTP_PORT=465\n",
            encoding="utf-8",
        )
        self.state_dir = self.root / "state"
        self.allow_file = self.root / "allow.json"
        self.allow_file.write_text(
            json.dumps(
                {
                    "agent@example.com": [
                        {"address": "owner@example.com", "identity": "user"},
                        {"address": "guest@example.com", "identity": "guest"},
                    ]
                }
            ),
            encoding="utf-8",
        )
        FakeIMAP.uidvalidity = 100
        FakeIMAP.messages = {}
        FakeSMTP.sent = []
        self.patches = [
            mock.patch.object(mail.imaplib, "IMAP4_SSL", FakeIMAP),
            mock.patch.object(mail.smtplib, "SMTP_SSL", FakeSMTP),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        self.tmp.cleanup()

    @property
    def common(self):
        return [
            "--env-file", str(self.env_file),
            "--state-dir", str(self.state_dir),
            "--allow-account-file", str(self.allow_file),
            "--folder", "INBOX",
        ]

    def run_cli(self, argv):
        out = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = mail.main(argv)
        return code, out.getvalue(), err.getvalue()

    def check(self, *extra):
        return self.run_cli(["check", *self.common, *extra])

    def parse_json(self, text):
        return json.loads(text.strip().splitlines()[-1])

    def add(self, uid, sender="owner@example.com", subject="hello", auth=True):
        FakeIMAP.messages[uid] = raw_message(uid, sender, subject, auth=auth)

    def state(self):
        path = next(self.state_dir.glob("*.jsonl"))
        return json.loads(path.read_text(encoding="utf-8").splitlines()[-1])

    def test_first_run_baselines_without_notifying(self):
        self.add(1)
        code, out, _err = self.check()
        self.assertEqual(code, 0)
        self.assertFalse(self.parse_json(out)["notify"])
        state = self.state()
        self.assertTrue(state["initialized"])
        self.assertEqual(state["last_seen_uid"], 1)
        self.assertEqual(state["messages"], {})

    def test_new_mail_notifies_then_stays_quiet_until_marked(self):
        self.add(1)
        self.check()
        self.add(2, subject="new thing")
        code, out, _err = self.check()
        data = self.parse_json(out)
        self.assertTrue(data["notify"])
        self.assertIn("uid 2", data["message"])
        self.assertIn("owner@example.com", data["message"])
        self.assertEqual(self.state()["messages"]["2"]["status"], "temp")

        code, out, _err = self.check()
        self.assertFalse(self.parse_json(out)["notify"])

        code, out, _err = self.run_cli(["mark", "--uid", "2", *self.common])
        self.assertEqual(code, 0)
        self.assertEqual(self.state()["messages"]["2"]["status"], "acked")
        code, out, _err = self.check()
        self.assertFalse(self.parse_json(out)["notify"])


    def test_notify_existing_first_run(self):
        self.add(1)
        self.add(2)
        code, out, _err = self.check("--notify-existing")
        data = self.parse_json(out)
        self.assertTrue(data["notify"])
        self.assertIn("uid 1", data["message"])
        self.assertIn("uid 2", data["message"])

    def test_notification_cap_keeps_all_temp_and_mentions_rest(self):
        self.add(1)
        self.check()
        for uid in range(2, 27):
            self.add(uid, subject=f"event {uid}")
        code, out, _err = self.check("--max-notify", "3")
        data = self.parse_json(out)
        self.assertTrue(data["notify"])
        self.assertIn("另有 22", data["message"])
        temp = [record for record in self.state()["messages"].values() if record["status"] == "temp"]
        self.assertEqual(len(temp), 25)

    def test_reminder_after_quiet_period_and_reset(self):
        self.add(1)
        self.check()
        self.add(2)
        self.check()
        state = self.state()
        state["messages"]["2"]["last_notified_at"] = int(mail.time.time()) - 31 * 60
        path = next(self.state_dir.glob("*.jsonl"))
        path.write_text(json.dumps(state) + "\n", encoding="utf-8")
        code, out, _err = self.check()
        data = self.parse_json(out)
        self.assertTrue(data["notify"])
        self.assertIn("待回", data["message"])
        updated = self.state()["messages"]["2"]
        self.assertGreater(updated["last_notified_at"], int(mail.time.time()) - 60)

    def test_no_allowlist_means_no_notification(self):
        self.allow_file.unlink()
        self.add(1, sender="stranger@example.com")
        self.check()
        self.add(2, sender="stranger@example.com")
        code, out, _err = self.check()
        self.assertFalse(self.parse_json(out)["notify"])
        self.assertEqual(self.state()["messages"]["2"]["status"], "ignored")

    def test_unverified_user_is_downgraded_to_guest(self):
        self.add(1)
        self.check()
        self.add(2, auth=False, subject="no auth")
        code, out, _err = self.check()
        data = self.parse_json(out)
        self.assertTrue(data["notify"])
        self.assertIn("guest", data["message"])
        self.assertIn("来源未验证", data["message"])
        self.assertEqual(self.state()["messages"]["2"]["identity"], "guest")

    def test_wildcard_guest_is_allowed(self):
        self.allow_file.write_text(
            json.dumps({"agent@example.com": [{"address": "*", "identity": "guest"}]}),
            encoding="utf-8",
        )
        self.add(1)
        self.check()
        self.add(2, sender="stranger@example.com")
        code, out, _err = self.check()
        data = self.parse_json(out)
        self.assertTrue(data["notify"])
        self.assertIn("guest", data["message"])

    def test_reply_auto_marks_and_sets_thread_headers(self):
        self.add(1)
        self.check()
        self.add(2, subject="please reply")
        self.check()
        body = self.root / "reply.txt"
        body.write_text("thanks!", encoding="utf-8")
        code, out, err = self.run_cli(["reply", "--uid", "2", "--body-file", str(body), *self.common])
        self.assertEqual(code, 0, err)
        self.assertEqual(len(FakeSMTP.sent), 1)
        sent = FakeSMTP.sent[0]
        self.assertEqual(sent["To"], "owner@example.com")
        self.assertIn("Re:", sent["Subject"])
        self.assertIn("<m2@example.com>", sent["In-Reply-To"])
        self.assertEqual(self.state()["messages"]["2"]["status"], "acked")
        code, out, _err = self.check()
        self.assertFalse(self.parse_json(out)["notify"])

    def test_read_does_not_mark(self):
        self.add(1)
        self.check()
        self.add(2, subject="read me")
        self.check()
        code, out, err = self.run_cli(["read", "--uid", "2", *self.common])
        self.assertEqual(code, 0, err)
        self.assertIn("read me", out)
        self.assertEqual(self.state()["messages"]["2"]["status"], "temp")


    def test_status_and_list_after_check(self):
        self.add(1)
        self.check()
        self.add(2, subject="pending item")
        self.check()
        code, out, err = self.run_cli(["status", *self.common])
        self.assertEqual(code, 0, err)
        self.assertIn("account: agent@example.com", out)
        self.assertIn("temp=1", out)
        code, out, err = self.run_cli(["list", "--pending", *self.common])
        self.assertEqual(code, 0, err)
        self.assertIn("uid 2", out)
        self.assertIn("pending item", out)


    def test_allowlist_and_state_are_scoped_by_receiving_account(self):
        self.env_file.write_text(
            "MAIL_ADDRESS=agent2@example.com\n"
            "MAIL_AUTHCODE=secret\n"
            "IMAP_HOST=imap.example\n"
            "IMAP_PORT=993\n"
            "SMTP_HOST=smtp.example\n"
            "SMTP_PORT=465\n",
            encoding="utf-8",
        )
        self.allow_file.write_text(
            json.dumps({"agent2@example.com": [{"address": "*", "identity": "guest"}]}),
            encoding="utf-8",
        )
        self.add(1)
        self.check()
        self.add(2, sender="stranger@example.com")
        code, out, _err = self.check()
        data = self.parse_json(out)
        self.assertTrue(data["notify"])
        self.assertIn("agent2@example.com", data["message"])
        state_files = sorted(path.name for path in self.state_dir.glob("*.jsonl"))
        self.assertEqual(state_files, ["agent2@example.com.jsonl"])

    def test_uidvalidity_change_rebaselines(self):
        self.add(1)
        self.check()
        FakeIMAP.uidvalidity = 200
        FakeIMAP.messages = {5: raw_message(5, "owner@example.com", "after reset")}
        code, out, _err = self.check()
        self.assertFalse(self.parse_json(out)["notify"])
        state = self.state()
        self.assertEqual(state["uidvalidity"], 200)
        self.assertEqual(state["last_seen_uid"], 5)

    def test_check_only_outputs_json_on_error(self):
        self.env_file.unlink()
        code, out, err = self.check()
        self.assertEqual(code, 0)
        data = self.parse_json(out)
        self.assertFalse(data["notify"])
        self.assertIn("error", data)
        self.assertNotIn("MAIL_AUTHCODE", out)

    def test_allow_add_list_remove(self):
        code, out, err = self.run_cli(["allow", *self.common, "--list"])
        self.assertEqual(code, 0, err)
        self.assertIn("owner@example.com", out)
        code, out, err = self.run_cli(
            ["allow", *self.common, "--add-allow-account", "new@example.com", "--identity", "guest"]
        )
        self.assertEqual(code, 0, err)
        data = json.loads(self.allow_file.read_text(encoding="utf-8"))
        self.assertIn({"address": "new@example.com", "identity": "guest"}, data["agent@example.com"])
        code, out, err = self.run_cli(["allow", *self.common, "--remove-allow-account", "new@example.com"])
        self.assertEqual(code, 0, err)
        data = json.loads(self.allow_file.read_text(encoding="utf-8"))
        self.assertNotIn({"address": "new@example.com", "identity": "guest"}, data["agent@example.com"])


if __name__ == "__main__":
    unittest.main()

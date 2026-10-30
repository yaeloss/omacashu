import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "client"))
import omacashu_cli as cli  # noqa: E402


class ClientValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.key = Path(self.tmp.name) / "id_ed25519"
        self.key.write_text("not a real key")
        os.chmod(self.key, 0o600)
        self.known = Path(self.tmp.name) / "known_hosts"
        self.known.write_text("")

    def tearDown(self):
        self.tmp.cleanup()

    def test_option_injection_rejected(self):
        for user in ["-oProxyCommand=touch /tmp/pwned", "root@evil", "Root", "a b", ""]:
            with self.subTest(user=user), self.assertRaises(cli.UsageError):
                cli.validate_user(user)
        for host in ["-oProxyCommand=sh", "evil.com -oX", "a;b", "", "host/../x", "-"]:
            with self.subTest(host=host), self.assertRaises(cli.UsageError):
                cli.validate_host(host)

    def test_valid_hosts(self):
        for host in ["trusted.example", "10.0.0.5", "fe80::1", "pi"]:
            self.assertEqual(cli.validate_host(host), host)

    def test_paths_validated(self):
        with self.assertRaises(cli.UsageError):
            cli.validate_file("/nonexistent", "identity", private=True)
        with self.assertRaises(cli.UsageError):
            cli.validate_file("-oX", "identity", private=True)
        with self.assertRaises(cli.UsageError):
            cli.validate_file(str(self.key) + " other", "identity", private=True)
        os.chmod(self.key, 0o644)
        with self.assertRaises(cli.UsageError):
            cli.validate_file(str(self.key), "identity", private=True)

    def test_ssh_command_is_hardened(self):
        cmd = cli.build_ssh_command("omacashu-propose", "trusted.example", 22, str(self.key), str(self.known))
        self.assertEqual(cmd[:3], ["ssh", "-F", "none"])
        self.assertEqual(cmd[-2:], ["--", "trusted.example"])
        joined = " ".join(cmd)
        for option in ["StrictHostKeyChecking=yes", f"UserKnownHostsFile={self.known}", "IdentitiesOnly=yes",
                       "IdentityAgent=none", "ControlMaster=no", "ControlPath=none", "PermitLocalCommand=no",
                       "ClearAllForwardings=yes", "BatchMode=yes"]:
            self.assertIn(option, joined)
        self.assertNotIn("@", joined)

    def test_cli_rejects_injection_before_running_ssh(self):
        with self.assertRaises(SystemExit) as ctx:
            cli.main(["--host", "-oProxyCommand=sh", "--identity", str(self.key),
                      "--known-hosts", str(self.known), "ping"])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()

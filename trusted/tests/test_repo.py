"""Repository-level safety checks for the trusted-device kit."""
import os
import re
import stat
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTABLES = ["bin/omacashu-broker", "bin/omacashu-review", "bridge/omacashu_ssh_bridge.py"]


def repo_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules", "__pycache__"}]
        for name in dirnames + filenames:
            yield Path(dirpath) / name


class RepoTests(unittest.TestCase):
    def test_no_symlinks(self):
        for path in repo_files():
            self.assertFalse(path.is_symlink(), path)

    def test_trusted_executables_use_isolated_python(self):
        for rel in EXECUTABLES:
            path = ROOT / rel
            self.assertTrue(path.stat().st_mode & stat.S_IXUSR, rel)
            self.assertEqual(path.read_text().splitlines()[0], "#!/usr/bin/python3 -I", rel)

    def test_no_payment_operations(self):
        source = "".join((ROOT / "broker" / "omacashu_broker" / name).read_text()
                         for name in ["protocol.py", "server.py", "store.py", "review.py"])
        source += (ROOT / "bridge" / "omacashu_ssh_bridge.py").read_text()
        source += "".join(p.read_text() for p in (ROOT / "sdk").glob("*.mjs"))
        for pattern in [r'"pay"', r"'pay'", r'"approve"', r"payInvoice", r"pay_invoice\(", r"sendPayment"]:
            self.assertIsNone(re.search(pattern, source), pattern)

    def test_systemd_unit_is_sandboxed(self):
        unit = (ROOT / "deploy" / "omacashu-broker.service").read_text()
        for directive in ["NoNewPrivileges=yes", "PrivateNetwork=yes", "RestrictAddressFamilies=AF_UNIX",
                          "ProtectSystem=strict", "CapabilityBoundingSet=\n", "SystemCallFilter=@system-service",
                          "MemoryDenyWriteExecute=yes", "StateDirectoryMode=0700", "-I -B"]:
            self.assertIn(directive, unit)

    def test_sshd_snippet_restricts_proposer(self):
        conf = (ROOT / "deploy" / "sshd_config.d" / "omacashu-propose.conf").read_text()
        for directive in ["Match User omacashu-propose", "PermitTTY no", "DisableForwarding yes",
                          "AuthenticationMethods publickey", "MaxSessions 1", "ForceCommand /usr/bin/python3 -I -B"]:
            self.assertIn(directive, conf)

    def test_sdk_supply_chain_pinned(self):
        pkg = (ROOT / "sdk" / "package.json").read_text()
        self.assertRegex(pkg, r'"@getalby/sdk": "\d+\.\d+\.\d+"')
        self.assertTrue((ROOT / "sdk" / "package-lock.json").is_file())
        self.assertIn("ignore-scripts=true", (ROOT / "sdk" / ".npmrc").read_text())


if __name__ == "__main__":
    unittest.main()

"""Plugin packaging and safety checks.

Mirrors the checks in Omarchy's `omarchy-plugin-validate` (and the shell's
PluginRegistry) so CI catches problems without an Omarchy install, and
enforces the live-wallet rules for the QML (docs/LIVE_WALLET_DESIGN.md):
exactly one Socket to the helper, one fixed terminal launcher, only the
helper protocol operations, and no process, file, network, clipboard or
URL APIs.
"""
import json
import os
import re
import stat
import struct
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ID = "io.github.yaeloss.omacashu"
QML_FILES = ["BarWidget.qml", "Panel.qml"]

KIND_ENTRY_POINTS = {
    "bar": "bar",
    "bar-widget": "barWidget",
    "menu": "menu",
    "overlay": "overlay",
    "panel": "panel",
    "service": "service",
}

ALLOWED_TOP_LEVEL = {
    ".git", ".github", ".gitignore", ".gitattributes",
    "manifest.json", "BarWidget.qml", "Panel.qml", "preview.png",
    "README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md",
    "assets", "docs", "tests", "helper", "trusted",
}

EXPECTED_EXECUTABLES = {
    "helper/bin/omacashu", "helper/install.sh", "helper/uninstall.sh",
    "trusted/bin/omacashu-broker", "trusted/bin/omacashu-review",
    "trusted/bridge/omacashu_ssh_bridge.py", "trusted/client/omacashu_cli.py",
}

HELPER_OPS = {"status", "prepare", "confirm", "cancel"}
LAUNCHER = "omarchy-launch-floating-terminal-with-presentation"

ALLOWED_IMPORTS = {"QtQuick", "Quickshell", "Quickshell.Io", "qs.Commons", "qs.Commons as Commons", "qs.Ui"}

FORBIDDEN_QML = [
    r"\bProcess\b", r"\bFileView\b", r"SocketServer", r"XMLHttpRequest", r"openUrlExternally",
    r"Clipboard", r"\bIpcHandler\b", r"Qt\.labs", r"\bbar\.run\b", r"\.run\(", r"WebSocket", r"WebEngine",
    r"nostr\+walletconnect", r"cashuA", r"pay_invoice", r"\bseed\b", r"mnemonic", r"secret-tool",
    r"Qt\.include", r"import\s+\"http", r"startDetached",
]


def manifest():
    return json.loads((ROOT / "manifest.json").read_text())


def iter_repo_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in {".git", "__pycache__", "node_modules"}]
        for name in dirnames + filenames:
            yield Path(dirpath) / name


class ValidatorMirrorTests(unittest.TestCase):
    """Same rules as `omarchy plugin validate`."""

    def test_schema_version_is_number_one(self):
        self.assertIs(type(manifest()["schemaVersion"]), int)
        self.assertEqual(manifest()["schemaVersion"], 1)

    def test_required_fields(self):
        m = manifest()
        for field in ["id", "name", "version", "kinds", "entryPoints"]:
            self.assertIn(field, m)

    def test_id(self):
        plugin_id = manifest()["id"]
        self.assertEqual(plugin_id, PLUGIN_ID)
        self.assertRegex(plugin_id, r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
        self.assertNotIn("..", plugin_id)
        self.assertFalse(plugin_id.startswith("omarchy."))

    def test_kinds_and_entry_points(self):
        m = manifest()
        self.assertIsInstance(m["kinds"], list)
        self.assertTrue(m["kinds"])
        self.assertIsInstance(m["entryPoints"], dict)
        for kind in m["kinds"]:
            if kind in KIND_ENTRY_POINTS:
                self.assertIn(KIND_ENTRY_POINTS[kind], m["entryPoints"])
        for value in m["entryPoints"].values():
            self.assertIsInstance(value, str)
            self.assertTrue(value)
            self.assertNotIn("\n", value)
            self.assertFalse(value.startswith("/"))
            self.assertNotIn("..", value)
            self.assertTrue((ROOT / value).is_file(), value)

    def test_default_section(self):
        section = manifest().get("barWidget", {}).get("defaultSection")
        if section is not None:
            self.assertIn(section, ["left", "center", "right"])

    def test_no_symlinks(self):
        for path in iter_repo_files():
            self.assertFalse(path.is_symlink(), f"symlink not allowed: {path}")


class InertPluginTests(unittest.TestCase):
    def qml(self, name):
        return (ROOT / name).read_text()

    def test_only_plugin_files_at_root(self):
        extra = {p.name for p in ROOT.iterdir()} - ALLOWED_TOP_LEVEL
        self.assertFalse(extra, f"unexpected root entries: {extra}")

    def test_runtime_code_only_in_helper_and_trusted(self):
        for path in iter_repo_files():
            rel = path.relative_to(ROOT)
            if path.is_dir() or rel.parts[0] in {"tests", ".github", "helper", "trusted"}:
                continue
            self.assertNotIn(path.suffix, {".py", ".js", ".mjs", ".sh", ".bash", ".service", ".so"}, str(rel))

    def test_only_expected_executables(self):
        found = set()
        for path in iter_repo_files():
            if path.is_file() and path.stat().st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
                found.add(str(path.relative_to(ROOT)))
        self.assertEqual(found, EXPECTED_EXECUTABLES)
        for rel in found:
            self.assertNotEqual((ROOT / rel).read_bytes()[:4], b"\x7fELF", f"bundled binary: {rel}")

    def test_exactly_one_socket_to_the_helper(self):
        panel = self.qml("Panel.qml")
        self.assertEqual(len(re.findall(r"^\s*Socket\s*\{", panel, re.MULTILINE)), 1)
        self.assertNotIn("Socket {", self.qml("BarWidget.qml"))
        self.assertIn('path: root.helperSocketPath', panel)
        self.assertIn('readonly property string helperSocketPath: runtimeDir + "/omacashu/helper.sock"', panel)

    def test_only_helper_protocol_operations(self):
        ops = set(re.findall(r'op:\s*"(\w+)"', self.qml("Panel.qml")))
        self.assertTrue(ops)
        self.assertLessEqual(ops, HELPER_OPS)

    def test_single_fixed_terminal_launcher(self):
        panel = self.qml("Panel.qml")
        calls = re.findall(r"execDetached\((.*)\)", panel)
        self.assertEqual(calls, [f'["{LAUNCHER}", command]'])
        self.assertIn("if (!root.pathsSafe) return", panel)
        self.assertNotIn("execDetached", self.qml("BarWidget.qml"))
        launches = re.findall(r"launchInTerminal\((.*)\)", panel)
        allowed = {"command", "\"bash '\" + root.pluginDir + \"/helper/install.sh'\"",
                   "\"'\" + root.homeDir + \"/.local/bin/omacashu' connect\"",
                   "\"'\" + root.homeDir + \"/.local/bin/omacashu' disconnect\""}
        self.assertLessEqual(set(launches), allowed, launches)

    def test_paths_are_validated_before_use(self):
        self.assertIn(r"return /^\/[A-Za-z0-9._\/-]+$/.test(p)", self.qml("Panel.qml"))

    def test_imports_are_allowlisted(self):
        for name in QML_FILES:
            for match in re.finditer(r"^\s*import\s+(.+?)\s*$", self.qml(name), re.MULTILINE):
                self.assertIn(match.group(1), ALLOWED_IMPORTS, f"{name}: import {match.group(1)}")

    def test_no_forbidden_apis(self):
        for name in QML_FILES:
            source = self.qml(name)
            for pattern in FORBIDDEN_QML:
                self.assertIsNone(re.search(pattern, source), f"{name}: forbidden pattern {pattern}")

    def test_text_is_plain(self):
        for name in QML_FILES:
            source = self.qml(name)
            texts = len(re.findall(r"^\s*Text\s*\{", source, re.MULTILINE))
            plain = source.count("textFormat: Text.PlainText")
            self.assertEqual(texts, plain, f"{name}: every Text must set textFormat: Text.PlainText")

    def test_module_name_matches_id(self):
        for name in QML_FILES:
            self.assertIn(f'moduleName: "{PLUGIN_ID}"', self.qml(name))

    def test_panel_lifecycle_forwarded(self):
        widget = self.qml("BarWidget.qml")
        for member in ["property bool opened", "function open()", "function close()",
                       "function toggle()", "closeForPopoutSwitch", "popoutSwitchClosing"]:
            self.assertIn(member, widget)

    def test_panel_shows_alpha_and_hold_to_pay(self):
        panel = self.qml("Panel.qml")
        self.assertIn("ALPHA · LIVE PAYMENTS", panel)
        self.assertIn("Hold to pay", panel)


class ListingTests(unittest.TestCase):
    def test_preview_png_within_marketplace_limits(self):
        data = (ROOT / "preview.png").read_bytes()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", data[16:24])
        self.assertLessEqual(width * height, 40_000_000)
        self.assertLess(len(data), 50 * 1024 * 1024)

    def test_social_preview_size(self):
        data = (ROOT / "assets" / "social-preview.jpg").read_bytes()
        self.assertEqual(data[:3], b"\xff\xd8\xff")
        self.assertLess(len(data), 1024 * 1024)

    def test_readme_has_install_and_removal(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("omarchy plugin add https://github.com/yaeloss/omacashu.git", readme)
        self.assertIn(f"omarchy plugin remove {PLUGIN_ID}", readme)

    def test_readme_avoids_privileged_commands(self):
        # The marketplace security baseline flags privilege/service references in the root README.
        readme = (ROOT / "README.md").read_text().lower()
        for word in ["sudo", "pkexec", "systemctl", "systemd-run", "sudoers", "curl", "wget"]:
            self.assertNotIn(word, readme)

    def test_helper_supply_chain_pinned(self):
        pkg = json.loads((ROOT / "helper" / "package.json").read_text())
        for name, version in pkg["dependencies"].items():
            self.assertRegex(version, r"^\d+\.\d+\.\d+$", name)
        self.assertTrue((ROOT / "helper" / "package-lock.json").is_file())
        self.assertIn("ignore-scripts=true", (ROOT / "helper" / ".npmrc").read_text())
        installer = (ROOT / "helper" / "install.sh").read_text()
        self.assertIn("ci --omit=dev --ignore-scripts", installer)
        self.assertNotRegex(installer, r"curl|wget")

    def test_license_present(self):
        self.assertIn("MIT License", (ROOT / "LICENSE").read_text())
        self.assertEqual(manifest()["license"], "MIT")


if __name__ == "__main__":
    unittest.main()

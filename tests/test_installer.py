"""Exercise the installer in an isolated home with fake npm and systemd."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipIf(os.geteuid() == 0, 'installer deliberately refuses root')
class InstallerTests(unittest.TestCase):
    def run_install(self, fail_start, previous):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            source = home / 'source'
            shutil.copytree(ROOT / 'helper', source, ignore=shutil.ignore_patterns('node_modules'))
            commands = home / 'commands'
            commands.mkdir()
            scripts = {
                'node': 'echo 22', 'npm': 'exit 0', 'secret-tool': 'exit 0', 'sleep': 'exit 0',
                'systemctl': '''echo "$*" >> "$HOME/systemctl.log"
case "$*" in
  *"is-enabled"*) exit "$PREVIOUS" ;;
  *"is-active"*)
    if [ -f "$HOME/started" ]; then exit "$FAIL_START"; else exit "$PREVIOUS"; fi ;;
  *"enable --now"*) touch "$HOME/started" ;;
esac
exit 0''',
            }
            for name, body in scripts.items():
                path = commands / name
                path.write_text('#!/bin/bash\n' + body + '\n')
                path.chmod(0o700)
            installer = source / 'install.sh'
            installer.write_text(installer.read_text().replace('/usr/bin/node', str(commands / 'node')))
            dest = home / '.local/share/omacashu/helper'
            unit = home / '.config/systemd/user/omacashu-helper.service'
            wrapper = home / '.local/bin/omacashu'
            if previous:
                dest.mkdir(parents=True)
                (dest / 'old').write_text('old code')
                for path in (unit, wrapper):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('old configuration')
            env = {**os.environ, 'HOME': str(home), 'XDG_DATA_HOME': str(home / '.local/share'),
                   'XDG_CONFIG_HOME': str(home / '.config'), 'PATH': str(commands) + ':' + os.environ['PATH'],
                   'PREVIOUS': '0' if previous else '1', 'FAIL_START': '1' if fail_start else '0'}
            result = subprocess.run(['bash', str(installer), '--yes'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode != 0, fail_start, result.stdout + result.stderr)
            if fail_start and previous:
                self.assertEqual((dest / 'old').read_text(), 'old code')
                for path in (unit, wrapper):
                    self.assertEqual(path.read_text(), 'old configuration')
                self.assertIn('--user start omacashu-helper.service', (home / 'systemctl.log').read_text())
            elif fail_start:
                self.assertFalse(dest.exists())
                self.assertFalse(unit.exists())
                self.assertFalse(wrapper.exists())
            else:
                self.assertTrue((dest / 'src/ledger.mjs').exists())
                self.assertFalse((dest / 'old').exists())
            self.assertEqual(list(dest.parent.glob('helper.rollback.*')), [])

    def test_failed_upgrade_restores_previous_installation(self):
        self.run_install(True, True)

    def test_failed_first_install_is_cleaned_up(self):
        self.run_install(True, False)

    def test_successful_upgrade_commits_replacement(self):
        self.run_install(False, True)

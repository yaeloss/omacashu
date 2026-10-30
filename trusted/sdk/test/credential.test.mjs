import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialError, parseConnectionUrl, readCredentialFile } from '../credential.mjs';

const PUBKEY = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);
const GOOD = `nostr+walletconnect://${PUBKEY}?relay=wss%3A%2F%2Frelay.example.com&secret=${SECRET}`;
const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omacashu-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('accepts a well-formed NIP-47 URI', () => {
  const parsed = parseConnectionUrl(GOOD);
  assert.equal(parsed.walletPubkey, PUBKEY);
  assert.equal(parsed.relayCount, 1);
  assert.equal(parseConnectionUrl(`nostr+walletconnect://${PUBKEY}?relay=ws://127.0.0.1:7777&secret=${SECRET}`).relayCount, 1);
});

test('rejects malformed or unsafe URIs without echoing them', () => {
  const bad = [
    'https://example.com',
    `nostr+walletconnect://${PUBKEY}?relay=wss://r.example&secret=short`,
    `nostr+walletconnect://${PUBKEY}?relay=ws://relay.example.com&secret=${SECRET}`,
    `nostr+walletconnect://${PUBKEY}?relay=wss://u:p@r.example&secret=${SECRET}`,
    `nostr+walletconnect://${PUBKEY}?secret=${SECRET}`,
    `nostr+walletconnect://${PUBKEY}?relay=wss://r.example&secret=${SECRET}&secret=${SECRET}`,
    `nostr+walletconnect://notahexkey?relay=wss://r.example&secret=${SECRET}`,
    `nostr+walletconnect://${PUBKEY}/path?relay=wss://r.example&secret=${SECRET}`,
    `${GOOD} `.repeat(2),
    'x'.repeat(5000),
  ];
  for (const value of bad) {
    assert.throws(() => parseConnectionUrl(value), (err) => err instanceof CredentialError && !err.message.includes(SECRET));
  }
});

test('reads a private 0600 credential file', async () => withTmp(async (dir) => {
  const file = join(dir, 'nwc.txt');
  await writeFile(file, GOOD + '\n', { mode: 0o600 });
  assert.equal(await readCredentialFile(file), GOOD);
}));

test('rejects group/other-readable, symlinked, directory and oversized credentials', async () => withTmp(async (dir) => {
  const open = join(dir, 'open.txt');
  await writeFile(open, GOOD, { mode: 0o600 });
  await chmod(open, 0o644);
  await assert.rejects(readCredentialFile(open), /mode 0600/);

  const target = join(dir, 'target.txt');
  await writeFile(target, GOOD, { mode: 0o600 });
  const link = join(dir, 'link.txt');
  await symlink(target, link);
  await assert.rejects(readCredentialFile(link), /symlink/);

  const sub = join(dir, 'sub');
  await mkdir(sub, { mode: 0o700 });
  await assert.rejects(readCredentialFile(sub), CredentialError);

  const big = join(dir, 'big.txt');
  await writeFile(big, 'x'.repeat(5000), { mode: 0o600 });
  await assert.rejects(readCredentialFile(big), /too large/);
}));

test('rejects a credential owned by another user', async () => withTmp(async (dir) => {
  const file = join(dir, 'nwc.txt');
  await writeFile(file, GOOD, { mode: 0o600 });
  await assert.rejects(readCredentialFile(file, { uid: process.getuid() + 1 }), /owned/);
}));

test('CLI never prints the credential on failure', { skip: !existsSync(join(SDK_DIR, 'node_modules', '@getalby', 'sdk')) && 'SDK not installed' }, async () => withTmp(async (dir) => {
  const file = join(dir, 'nwc.txt');
  // Loopback relay on a closed port: the query must fail fast and quietly.
  await writeFile(file, `nostr+walletconnect://${PUBKEY}?relay=ws://127.0.0.1:9&secret=${SECRET}`, { mode: 0o600 });
  const run = spawnSync(process.execPath, ['readonly.mjs', 'info', file], { cwd: SDK_DIR, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.ok(!run.stderr.includes(SECRET) && !run.stderr.includes(PUBKEY), 'credential leaked to stderr');
}));

test('CLI refuses balance without explicit opt-in', () => {
  const run = spawnSync(process.execPath, ['readonly.mjs', 'balance', '/nonexistent'], {
    cwd: SDK_DIR, encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Balance display disabled/);
});

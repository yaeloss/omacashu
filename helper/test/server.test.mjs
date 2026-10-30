import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request, startServer } from '../src/server.mjs';

const stub = { handle: async (msg) => ({ ok: true, echo: msg.op }) };

function dirs(t) {
  const base = mkdtempSync(join(tmpdir(), 'omacashu-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const run = join(base, 'run');
  mkdirSync(run, { mode: 0o700 });
  return { base, run, sock: join(run, 'helper.sock') };
}

function raw(path, data, { end = true } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(path);
    const chunks = [];
    s.on('connect', () => { if (data) s.write(data); if (end) s.end(); });
    s.on('data', (c) => chunks.push(c));
    s.on('close', () => resolve(Buffer.concat(chunks).toString()));
    s.on('error', () => resolve(''));
  });
}

test('socket is user-only and answers one request', async (t) => {
  const { sock } = dirs(t);
  const server = await startServer(stub, sock);
  t.after(() => server.close());
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  assert.deepEqual(await request(sock, { op: 'status' }), { ok: true, echo: 'status' });
});

test('rejects invalid, oversized and stalled requests', async (t) => {
  const { sock } = dirs(t);
  const server = await startServer(stub, sock);
  t.after(() => server.close());
  assert.match(await raw(sock, '{"op":"pay"}\n'), /invalid_request/);
  assert.match(await raw(sock, 'x'.repeat(9000)), /too_large/);
  const started = Date.now();
  assert.match(await raw(sock, '{"op":', { end: false }), /timeout/);
  assert.ok(Date.now() - started < 3500);
});

test('refuses a non-private runtime directory or symlinked one', async (t) => {
  const { base } = dirs(t);
  const open = join(base, 'open');
  mkdirSync(open);
  chmodSync(open, 0o755);
  await assert.rejects(startServer(stub, join(open, 'helper.sock')), /private/);
  const real = join(base, 'real');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(base, 'link'));
  await assert.rejects(startServer(stub, join(base, 'link', 'helper.sock')), /real directory/);
});

test('refuses to steal a live socket but replaces a stale one', async (t) => {
  const { sock } = dirs(t);
  const first = await startServer(stub, sock);
  await assert.rejects(startServer(stub, sock), /already running/);
  await new Promise((r) => first.close(r));
  // simulate a stale socket file left behind
  const stale = net.createServer();
  await new Promise((r) => stale.listen(sock, r));
  stale.unref();
  stale.close(); // close without unlink is not guaranteed; ensure a file exists either way
  const second = await startServer(stub, sock);
  t.after(() => second.close());
  assert.equal((await request(sock, { op: 'status' })).ok, true);
});

test('CLI basics', () => {
  const bin = fileURLToPath(new URL('../bin/omacashu', import.meta.url));
  const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.match(version.stdout, /^0\.2\.0-alpha/);
  const usage = spawnSync(process.execPath, [bin, 'pay', 'lnbc1'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const status = spawnSync(process.execPath, [bin, 'status'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: tmpdir() + '/omacashu-none', HOME: tmpdir() },
  });
  assert.equal(status.status, 1);
  assert.match(status.stderr, /not running/);
});

/** User-only Unix socket transport for the helper service. One JSON line in, one out. */
import net from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseRequest } from './service.mjs';

export const MAX_REQUEST_BYTES = 8192;
export const READ_DEADLINE_MS = 2000;
export const MAX_CONNECTIONS = 8;

function assertPrivateDirectory(dir) {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} must be a real directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} must be owned by you`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} must be private (mode 0700)`);
}

function probe(path) {
  return new Promise((resolve) => {
    const s = net.connect(path);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

export async function startServer(service, socketPath, { log = () => {} } = {}) {
  assertPrivateDirectory(dirname(socketPath));
  let existing = null;
  try {
    existing = lstatSync(socketPath);
  } catch { /* absent */ }
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid()) throw new Error('socket path is occupied by something else');
    if (await probe(socketPath)) throw new Error('another omacashu helper is already running');
    unlinkSync(socketPath);
  }

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = Buffer.alloc(0);
    let handled = false;
    const reply = (response) => {
      if (socket.destroyed) return;
      socket.end(JSON.stringify(response) + '\n');
    };
    const timer = setTimeout(() => {
      if (!handled) {
        handled = true;
        reply({ ok: false, error: 'timeout', message: 'request not received in time' });
      }
    }, READ_DEADLINE_MS);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        clearTimeout(timer);
        reply({ ok: false, error: 'too_large', message: 'request too large' });
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      handled = true;
      clearTimeout(timer);
      const msg = parseRequest(buffer.subarray(0, newline).toString('utf8'));
      if (!msg) {
        reply({ ok: false, error: 'invalid_request', message: 'invalid request' });
        return;
      }
      service.handle(msg).then(reply, () => {
        log('request_failed');
        reply({ ok: false, error: 'helper_failure', message: 'internal error' });
      });
    });
    socket.on('end', () => {
      if (!handled) {
        handled = true;
        clearTimeout(timer);
        reply({ ok: false, error: 'invalid_request', message: 'invalid request' });
      }
    });
  });
  server.maxConnections = MAX_CONNECTIONS;

  const oldMask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
  } finally {
    process.umask(oldMask);
  }
  chmodSync(socketPath, 0o600);
  return server;
}

/** Client used by the CLI: send one request, get one parsed response. */
export function request(socketPath, payload, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('helper did not respond')); }, timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('malformed helper response'));
      }
    });
  });
}

/** NWC connection storage in the Secret Service keyring via secret-tool (libsecret). */
import { spawn } from 'node:child_process';

const ATTRIBUTES = ['service', 'omacashu', 'account', 'nwc'];
const TIMEOUT_MS = 30_000;

export class KeyringError extends Error {}

function run(args, input) {
  return new Promise((resolve, reject) => {
    const env = { PATH: '/usr/bin:/bin' };
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'HOME']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    let child;
    try {
      child = spawn('secret-tool', args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      reject(new KeyringError('secret-tool is not available (install libsecret)'));
      return;
    }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', () => reject(new KeyringError('secret-tool is not available (install libsecret)')));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8192) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      chunks.length = 0;
      resolve({ code, output });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export async function storeConnection(uri) {
  const { code } = await run(['store', '--label=omaCashu wallet connection (NWC)', ...ATTRIBUTES], uri);
  if (code !== 0) throw new KeyringError('could not save to the keyring (is it unlocked?)');
}

export async function loadConnection() {
  const { code, output } = await run(['lookup', ...ATTRIBUTES]);
  if (code !== 0 || output.trim() === '') return null;
  return output.trim();
}

export async function clearConnection() {
  await run(['clear', ...ATTRIBUTES]);
}

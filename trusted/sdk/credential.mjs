/**
 * Credential handling for the trusted-device read-only adapter.
 * Never log, print, or include the connection string in an error message.
 */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

const MAX_CREDENTIAL_BYTES = 4096;
const HEX64 = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class CredentialError extends Error {}

/**
 * Open with O_NOFOLLOW and check the *opened handle* (no lstat/read race):
 * regular file, owned by this user, mode 0600 or stricter, bounded size.
 */
export async function readCredentialFile(path, { uid = process.getuid?.() } = {}) {
  if (typeof path !== 'string' || path === '') throw new CredentialError('credential path required');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch {
    throw new CredentialError('cannot open credential file (missing, or a symlink)');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new CredentialError('credential must be a regular file');
    if ((st.mode & 0o077) !== 0) throw new CredentialError('credential file must be mode 0600');
    if (uid !== undefined && st.uid !== uid) throw new CredentialError('credential file must be owned by this user');
    if (st.size > MAX_CREDENTIAL_BYTES) throw new CredentialError('credential file too large');
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CREDENTIAL_BYTES) throw new CredentialError('credential file too large');
    const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
    buffer.fill(0);
    return text;
  } finally {
    await handle.close();
  }
}

/** Strictly parse a NIP-47 connection URI. Returns the original string only if it is well formed. */
export function parseConnectionUrl(raw) {
  const invalid = () => new CredentialError('invalid connection credential');
  if (typeof raw !== 'string' || raw.length > MAX_CREDENTIAL_BYTES || /\s/.test(raw)) throw invalid();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'nostr+walletconnect:' || url.username || url.password || url.port) throw invalid();
  const pubkey = url.hostname.toLowerCase();
  if (!HEX64.test(pubkey) || (url.pathname !== '' && url.pathname !== '/')) throw invalid();
  const secrets = url.searchParams.getAll('secret');
  if (secrets.length !== 1 || !HEX64.test(secrets[0].toLowerCase())) throw invalid();
  const relays = url.searchParams.getAll('relay');
  if (relays.length === 0) throw invalid();
  for (const relay of relays) {
    let relayUrl;
    try {
      relayUrl = new URL(relay);
    } catch {
      throw invalid();
    }
    const secure = relayUrl.protocol === 'wss:';
    const loopback = relayUrl.protocol === 'ws:' && LOOPBACK_HOSTS.has(relayUrl.hostname);
    if (!(secure || loopback) || relayUrl.username || relayUrl.password) throw invalid();
  }
  return { url: raw, walletPubkey: pubkey, relayCount: relays.length };
}

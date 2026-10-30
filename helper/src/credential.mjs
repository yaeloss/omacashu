/** Strict NIP-47 connection URI parsing. Never include the URI in an error message. */
const MAX_URI_LENGTH = 4096;
const HEX64 = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class CredentialError extends Error {}

export function parseConnectionUrl(raw) {
  const invalid = () => new CredentialError('invalid wallet connection (expected nostr+walletconnect://...)');
  if (typeof raw !== 'string') throw invalid();
  raw = raw.trim();
  if (raw.length > MAX_URI_LENGTH || /\s/.test(raw)) throw invalid();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'nostr+walletconnect:' || url.username || url.password || url.port) throw invalid();
  const walletPubkey = url.hostname.toLowerCase();
  if (!HEX64.test(walletPubkey) || (url.pathname !== '' && url.pathname !== '/')) throw invalid();
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
  return { url: raw, walletPubkey, relays };
}

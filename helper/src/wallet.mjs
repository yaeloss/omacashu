/** Thin, timeout-bounded wrapper around the Alby SDK NWC client. */
import { createHash } from 'node:crypto';

export const QUERY_TIMEOUT_MS = 15_000;
export const PAY_TIMEOUT_MS = 60_000;

export class WalletTimeout extends Error {}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new WalletTimeout('wallet did not respond')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export async function createNwcWallet(url) {
  const { NWCClient } = await import('@getalby/sdk/nwc');
  const client = new NWCClient({ nostrWalletConnectUrl: url });
  return {
    getInfo: () => withTimeout(client.getInfo(), QUERY_TIMEOUT_MS),
    getBudget: () => withTimeout(client.getBudget(), QUERY_TIMEOUT_MS),
    payInvoice: (invoice) => withTimeout(client.payInvoice({ invoice }), PAY_TIMEOUT_MS),
    close: () => { try { client.close(); } catch { /* never log */ } },
  };
}

export function preimageMatches(preimageHex, paymentHash) {
  if (typeof preimageHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(preimageHex)) return false;
  return createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex') === paymentHash;
}

const DEFINITIVE_WALLET_CODES = new Set([
  'PAYMENT_FAILED', 'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'RESTRICTED', 'UNAUTHORIZED', 'NOT_IMPLEMENTED',
]);

/**
 * True only when the payment definitively did not happen: the wallet answered with an
 * explicit refusal code, or we never reached a relay. Timeouts and anything ambiguous
 * are "unknown" and block automatic retries.
 */
export function isDefinitiveFailure(error) {
  if (error instanceof WalletTimeout) return false;
  const name = error?.constructor?.name;
  if (name === 'Nip47NetworkError') return true;
  return name === 'Nip47WalletError' && DEFINITIVE_WALLET_CODES.has(String(error.code).toUpperCase());
}

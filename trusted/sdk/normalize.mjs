/** Explicit allowlists: strip extra NIP-47 fields, secrets, identifiers and unsafe characters. */
const METHOD_SHAPE = /^(get_info|get_balance|make_invoice|pay_invoice|lookup_invoice|list_transactions)$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
// Control, format (incl. bidi overrides), and line/paragraph separators can spoof terminals and UIs.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_ALIAS_CHARS = 64;

export function sanitizeText(value, maxChars = MAX_ALIAS_CHARS) {
  if (typeof value !== 'string') return null;
  const clean = Array.from(value.replace(UNSAFE_CHARS, '').trim()).slice(0, maxChars).join('');
  return clean === '' ? null : clean;
}

export function normalizeInfo(info) {
  if (!info || typeof info !== 'object') throw Error('invalid wallet metadata');
  const methods = Array.isArray(info.methods)
    ? info.methods.filter(method => typeof method === 'string' && METHOD_SHAPE.test(method))
    : [];
  return {
    alias: sanitizeText(info.alias),
    network: NETWORKS.includes(info.network) ? info.network : 'unknown',
    methods: [...new Set(methods)].sort()
  };
}

export function normalizeBalance(balance) {
  if (!balance || !Number.isSafeInteger(balance.balance) || balance.balance < 0) throw Error('invalid balance');
  // NIP-47 balance is denominated in millisatoshis, not sats.
  return { balance_msat: balance.balance, balance_sat: Math.floor(balance.balance / 1000) };
}

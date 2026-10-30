/** Test-only BOLT11 encoder: signs fresh invoices with a throwaway key so policy checks see current timestamps. */
import { bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';

export const TEST_KEY = sha256(new TextEncoder().encode('omacashu throwaway test key'));
export const TEST_PAYEE = Buffer.from(secp256k1.getPublicKey(TEST_KEY, true)).toString('hex');

function intWords(value) {
  const words = [];
  do {
    words.unshift(value % 32);
    value = Math.floor(value / 32);
  } while (value > 0);
  return words;
}

function fixedIntWords(value, length) {
  const words = intWords(value);
  while (words.length < length) words.unshift(0);
  return words;
}

function tag(type, words) {
  return [type, words.length >> 5, words.length & 31, ...words];
}

function paddedBytes(words) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

export function makeInvoice({
  prefix = 'lnbc', amount = '2500n', timestamp = Math.floor(Date.now() / 1000), expiry = 3600,
  description = 'omaCashu test', paymentHash = randomBytes(32).toString('hex'), key = TEST_KEY,
  secret = true, includePayee = false, forceHighS = false,
} = {}) {
  const hrp = prefix + amount;
  let words = fixedIntWords(timestamp, 7);
  words = words.concat(tag(1, bech32.toWords(Buffer.from(paymentHash, 'hex'))));
  if (secret) words = words.concat(tag(16, bech32.toWords(randomBytes(32))));
  if (description !== null) words = words.concat(tag(13, bech32.toWords(new TextEncoder().encode(description))));
  if (expiry !== null) words = words.concat(tag(6, intWords(expiry)));
  if (includePayee) words = words.concat(tag(19, bech32.toWords(secp256k1.getPublicKey(key, true))));
  const message = sha256(Buffer.concat([Buffer.from(hrp, 'utf8'), paddedBytes(words)]));
  const recovered = secp256k1.sign(message, key, { prehash: false, format: 'recovered' });
  let compact = Buffer.from(recovered.slice(1));
  if (forceHighS) {
    const n = secp256k1.Point.Fn.ORDER;
    const s = BigInt('0x' + compact.subarray(32).toString('hex'));
    compact = Buffer.concat([compact.subarray(0, 32), Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex')]);
  }
  const signature = Buffer.concat([compact, Buffer.from([recovered[0]])]);
  return { invoice: bech32.encode(hrp, words.concat(bech32.toWords(signature)), false), paymentHash };
}

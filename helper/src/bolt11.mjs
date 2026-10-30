/**
 * Verified BOLT11 decoder (https://github.com/lightning/bolts/blob/master/11-payment-encoding.md).
 *
 * Unlike display-only decoders this verifies the signature (n-field low-S
 * verification or public-key recovery), enforces the fixed-length and
 * exactly-once field rules, and returns the payee node key and network so
 * the confirmation screen never shows unverified amounts or destinations.
 * Feature-bit negotiation (field 9) is left to the paying wallet.
 */
import { bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

export class InvoiceError extends Error {}

const MAX_INVOICE_LENGTH = 7089;
const SIGNATURE_WORDS = 104;
const TIMESTAMP_WORDS = 7;
const DEFAULT_EXPIRY = 3600;
// Longest prefixes first so "bcrt"/"tbs" are not mistaken for "bc"/"tb".
const NETWORKS = [['bcrt', 'regtest'], ['tbs', 'signet'], ['bc', 'mainnet'], ['tb', 'testnet']];
const MSAT_PER_BTC = 100_000_000_000n;
const MULTIPLIER_DIVISOR = { m: 1_000n, u: 1_000_000n, n: 1_000_000_000n, p: 1_000_000_000_000n };
const TAG = { p: 1, s: 16, d: 13, h: 23, n: 19, x: 6 };
const utf8 = new TextDecoder('utf-8', { fatal: true });

const fail = (message) => { throw new InvoiceError(message); };
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

function wordsToInt(words) {
  let value = 0;
  for (const word of words) value = value * 32 + word;
  return value;
}

/** 5-bit words to bytes, zero-padding the final byte (used for the signed message). */
function wordsToPaddedBytes(words) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

function strictBytes(words, what) {
  try {
    return bech32.fromWords(words);
  } catch {
    return fail(`invalid ${what} field`);
  }
}

function parseHrp(hrp) {
  if (!hrp.startsWith('ln')) fail('not a Lightning invoice');
  const rest = hrp.slice(2);
  const match = NETWORKS.find(([prefix]) => rest.startsWith(prefix));
  if (!match) fail('unknown currency prefix');
  const amountPart = rest.slice(match[0].length);
  if (amountPart === '') return { network: match[1], amountMsat: null };
  const parsed = /^([1-9][0-9]*)([munp])?$/.exec(amountPart);
  if (!parsed) fail('invalid amount');
  const value = BigInt(parsed[1]);
  const multiplier = parsed[2];
  if (!multiplier) return { network: match[1], amountMsat: value * MSAT_PER_BTC };
  const scaled = value * MSAT_PER_BTC;
  if (scaled % MULTIPLIER_DIVISOR[multiplier] !== 0n) fail('sub-millisatoshi amount');
  return { network: match[1], amountMsat: scaled / MULTIPLIER_DIVISOR[multiplier] };
}

export function decodeInvoice(input) {
  if (typeof input !== 'string') fail('invoice must be text');
  let text = input.trim();
  if (/^lightning:/i.test(text)) text = text.slice('lightning:'.length);
  if (text.length < 20 || text.length > MAX_INVOICE_LENGTH) fail('invalid invoice length');
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) fail('mixed-case invoice');
  const lower = text.toLowerCase();

  let decoded;
  try {
    decoded = bech32.decode(lower, false);
  } catch {
    fail('invalid invoice encoding or checksum');
  }
  const { prefix: hrp, words } = decoded;
  const { network, amountMsat } = parseHrp(hrp);
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) fail('invoice too short');

  const dataWords = words.slice(0, -SIGNATURE_WORDS);
  const signature = strictBytes(words.slice(-SIGNATURE_WORDS), 'signature');
  const timestamp = wordsToInt(dataWords.slice(0, TIMESTAMP_WORDS));

  const seen = { p: 0, s: 0, d: 0, h: 0, n: 0, x: 0 };
  let paymentHash = null;
  let description = null;
  let descriptionHash = null;
  let payee = null;
  let expiry = DEFAULT_EXPIRY;

  let i = TIMESTAMP_WORDS;
  while (i < dataWords.length) {
    if (i + 3 > dataWords.length) fail('truncated tagged field');
    const type = dataWords[i];
    const length = dataWords[i + 1] * 32 + dataWords[i + 2];
    i += 3;
    if (i + length > dataWords.length) fail('truncated tagged field');
    const field = dataWords.slice(i, i + length);
    i += length;

    switch (type) {
      case TAG.p:
        if (length !== 52) fail('invalid payment hash length');
        seen.p += 1;
        paymentHash = toHex(strictBytes(field, 'payment hash'));
        break;
      case TAG.s:
        if (length !== 52) fail('invalid payment secret length');
        seen.s += 1;
        strictBytes(field, 'payment secret');
        break;
      case TAG.h:
        if (length !== 52) fail('invalid description hash length');
        seen.h += 1;
        descriptionHash = toHex(strictBytes(field, 'description hash'));
        break;
      case TAG.n:
        if (length !== 53) fail('invalid payee key length');
        seen.n += 1;
        payee = strictBytes(field, 'payee');
        break;
      case TAG.d:
        seen.d += 1;
        try {
          description = utf8.decode(strictBytes(field, 'description'));
        } catch (error) {
          if (error instanceof InvoiceError) throw error;
          fail('description is not valid UTF-8');
        }
        break;
      case TAG.x:
        if (length === 0 || field[0] === 0) fail('non-minimal expiry');
        seen.x += 1;
        expiry = wordsToInt(field);
        break;
      default:
        break; // c, f, r, 9, m and unknown fields do not affect what we display or verify
    }
  }

  if (seen.p !== 1) fail('invoice must contain exactly one payment hash');
  if (seen.s !== 1) fail('invoice must contain exactly one payment secret');
  if (seen.d + seen.h !== 1) fail('invoice must contain a description or a description hash, not both');
  if (seen.n > 1 || seen.x > 1) fail('duplicate field');

  const recovery = signature[64];
  if (recovery > 3) fail('invalid signature recovery id');
  const compact = signature.slice(0, 64);
  const message = sha256(Buffer.concat([Buffer.from(hrp, 'utf8'), wordsToPaddedBytes(dataWords)]));

  // Read r and s from the raw bytes: the curve library normalizes s on parse, which would hide high-S.
  const order = secp256k1.Point.Fn.ORDER;
  const r = BigInt('0x' + toHex(compact.slice(0, 32)));
  let s = BigInt('0x' + toHex(compact.slice(32, 64)));
  if (r === 0n || s === 0n || r >= order || s >= order) fail('invalid signature');
  const highS = s > order >> 1n;

  let payeeKey;
  try {
    if (payee) {
      // With an n field the spec requires low-S and verification against that key.
      if (highS) fail('non-canonical (high-S) signature');
      if (!secp256k1.verify(compact, message, payee, { prehash: false, lowS: true })) fail('invalid signature');
      payeeKey = payee;
    } else {
      // Recovery must accept high-S. Per the BOLT11 test vector, a high-S signature is read as
      // its low-S equivalent with the recovery id unchanged (it was produced by negating s).
      if (highS) s = order - s;
      payeeKey = new secp256k1.Signature(r, s).addRecoveryBit(recovery).recoverPublicKey(message).toBytes(true);
    }
  } catch (error) {
    if (error instanceof InvoiceError) throw error;
    fail('invalid signature');
  }

  if (amountMsat !== null && amountMsat > BigInt(Number.MAX_SAFE_INTEGER)) fail('amount too large');

  return {
    invoice: lower,
    network,
    amountMsat: amountMsat === null ? null : Number(amountMsat),
    timestamp,
    expiry,
    expiresAt: timestamp + expiry,
    paymentHash,
    description,
    descriptionHash,
    payee: toHex(payeeKey),
  };
}

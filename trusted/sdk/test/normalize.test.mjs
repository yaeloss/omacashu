import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInfo, normalizeBalance, sanitizeText } from '../normalize.mjs';

test('metadata allowlist, no leaked secret or unknown methods', () => {
  const info = normalizeInfo({ alias: 'Wallet', network: 'mainnet', methods: ['get_balance', 'pay_invoice', 'secret_method'], secret: 'dontprint' });
  assert.deepEqual(info, { alias: 'Wallet', network: 'mainnet', methods: ['get_balance', 'pay_invoice'] });
  assert.equal('secret' in info, false);
});

test('unknown network and missing fields are normalized', () => {
  assert.deepEqual(normalizeInfo({ network: 'evilnet' }), { alias: null, network: 'unknown', methods: [] });
  assert.throws(() => normalizeInfo(null));
});

test('alias is stripped of terminal escapes, bidi overrides and line separators', () => {
  const info = normalizeInfo({ alias: '\u001b[31mEvil\u202e\u0007 Wallet\u2028', methods: [] });
  assert.equal(info.alias, '[31mEvil Wallet');
  assert.equal(sanitizeText('\u0000\u200b'), null);
  assert.equal(Array.from(sanitizeText('🙂'.repeat(100))).length, 64);
});

test('balance unit conversion uses millisatoshis', () => {
  assert.deepEqual(normalizeBalance({ balance: 2500999 }), { balance_msat: 2500999, balance_sat: 2500 });
});

test('balance rejects invalid and negative numbers', () => {
  for (const balance of [-1, NaN, Infinity, 1.2, '1500', Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => normalizeBalance({ balance }));
  }
});

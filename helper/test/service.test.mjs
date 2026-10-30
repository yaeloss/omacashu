import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkConnection, checkInvoice, PolicyError, STRICT_POLICY } from '../src/policy.mjs';
import { HelperService, parseRequest } from '../src/service.mjs';
import { Ledger } from '../src/ledger.mjs';
import { parseConnectionUrl } from '../src/credential.mjs';
import { sanitizeText } from '../src/sanitize.mjs';
import { isDefinitiveFailure, WalletTimeout } from '../src/wallet.mjs';
import { makeInvoice } from './helpers/invoice.mjs';
import { createHash, randomBytes } from 'node:crypto';

const GOOD_INFO = { alias: 'Test Wallet', network: 'mainnet', methods: ['get_info', 'get_budget', 'pay_invoice', 'get_balance'] };
const BUDGET = { used_budget: 1_000_000, total_budget: 50_000_000, renews_at: 2_000_000_000, renewal_period: 'monthly' };
const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${'b'.repeat(64)}`;

class Nip47WalletError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function fakeWallet({ info = GOOD_INFO, budget = BUDGET, pay } = {}) {
  const calls = { pay: [] };
  return {
    calls,
    getInfo: async () => info,
    getBudget: async () => budget,
    payInvoice: async (invoice) => {
      calls.pay.push(invoice);
      return pay(invoice);
    },
    close() {},
  };
}

function preimageFor() {
  const preimage = randomBytes(32);
  return { preimage: preimage.toString('hex'), hash: createHash('sha256').update(preimage).digest('hex') };
}

function setup(t, walletOptions = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omacashu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(join(dir, 'state'));
  const wallet = fakeWallet(walletOptions);
  let now = extra.now ?? Math.floor(Date.now() / 1000);
  const service = new HelperService({
    loadCredential: async () => (extra.noCredential ? null : URI),
    walletFactory: async () => wallet,
    ledger,
    clock: () => now,
  });
  return { service, wallet, ledger, dir, advance: (s) => { now += s; } };
}

// ---------- policy ----------

test('connection policy: budget required, ceiling; extra permissions allowed but reported', () => {
  assert.deepEqual(checkConnection(GOOD_INFO, BUDGET).problems, []);
  assert.match(checkConnection(GOOD_INFO, {}).problems.join(), /no wallet-enforced budget/);
  const fullAccess = { methods: [...GOOD_INFO.methods, 'pay_keysend', 'make_hold_invoice', 'multi_pay_invoice', 'sign_message'] };
  const result = checkConnection(fullAccess, BUDGET);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unused, ['get_balance', 'pay_keysend', 'make_hold_invoice', 'multi_pay_invoice', 'sign_message']);
  assert.match(checkConnection({ methods: ['get_info'] }, BUDGET).problems.join(), /pay_invoice.*get_budget/s);
  assert.match(checkConnection(GOOD_INFO, { ...BUDGET, total_budget: 200_000_000 }).problems.join(), /exceeds the local ceiling/);
});

test('invoice policy', () => {
  const now = 1_800_000_000;
  const base = { network: 'mainnet', amountMsat: 1000, timestamp: now, expiresAt: now + 600, paymentHash: 'x' };
  const ok = (d, extra = {}) => checkInvoice({ ...base, ...d }, { now, remainingMsat: 10_000, ledgerStatus: null, ...extra });
  ok({});
  ok({}, { ledgerStatus: 'failed' }); // a definitively failed payment may be retried
  const code = (fn) => { try { fn(); return null; } catch (e) { assert.ok(e instanceof PolicyError); return e.code; } };
  assert.equal(code(() => ok({ network: 'testnet' })), 'wrong_network');
  assert.equal(code(() => ok({ amountMsat: null })), 'no_amount');
  assert.equal(code(() => ok({ expiresAt: now + 30 })), 'expired');
  assert.equal(code(() => ok({ timestamp: now + 3600 })), 'future');
  assert.equal(code(() => ok({ amountMsat: 20_000 })), 'over_budget');
  assert.equal(code(() => ok({}, { ledgerStatus: 'paid' })), 'already_paid');
  assert.equal(code(() => ok({}, { ledgerStatus: 'unknown' })), 'already_attempted');
});

test('strict policy is frozen', () => {
  assert.ok(Object.isFrozen(STRICT_POLICY));
  assert.equal(STRICT_POLICY.requireBudget, true);
});

// ---------- service ----------

test('prepare then confirm pays once and verifies the preimage', async (t) => {
  const { preimage, hash } = preimageFor();
  const { service, wallet, ledger } = setup(t, { pay: async () => ({ preimage, fees_paid: 2000 }) });
  const { invoice } = makeInvoice({ amount: '10u', paymentHash: hash, description: 'tea\u202e\u0007 time' });
  const prepared = await service.handle({ op: 'prepare', invoice });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.amount_sat, 1000);
  assert.equal(prepared.description, 'tea time');
  assert.equal(prepared.budget_remaining_after_sat, 48_000);
  const paid = await service.handle({ op: 'confirm', payment_id: prepared.payment_id });
  assert.deepEqual(paid, { ok: true, status: 'paid', amount_sat: 1000, fee_sat: 2 });
  assert.equal(ledger.status(hash), 'paid');
  // single use + never twice
  assert.equal((await service.handle({ op: 'confirm', payment_id: prepared.payment_id })).error, 'unknown_payment');
  assert.equal((await service.handle({ op: 'prepare', invoice })).error, 'already_paid');
  assert.equal(wallet.calls.pay.length, 1);
});

test('confirmation window expires', async (t) => {
  const { service, wallet, advance } = setup(t, { pay: async () => ({}) });
  const prepared = await service.handle({ op: 'prepare', invoice: makeInvoice().invoice });
  advance(121);
  assert.equal((await service.handle({ op: 'confirm', payment_id: prepared.payment_id })).error, 'confirmation_expired');
  assert.equal(wallet.calls.pay.length, 0);
});

test('cancel discards a prepared payment', async (t) => {
  const { service } = setup(t, { pay: async () => ({}) });
  const prepared = await service.handle({ op: 'prepare', invoice: makeInvoice().invoice });
  await service.handle({ op: 'cancel', payment_id: prepared.payment_id });
  assert.equal((await service.handle({ op: 'confirm', payment_id: prepared.payment_id })).error, 'unknown_payment');
});

test('definitive wallet failure allows a retry; timeouts block it', async (t) => {
  let mode = 'fail';
  const { preimage, hash } = preimageFor();
  const { service, ledger } = setup(t, {
    pay: async () => {
      if (mode === 'fail') throw new Nip47WalletError('no route', 'PAYMENT_FAILED');
      if (mode === 'timeout') throw new WalletTimeout('wallet did not respond');
      return { preimage };
    },
  });
  const { invoice } = makeInvoice({ paymentHash: hash });
  let prepared = await service.handle({ op: 'prepare', invoice });
  const failed = await service.handle({ op: 'confirm', payment_id: prepared.payment_id });
  assert.equal(failed.status, 'failed');
  assert.equal(ledger.status(hash), 'failed');

  mode = 'timeout';
  prepared = await service.handle({ op: 'prepare', invoice });
  const unresolved = await service.handle({ op: 'confirm', payment_id: prepared.payment_id });
  assert.equal(unresolved.status, 'unknown');
  assert.equal(ledger.status(hash), 'unknown');
  assert.equal((await service.handle({ op: 'prepare', invoice })).error, 'already_attempted');
});

test('success without a matching preimage is not trusted', async (t) => {
  const { service, ledger } = setup(t, { pay: async () => ({ preimage: 'ff'.repeat(32) }) });
  const { invoice, paymentHash } = makeInvoice();
  const prepared = await service.handle({ op: 'prepare', invoice });
  const result = await service.handle({ op: 'confirm', payment_id: prepared.payment_id });
  assert.equal(result.error, 'payment_unverified');
  assert.equal(ledger.status(paymentHash), 'unknown');
});

test('refuses unbudgeted connections, over-budget and wrong-network invoices; accepts full-access budgeted ones', async (t) => {
  const noBudget = setup(t, { budget: {}, pay: async () => ({}) });
  assert.equal((await noBudget.service.handle({ op: 'prepare', invoice: makeInvoice().invoice })).error, 'connection_not_allowed');
  const status = await noBudget.service.handle({ op: 'status' });
  assert.equal(status.usable, false);

  const broad = setup(t, { info: { ...GOOD_INFO, methods: [...GOOD_INFO.methods, 'sign_message', 'pay_keysend'] }, pay: async () => ({}) });
  assert.equal((await broad.service.handle({ op: 'prepare', invoice: makeInvoice().invoice })).ok, true);

  const { service, wallet } = setup(t, { pay: async () => ({}) });
  assert.equal((await service.handle({ op: 'prepare', invoice: makeInvoice({ amount: '1m' }).invoice })).error, 'over_budget');
  assert.equal((await service.handle({ op: 'prepare', invoice: makeInvoice({ prefix: 'lntbs' }).invoice })).error, 'wrong_network');
  assert.equal((await service.handle({ op: 'prepare', invoice: makeInvoice({ amount: '' }).invoice })).error, 'no_amount');
  assert.equal((await service.handle({ op: 'prepare', invoice: 'lnbc1garbage' })).error, 'invalid_invoice');
  assert.equal(wallet.calls.pay.length, 0);
});

test('not connected', async (t) => {
  const { service } = setup(t, {}, { noCredential: true });
  assert.equal((await service.handle({ op: 'status' })).connected, false);
  assert.equal((await service.handle({ op: 'prepare', invoice: makeInvoice().invoice })).error, 'not_connected');
});

test('rate limits', async (t) => {
  const { service } = setup(t, { pay: async () => ({}) });
  const results = [];
  for (let i = 0; i < 11; i++) results.push(await service.handle({ op: 'prepare', invoice: makeInvoice().invoice }));
  assert.equal(results[10].error, 'rate_limited');
});

test('status reports budget without balances or secrets', async (t) => {
  const { service } = setup(t, { pay: async () => ({}) });
  const status = await service.handle({ op: 'status' });
  assert.equal(status.usable, true);
  assert.deepEqual(status.budget, { used_sat: 1000, total_sat: 50_000, remaining_sat: 49_000, renews_at: 2_000_000_000, renewal_period: 'monthly' });
  assert.ok(!JSON.stringify(status).includes('b'.repeat(64)));
});

test('request parsing is strict', () => {
  assert.deepEqual(parseRequest('{"op":"status"}'), { op: 'status' });
  for (const bad of ['{"op":"pay","invoice":"x"}', '{"op":"status","x":1}', '{"op":"prepare"}', '{"op":"prepare","invoice":5}',
    '[]', 'null', 'nope', '{"op":"confirm","payment_id":"a","extra":"b"}']) {
    assert.equal(parseRequest(bad), null, bad);
  }
});

// ---------- ledger, credential, wallet errors ----------

test('ledger persists, is private, and refuses corrupt files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omacashu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, 'state');
  const hash = 'ab'.repeat(32);
  new Ledger(state).record(hash, 'unknown');
  assert.equal(new Ledger(state).status(hash), 'unknown');
  assert.equal(statSync(join(state, 'payments.json')).mode & 0o777, 0o600);
  writeFileSync(join(state, 'payments.json'), '{corrupt');
  assert.throws(() => new Ledger(state), /corrupt/);
  const open = join(dir, 'open');
  mkdirSync(open, { mode: 0o755 });
  chmodSync(open, 0o755);
  assert.throws(() => new Ledger(open), /private/);
});

test('credential parsing never echoes the secret', () => {
  assert.equal(parseConnectionUrl(URI).relays.length, 1);
  for (const bad of ['https://x', URI.replace('wss%3A', 'ws%3A'), URI + '&secret=' + 'c'.repeat(64), 'x'.repeat(5000)]) {
    assert.throws(() => parseConnectionUrl(bad), (e) => !e.message.includes('b'.repeat(64)));
  }
});

test('sanitizer strips spoofing characters', () => {
  assert.equal(sanitizeText('\u001b[31mHi\u202e\u2028there'), '[31mHi there');
  assert.equal(sanitizeText('\u0000'), null);
  assert.equal(Array.from(sanitizeText('x'.repeat(200), 10)).length, 10);
});

test('failure classification', () => {
  assert.equal(isDefinitiveFailure(new Nip47WalletError('x', 'PAYMENT_FAILED')), true);
  assert.equal(isDefinitiveFailure(new Nip47WalletError('x', 'INTERNAL')), false);
  assert.equal(isDefinitiveFailure(new WalletTimeout('x')), false);
  assert.equal(isDefinitiveFailure(new Error('x')), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeInvoice, InvoiceError } from '../src/bolt11.mjs';
import { POSITIVE, NEGATIVE } from './helpers/bolt11-vectors.mjs';
import { makeInvoice, TEST_PAYEE } from './helpers/invoice.mjs';

const SPEC_PAYEE = '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad';
const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102';
const CAKE = 'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon';

test('spec: donation without amount', () => {
  const d = decodeInvoice(POSITIVE.donation);
  assert.equal(d.network, 'mainnet');
  assert.equal(d.amountMsat, null);
  assert.equal(d.paymentHash, SPEC_HASH);
  assert.equal(d.payee, SPEC_PAYEE);
  assert.equal(d.description, 'Please consider supporting this project');
  assert.equal(d.timestamp, 1496314658);
  assert.equal(d.expiry, 3600);
});

test('spec: amounts, descriptions and expiry', () => {
  const coffee = decodeInvoice(POSITIVE.coffee);
  assert.equal(coffee.amountMsat, 250_000_000);
  assert.equal(coffee.description, '1 cup coffee');
  assert.equal(coffee.expiry, 60);
  assert.equal(coffee.payee, SPEC_PAYEE);
  assert.equal(decodeInvoice(POSITIVE.nonsense).description, 'ナンセンス 1杯');
  const hashed = decodeInvoice(POSITIVE.hashed);
  assert.equal(hashed.amountMsat, 2_000_000_000);
  assert.equal(hashed.description, null);
  assert.equal(hashed.descriptionHash, createHash('sha256').update(CAKE).digest('hex'));
  assert.equal(decodeInvoice(POSITIVE.features).amountMsat, 2_500_000_000);
  assert.equal(decodeInvoice(POSITIVE.metadata).amountMsat, 1_000_000_000);
});

test('spec: pico-BTC amount', () => {
  const d = decodeInvoice(POSITIVE.pico);
  assert.equal(d.amountMsat, 967_878_534);
  assert.equal(d.paymentHash, '462264ede7e14047e9b249da94fefc47f41f7d02ee9b091815a5506bc8abf75f');
  assert.equal(d.expiry, 604800);
  assert.equal(d.timestamp, 1572468703);
});

test('spec: networks, upper case, ignored fields, routing, high-S recovery', () => {
  assert.equal(decodeInvoice(POSITIVE.testnet_fallback).network, 'testnet');
  assert.equal(decodeInvoice(POSITIVE.uppercase).payee, SPEC_PAYEE);
  assert.equal(decodeInvoice(POSITIVE.ignored_fields).payee, SPEC_PAYEE);
  assert.equal(decodeInvoice(POSITIVE.routing).payee, SPEC_PAYEE);
  assert.equal(decodeInvoice(POSITIVE.high_s_recovery).payee, SPEC_PAYEE);
  assert.equal(decodeInvoice('lightning:' + POSITIVE.coffee).amountMsat, 250_000_000);
});

test('spec: every invalid invoice is rejected', () => {
  for (const [name, invoice] of Object.entries(NEGATIVE)) {
    assert.throws(() => decodeInvoice(invoice), InvoiceError, name);
  }
});

test('fresh signed invoices decode with the signer as payee', () => {
  const { invoice, paymentHash } = makeInvoice({ amount: '10u', expiry: 600, description: 'tea' });
  const d = decodeInvoice(invoice);
  assert.equal(d.payee, TEST_PAYEE);
  assert.equal(d.paymentHash, paymentHash);
  assert.equal(d.amountMsat, 1_000_000);
  assert.equal(d.expiry, 600);
  const withN = decodeInvoice(makeInvoice({ includePayee: true }).invoice);
  assert.equal(withN.payee, TEST_PAYEE);
});

test('high-S: rejected with an n field, accepted (normalized) for recovery', () => {
  assert.throws(() => decodeInvoice(makeInvoice({ includePayee: true, forceHighS: true }).invoice), /high-S/);
  assert.equal(decodeInvoice(makeInvoice({ forceHighS: true }).invoice).payee, TEST_PAYEE);
});

test('tampering with any character breaks the invoice', () => {
  const { invoice } = makeInvoice({ amount: '10u' });
  // Change the amount in the human-readable part and recompute nothing: checksum must fail.
  assert.throws(() => decodeInvoice(invoice.replace('lnbc10u', 'lnbc90u')), InvoiceError);
  // Flip a data character.
  const i = 30;
  const flipped = invoice.slice(0, i) + (invoice[i] === 'q' ? 'p' : 'q') + invoice.slice(i + 1);
  assert.throws(() => decodeInvoice(flipped), InvoiceError);
});

test('structural rules', () => {
  assert.throws(() => decodeInvoice(makeInvoice({ secret: false }).invoice), /payment secret/);
  assert.throws(() => decodeInvoice(makeInvoice({ description: null }).invoice), /description/);
  assert.throws(() => decodeInvoice('lnxy1' + 'q'.repeat(200)), InvoiceError);
  assert.throws(() => decodeInvoice(42), InvoiceError);
  assert.throws(() => decodeInvoice('x'.repeat(8000)), InvoiceError);
});

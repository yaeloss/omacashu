#!/usr/bin/env node
/**
 * Real end-to-end payment test against the NWC Faucet (https://faucet.nwc.dev).
 * Faucet balances are NOT real money. Opt-in only: `node test/e2e/faucet-e2e.mjs`.
 *
 * Exercises the real HelperService, BOLT11 verifier, ledger and Alby SDK NWC
 * client. Faucet connections have no budget, so the
 * payment leg uses a relaxed policy constructed HERE (test-only); the strict
 * policy is also checked and must refuse the same connection.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { HelperService } from '../../src/service.mjs';
import { Ledger } from '../../src/ledger.mjs';
import { STRICT_POLICY } from '../../src/policy.mjs';
import { createNwcWallet } from '../../src/wallet.mjs';

for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = () => {};
process.removeAllListeners('warning');
process.on('warning', () => {});
const say = (s) => process.stdout.write(s + '\n');

async function faucetWallet(balance) {
  const response = await fetch(`https://faucet.nwc.dev?balance=${balance}`, { method: 'POST' });
  assert.equal(response.ok, true, 'faucet unavailable');
  const uri = (await response.text()).trim();
  assert.match(uri, /^nostr\+walletconnect:\/\//);
  return uri;
}

const dir = mkdtempSync(join(tmpdir(), 'omacashu-e2e-'));
const timer = setTimeout(() => { say('E2E timed out'); process.exit(1); }, 120_000);
let payeeWallet;
try {
  const payerUri = await faucetWallet(1000);
  const payeeUri = await faucetWallet(0);
  say('✓ created two faucet wallets (fake sats)');

  const strict = new HelperService({
    loadCredential: async () => payerUri, walletFactory: createNwcWallet, ledger: new Ledger(join(dir, 'strict')),
  });
  const strictStatus = await strict.handle({ op: 'status' });
  assert.equal(strictStatus.usable, false);
  say(`✓ strict policy refuses the faucet connection: ${strictStatus.problems.join('; ')}`);
  strict.reload();

  const relaxed = Object.freeze({ ...STRICT_POLICY, requireBudget: false });
  const service = new HelperService({
    loadCredential: async () => payerUri, walletFactory: createNwcWallet, ledger: new Ledger(join(dir, 'relaxed')), policy: relaxed,
  });

  payeeWallet = await createNwcWallet(payeeUri);
  const { NWCClient } = await import('@getalby/sdk/nwc');
  const payeeClient = new NWCClient({ nostrWalletConnectUrl: payeeUri });
  const { invoice } = await payeeClient.makeInvoice({ amount: 21_000, description: 'omaCashu e2e test' });
  say('✓ payee created a 21-sat invoice');

  const status = await service.handle({ op: 'status' });
  assert.equal(status.connected && status.reachable && status.usable, true, JSON.stringify(status));

  const prepared = await service.handle({ op: 'prepare', invoice });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.amount_sat, 21);
  assert.equal(prepared.description, 'omaCashu e2e test');
  assert.match(prepared.payee, /^0[23][0-9a-f]{64}$/);
  say(`✓ helper verified the invoice: ${prepared.amount_sat} sats to ${prepared.payee.slice(0, 12)}…`);

  const paid = await service.handle({ op: 'confirm', payment_id: prepared.payment_id });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(paid.status, 'paid');
  say('✓ paid, and the preimage matches the payment hash');

  const balance = await payeeClient.getBalance();
  assert.equal(balance.balance, 21_000);
  say('✓ payee balance is now 21 sats');

  const again = await service.handle({ op: 'prepare', invoice });
  assert.equal(again.error, 'already_paid');
  say('✓ the same invoice cannot be paid twice');
  payeeClient.close();
  service.reload();
  say('E2E PASSED');
  clearTimeout(timer);
  process.exit(0);
} catch (error) {
  say(`E2E FAILED: ${error instanceof assert.AssertionError ? error.message : 'unexpected error'}`);
  process.exit(1);
} finally {
  payeeWallet?.close();
  rmSync(dir, { recursive: true, force: true });
}

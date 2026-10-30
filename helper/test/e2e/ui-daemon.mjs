#!/usr/bin/env node
/**
 * UI test daemon: serves the helper socket with a NWC Faucet wallet (fake sats)
 * so the panel's connected, review and payment screens can be exercised.
 * Faucet wallets have no budget support, so this harness reports a simulated
 * 50,000-sat budget. TEST USE ONLY: stop the
 * real helper first (systemctl --user stop omacashu-helper), restart it after.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelperService } from '../../src/service.mjs';
import { Ledger } from '../../src/ledger.mjs';
import { STRICT_POLICY } from '../../src/policy.mjs';
import { startServer } from '../../src/server.mjs';
import { createNwcWallet } from '../../src/wallet.mjs';

for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = () => {};
process.removeAllListeners('warning');
process.on('warning', () => {});

const response = await fetch('https://faucet.nwc.dev?balance=5000', { method: 'POST' });
const payerUri = (await response.text()).trim();
let spentMsat = 1_000_000;

const service = new HelperService({
  loadCredential: async () => payerUri,
  walletFactory: async (url) => {
    const wallet = await createNwcWallet(url);
    return {
      ...wallet,
      getBudget: async () => ({ used_budget: spentMsat, total_budget: 50_000_000, renews_at: Math.floor(Date.now() / 1000) + 12 * 86400, renewal_period: 'monthly' }),
      payInvoice: async (invoice) => {
        const result = await wallet.payInvoice(invoice);
        spentMsat += 21_000;
        return result;
      },
    };
  },
  ledger: new Ledger(mkdtempSync(join(tmpdir(), 'omacashu-ui-'))),
  policy: Object.freeze({ ...STRICT_POLICY, requireBudget: false }),
});

const runtime = join(process.env.XDG_RUNTIME_DIR, 'omacashu');
mkdirSync(runtime, { recursive: true, mode: 0o700 });
await startServer(service, join(runtime, 'helper.sock'));
process.stdout.write('ui test daemon ready (faucet wallet, simulated budget)\n');
process.on('SIGTERM', () => process.exit(0));

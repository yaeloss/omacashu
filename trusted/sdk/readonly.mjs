#!/usr/bin/env node
/**
 * omaCashu ALPHA: read-only NWC SDK adapter. Run ONLY on an independently trusted device.
 * Never run this under the Omarchy desktop account. Never copy the NWC URL to Omarchy.
 * There is NO pay_invoice, signing, token handling or payment authorization here.
 *
 * This standalone operator tool is not connected to the plugin or broker.
 */
import { CredentialError, parseConnectionUrl, readCredentialFile } from './credential.mjs';
import { normalizeBalance, normalizeInfo } from './normalize.mjs';

const TIMEOUT_MS = 20_000;
const GENERIC_FAILURE = 'Wallet query failed; check connectivity and permissions on the trusted device.';

// The SDK and its transports may log URLs, relay frames or errors containing the
// credential. Silence every console method before any SDK code is loaded.
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) {
  console[method] = () => {};
}

function finish(message, code) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

// Late SDK/relay errors must never print a stack trace (which can include the URL).
process.on('uncaughtException', () => finish(GENERIC_FAILURE, 1));
process.on('unhandledRejection', () => finish(GENERIC_FAILURE, 1));

async function main() {
  const [action, secretPath, ...extra] = process.argv.slice(2);
  if (!['info', 'balance'].includes(action) || !secretPath || extra.length) {
    finish('Usage (trusted device only): node readonly.mjs info|balance /private/path/nwc-connection.txt', 2);
  }
  if (action === 'balance' && process.env.OMACASHU_ALLOW_BALANCE !== 'yes') {
    finish('Balance display disabled; set OMACASHU_ALLOW_BALANCE=yes on the trusted device to opt in.', 2);
  }

  const timer = setTimeout(() => finish('Wallet query timed out.', 1), TIMEOUT_MS);
  let client;
  try {
    const { url } = parseConnectionUrl(await readCredentialFile(secretPath));
    // Dynamic import: SDK code loads only after the console is silenced and the credential is validated.
    const { NWCClient } = await import('@getalby/sdk/nwc');
    client = new NWCClient({ nostrWalletConnectUrl: url });
    const result = action === 'info'
      ? normalizeInfo(await client.getInfo())
      : normalizeBalance(await client.getBalance());
    process.stdout.write(JSON.stringify({ ok: true, action, ...result }) + '\n');
    process.exitCode = 0;
  } catch (error) {
    // CredentialError messages are fixed strings without secret material; everything else is generic.
    process.stderr.write((error instanceof CredentialError ? error.message : GENERIC_FAILURE) + '\n');
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    try { client?.close(); } catch { /* never log */ }
  }
  // Relay sockets may keep the event loop alive; exit explicitly.
  process.exit(process.exitCode ?? 1);
}

await main();

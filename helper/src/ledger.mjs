/**
 * Persistent record of payment attempts, keyed by payment hash, so an invoice
 * is never paid twice and an unresolved attempt blocks automatic retries.
 */
import { mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync, fsyncSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ENTRIES = 2000;
const STATUSES = new Set(['paid', 'unknown', 'failed']);

export class Ledger {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'payments.json');
    this.entries = new Map();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) {
      throw new Error('state directory must be a private (0700) directory owned by you');
    }
    this.load();
  }

  load() {
    let raw;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    try {
      const data = JSON.parse(raw);
      for (const [hash, entry] of Object.entries(data.payments ?? {})) {
        if (/^[0-9a-f]{64}$/.test(hash) && STATUSES.has(entry?.status)) this.entries.set(hash, entry);
      }
    } catch {
      // A corrupt ledger must not silently allow re-payment: keep the file for inspection and refuse to start.
      throw new Error('payment ledger is corrupt; inspect ' + this.path);
    }
  }

  status(paymentHash) {
    return this.entries.get(paymentHash)?.status ?? null;
  }

  record(paymentHash, status, now = Math.floor(Date.now() / 1000)) {
    this.entries.set(paymentHash, { status, at: now });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (this.entries.get(oldest)?.status === 'unknown') break;
      this.entries.delete(oldest);
    }
    this.save();
  }

  save() {
    const tmp = this.path + '.tmp';
    const body = JSON.stringify({ version: 1, payments: Object.fromEntries(this.entries) });
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

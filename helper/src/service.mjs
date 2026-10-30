/**
 * omaCashu helper service: the only component that holds the NWC credential.
 * Pure request/response logic; transport lives in server.mjs.
 */
import { randomBytes } from 'node:crypto';
import { decodeInvoice, InvoiceError } from './bolt11.mjs';
import { parseConnectionUrl } from './credential.mjs';
import { checkConnection, checkInvoice, PolicyError, STRICT_POLICY } from './policy.mjs';
import { sanitizeText } from './sanitize.mjs';
import { isDefinitiveFailure, preimageMatches } from './wallet.mjs';

export const VERSION = '0.2.0-alpha';
const PREPARE_TTL_SECONDS = 120;
const MAX_PENDING = 5;
const REFRESH_SECONDS = 15;
const PAYMENT_ID = /^[0-9a-f]{32}$/;

export class RateLimiter {
  constructor(limit, windowSeconds, clock) {
    Object.assign(this, { limit, windowSeconds, clock, events: [] });
  }

  allow() {
    const now = this.clock();
    this.events = this.events.filter((t) => t > now - this.windowSeconds);
    if (this.events.length >= this.limit) return false;
    this.events.push(now);
    return true;
  }
}

const sat = (msat) => Math.ceil(msat / 1000);
const err = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });

export class HelperService {
  constructor({ loadCredential, walletFactory, ledger, policy = STRICT_POLICY, clock = () => Math.floor(Date.now() / 1000) }) {
    Object.assign(this, { loadCredential, walletFactory, ledger, policy, clock });
    this.wallet = null;
    this.connection = null; // { alias, network, problems, budget }
    this.lastRefresh = 0;
    this.pending = new Map();
    this.paying = new Set();
    this.limits = { prepare: new RateLimiter(10, 60, clock), confirm: new RateLimiter(3, 60, clock) };
  }

  async ensureWallet() {
    if (this.wallet) return this.wallet;
    const uri = await this.loadCredential();
    if (!uri) return null;
    const { url } = parseConnectionUrl(uri);
    this.wallet = await this.walletFactory(url);
    return this.wallet;
  }

  async refresh(force = false) {
    if (!force && this.connection && this.clock() - this.lastRefresh < REFRESH_SECONDS) return this.connection;
    const info = await this.wallet.getInfo();
    const budgetResponse = await this.wallet.getBudget().catch(() => null);
    const { problems, budget } = checkConnection(info, budgetResponse, this.policy);
    this.connection = {
      alias: sanitizeText(info?.alias, 40),
      network: typeof info?.network === 'string' ? info.network.slice(0, 16) : null,
      problems,
      budget,
    };
    this.lastRefresh = this.clock();
    return this.connection;
  }

  reload() {
    this.wallet?.close();
    this.wallet = null;
    this.connection = null;
    this.lastRefresh = 0;
    this.pending.clear();
  }

  async handle(msg) {
    switch (msg.op) {
      case 'status': return this.status();
      case 'prepare': return this.prepare(msg.invoice);
      case 'confirm': return this.confirm(msg.payment_id);
      case 'cancel': this.pending.delete(msg.payment_id); return { ok: true };
      case 'reload': this.reload(); return { ok: true };
      default: return err('invalid_request', 'unsupported operation');
    }
  }

  base() {
    return { ok: true, version: VERSION, mode: this.policy.network, ceiling_sat: this.policy.ceilingSat };
  }

  budgetView(budget) {
    if (!budget) return null;
    return {
      used_sat: Math.floor(budget.usedMsat / 1000),
      total_sat: Math.floor(budget.totalMsat / 1000),
      remaining_sat: Math.floor(budget.remainingMsat / 1000),
      renews_at: budget.renewsAt,
      renewal_period: budget.renewalPeriod,
    };
  }

  async status() {
    let wallet;
    try {
      wallet = await this.ensureWallet();
    } catch {
      return { ...this.base(), connected: false, problem: 'stored connection is invalid; run omacashu connect' };
    }
    if (!wallet) return { ...this.base(), connected: false };
    let connection;
    try {
      connection = await this.refresh(false);
    } catch {
      return { ...this.base(), connected: true, reachable: false };
    }
    return {
      ...this.base(),
      connected: true,
      reachable: true,
      usable: connection.problems.length === 0,
      problems: connection.problems,
      alias: connection.alias,
      budget: this.budgetView(connection.budget),
    };
  }

  async prepare(invoice) {
    if (!this.limits.prepare.allow()) return err('rate_limited', 'too many requests; wait a minute');
    let decoded;
    try {
      decoded = decodeInvoice(invoice);
    } catch (error) {
      return err('invalid_invoice', error instanceof InvoiceError ? error.message : 'invalid invoice');
    }
    let connection;
    try {
      if (!(await this.ensureWallet())) return err('not_connected', 'no wallet connected');
      connection = await this.refresh(true);
    } catch {
      return err('wallet_unreachable', 'could not reach the wallet');
    }
    if (connection.problems.length) return err('connection_not_allowed', connection.problems[0]);
    try {
      checkInvoice(decoded, {
        policy: this.policy,
        now: this.clock(),
        remainingMsat: connection.budget ? connection.budget.remainingMsat : null,
        ledgerStatus: this.ledger.status(decoded.paymentHash),
      });
    } catch (error) {
      if (error instanceof PolicyError) return err(error.code, error.message);
      throw error;
    }
    if (this.paying.has(decoded.paymentHash)) return err('in_progress', 'this invoice is being paid');

    const now = this.clock();
    const id = randomBytes(16).toString('hex');
    const confirmBy = Math.min(now + PREPARE_TTL_SECONDS, decoded.expiresAt - 10);
    this.pending.set(id, { decoded, confirmBy });
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value);

    const remainingAfter = connection.budget ? connection.budget.remainingMsat - decoded.amountMsat : null;
    return {
      ok: true,
      payment_id: id,
      amount_sat: sat(decoded.amountMsat),
      amount_msat: decoded.amountMsat,
      payee: decoded.payee,
      description: sanitizeText(decoded.description, 120),
      description_hash_only: decoded.descriptionHash !== null,
      expires_at: decoded.expiresAt,
      confirm_by: confirmBy,
      budget_remaining_after_sat: remainingAfter === null ? null : Math.floor(remainingAfter / 1000),
      network: decoded.network,
    };
  }

  async confirm(paymentId) {
    if (typeof paymentId !== 'string' || !PAYMENT_ID.test(paymentId)) return err('invalid_request', 'invalid payment id');
    const entry = this.pending.get(paymentId);
    this.pending.delete(paymentId); // single use, whatever happens next
    if (!entry) return err('unknown_payment', 'payment request not found or already used; review it again');
    if (!this.limits.confirm.allow()) return err('rate_limited', 'too many payments; wait a minute');
    const { decoded, confirmBy } = entry;
    const hash = decoded.paymentHash;
    if (this.clock() > confirmBy) return err('confirmation_expired', 'confirmation window expired; review it again');
    const status = this.ledger.status(hash);
    if (status === 'paid') return err('already_paid', 'this invoice was already paid');
    if (status === 'unknown') return err('already_attempted', 'a payment for this invoice is unresolved; check your wallet');
    if (this.paying.has(hash) || !this.wallet) return err('in_progress', 'payment already in progress');

    this.paying.add(hash);
    // Persist the attempt BEFORE contacting the wallet so a crash can never lead to a silent second payment.
    this.ledger.record(hash, 'unknown');
    try {
      const result = await this.wallet.payInvoice(decoded.invoice);
      if (!preimageMatches(result?.preimage, hash)) {
        return err('payment_unverified', 'the wallet reported success without a valid proof of payment; check your wallet', { status: 'unknown' });
      }
      this.ledger.record(hash, 'paid');
      this.lastRefresh = 0;
      const feeMsat = Number.isSafeInteger(result.fees_paid) && result.fees_paid >= 0 ? result.fees_paid : null;
      return { ok: true, status: 'paid', amount_sat: sat(decoded.amountMsat), fee_sat: feeMsat === null ? null : sat(feeMsat) };
    } catch (error) {
      if (isDefinitiveFailure(error)) {
        this.ledger.record(hash, 'failed');
        return err('payment_failed', 'the wallet could not pay this invoice', { status: 'failed', reason: String(error.code ?? 'network').slice(0, 32) });
      }
      return err('payment_unresolved', 'no confirmation from the wallet; check your wallet before trying again', { status: 'unknown' });
    } finally {
      this.paying.delete(hash);
    }
  }
}

const SHAPES = {
  status: ['op'],
  reload: ['op'],
  prepare: ['op', 'invoice'],
  confirm: ['op', 'payment_id'],
  cancel: ['op', 'payment_id'],
};

/** Strict request validation: known op, exact key set, string values, bounded sizes. */
export function parseRequest(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.op !== 'string') return null;
  const shape = SHAPES[msg.op];
  if (!shape) return null;
  const keys = Object.keys(msg);
  if (keys.length !== shape.length || !shape.every((k) => keys.includes(k))) return null;
  for (const key of shape) if (typeof msg[key] !== 'string' || msg[key].length > 7200) return null;
  return msg;
}

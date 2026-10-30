/**
 * Live-wallet policy (docs/LIVE_WALLET_DESIGN.md). The daemon always uses
 * STRICT_POLICY; only test harnesses construct relaxed policies.
 */
export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// omaCashu only ever calls get_info, get_budget and pay_invoice. Other permissions on the
// connection are allowed; they are listed at connect time for information only.
export const USED_METHODS = new Set(['get_info', 'get_budget', 'pay_invoice']);
export const REQUIRED_METHODS = ['pay_invoice', 'get_budget'];
export const DEFAULT_CEILING_SAT = 100_000;
export const MIN_SECONDS_LEFT = 60;
export const MAX_FUTURE_SKEW = 60;

export const STRICT_POLICY = Object.freeze({
  requireBudget: true,
  ceilingSat: DEFAULT_CEILING_SAT,
  network: 'mainnet',
});

export function normalizeBudget(budget) {
  if (!budget || typeof budget !== 'object' || !Number.isSafeInteger(budget.total_budget) || budget.total_budget <= 0) {
    return null;
  }
  const used = Number.isSafeInteger(budget.used_budget) && budget.used_budget >= 0 ? budget.used_budget : 0;
  return {
    usedMsat: used,
    totalMsat: budget.total_budget,
    remainingMsat: Math.max(0, budget.total_budget - used),
    renewsAt: Number.isSafeInteger(budget.renews_at) ? budget.renews_at : null,
    renewalPeriod: typeof budget.renewal_period === 'string' ? budget.renewal_period.slice(0, 16) : 'never',
  };
}

/**
 * Returns human-readable problems (an empty list means the connection is acceptable) and
 * `unused`: extra permissions on the connection that omaCashu never calls (informational).
 */
export function checkConnection(info, budgetResponse, policy = STRICT_POLICY) {
  const problems = [];
  const methods = Array.isArray(info?.methods) ? info.methods.filter((m) => typeof m === 'string') : [];
  for (const method of REQUIRED_METHODS) {
    if (!methods.includes(method)) problems.push(`connection does not allow ${method}`);
  }
  const unused = methods.filter((m) => !USED_METHODS.has(m)).map((m) => m.slice(0, 32)).slice(0, 16);
  const budget = normalizeBudget(budgetResponse);
  if (policy.requireBudget) {
    if (!budget) {
      problems.push('connection has no wallet-enforced budget');
    } else if (budget.totalMsat > policy.ceilingSat * 1000) {
      problems.push(`budget ${Math.floor(budget.totalMsat / 1000)} sats exceeds the local ceiling of ${policy.ceilingSat} sats`);
    }
  }
  return { problems, budget, unused };
}

/** Throws PolicyError if a verified invoice must not be offered for payment. */
export function checkInvoice(decoded, { policy = STRICT_POLICY, now, remainingMsat, ledgerStatus }) {
  if (decoded.network !== policy.network) {
    throw new PolicyError('wrong_network', `invoice is for ${decoded.network}, wallet mode is ${policy.network}`);
  }
  if (decoded.amountMsat === null || decoded.amountMsat <= 0) {
    throw new PolicyError('no_amount', 'invoices without an amount are not supported');
  }
  if (decoded.timestamp > now + MAX_FUTURE_SKEW) throw new PolicyError('future', 'invoice timestamp is in the future');
  if (decoded.expiresAt - now < MIN_SECONDS_LEFT) throw new PolicyError('expired', 'invoice is expired or about to expire');
  if (ledgerStatus === 'paid') throw new PolicyError('already_paid', 'this invoice was already paid');
  if (ledgerStatus === 'unknown') {
    throw new PolicyError('already_attempted', 'a payment for this invoice is still unresolved; check your wallet');
  }
  if (remainingMsat !== null && remainingMsat !== undefined && decoded.amountMsat > remainingMsat) {
    throw new PolicyError('over_budget', 'amount exceeds the remaining wallet budget');
  }
}

// NCA quote engine. Must stay identical to SnapQuote.quote in public/site.js,
// which shows the same numbers to the applicant before they submit.
function tc(z) { return Math.round((z + Number.EPSILON) * 100); }

export function quote(amount, days) {
  const pc = tc(amount);
  const init = Math.min(tc(1050), tc(165) + Math.round(Math.max(0, pc - tc(1000)) * 0.10));
  const svc = Math.round((tc(60) / 30) * days);
  const intr = Math.round(pc * 0.0017 * days);
  return {
    principal: pc / 100,
    initiationFee: init / 100,
    serviceFee: svc / 100,
    interest: intr / 100,
    total: (pc + init + svc + intr) / 100,
  };
}

export const LIMITS = { minAmount: 500, maxAmount: 2000, amountStep: 100, minDays: 5, maxDays: 30 };

export function validLoan(amount, days) {
  return Number.isInteger(amount) && Number.isInteger(days)
    && amount >= LIMITS.minAmount && amount <= LIMITS.maxAmount && amount % LIMITS.amountStep === 0
    && days >= LIMITS.minDays && days <= LIMITS.maxDays;
}

// Today's date in South Africa, plus n days, as YYYY-MM-DD.
export function saDatePlus(days, from = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(from);
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Synthetic payer behaviour.
 *
 * The PayPal sandbox has no payment history, so Tidewater ships a clearly-labelled synthetic
 * ledger. The forecaster never sees the hidden ground truth in this file (persona parameters,
 * the latent untreated payment time, ghost flags). It only sees invoices, reminders and payment
 * dates, exactly as it would from PayPal. The backtest uses the hidden truth to *score* it.
 */
import { DAY_MS, makeRng, type Rng } from '../forecast/math';

export type Family = 'lognormal' | 'loglogistic' | 'batch';

export interface Persona {
  id: string;
  name: string;
  email: string;
  /** median days-to-pay at 30-day terms */
  medianDays: number;
  sigma: number;
  ghostProb: number;
  amountMedian: number;
  amountSigma: number;
  netChoices: number[];
  /** invoices per ~30 days in the history window */
  ratePer30: number;
  /** per-persona reminder responsiveness (1 = ignores reminders; <1 = pays faster after one) */
  kappa: number;
}

export const PERSONAS: Persona[] = [
  { id: 'northwind', name: 'Northwind Studios', email: 'ap@northwind.example', medianDays: 9, sigma: 0.28, ghostProb: 0.01, amountMedian: 2400, amountSigma: 0.5, netChoices: [14, 30], ratePer30: 1.1, kappa: 0.9 },
  { id: 'atlas', name: 'Atlas Freight Co', email: 'payables@atlasfreight.example', medianDays: 58, sigma: 0.45, ghostProb: 0.06, amountMedian: 7800, amountSigma: 0.55, netChoices: [30, 45], ratePer30: 1.0, kappa: 0.62 },
  { id: 'lumen', name: 'Lumen Foods', email: 'invoices@lumenfoods.example', medianDays: 31, sigma: 0.1, ghostProb: 0.01, amountMedian: 3300, amountSigma: 0.35, netChoices: [30], ratePer30: 0.9, kappa: 0.95 },
  { id: 'brightpath', name: 'Brightpath Schools', email: 'finance@brightpath.example', medianDays: 47, sigma: 0.22, ghostProb: 0.02, amountMedian: 5200, amountSigma: 0.4, netChoices: [30, 45], ratePer30: 0.8, kappa: 0.7 },
  { id: 'kestrel', name: 'Kestrel Labs', email: 'bills@kestrel.example', medianDays: 26, sigma: 0.75, ghostProb: 0.04, amountMedian: 4100, amountSigma: 0.6, netChoices: [14, 30], ratePer30: 1.0, kappa: 0.55 },
  { id: 'meridian', name: 'Meridian Clinics', email: 'ap@meridianclinics.example', medianDays: 40, sigma: 0.3, ghostProb: 0.02, amountMedian: 12500, amountSigma: 0.45, netChoices: [30, 45], ratePer30: 0.6, kappa: 0.75 },
  { id: 'orchard', name: 'Orchard & Pine', email: 'hello@orchardpine.example', medianDays: 22, sigma: 0.5, ghostProb: 0.05, amountMedian: 900, amountSigma: 0.55, netChoices: [7, 14], ratePer30: 1.3, kappa: 0.68 },
  { id: 'vantage', name: 'Vantage Retail', email: 'accounts@vantage.example', medianDays: 44, sigma: 0.6, ghostProb: 0.1, amountMedian: 6400, amountSigma: 0.5, netChoices: [30], ratePer30: 0.9, kappa: 0.6 },
  { id: 'harbor', name: 'Harbor Legal', email: 'ap@harborlegal.example', medianDays: 12, sigma: 0.3, ghostProb: 0.01, amountMedian: 3900, amountSigma: 0.45, netChoices: [14, 30], ratePer30: 0.8, kappa: 0.92 },
  { id: 'cobalt', name: 'Cobalt Robotics', email: 'finance@cobalt.example', medianDays: 30, sigma: 0.35, ghostProb: 0.03, amountMedian: 8800, amountSigma: 0.5, netChoices: [30], ratePer30: 0.8, kappa: 0.72 },
  { id: 'sable', name: 'Sable Media', email: 'billing@sablemedia.example', medianDays: 70, sigma: 0.55, ghostProb: 0.18, amountMedian: 3100, amountSigma: 0.6, netChoices: [30, 45], ratePer30: 0.8, kappa: 0.58 },
  { id: 'juniper', name: 'Juniper Health', email: 'ap@juniperhealth.example', medianDays: 20, sigma: 0.2, ghostProb: 0.01, amountMedian: 4600, amountSigma: 0.4, netChoices: [30], ratePer30: 0.9, kappa: 0.93 },
  { id: 'pinnacle', name: 'Pinnacle Builders', email: 'pay@pinnaclebuild.example', medianDays: 52, sigma: 0.4, ghostProb: 0.08, amountMedian: 15000, amountSigma: 0.5, netChoices: [30, 45], ratePer30: 0.5, kappa: 0.66 },
  { id: 'zephyr', name: 'Zephyr Travel', email: 'finance@zephyr.example', medianDays: 35, sigma: 0.5, ghostProb: 0.05, amountMedian: 2700, amountSigma: 0.5, netChoices: [14, 30], ratePer30: 0.12, kappa: 0.75 },
];

/** True data-generating coefficients (the model must recover these, not be told them). */
export const TRUE_BETA_TERMS = 0.8;
export const TRUE_BETA_AMOUNT = 0.12;
const REF_AMOUNT = 4000;

export interface GeneratedInvoice {
  id: string;
  number: string;
  payerId: string;
  amount: number;
  netDays: number;
  sentAt: number;
  dueAt: number;
  /** hidden: untreated payment time in days since sending; Infinity for a ghost */
  latentT0: number;
  ghost: boolean;
  kappa: number;
  /** reminders the (simulated) merchant actually sent, epoch ms, only those <= now */
  reminders: number[];
  /** realised payment time (epoch ms) if it happened by `now`, else null */
  paidAt: number | null;
  /** hidden: the realised, treatment-adjusted time in days (Infinity for ghost) */
  trueT: number;
}

export interface GenerateOptions {
  now: number;
  seed: number;
  family?: Family;
  historyDays?: number;
  personas?: Persona[];
  /** probability that the merchant sends a first reminder 3 days after the due date */
  reminderProb?: number;
  /** multiplier on the historical volume for the most recent 45 days (to populate the open ledger) */
  recentBoost?: number;
  /** multiplier on every persona's arrival rate (default 1) */
  volume?: number;
}

const logistic = (rng: Rng) => {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, rng.next()));
  return Math.log(u / (1 - u)) * (Math.sqrt(3) / Math.PI); // sd = 1
};

function adjustToBusinessDay(ms: number): number {
  const d = new Date(ms);
  const dow = d.getUTCDay();
  if (dow === 6) return ms + 2 * DAY_MS;
  if (dow === 0) return ms + DAY_MS;
  return ms;
}

/** Draw the untreated payment time (days) for one invoice. */
export function drawLatentT0(rng: Rng, p: Persona, netDays: number, amount: number, family: Family): number {
  if (rng.next() < p.ghostProb) return Infinity;
  const z = (Math.log(amount) - Math.log(REF_AMOUNT)) / 0.8; // roughly standardised
  const mu = Math.log(p.medianDays) + TRUE_BETA_TERMS * Math.log(netDays / 30) + TRUE_BETA_AMOUNT * z;
  let t: number;
  if (family === 'loglogistic') t = Math.exp(mu + p.sigma * logistic(rng));
  else t = Math.exp(mu + p.sigma * rng.gauss());
  if (family === 'batch') {
    // misspecified: customer pays in 15-day batches (the model does not know this)
    t = Math.max(15, Math.ceil(t / 15) * 15 + (rng.next() - 0.5) * 2);
  }
  return Math.max(0.5, t);
}

/** Apply a reminder sent at day r (since sending) to a payment time t. */
export function applyReminder(t: number, r: number, kappa: number, isRepeat: boolean): number {
  if (!(t > r)) return t;
  const k = isRepeat ? Math.pow(kappa, 0.35) : kappa;
  return r + k * (t - r);
}

export function generateLedger(opts: GenerateOptions): { personas: Persona[]; invoices: GeneratedInvoice[] } {
  const family = opts.family ?? 'lognormal';
  const historyDays = opts.historyDays ?? 430;
  const personas = opts.personas ?? PERSONAS;
  const reminderProb = opts.reminderProb ?? 0.6;
  const recentBoost = opts.recentBoost ?? 1.6;
  const rng = makeRng(opts.seed);
  const out: GeneratedInvoice[] = [];
  let seq = 1000;
  const start = opts.now - historyDays * DAY_MS;

  for (const p of personas) {
    // Poisson-ish arrivals: step through the window in days.
    const perDay = (p.ratePer30 * (opts.volume ?? 1)) / 30;
    for (let d = 0; d < historyDays; d++) {
      const ageDays = historyDays - d;
      const rate = perDay * (ageDays <= 45 ? recentBoost : 1);
      // Bernoulli approximation of Poisson for small daily rates
      const L = Math.exp(-rate);
      let k = 0;
      let pr = 1;
      do {
        k++;
        pr *= rng.next();
      } while (pr > L);
      const n = k - 1;
      for (let j = 0; j < n; j++) {
        const sentAt = Math.floor(start + (d + rng.next() * 0.6) * DAY_MS);
        const netDays = p.netChoices[Math.floor(rng.next() * p.netChoices.length)];
        const amount = Math.max(50, Math.round(p.amountMedian * Math.exp(p.amountSigma * rng.gauss()) / 5) * 5);
        const latentT0 = drawLatentT0(rng, p, netDays, amount, family);
        const kappa = Math.min(1, Math.max(0.3, p.kappa * Math.exp(0.1 * rng.gauss())));
        const dueAt = sentAt + netDays * DAY_MS;
        seq++;
        // merchant reminder policy: remind 3 days after due if still unpaid, with some probability;
        // a second reminder 14 days later with lower probability.
        const reminders: number[] = [];
        let t = latentT0;
        // Only reminders that have already happened (<= now) are applied: the future is whatever the
        // user and the simulation clock decide, not a hidden merchant policy.
        const r1 = netDays + 3;
        const when1 = sentAt + r1 * DAY_MS;
        if (t > r1 && when1 <= opts.now && rng.next() < reminderProb) {
          reminders.push(when1);
          t = applyReminder(t, r1, kappa, false);
          const r2 = r1 + 14;
          const when2 = sentAt + r2 * DAY_MS;
          if (t > r2 && when2 <= opts.now && rng.next() < 0.35) {
            reminders.push(when2);
            t = applyReminder(t, r2, kappa, true);
          }
        }
        let paidAt: number | null = null;
        let trueT = t;
        if (Number.isFinite(t)) {
          const paid = adjustToBusinessDay(sentAt + t * DAY_MS);
          trueT = (paid - sentAt) / DAY_MS;
          if (paid <= opts.now) paidAt = paid;
        }
        // Reminders after "now" never happened yet.
        out.push({
          id: `SYN-${p.id.toUpperCase()}-${seq}`,
          number: `INV-${seq}`,
          payerId: p.id,
          amount,
          netDays,
          sentAt,
          dueAt,
          latentT0,
          ghost: !Number.isFinite(latentT0),
          kappa,
          reminders,
          paidAt,
          trueT,
        });
      }
    }
  }
  out.sort((a, b) => a.sentAt - b.sentAt);
  return { personas, invoices: out };
}

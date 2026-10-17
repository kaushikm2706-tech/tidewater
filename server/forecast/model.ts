/**
 * Tidewater's payment-time model.
 *
 * Statistical form (see docs/METHOD.md for the derivation and the assumptions):
 *
 *   ln T_i = a_{p(i)} + beta1 * ln(net_i / 30) + beta2 * z(ln amount_i) + sigma_{p(i)} * eps_i,   eps ~ N(0, 1)
 *   a_p   ~ N(mu_a, tau^2)                 (payer random intercept, shrunk toward the population)
 *   sigma_p^2 ~ scaled-inverse-chi^2 prior (payer noise, shrunk toward the pooled noise)
 *   an invoice is a "ghost" (never paid) with probability pi_p (payer-level Beta-style shrinkage)
 *
 * T is the time from sending to payment, in days. Open invoices are right-censored, and the
 * cure-model EM below weights each censored invoice by its posterior probability of being a
 * payer-who-will-eventually-pay. Reminders enter in a second stage as a multiplicative speed-up
 * of the remaining time, T = r + kappa * (T0 - r), with kappa estimated on a grid posterior.
 */
import type { NudgeEffect, QuantileSet } from '../../shared/types';
import { DAY_MS, clamp, makeRng, normCdf, normIsf, normPdf, normSf, truncatedBelowMoments, type Rng } from './math';

export interface Observation {
  invoiceId: string;
  payerId: string;
  sentAt: number; // ms
  netDays: number;
  amount: number;
  paidAt: number | null; // ms
  cancelled?: boolean;
  reminders: number[]; // ms
}

export interface ModelConfig {
  /** An invoice still unpaid after this many days is labelled "ghost" for training. */
  ghostHorizonDays: number;
  /** Prior pseudo-observations for the payer noise (sigma_p^2). */
  sigmaPriorN: number;
  /** Prior pseudo-count for the ghost probability. */
  ghostPriorN: number;
  /** Floors keep the EM from collapsing on tiny payers. */
  minSigma: number;
  minTau2: number;
  maxIter: number;
  tol: number;
  /** Minimum observable time-to-pay (days), avoids ln(0). */
  minDays: number;
  /** Prior sd of ln(kappa) (centered on 1 = "reminders do nothing until the data say otherwise"). */
  kappaPriorSd: number;
}

export const DEFAULT_CONFIG: ModelConfig = {
  ghostHorizonDays: 120,
  sigmaPriorN: 6,
  ghostPriorN: 6,
  minSigma: 0.06,
  minTau2: 0.02,
  maxIter: 400,
  tol: 1e-8,
  minDays: 0.25,
  kappaPriorSd: 0.6,
};

export interface PayerFit {
  payerId: string;
  a: number;
  aVar: number;
  sigma: number;
  ghostProb: number;
  nTotal: number;
  nEvents: number;
}

export interface FittedModel {
  config: ModelConfig;
  now: number;
  beta: [number, number];
  amountMean: number;
  amountSd: number;
  muA: number;
  tau2: number;
  sigma0: number;
  ghost0: number;
  payers: Map<string, PayerFit>;
  nudge: NudgeEffect;
  diagnostics: {
    iterations: number;
    converged: boolean;
    logLik: number;
    nInvoices: number;
    nEvents: number;
    nCensored: number;
    nGhost: number;
  };
}

interface TrainRow {
  payerIdx: number;
  y: number; // ln days
  event: boolean;
  ghostLabelled: boolean;
  x1: number;
  x2: number;
}

const lnAmount = (a: number) => Math.log(Math.max(a, 1e-6));

function daysBetween(later: number, earlier: number): number {
  return (later - earlier) / DAY_MS;
}

/** Build the training rows. Reminders censor an invoice at the first reminder (see header). */
function buildRows(
  obs: Observation[],
  now: number,
  cfg: ModelConfig,
  amountMean: number,
  amountSd: number,
): { rows: TrainRow[]; payerIds: string[] } {
  const payerIndex = new Map<string, number>();
  const rows: TrainRow[] = [];
  for (const o of obs) {
    if (o.cancelled) continue;
    let idx = payerIndex.get(o.payerId);
    if (idx === undefined) {
      idx = payerIndex.size;
      payerIndex.set(o.payerId, idx);
    }
    const x1 = Math.log(Math.max(o.netDays, 1) / 30);
    const x2 = (lnAmount(o.amount) - amountMean) / amountSd;
    const firstReminder = o.reminders.length ? Math.min(...o.reminders) : null;
    const rDays = firstReminder !== null ? Math.max(daysBetween(firstReminder, o.sentAt), cfg.minDays) : null;
    if (o.paidAt !== null) {
      const t = Math.max(daysBetween(o.paidAt, o.sentAt), cfg.minDays);
      if (rDays !== null && t > rDays) {
        // paid after a reminder: only "unpaid at r" is clean information about the untreated clock
        rows.push({ payerIdx: idx, y: Math.log(rDays), event: false, ghostLabelled: false, x1, x2 });
      } else {
        rows.push({ payerIdx: idx, y: Math.log(t), event: true, ghostLabelled: false, x1, x2 });
      }
    } else {
      const age = Math.max(daysBetween(now, o.sentAt), cfg.minDays);
      if (age > cfg.ghostHorizonDays) {
        rows.push({ payerIdx: idx, y: Math.log(cfg.ghostHorizonDays), event: false, ghostLabelled: true, x1, x2 });
      } else {
        const c = rDays !== null ? Math.min(age, rDays) : age;
        rows.push({ payerIdx: idx, y: Math.log(c), event: false, ghostLabelled: false, x1, x2 });
      }
    }
  }
  return { rows, payerIds: [...payerIndex.keys()] };
}

export function fitModel(obs: Observation[], now: number, partial: Partial<ModelConfig> = {}): FittedModel {
  const cfg: ModelConfig = { ...DEFAULT_CONFIG, ...partial };
  const usable = obs.filter((o) => !o.cancelled);
  const lnAs = usable.map((o) => lnAmount(o.amount));
  const amountMean = lnAs.length ? lnAs.reduce((a, b) => a + b, 0) / lnAs.length : 0;
  const amountSd = Math.max(
    0.05,
    lnAs.length > 1 ? Math.sqrt(lnAs.reduce((a, b) => a + (b - amountMean) ** 2, 0) / (lnAs.length - 1)) : 1,
  );
  const { rows, payerIds } = buildRows(obs, now, cfg, amountMean, amountSd);
  const P = payerIds.length;
  const N = rows.length;

  const base: FittedModel = {
    config: cfg,
    now,
    beta: [0, 0],
    amountMean,
    amountSd,
    muA: Math.log(30),
    tau2: 0.25,
    sigma0: 0.5,
    ghost0: 0.05,
    payers: new Map(),
    nudge: { kappa: 1, lo: 1 - 2 * cfg.kappaPriorSd * 0.5, hi: 1 + 2 * cfg.kappaPriorSd * 0.5, nObs: 0, basis: 'prior' },
    diagnostics: { iterations: 0, converged: true, logLik: 0, nInvoices: N, nEvents: 0, nCensored: 0, nGhost: 0 },
  };
  if (N === 0) return base;

  const events = rows.filter((r) => r.event);
  const nEvents = events.length;
  const nGhost = rows.filter((r) => r.ghostLabelled).length;
  base.diagnostics.nEvents = nEvents;
  base.diagnostics.nGhost = nGhost;
  base.diagnostics.nCensored = N - nEvents - nGhost;

  // ---- initial values
  const yEv = events.length ? events.map((r) => r.y) : rows.map((r) => r.y);
  const yMean = yEv.reduce((a, b) => a + b, 0) / yEv.length;
  const yVar = yEv.length > 1 ? yEv.reduce((a, b) => a + (b - yMean) ** 2, 0) / (yEv.length - 1) : 0.25;
  let beta: [number, number] = [0, 0];
  const a = new Array<number>(P).fill(yMean);
  const aVar = new Array<number>(P).fill(0.1);
  let muA = yMean;
  let tau2 = Math.max(cfg.minTau2, 0.5 * yVar);
  let sigma0sq = Math.max(cfg.minSigma ** 2, 0.5 * yVar);
  const sigmaSq = new Array<number>(P).fill(sigma0sq);
  let ghost0 = clamp((nGhost + 0.5) / (N + 1), 0.001, 0.5);
  const ghostP = new Array<number>(P).fill(ghost0);

  const w = new Array<number>(N).fill(1);
  const yhat = new Array<number>(N).fill(0);
  const vtr = new Array<number>(N).fill(0);

  let prevLL = -Infinity;
  let converged = false;
  let iter = 0;
  let ll = 0;
  for (iter = 1; iter <= cfg.maxIter; iter++) {
    // ---------- E-step
    const gMass = new Array<number>(P).fill(0);
    const nTot = new Array<number>(P).fill(0);
    ll = 0;
    for (let i = 0; i < N; i++) {
      const r = rows[i];
      const p = r.payerIdx;
      nTot[p] += 1;
      const m = a[p] + beta[0] * r.x1 + beta[1] * r.x2;
      const s = Math.sqrt(sigmaSq[p]);
      const pi = ghostP[p];
      if (r.event) {
        w[i] = 1;
        yhat[i] = r.y;
        vtr[i] = 0;
        const z = (r.y - m) / s;
        ll += Math.log(1 - pi) - Math.log(s) - 0.5 * z * z - 0.5 * Math.log(2 * Math.PI);
      } else if (r.ghostLabelled) {
        w[i] = 0;
        yhat[i] = m;
        vtr[i] = 0;
        gMass[p] += 1;
        const S = normSf((r.y - m) / s);
        ll += Math.log(pi + (1 - pi) * S);
      } else {
        const alpha = (r.y - m) / s;
        const S = normSf(alpha);
        const denom = (1 - pi) * S + pi;
        const resp = denom > 0 ? ((1 - pi) * S) / denom : 0;
        const tm = truncatedBelowMoments(m, s, r.y);
        w[i] = resp;
        yhat[i] = tm.mean;
        vtr[i] = tm.variance;
        gMass[p] += 1 - resp;
        ll += Math.log(Math.max(denom, 1e-300));
      }
    }

    // ---------- M-step: fixed effects (weighted least squares with a unit ridge)
    let s11 = 1, s12 = 0, s22 = 1, b1 = 0, b2 = 0;
    for (let i = 0; i < N; i++) {
      if (w[i] === 0) continue;
      const r = rows[i];
      const prec = w[i] / sigmaSq[r.payerIdx];
      const z = yhat[i] - a[r.payerIdx];
      s11 += prec * r.x1 * r.x1;
      s12 += prec * r.x1 * r.x2;
      s22 += prec * r.x2 * r.x2;
      b1 += prec * r.x1 * z;
      b2 += prec * r.x2 * z;
    }
    const det = s11 * s22 - s12 * s12;
    beta = [(s22 * b1 - s12 * b2) / det, (s11 * b2 - s12 * b1) / det];

    // ---------- M-step: payer intercepts (posterior mean/variance under the N(mu_a, tau^2) prior)
    const num = new Array<number>(P).fill(0);
    const precSum = new Array<number>(P).fill(0);
    for (let i = 0; i < N; i++) {
      if (w[i] === 0) continue;
      const r = rows[i];
      const prec = w[i] / sigmaSq[r.payerIdx];
      num[r.payerIdx] += prec * (yhat[i] - beta[0] * r.x1 - beta[1] * r.x2);
      precSum[r.payerIdx] += prec;
    }
    for (let p = 0; p < P; p++) {
      const prec = precSum[p] + 1 / tau2;
      a[p] = (num[p] + muA / tau2) / prec;
      aVar[p] = 1 / prec;
    }
    muA = a.reduce((x, y) => x + y, 0) / P;
    tau2 = clamp(a.reduce((x, y, p) => x + (y - muA) ** 2 + aVar[p], 0) / P, cfg.minTau2, 4);

    // ---------- M-step: payer noise with a scaled-inverse-chi^2 prior toward the pooled noise
    const ss = new Array<number>(P).fill(0);
    const nEff = new Array<number>(P).fill(0);
    for (let i = 0; i < N; i++) {
      if (w[i] === 0) continue;
      const r = rows[i];
      const p = r.payerIdx;
      const resid = yhat[i] - a[p] - beta[0] * r.x1 - beta[1] * r.x2;
      ss[p] += w[i] * (resid * resid + vtr[i] + aVar[p]);
      nEff[p] += w[i];
    }
    const totSS = ss.reduce((x, y) => x + y, 0);
    const totN = nEff.reduce((x, y) => x + y, 0);
    sigma0sq = Math.max(cfg.minSigma ** 2, totN > 0 ? totSS / totN : sigma0sq);
    for (let p = 0; p < P; p++) {
      sigmaSq[p] = Math.max(cfg.minSigma ** 2, (cfg.sigmaPriorN * sigma0sq + ss[p]) / (cfg.sigmaPriorN + nEff[p]));
    }

    // ---------- M-step: ghost probabilities
    const totG = gMass.reduce((x, y) => x + y, 0);
    ghost0 = clamp(totG / N, 0.001, 0.5);
    for (let p = 0; p < P; p++) {
      ghostP[p] = clamp((gMass[p] + cfg.ghostPriorN * ghost0) / (nTot[p] + cfg.ghostPriorN), 0.001, 0.9);
    }

    if (Math.abs(ll - prevLL) < cfg.tol * (1 + Math.abs(ll))) {
      converged = true;
      break;
    }
    prevLL = ll;
  }

  const payers = new Map<string, PayerFit>();
  const nPer = new Array<number>(P).fill(0);
  const nEv = new Array<number>(P).fill(0);
  rows.forEach((r) => {
    nPer[r.payerIdx] += 1;
    if (r.event) nEv[r.payerIdx] += 1;
  });
  payerIds.forEach((id, p) => {
    payers.set(id, {
      payerId: id,
      a: a[p],
      aVar: aVar[p],
      sigma: Math.sqrt(sigmaSq[p]),
      ghostProb: ghostP[p],
      nTotal: nPer[p],
      nEvents: nEv[p],
    });
  });

  const fitted: FittedModel = {
    ...base,
    beta,
    muA,
    tau2,
    sigma0: Math.sqrt(sigma0sq),
    ghost0,
    payers,
    diagnostics: { ...base.diagnostics, iterations: Math.min(iter, cfg.maxIter), converged, logLik: ll },
  };
  fitted.nudge = estimateNudge(fitted, obs, now);
  return fitted;
}

// ---------------------------------------------------------------------------------------------
// Predictive distribution for one invoice
// ---------------------------------------------------------------------------------------------

export interface PredictiveInput {
  payerId: string;
  netDays: number;
  amount: number;
  sentAt: number;
  reminders: number[];
}

export interface Predictive {
  /** quantile of T (days since sending); Infinity when the quantile falls in the ghost mass */
  quantileDays(p: number): number;
  /** P(T <= tDays | unpaid at now) */
  cdfDays(tDays: number): number;
  sampleDays(rng: Rng): number;
  /** Common-random-numbers sampler: u1 decides ghost vs pays, u2 is the quantile level. */
  sampleFromU(u1: number, u2: number): number;
  ghostProb: number;
  elapsedDays: number;
  meta: { mu: number; sigma: number; kappa: number; reminderDays: number | null };
}

export interface PredictOptions {
  /** hypothetical extra reminder sent "now" (for scenario simulation) */
  nudgeNow?: { kappa: number } | null;
}

function payerParams(model: FittedModel, payerId: string) {
  const f = model.payers.get(payerId);
  if (f) return { a: f.a, aVar: f.aVar, sigma: f.sigma, pi: f.ghostProb };
  return { a: model.muA, aVar: model.tau2, sigma: model.sigma0, pi: model.ghost0 };
}

export function makePredictive(model: FittedModel, inv: PredictiveInput, now: number, opts: PredictOptions = {}): Predictive {
  const cfg = model.config;
  const pp = payerParams(model, inv.payerId);
  const x1 = Math.log(Math.max(inv.netDays, 1) / 30);
  const x2 = (lnAmount(inv.amount) - model.amountMean) / model.amountSd;
  const mu = pp.a + model.beta[0] * x1 + model.beta[1] * x2;
  const sigma = Math.sqrt(pp.sigma ** 2 + pp.aVar);
  const elapsed = Math.max(daysBetween(now, inv.sentAt), cfg.minDays);
  const pastReminders = inv.reminders.filter((t) => t <= now).sort((x, y) => x - y);
  const rDays = pastReminders.length ? Math.max(daysBetween(pastReminders[0], inv.sentAt), cfg.minDays) : null;
  const kappa = model.nudge.kappa;

  // Stage-1 clock: map the observed elapsed time back to the untreated clock (T0).
  const treatedAlready = rDays !== null && elapsed > rDays;
  let e0 = treatedAlready ? rDays! + (elapsed - rDays!) / kappa : elapsed;

  // A hypothetical nudge now: T = elapsed + k2 * (Tcur - elapsed), where Tcur follows the current predictive.
  const nudgeKappa = opts.nudgeNow ? opts.nudgeNow.kappa : null;

  const sf0 = (t: number) => normSf((Math.log(Math.max(t, 1e-9)) - mu) / sigma);
  const S_e0 = Math.max(sf0(e0), 1e-300);
  const pi = pp.pi;
  let ghostProb = elapsed > cfg.ghostHorizonDays ? 1 : pi / (pi + (1 - pi) * S_e0);
  ghostProb = clamp(ghostProb, 0, 1);

  // Untreated-clock quantile conditional on T0 > e0 and not ghost.
  const t0Quantile = (q: number) => {
    // q in [0,1): conditional quantile of T0 given T0 > e0
    const sf = S_e0 * (1 - q);
    if (sf <= 0) return Infinity;
    const z = normIsf(sf);
    return Math.exp(mu + sigma * z);
  };
  // Map T0 -> T (current treatment status)
  const toT = (t0: number) => {
    let t = t0;
    if (treatedAlready) t = rDays! + kappa * (t0 - rDays!);
    if (nudgeKappa !== null) {
      // effect of a new nudge: scale the residual beyond now. Repeat nudges are assumed weaker (sqrt(kappa)).
      const k2 = pastReminders.length ? Math.sqrt(nudgeKappa) : nudgeKappa;
      t = elapsed + k2 * (t - elapsed);
    }
    return Math.max(t, elapsed);
  };
  const fromT = (t: number) => {
    // inverse of toT, returns T0
    let tt = t;
    if (nudgeKappa !== null) {
      const k2 = pastReminders.length ? Math.sqrt(nudgeKappa) : nudgeKappa;
      tt = elapsed + (tt - elapsed) / k2;
    }
    if (treatedAlready) tt = rDays! + (tt - rDays!) / kappa;
    return tt;
  };

  const quantileDays = (p: number) => {
    const pay = 1 - ghostProb;
    if (p >= pay) return Infinity;
    const q = p / pay;
    return toT(t0Quantile(q));
  };
  const cdfDays = (tDays: number) => {
    if (tDays <= elapsed) return 0;
    const t0 = fromT(tDays);
    if (t0 <= e0) return 0;
    const cond = 1 - sf0(t0) / S_e0; // P(T0<=t0 | T0>e0)
    return (1 - ghostProb) * clamp(cond, 0, 1);
  };
  const sampleFromU = (u1: number, u2: number) => {
    if (u1 < ghostProb) return Infinity;
    return toT(t0Quantile(u2));
  };
  const sampleDays = (rng: Rng) => sampleFromU(rng.next(), rng.next());
  return { quantileDays, cdfDays, sampleDays, sampleFromU, ghostProb, elapsedDays: elapsed, meta: { mu, sigma, kappa, reminderDays: rDays } };
}

export function quantilesAt(pred: Predictive, sentAt: number): QuantileSet {
  const f = (p: number) => {
    const d = pred.quantileDays(p);
    return Number.isFinite(d) ? sentAt + d * DAY_MS : null;
  };
  return { p10: f(0.1), p25: f(0.25), p50: f(0.5), p75: f(0.75), p90: f(0.9) };
}

// ---------------------------------------------------------------------------------------------
// Stage 2: reminder effect (kappa) on a grid posterior
// ---------------------------------------------------------------------------------------------

const KAPPA_GRID = Array.from({ length: 161 }, (_, i) => Math.exp(Math.log(0.15) + ((Math.log(2.0) - Math.log(0.15)) * i) / 160));

export function estimateNudge(model: FittedModel, obs: Observation[], now: number): NudgeEffect {
  const cfg = model.config;
  const treated = obs.filter((o) => !o.cancelled && o.reminders.length > 0);
  const items: { payer: string; pp: ReturnType<typeof payerParams>; mu: number; sigma: number; r: number; t: number | null; e: number }[] = [];
  for (const o of treated) {
    const r = Math.max(daysBetween(Math.min(...o.reminders), o.sentAt), cfg.minDays);
    const e = o.paidAt !== null ? daysBetween(o.paidAt, o.sentAt) : daysBetween(now, o.sentAt);
    if (e <= r) continue; // paid before/at the reminder: no information about its effect
    const pp = payerParams(model, o.payerId);
    const x1 = Math.log(Math.max(o.netDays, 1) / 30);
    const x2 = (lnAmount(o.amount) - model.amountMean) / model.amountSd;
    items.push({
      payer: o.payerId,
      pp,
      mu: pp.a + model.beta[0] * x1 + model.beta[1] * x2,
      sigma: Math.sqrt(pp.sigma ** 2 + pp.aVar),
      r,
      t: o.paidAt !== null ? e : null,
      e,
    });
  }
  const prior = (k: number) => -0.5 * (Math.log(k) / cfg.kappaPriorSd) ** 2;
  if (items.length < 4) {
    return { kappa: 1, lo: Math.exp(-1.28 * cfg.kappaPriorSd), hi: Math.exp(1.28 * cfg.kappaPriorSd), nObs: items.length, basis: 'prior' };
  }
  // Per-payer log-likelihood profiles on the grid. Invoices of one payer share an estimated payer
  // intercept, so they are not independent; we keep the profiles so the interval can be widened by a
  // cluster bootstrap over payers (see below).
  const clusters = new Map<string, number[]>();
  for (const it of items) {
    const row = clusters.get(it.payer) ?? new Array<number>(KAPPA_GRID.length).fill(0);
    KAPPA_GRID.forEach((k, gi) => {
      const sf0 = (t: number) => normSf((Math.log(Math.max(t, 1e-9)) - it.mu) / it.sigma);
      const Sr = Math.max(sf0(it.r), 1e-300);
      const piR = it.pp.pi / (it.pp.pi + (1 - it.pp.pi) * Sr);
      if (it.t !== null) {
        const t0 = it.r + (it.t - it.r) / k;
        const dens = normPdf((Math.log(t0) - it.mu) / it.sigma) / (it.sigma * t0);
        const cond = ((1 - piR) * dens) / Sr;
        row[gi] += Math.log(Math.max(cond / k, 1e-300));
      } else {
        const e0 = it.r + (it.e - it.r) / k;
        const surv = piR + (1 - piR) * (sf0(e0) / Sr);
        row[gi] += Math.log(Math.max(surv, 1e-300));
      }
    });
    clusters.set(it.payer, row);
  }
  const profiles = [...clusters.values()];
  const lnGrid = KAPPA_GRID.map((k) => Math.log(k));
  const summarise = (rows: number[][]) => {
    const lp = KAPPA_GRID.map((k, gi) => prior(k) + rows.reduce((a, r) => a + r[gi], 0));
    const mx = Math.max(...lp);
    const w = lp.map((l) => Math.exp(l - mx));
    const tot = w.reduce((a, b) => a + b, 0);
    const post = w.map((x) => x / tot);
    let mean = 0;
    post.forEach((p, i) => (mean += p * lnGrid[i]));
    let v = 0;
    post.forEach((p, i) => (v += p * (lnGrid[i] - mean) ** 2));
    return { mean, sd: Math.sqrt(v) };
  };
  const full = summarise(profiles);
  // Cluster bootstrap over payers: spread of the posterior mean when whole payers are resampled.
  const rng = makeRng(20261017);
  const B = 200;
  const means: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample: number[][] = [];
    for (let i = 0; i < profiles.length; i++) sample.push(profiles[Math.floor(rng.next() * profiles.length)]);
    means.push(summarise(sample).mean);
  }
  const bm = means.reduce((a, b) => a + b, 0) / B;
  const bootSd = Math.sqrt(means.reduce((a, b) => a + (b - bm) ** 2, 0) / (B - 1));
  const sdTot = Math.max(full.sd, bootSd);
  const z = 1.2816; // central 80% interval
  const lo = Math.exp(full.mean - z * sdTot);
  const hi = Math.exp(full.mean + z * sdTot);
  const lm = full.mean;
  return { kappa: Math.exp(lm), lo, hi, nObs: items.length, basis: 'estimated' };
}

// ---------------------------------------------------------------------------------------------
// Helpers used by the portfolio simulator and the API
// ---------------------------------------------------------------------------------------------

export function typicalMedianDays(model: FittedModel, payerId: string, netDays = 30, amount?: number): number {
  const pp = payerParams(model, payerId);
  const x1 = Math.log(Math.max(netDays, 1) / 30);
  const x2 = amount === undefined ? 0 : (lnAmount(amount) - model.amountMean) / model.amountSd;
  return Math.exp(pp.a + model.beta[0] * x1 + model.beta[1] * x2);
}

export function payerParamsPublic(model: FittedModel, payerId: string) {
  return payerParams(model, payerId);
}

export { makeRng, normCdf };

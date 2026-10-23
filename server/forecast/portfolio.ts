/**
 * Portfolio-level outputs: per-invoice forecasts, the "cash tide" (cumulative inflow with
 * uncertainty bands), KPIs, and the nudge-scenario simulator.
 */
import type { Invoice, InvoiceForecast, Kpis, NudgeSimulation, Payer, PayerSummary, TidePoint } from '../../shared/types';
import { DAY_MS, makeRng, quantile } from './math';
import { makePredictive, quantilesAt, typicalMedianDays, type FittedModel, type Predictive } from './model';

export const TIDE_HORIZON_DAYS = 75;

const isOpen = (i: Invoice) => i.status === 'SENT' || i.status === 'PARTIALLY_PAID';

export function dayStartUtc(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function openInvoices(invoices: Invoice[]): Invoice[] {
  return invoices.filter(isOpen);
}

function predictiveFor(model: FittedModel, inv: Invoice, now: number, nudgeKappa: number | null = null): Predictive {
  return makePredictive(
    model,
    { payerId: inv.payerId, netDays: inv.netDays, amount: inv.amount, sentAt: inv.sentAt, reminders: inv.reminders },
    now,
    nudgeKappa === null ? {} : { nudgeNow: { kappa: nudgeKappa } },
  );
}

export function forecastInvoices(model: FittedModel, invoices: Invoice[], payers: Map<string, Payer>, now: number): InvoiceForecast[] {
  return openInvoices(invoices).map((inv) => {
    const pred = predictiveFor(model, inv, now);
    const q = quantilesAt(pred, inv.sentAt);
    const elapsed = pred.elapsedDays;
    const lateHorizon = Math.max(inv.netDays + 14, elapsed + 14);
    const cdfLate = pred.cdfDays(lateHorizon);
    const p10 = pred.quantileDays(0.1);
    const p90 = pred.quantileDays(0.9);
    const spread = Number.isFinite(p10) && Number.isFinite(p90) ? p90 - p10 : null;
    return {
      invoiceId: inv.id,
      number: inv.number,
      payerId: inv.payerId,
      payerName: payers.get(inv.payerId)?.name ?? inv.payerId,
      amount: inv.amount,
      currency: inv.currency,
      netDays: inv.netDays,
      sentAt: inv.sentAt,
      dueAt: inv.dueAt,
      elapsedDays: elapsed,
      daysToDue: (inv.dueAt - now) / DAY_MS,
      quantiles: q,
      medianLatenessDays: q.p50 === null ? null : (q.p50 - inv.dueAt) / DAY_MS,
      spreadDays: spread,
      probPaidByDue: pred.cdfDays(inv.netDays),
      probPaid7d: pred.cdfDays(elapsed + 7),
      probPaid14d: pred.cdfDays(elapsed + 14),
      probPaid30d: pred.cdfDays(elapsed + 30),
      ghostProb: pred.ghostProb,
      risk: Math.min(1, Math.max(0, 1 - cdfLate)),
      remindersSent: inv.reminders.length,
      lastReminderAt: inv.reminders.length ? Math.max(...inv.reminders) : null,
      source: inv.source,
    };
  });
}

export interface TideOptions {
  draws?: number;
  seed?: number;
  horizonDays?: number;
  /** invoices to nudge in the scenario curve */
  scenarioIds?: Set<string>;
  scenarioKappa?: number;
}

/**
 * Cumulative inflow by day. `expected` is exact (sum of amount x predictive CDF); the bands come
 * from Monte Carlo with common random numbers so the scenario curve differs from the base curve
 * only through the nudge, not through sampling noise.
 */
export function computeTide(model: FittedModel, invoices: Invoice[], now: number, opts: TideOptions = {}): TidePoint[] {
  const H = opts.horizonDays ?? TIDE_HORIZON_DAYS;
  const draws = opts.draws ?? 1200;
  const open = openInvoices(invoices);
  const base = open.map((inv) => predictiveFor(model, inv, now));
  const scen =
    opts.scenarioIds && opts.scenarioIds.size
      ? open.map((inv, i) => (opts.scenarioIds!.has(inv.id) ? predictiveFor(model, inv, now, opts.scenarioKappa ?? model.nudge.kappa) : base[i]))
      : null;

  const rng = makeRng(opts.seed ?? 20261017);
  const U1 = new Float64Array(draws * open.length);
  const U2 = new Float64Array(draws * open.length);
  for (let i = 0; i < U1.length; i++) {
    U1[i] = rng.next();
    U2[i] = rng.next();
  }
  const mc = new Float64Array(draws * (H + 1));
  for (let d = 0; d < draws; d++) {
    for (let j = 0; j < open.length; j++) {
      const T = base[j].sampleFromU(U1[d * open.length + j], U2[d * open.length + j]);
      if (!Number.isFinite(T)) continue;
      // Bucket k holds payments made by now + k days, so point k lines up with the KPI tiles.
      const idx = Math.max(0, Math.ceil((open[j].sentAt + T * DAY_MS - now) / DAY_MS));
      if (idx <= H) mc[d * (H + 1) + idx] += open[j].amount;
    }
    for (let k = 1; k <= H; k++) mc[d * (H + 1) + k] += mc[d * (H + 1) + k - 1];
  }

  const out: TidePoint[] = [];
  for (let k = 0; k <= H; k++) {
    const dayEnd = now + k * DAY_MS;
    let expected = 0;
    let scenario = 0;
    let naive = 0;
    open.forEach((inv, j) => {
      const tDays = (dayEnd - inv.sentAt) / DAY_MS;
      expected += inv.amount * base[j].cdfDays(tDays);
      if (scen) scenario += inv.amount * scen[j].cdfDays(tDays);
      if (inv.dueAt <= dayEnd) naive += inv.amount;
    });
    const col: number[] = [];
    for (let d = 0; d < draws; d++) col.push(mc[d * (H + 1) + k]);
    col.sort((a, b) => a - b);
    out.push({
      day: isoDay(now + k * DAY_MS),
      dayIndex: k,
      expected,
      p10: quantile(col, 0.1),
      p25: quantile(col, 0.25),
      p75: quantile(col, 0.75),
      p90: quantile(col, 0.9),
      naive,
      scenario: scen ? scenario : null,
    });
  }
  return out;
}

export function computeKpis(model: FittedModel, invoices: Invoice[], forecasts: InvoiceForecast[], now: number, currency = 'USD'): Omit<Kpis, 'staleCount' | 'staleAmount'> {
  const open = openInvoices(invoices);
  const preds = new Map(open.map((inv) => [inv.id, predictiveFor(model, inv, now)]));
  const expectedBy = (days: number) =>
    open.reduce((acc, inv) => {
      const p = preds.get(inv.id)!;
      return acc + inv.amount * p.cdfDays(p.elapsedDays + days);
    }, 0);
  const outstanding = open.reduce((a, i) => a + i.amount, 0);
  const dueByDate30d = open.reduce((a, i) => a + (i.dueAt <= now + 30 * DAY_MS ? i.amount : 0), 0);
  const expected30d = expectedBy(30);
  const risky = forecasts.filter((f) => f.risk >= 0.6);
  const weighted = forecasts.reduce(
    (acc, f) => {
      if (f.quantiles.p50 === null) return acc;
      const d = Math.max(0, (f.quantiles.p50 - now) / DAY_MS);
      return { w: acc.w + f.amount, s: acc.s + f.amount * d };
    },
    { w: 0, s: 0 },
  );
  return {
    outstanding,
    openCount: open.length,
    expected7d: expectedBy(7),
    expected14d: expectedBy(14),
    expected30d,
    dueByDate30d,
    dueDateGap30d: expected30d - dueByDate30d,
    atRisk: risky.reduce((a, f) => a + f.amount, 0),
    atRiskCount: risky.length,
    expectedDaysToCash: weighted.w ? weighted.s / weighted.w : 0,
    currency,
  };
}

export function summarisePayers(model: FittedModel, invoices: Invoice[], payers: Map<string, Payer>): PayerSummary[] {
  const byPayer = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    const arr = byPayer.get(inv.payerId) ?? [];
    arr.push(inv);
    byPayer.set(inv.payerId, arr);
  }
  const out: PayerSummary[] = [];
  for (const [id, payer] of payers) {
    const list = byPayer.get(id) ?? [];
    const fit = model.payers.get(id);
    const open = list.filter(isOpen);
    out.push({
      payerId: id,
      name: payer.name,
      nInvoices: list.length,
      nPaid: list.filter((i) => i.paidAt !== null).length,
      medianDaysAt30: typicalMedianDays(model, id, 30),
      sigma: fit?.sigma ?? model.sigma0,
      ghostProb: fit?.ghostProb ?? model.ghost0,
      openAmount: open.reduce((a, i) => a + i.amount, 0),
      openCount: open.length,
      synthetic: payer.synthetic,
    });
  }
  return out.sort((a, b) => b.openAmount - a.openAmount);
}

/** What would happen to expected cash if reminders were sent now to these invoices? */
export function simulateNudges(model: FittedModel, invoices: Invoice[], payers: Map<string, Payer>, now: number, ids: string[], opts: { draws?: number } = {}): NudgeSimulation {
  const idSet = new Set(ids);
  const open = openInvoices(invoices).filter((i) => idSet.has(i.id));
  const kappa = model.nudge.kappa;
  let anyRepeat = false;
  const per = open.map((inv) => {
    const before = predictiveFor(model, inv, now);
    const after = predictiveFor(model, inv, now, kappa);
    if (inv.reminders.length) anyRepeat = true;
    const e = before.elapsedDays;
    const dP14 = after.cdfDays(e + 14) - before.cdfDays(e + 14);
    return {
      invoiceId: inv.id,
      number: inv.number,
      payerName: payers.get(inv.payerId)?.name ?? inv.payerId,
      amount: inv.amount,
      deltaP14: dP14,
      deltaExpected14d: dP14 * inv.amount,
      medianBefore: quantilesAt(before, inv.sentAt).p50,
      medianAfter: quantilesAt(after, inv.sentAt).p50,
      d7: inv.amount * (after.cdfDays(e + 7) - before.cdfDays(e + 7)),
      d30: inv.amount * (after.cdfDays(e + 30) - before.cdfDays(e + 30)),
    };
  });
  const tide = computeTide(model, invoices, now, { draws: opts.draws ?? 800, scenarioIds: idSet, scenarioKappa: kappa });
  return {
    invoiceIds: open.map((i) => i.id),
    kappa,
    kappaBasis: model.nudge.basis,
    repeatAssumption: anyRepeat,
    deltaExpected7d: per.reduce((a, p) => a + p.d7, 0),
    deltaExpected14d: per.reduce((a, p) => a + p.deltaExpected14d, 0),
    deltaExpected30d: per.reduce((a, p) => a + p.d30, 0),
    perInvoice: per.map(({ d7: _d7, d30: _d30, ...rest }) => rest),
    tide,
  };
}

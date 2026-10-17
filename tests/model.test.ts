import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../server/forecast/math';
import { fitModel, makePredictive, type Observation } from '../server/forecast/model';
import { PERSONAS, generateLedger } from '../server/sim/generator';

const NOW = Date.UTC(2026, 9, 17, 12);

function observations(reminderProb: number, seed = 7) {
  const { invoices } = generateLedger({ now: NOW, seed, volume: 2, reminderProb, recentBoost: 1.5 });
  const obs: Observation[] = invoices.map((g) => ({ invoiceId: g.id, payerId: g.payerId, sentAt: g.sentAt, netDays: g.netDays, amount: g.amount, paidAt: g.paidAt, reminders: g.reminders }));
  return { invoices, obs };
}

describe('hierarchical censored log-normal model', () => {
  it('recovers payer median days-to-pay on a ledger with no reminders, despite open (censored) invoices', () => {
    const { obs } = observations(0);
    const m = fitModel(obs, NOW);
    expect(m.diagnostics.converged).toBe(true);
    let checked = 0;
    for (const p of PERSONAS) {
      const fit = m.payers.get(p.id);
      if (!fit || fit.nEvents < 15 || p.ghostProb > 0.1) continue;
      // median at net-30 and reference amount (the model centres amount, so allow for the amount elasticity)
      const est = Math.exp(fit.a);
      expect(est / p.medianDays, `${p.id}: est ${est.toFixed(1)} vs true ${p.medianDays}`).toBeGreaterThan(0.75);
      expect(est / p.medianDays, `${p.id}`).toBeLessThan(1.3);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('is not fooled by censoring: ignoring open invoices (treating only paid ones) would be optimistic, the model is not', () => {
    const { obs, invoices } = observations(0);
    const m = fitModel(obs, NOW);
    const slow = PERSONAS.find((p) => p.id === 'atlas')!; // slow payer, many invoices still open
    const paidOnly = invoices.filter((g) => g.payerId === 'atlas' && g.paidAt !== null).map((g) => (g.paidAt! - g.sentAt) / DAY_MS);
    const naiveMedian = paidOnly.sort((a, b) => a - b)[Math.floor(paidOnly.length / 2)];
    const est = Math.exp(m.payers.get('atlas')!.a);
    expect(Math.abs(est - slow.medianDays)).toBeLessThanOrEqual(Math.abs(naiveMedian - slow.medianDays) + 3);
  });

  it('estimates that reminders speed payment up when the data-generating process says so, and that the effect is bounded away from none', () => {
    const { obs } = observations(0.9, 11);
    const m = fitModel(obs, NOW);
    expect(m.nudge.basis).toBe('estimated');
    expect(m.nudge.kappa).toBeLessThan(0.95);
    expect(m.nudge.kappa).toBeGreaterThan(0.35);
    expect(m.nudge.lo).toBeLessThan(m.nudge.hi);
  });

  it('produces proper conditional predictives: monotone CDF, quantiles ordered, conditioning on elapsed time', () => {
    const { obs, invoices } = observations(0.3);
    const m = fitModel(obs, NOW);
    const open = invoices.find((g) => g.paidAt === null && NOW - g.sentAt < 100 * DAY_MS && NOW - g.sentAt > 20 * DAY_MS)!;
    const pred = makePredictive(m, { payerId: open.payerId, netDays: open.netDays, amount: open.amount, sentAt: open.sentAt, reminders: open.reminders }, NOW);
    let prev = -1;
    for (let d = pred.elapsedDays; d < pred.elapsedDays + 120; d += 3) {
      const c = pred.cdfDays(d);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(c).toBeLessThanOrEqual(1 - pred.ghostProb + 1e-9);
      prev = c;
    }
    expect(pred.cdfDays(pred.elapsedDays)).toBeLessThan(1e-6); // nothing has happened "before now" for an unpaid invoice
    const q = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => pred.quantileDays(p)).filter(Number.isFinite);
    for (let i = 1; i < q.length; i++) expect(q[i]).toBeGreaterThanOrEqual(q[i - 1]);
    expect(q[0]).toBeGreaterThan(pred.elapsedDays);
  });
});

import crypto from 'node:crypto';
import { DAY_MS } from '../forecast/math';
import type { InvoiceForecast, Proposal } from '../../shared/types';
import type { Ledger } from './ledger';
import { POLICY, checkPolicy, draftReminder, proposalFromRow } from './proposals';

export interface RankedNudge {
  invoiceId: string;
  number: string;
  payerName: string;
  amount: number;
  currency: string;
  daysToDue: number;
  probPaid14dBefore: number;
  probPaid14dAfter: number;
  expectedGain14d: number;
  ghostProb: number;
  why: string;
}

export type ProposeResult =
  | { ok: true; proposal: Proposal; deduplicated: boolean }
  | { ok: false; blockedBy: 'policy' | 'not-found'; message: string };

export class Actions {
  constructor(private ledger: Ledger) {}

  /** Rank invoices by expected 14-day cash gain from a reminder, applying the same policy as `propose`. */
  rank(limit = 8, minGain = 1): RankedNudge[] {
    const l = this.ledger;
    const now = l.now();
    const out: RankedNudge[] = [];
    const forecasts = l.forecasts();
    if (!forecasts.length) return out;
    const eligible = forecasts.filter((f) => {
      const inv = l.invoice(f.invoiceId);
      return inv && checkPolicy(inv, now).ok;
    });
    if (!eligible.length) return out;
    const sim = l.simulate(eligible.map((f) => f.invoiceId));
    const k = sim.kappa;
    for (const row of sim.perInvoice) {
      const f = forecasts.find((x) => x.invoiceId === row.invoiceId)!;
      const after = f.probPaid14d + row.deltaP14;
      out.push({
        invoiceId: f.invoiceId,
        number: f.number,
        payerName: f.payerName,
        amount: f.amount,
        currency: f.currency,
        daysToDue: f.daysToDue,
        probPaid14dBefore: f.probPaid14d,
        probPaid14dAfter: after,
        expectedGain14d: row.deltaExpected14d,
        ghostProb: f.ghostProb,
        why: describeWhy(f, row.deltaP14, k, sim.kappaBasis),
      });
    }
    return out.filter((r) => r.expectedGain14d >= minGain).sort((a, b) => b.expectedGain14d - a.expectedGain14d).slice(0, limit);
  }

  propose(input: { invoiceId: string; subject?: string; note?: string; createdBy: 'agent' | 'user'; reason?: string }): ProposeResult {
    const l = this.ledger;
    const now = l.now();
    const inv = l.invoice(input.invoiceId);
    if (!inv) return { ok: false, blockedBy: 'not-found', message: `No invoice with id ${input.invoiceId}.` };
    const verdict = checkPolicy(inv, now);
    if (!verdict.ok) {
      l.store.addAudit(now, input.createdBy, 'proposal.blocked-by-policy', inv.id, { reason: verdict.reason });
      return { ok: false, blockedBy: 'policy', message: verdict.reason! };
    }
    const existing = l.store.pendingProposalForInvoice(inv.id);
    if (existing) {
      const p = proposalFromRow(existing, l.store.getInvoices(), new Map(l.store.getPayers().map((x) => [x.id, x])));
      return { ok: true, proposal: p, deduplicated: true };
    }
    const f = l.forecastFor(inv.id)!;
    const sim = l.simulate([inv.id]);
    const row = sim.perInvoice[0];
    const draft = draftReminder(f);
    const id = `prop_${crypto.randomBytes(5).toString('hex')}`;
    const proposal: Proposal = {
      id,
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      payerName: f.payerName,
      amount: inv.amount,
      currency: inv.currency,
      subject: (input.subject ?? '').trim() || draft.subject,
      note: (input.note ?? '').trim() || draft.note,
      createdBy: input.createdBy,
      status: 'pending',
      createdAt: now,
      decidedAt: null,
      executedAt: null,
      reason: input.reason?.trim() || describeWhy(f, row?.deltaP14 ?? 0, sim.kappa, sim.kappaBasis),
      before: { median: f.quantiles.p50, probPaid14d: f.probPaid14d, ghostProb: f.ghostProb },
      effect: row ? { deltaP14: row.deltaP14, deltaExpected14d: row.deltaExpected14d, kappa: sim.kappa, basis: sim.kappaBasis } : null,
      result: null,
      policyNote: sim.repeatAssumption ? 'Repeat reminder: effect assumed weaker than the first (not yet identifiable from data).' : null,
    };
    l.store.insertProposal(proposal);
    l.store.addAudit(now, input.createdBy, 'proposal.created', inv.id, { proposalId: id, expectedGain14d: row?.deltaExpected14d ?? 0, kappa: sim.kappa, basis: sim.kappaBasis, forecast: proposal.before });
    l.bump();
    return { ok: true, proposal, deduplicated: false };
  }

  /** The only code path that sends a reminder through PayPal. Called only from the confirm endpoint. */
  async confirm(proposalId: string, edits: { subject?: string; note?: string } = {}): Promise<Proposal> {
    const l = this.ledger;
    const now = l.now();
    const row = l.store.getProposalRow(proposalId);
    if (!row) throw httpError(404, 'Proposal not found');
    if (row.status !== 'pending') throw httpError(409, `Proposal is already ${row.status}`);
    const inv = l.invoice(row.invoice_id);
    if (!inv) throw httpError(404, 'Invoice not found');
    const verdict = checkPolicy(inv, now); // re-check: state may have changed since it was proposed
    if (!verdict.ok) {
      l.store.updateProposal(proposalId, { status: 'blocked', decidedAt: now, policyNote: verdict.reason });
      l.store.addAudit(now, 'human', 'proposal.blocked-at-confirm', inv.id, { proposalId, reason: verdict.reason });
      l.bump();
      throw httpError(409, verdict.reason!);
    }
    const subject = (edits.subject ?? row.subject).trim() || row.subject;
    const note = (edits.note ?? row.note).trim() || row.note;
    l.store.updateProposal(proposalId, { status: 'confirmed', decidedAt: now, subject, note });
    l.store.addAudit(now, 'human', 'proposal.confirmed', inv.id, { proposalId, edited: subject !== row.subject || note !== row.note });
    try {
      const sent = await l.port.remind(inv.id, { subject, note });
      const at = l.port.kind === 'simulator' ? now : sent.at;
      l.store.addReminder(inv.id, at, l.port.kind, note, proposalId);
      l.store.updateProposal(proposalId, { status: 'executed', executedAt: at, result: `Reminder sent via PayPal ${l.port.kind}.` });
      l.store.addAudit(at, 'tidewater', 'paypal.reminder-sent', inv.id, { proposalId, via: l.port.kind, subject });
    } catch (e) {
      const msg = (e as Error).message;
      l.store.updateProposal(proposalId, { status: 'failed', result: msg });
      l.store.addAudit(now, 'tidewater', 'paypal.reminder-failed', inv.id, { proposalId, error: msg });
      l.bump();
      throw httpError(502, `PayPal rejected the reminder: ${msg}`);
    }
    l.bump();
    return proposalFromRow(l.store.getProposalRow(proposalId), l.store.getInvoices(), new Map(l.store.getPayers().map((x) => [x.id, x])));
  }

  reject(proposalId: string): Proposal {
    const l = this.ledger;
    const row = l.store.getProposalRow(proposalId);
    if (!row) throw httpError(404, 'Proposal not found');
    if (row.status !== 'pending') throw httpError(409, `Proposal is already ${row.status}`);
    l.store.updateProposal(proposalId, { status: 'rejected', decidedAt: l.now() });
    l.store.addAudit(l.now(), 'human', 'proposal.rejected', row.invoice_id, { proposalId });
    l.bump();
    return proposalFromRow(l.store.getProposalRow(proposalId), l.store.getInvoices(), new Map(l.store.getPayers().map((x) => [x.id, x])));
  }
}

function describeWhy(f: InvoiceForecast, deltaP14: number, kappa: number, basis: 'estimated' | 'prior'): string {
  const late = f.medianLatenessDays;
  const lateTxt = late === null ? 'is unlikely to be paid' : late > 0.5 ? `is expected ${late.toFixed(0)} days after its due date` : late < -0.5 ? `is expected ${(-late).toFixed(0)} days before its due date` : 'is expected on its due date';
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const eff = basis === 'estimated' ? `estimated reminder effect x${kappa.toFixed(2)} on remaining time` : 'no reminder effect learned yet (prior only)';
  return `${f.payerName}'s invoice ${lateTxt}. Chance of payment within 14 days moves ${pct(f.probPaid14d)} -> ${pct(Math.min(1, f.probPaid14d + deltaP14))} (${eff}).`;
}

export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

export { POLICY, DAY_MS };

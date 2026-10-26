/**
 * The Collector: an AG Studio agent (Studio's Agent Framework) that finds the reminders worth sending.
 * It can read forecasts and PROPOSE reminders. It cannot send anything: sending is a human action in
 * the Action Queue, and the server re-checks the reminder policy at both steps.
 */
import React from 'react';
import { createAiHarness, directLlmRunner } from 'ag-studio';
import type { AgStudioApi } from 'ag-studio';
import { api, ApiError } from '../api';
import { usd, pct, day } from '../format';
import { offlinePlanner, openAiCompatAdapter } from './adapters';

export const REFRESH_EVENT = 'tidewater:refresh';
const refresh = () => window.dispatchEvent(new Event(REFRESH_EVENT));

const INSTRUCTIONS = `You are the Collector, a receivables assistant inside Tidewater.
Tidewater forecasts when each open PayPal invoice will be paid, as a probability distribution, and estimates how much a reminder speeds payment up.

Rules you must follow:
- Use tools for every number. Never invent amounts, dates or probabilities.
- You may PROPOSE reminders with propose_reminder. You cannot send them. A human reviews and confirms each one in the Action Queue. Never say a reminder was sent.
- The server enforces a reminder policy (no reminder within 5 days of the last one, at most 3 per invoice, only when the invoice is due within 3 days or overdue). If a proposal is blocked, report the reason; do not try to work around it.
- The reminder effect is estimated from this ledger's history and carries uncertainty; say "estimated".
- Most data in the demo is synthetic. Say so if asked where the numbers come from.
- Be efficient: call get_overview once, then rank_nudges; skip tools you do not need. Keep answers short: a verdict, then the few invoices that matter.`;

const j = (x: unknown) => JSON.stringify(x);

function defineTools(studio: AgStudioApi): any[] {
  const d = (cfg: any) => (studio as any).defineAiTool(cfg);
  return [
    d({
      name: 'get_overview',
      description: 'Headline numbers for the open receivables: outstanding, expected cash in 14 and 30 days, how far the due dates over-promise, and the invoices at greatest risk. Call this first for any broad question.',
      params: (s: any) => s.object({}),
      execute: async (_args: any, ctx: any) => {
        const snap = await api.snapshot();
        const k = snap.kpis;
        const top = [...snap.invoices].sort((a, b) => b.amount * b.risk - a.amount * a.risk).slice(0, 4).map((f) => ({ invoiceId: f.invoiceId, number: f.number, payer: f.payerName, amountText: usd(f.amount), risk: Math.round(f.risk * 100) / 100, medianPaidOn: day(f.quantiles.p50) }));
        const summary = `${k.openCount} open invoices, ${usd(k.outstanding)} outstanding. Expected in 14 days: ${usd(k.expected14d)}; in 30 days: ${usd(k.expected30d)} versus ${usd(k.dueByDate30d)} if every invoice were paid on its due date (the due dates over-promise by ${usd(-k.dueDateGap30d)}). ${k.atRiskCount} invoices (${usd(k.atRisk)}) are at risk. Reminder effect is ${snap.model.nudge.basis}: remaining time x${snap.model.nudge.kappa.toFixed(2)}.`;
        return ctx.success(j({ summary, topRisks: top, syntheticShare: snap.model.syntheticShare }), { summary });
      },
    }),
    d({
      name: 'get_forecast',
      description: 'Payment-date forecast for one open invoice: quantiles of the likely payment date, probability of payment within 14 days, and probability the payer never pays.',
      params: (s: any) => s.object({ invoiceId: s.string({ description: 'Invoice id or invoice number, e.g. INV-1129' }) }),
      execute: async ({ invoiceId }: any, ctx: any) => {
        const snap = await api.snapshot();
        const key = String(invoiceId).toLowerCase();
        const f = snap.invoices.find((x) => x.invoiceId.toLowerCase() === key || x.number.toLowerCase() === key);
        if (!f) return ctx.success(j({ summary: `No open invoice matches "${invoiceId}".` }), {});
        const summary = `${f.number} (${f.payerName}, ${usd(f.amount)}) is due ${day(f.dueAt)}. Median expected payment ${day(f.quantiles.p50)} (80% range ${day(f.quantiles.p10)} to ${day(f.quantiles.p90)}). Chance of payment within 14 days ${pct(f.probPaid14d)}; chance the payer never pays ${pct(f.ghostProb, 1)}. ${f.remindersSent} reminders sent so far.`;
        return ctx.success(j({ summary, forecast: f }), { forecast: f });
      },
    }),
    d({
      name: 'rank_nudges',
      description: 'Rank open invoices by the modelled extra cash a reminder would bring in within 14 days. Only invoices that currently pass the reminder policy are included.',
      params: (s: any) => s.object({ limit: s.number({ description: 'How many to return (1-8)' }).optional() }),
      execute: async ({ limit }: any, ctx: any) => {
        const n = Math.min(8, Math.max(1, Math.round(Number(limit) || 5)));
        const ranked = await api.rank(n);
        const nudges = ranked.map((r) => ({ invoiceId: r.invoiceId, number: r.number, payerName: r.payerName, amountText: usd(r.amount, r.currency), p14: `${Math.round(r.probPaid14dBefore * 100)}% -> ${Math.round(r.probPaid14dAfter * 100)}%`, gainText: `+${usd(r.expectedGain14d, r.currency)}`, why: r.why }));
        return ctx.success(j({ nudges }), { nudges });
      },
    }),
    d({
      name: 'simulate_nudge',
      description: 'Estimate the combined effect on expected cash if reminders were sent now to the given invoices. Does not send anything.',
      params: (s: any) => s.object({ invoiceIds: s.array(s.string()) }),
      execute: async ({ invoiceIds }: any, ctx: any) => {
        try {
          const sim = await api.simulate(invoiceIds);
          const summary = `Estimated extra cash if nudged now: ${usd(sim.deltaExpected7d)} within 7 days, ${usd(sim.deltaExpected14d)} within 14 days, ${usd(sim.deltaExpected30d)} within 30 days (reminder effect ${sim.kappaBasis}, x${sim.kappa.toFixed(2)} on remaining time).`;
          return ctx.success(j({ summary, perInvoice: sim.perInvoice.map((p) => ({ number: p.number, payer: p.payerName, deltaP14: Math.round(p.deltaP14 * 100) / 100, deltaExpected14d: Math.round(p.deltaExpected14d) })) }), { sim });
        } catch (e) {
          return ctx.success(j({ error: (e as Error).message }), {});
        }
      },
    }),
    d({
      name: 'propose_reminder',
      description: 'Propose a payment reminder for one invoice. This only creates a draft in the Action Queue for a human to review; nothing is sent. Optionally supply a friendly subject and note, otherwise a standard draft is used.',
      params: (s: any) =>
        s.object({
          invoiceId: s.string({ description: 'The invoiceId from rank_nudges or get_forecast' }),
          subject: s.string({ description: 'Email subject for the reminder' }).optional(),
          note: s.string({ description: 'Short, polite note to the payer. Do not threaten, and do not state facts you have not been given.' }).optional(),
          reason: s.string({ description: 'One sentence on why this invoice, for the human reviewer' }).optional(),
        }),
      execute: async (args: any, ctx: any) => {
        try {
          const r = await api.propose(args.invoiceId, 'agent', { subject: args.subject, note: args.note, reason: args.reason });
          const p = r.proposal;
          refresh();
          const gain = p.effect?.deltaExpected14d ?? 0;
          const out = { ok: true, proposalId: p.id, invoiceNumber: p.invoiceNumber, payerName: p.payerName, amountText: usd(p.amount, p.currency), expectedGain14d: Math.round(gain), gainText: `+${usd(gain, p.currency)}`, deduplicated: r.deduplicated, status: p.status };
          return ctx.success(j(out), { proposal: p, deduplicated: r.deduplicated });
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : String((e as Error).message);
          return ctx.success(j({ ok: false, error: msg }), { error: msg });
        }
      },
    }),
  ];
}

export function createCollector(llmConfigured: boolean) {
  const adapter = llmConfigured ? openAiCompatAdapter() : offlinePlanner();
  return ({ api: studio }: { api: AgStudioApi }) =>
    createAiHarness(studio, () => ({
      agents: [
        directLlmRunner({
          id: 'collector',
          name: 'Collector',
          description: 'Finds the invoice reminders worth sending and drafts them for human approval.',
          instructions: () => INSTRUCTIONS,
          tools: () => defineTools(studio),
          adapter,
          maxTurns: 10,
        }),
      ],
      primary: 'collector',
      promptStarters: [
        { label: 'How are receivables looking?', prompt: 'Give me an overview of the open receivables.' },
        { label: 'Propose the best reminders', prompt: 'Propose reminders for the invoices where a nudge brings in the most cash.' },
        { label: 'Why is cash slower than due dates say?', prompt: 'Why is expected cash lower than the due dates promise? Which payers drive it?' },
      ],
    }) as any);
}

// ------------------------------------------------------------------------------------------ tool display
const lbl = (done: string, busy: string) => ({ label: ({ status }: any) => ({ text: status === 'done' ? done : busy }) });

function NudgeTable({ result }: any) {
  const nudges: any[] = result?.data?.nudges ?? [];
  if (!nudges.length) return <div style={{ padding: 8, opacity: 0.7 }}>No eligible invoices.</div>;
  return (
    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
      <tbody>
        {nudges.map((n) => (
          <tr key={n.invoiceId}>
            <td style={{ padding: '3px 6px' }}>{n.number}</td>
            <td style={{ padding: '3px 6px' }}>{n.payerName}</td>
            <td style={{ padding: '3px 6px', textAlign: 'right' }}>{n.amountText}</td>
            <td style={{ padding: '3px 6px', textAlign: 'right', color: '#2dd4bf', fontWeight: 700 }}>{n.gainText}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProposalBody({ result }: any) {
  const p = result?.data?.proposal;
  if (!p) return <div style={{ padding: 8 }}>{result?.data?.error ?? 'Blocked.'}</div>;
  return (
    <div style={{ padding: 8, fontSize: 12, lineHeight: 1.45 }}>
      <b>{p.subject}</b>
      <div style={{ opacity: 0.8, marginTop: 4 }}>{p.note}</div>
    </div>
  );
}

export const aiToolDisplay: Record<string, any> = {
  get_overview: lbl('Read the receivables overview', 'Reading the receivables overview…'),
  get_forecast: { label: ({ args, status }: any) => ({ text: status === 'done' ? 'Read an invoice forecast' : 'Reading an invoice forecast…', pill: args?.invoiceId ? String(args.invoiceId) : undefined }) },
  rank_nudges: { ...lbl('Ranked invoices by cash gain from a reminder', 'Ranking invoices by cash gain…'), detail: NudgeTable },
  simulate_nudge: lbl('Simulated the effect of nudging', 'Simulating the nudge…'),
  propose_reminder: {
    label: ({ args, status, result }: any) => ({
      text: status !== 'done' ? 'Drafting a reminder for approval…' : result?.data?.proposal ? 'Drafted a reminder. Awaiting your approval' : 'Reminder blocked by policy',
      pill: args?.invoiceId ? String(args.invoiceId).replace(/^SYN-|^SIM-INV2-/, '') : undefined,
    }),
    detail: ProposalBody,
  },
};

import type { Snapshot } from '@shared/types';

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const pct0 = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });
const pct1 = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));

const money = (id: string, name: string) => ({ id, name, format: 'currencyFormat' as const, formatOptions: { format: usd0 } });
const num = (id: string, name: string) => ({ id, name, format: 'decimalFormat' as const, formatOptions: { format: dec1 } });
const int = (id: string, name: string) => ({ id, name, format: 'integerFormat' as const });
const txt = (id: string, name: string) => ({ id, name, format: 'textFormat' as const });
const p0 = (id: string, name: string) => ({ id, name, format: 'percentageFormat' as const, formatOptions: { format: pct0 } });
const p1 = (id: string, name: string) => ({ id, name, format: 'percentageFormat' as const, formatOptions: { format: pct1 } });

/** Turn a snapshot into AG Studio data sources. Called on every refresh. */
export function buildStudioData(s: Snapshot) {
  const k = s.kpis;
  return {
    sources: [
      {
        id: 'tide',
        name: 'Cash tide',
        data: s.tide.map((t) => ({ dayIndex: t.dayIndex, day: t.day, expected: t.expected, p10: t.p10, p25: t.p25, p75: t.p75, p90: t.p90, naive: t.naive, scenario: t.scenario })),
        fields: [int('dayIndex', 'Day offset'), txt('day', 'Date'), money('expected', 'Expected cash'), money('p10', 'P10'), money('p25', 'P25'), money('p75', 'P75'), money('p90', 'P90'), money('naive', 'Due-date promise'), money('scenario', 'If nudged')],
      },
      {
        id: 'kpi',
        name: 'Headline numbers',
        data: [{ outstanding: k.outstanding, expected14d: k.expected14d, expected30d: k.expected30d, gap: k.dueDateGap30d, atRisk: k.atRisk, atRiskCount: k.atRiskCount, daysToCash: k.expectedDaysToCash, openCount: k.openCount }],
        fields: [money('outstanding', 'Outstanding'), money('expected14d', 'Expected in 14 days'), money('expected30d', 'Expected in 30 days'), money('gap', 'Due-date gap (30d)'), money('atRisk', 'At risk'), int('atRiskCount', 'At-risk invoices'), num('daysToCash', 'Expected days to cash'), int('openCount', 'Open invoices')],
      },
      {
        id: 'invoices',
        name: 'Open invoices',
        data: [...s.invoices].sort((a, b) => b.amount * b.risk - a.amount * a.risk).map((f) => ({
          number: f.number,
          payer: f.payerName,
          amount: f.amount,
          due: iso(f.dueAt),
          daysToDue: Math.round(f.daysToDue),
          median: f.quantiles.p50 === null ? 'not expected' : iso(f.quantiles.p50),
          late: f.medianLatenessDays === null ? null : Math.round(f.medianLatenessDays),
          spread: f.spreadDays === null ? null : Math.round(f.spreadDays),
          pDue: f.probPaidByDue,
          p14: f.probPaid14d,
          p30: f.probPaid30d,
          ghost: f.ghostProb,
          risk: f.risk,
          reminders: f.remindersSent,
          source: f.source,
        })),
        fields: [txt('number', 'Invoice'), txt('payer', 'Payer'), money('amount', 'Amount'), txt('due', 'Due'), int('daysToDue', 'Days to due'), txt('median', 'Likely paid (median)'), int('late', 'Median days late'), int('spread', 'Uncertainty (days)'), p0('pDue', 'Paid by due date'), p0('p14', 'Paid in 14 days'), p0('p30', 'Paid in 30 days'), p1('ghost', 'May never pay'), p0('risk', 'Risk'), int('reminders', 'Reminders sent'), txt('source', 'Source')],
      },
      {
        id: 'payers',
        name: 'Payers',
        data: s.payers.map((p) => ({ payerId: p.payerId, name: p.name, days: p.medianDaysAt30, sigma: p.sigma, ghost: p.ghostProb, open: p.openAmount, count: p.openCount, nInvoices: p.nInvoices, nPaid: p.nPaid })),
        fields: [txt('payerId', 'Payer id'), txt('name', 'Payer'), num('days', 'Median days to pay (net-30)'), num('sigma', 'Spread (log-sd)'), p1('ghost', 'May never pay'), money('open', 'Open amount'), int('count', 'Open invoices'), int('nInvoices', 'History (invoices)'), int('nPaid', 'Paid (invoices)')],
      },
    ],
  };
}

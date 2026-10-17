import React from 'react';
import type { InvoiceForecast, Snapshot } from '@shared/types';
import { api, type InvoiceCurve } from '../api';
import { day, dayShort, pct, usd } from '../format';

/** Invoice Lens: the full payment-date distribution for one invoice, with and without a reminder. */
export function LensPanel({ snap, payer, onClearPayer, initialId }: { snap: Snapshot; payer: string | null; onClearPayer: () => void; initialId?: string | null }) {
  const list = React.useMemo(
    () => [...snap.invoices].filter((f) => !payer || f.payerId === payer).sort((a, b) => b.amount * b.risk - a.amount * a.risk),
    [snap.invoices, payer],
  );
  const [id, setId] = React.useState<string | null>(initialId ?? null);
  const sel = list.find((f) => f.invoiceId === id) ?? list[0] ?? null;
  const [curve, setCurve] = React.useState<InvoiceCurve | null>(null);
  React.useEffect(() => {
    setCurve(null);
    if (sel) api.curve(sel.invoiceId).then(setCurve).catch(() => setCurve(null));
  }, [sel?.invoiceId, snap.generatedAt]);
  const payerName = payer ? snap.payers.find((p) => p.payerId === payer)?.name : null;

  return (
    <div className="tw-scroll">
      <div className="tw-card">
        <h4>Invoice Lens</h4>
        <p>Every forecast is a distribution, not a date. This shows the chance an invoice has been paid by each day, and what one reminder would change.</p>
        {payerName && <div className="tw-row" style={{ marginTop: 6 }}><span className="tw-pill agent">payer: {payerName}</span><button className="tw-btn" onClick={onClearPayer}>show all</button></div>}
        <label className="tw-label">Invoice</label>
        <select className="tw-select" value={sel?.invoiceId ?? ''} onChange={(e) => setId(e.target.value)}>
          {list.map((f) => <option key={f.invoiceId} value={f.invoiceId}>{f.number} · {f.payerName} · {usd(f.amount)}</option>)}
        </select>
      </div>
      {sel && curve && <Lens f={sel} c={curve} />}
      {!sel && <div className="tw-empty">No open invoices{payerName ? ` for ${payerName}` : ''}.</div>}
    </div>
  );
}

function Lens({ f, c }: { f: InvoiceForecast; c: InvoiceCurve }) {
  const W = 360, H = 190, m = { l: 34, r: 10, t: 12, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const X = (k: number) => m.l + (k / c.horizon) * iw;
  const Y = (p: number) => m.t + ih - p * ih;
  const path = (get: (p: InvoiceCurve['points'][number]) => number) => c.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.k).toFixed(1)},${Y(get(p)).toFixed(1)}`).join('');
  const area = `${path((p) => p.cdf)}L${X(c.horizon)},${Y(0)}L${X(0)},${Y(0)}Z`;
  const gain = c.points.map((p) => p.cdfNudged - p.cdf);
  const maxGain = Math.max(...gain);
  const pmf = c.points.map((p, i) => (i ? p.cdf - c.points[i - 1].cdf : 0));
  const maxPmf = Math.max(...pmf, 1e-9);
  const dueK = c.daysToDue;
  const medK = f.quantiles.p50 !== null ? (f.quantiles.p50 - (f.dueAt - f.daysToDue * 86_400_000)) / 86_400_000 : null;
  const ceil = 1 - c.ghostProb;
  return (
    <div className="tw-card">
      <div className="tw-row between"><b style={{ color: 'var(--bright)' }}>{f.number} · {f.payerName}</b><span className="tw-pill">{usd(f.amount, f.currency)}</span></div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ marginTop: 8 }} role="img" aria-label="Cumulative probability of payment by day">
        <defs><linearGradient id="lens-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2dd4bf" stopOpacity=".5" /><stop offset="1" stopColor="#2dd4bf" stopOpacity=".02" /></linearGradient></defs>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}><line x1={m.l} x2={W - m.r} y1={Y(t)} y2={Y(t)} stroke="rgba(148,163,184,.12)" /><text x={m.l - 5} y={Y(t) + 3} textAnchor="end" fontSize="9" fill="#8fa3bf">{Math.round(t * 100)}%</text></g>
        ))}
        {[0, 15, 30, 45, 60, 75].filter((t) => t <= c.horizon).map((t) => <text key={t} x={X(t)} y={H - 12} textAnchor="middle" fontSize="9" fill="#8fa3bf">{t === 0 ? 'today' : `+${t}d`}</text>)}
        <line x1={m.l} x2={W - m.r} y1={Y(ceil)} y2={Y(ceil)} stroke="#fb7185" strokeDasharray="3 4" strokeOpacity=".7" />
        <text x={W - m.r} y={Y(ceil) - 3} textAnchor="end" fontSize="9" fill="#fb7185">{pct(c.ghostProb, 1)} may never pay</text>
        <path d={area} fill="url(#lens-fill)" />
        {maxGain > 0.005 && <path d={path((p) => p.cdfNudged)} fill="none" stroke="#fbbf24" strokeWidth="1.8" strokeDasharray="4 3" />}
        <path d={path((p) => p.cdf)} fill="none" stroke="#e6f1ff" strokeWidth="2" />
        {dueK > -1 && dueK <= c.horizon && (<g><line x1={X(Math.max(0, dueK))} x2={X(Math.max(0, dueK))} y1={m.t} y2={m.t + ih} stroke="#94a3b8" strokeDasharray="2 3" /><text x={X(Math.max(0, dueK)) + 3} y={m.t + 9} fontSize="9" fill="#94a3b8">due</text></g>)}
        {medK !== null && medK >= 0 && medK <= c.horizon && <circle cx={X(medK)} cy={Y(0.5)} r="3.5" fill="#e6f1ff" />}
        {/* heat strip: probability mass per day */}
        {pmf.map((v, i) => i > 0 && <rect key={i} x={X(i) - iw / c.horizon / 2} y={m.t + ih + 3} width={iw / c.horizon} height="6" fill="#2dd4bf" opacity={0.08 + 0.92 * (v / maxPmf)} />)}
      </svg>
      <dl className="tw-kv" style={{ marginTop: 6 }}>
        <dt>Most likely paid around</dt><dd>{f.quantiles.p50 ? dayShort(f.quantiles.p50) : 'not expected'}</dd>
        <dt>80% range</dt><dd>{f.quantiles.p10 ? dayShort(f.quantiles.p10) : '—'} to {f.quantiles.p90 ? dayShort(f.quantiles.p90) : 'unlikely'}</dd>
        <dt>Due date</dt><dd>{day(f.dueAt)} ({f.daysToDue >= 0 ? `in ${Math.round(f.daysToDue)}d` : `${Math.round(-f.daysToDue)}d overdue`})</dd>
        <dt>Paid by due date / 14d / 30d</dt><dd>{pct(f.probPaidByDue)} / {pct(f.probPaid14d)} / {pct(f.probPaid30d)}</dd>
        <dt>Reminders sent</dt><dd>{f.remindersSent}</dd>
        {maxGain > 0.005 && (<><dt>One reminder now</dt><dd style={{ color: '#fbbf24' }}>+{pct(gain[14] ?? 0)} by day 14, +{pct(gain[30] ?? 0)} by day 30 ({c.kappaBasis} effect ×{c.kappa.toFixed(2)})</dd></>)}
      </dl>
      <p>Strip under the curve: where the probability mass sits, day by day.</p>
    </div>
  );
}

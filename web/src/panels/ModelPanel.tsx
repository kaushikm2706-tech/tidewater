import React from 'react';
import type { BacktestReport, Snapshot } from '@shared/types';
import { api } from '../api';
import { pct } from '../format';

export function ModelPanel({ snap }: { snap: Snapshot }) {
  const m = snap.model;
  const [bt, setBt] = React.useState<BacktestReport[] | null>(null);
  const [nudge, setNudge] = React.useState<{ truth: number; estimate: number; lo: number; hi: number }[]>([]);
  React.useEffect(() => {
    api.backtest().then((r) => { setBt(r.reports); setNudge(r.nudge ?? []); }).catch(() => setBt(null));
  }, []);
  const k = m.nudge;
  const lo = Math.max(0.2, k.lo), hi = Math.min(1.1, k.hi);
  const pos = (x: number) => `${((x - 0.2) / 0.9) * 100}%`;
  return (
    <div className="tw-scroll">
      <div className="tw-card">
        <h4>What the model is</h4>
        <p>A hierarchical censored log-normal with a “never pays” mixture, fitted by EM on this ledger. Open invoices are treated as right-censored, not as failures. Each payer's behaviour is shrunk toward the portfolio.</p>
        <dl className="tw-kv" style={{ marginTop: 8 }}>
          <dt>Invoices used</dt><dd>{m.nInvoices} ({m.nEvents} paid, {m.nCensored} still open)</dd>
          <dt>Payers</dt><dd>{m.nPayers}</dd>
          <dt>Portfolio median days to pay</dt><dd>{m.populationMedianDays.toFixed(0)} (net-30)</dd>
          <dt>Baseline never-pay rate</dt><dd>{pct(m.ghostBase, 1)}</dd>
          <dt>Payment terms elasticity</dt><dd>{m.betaTerms.toFixed(2)}</dd>
          <dt>Amount elasticity</dt><dd>{m.betaAmount.toFixed(2)}</dd>
          <dt>Fit</dt><dd>{m.converged ? 'converged' : 'not converged'} in {m.iterations} iterations</dd>
          <dt>Synthetic share of data</dt><dd style={{ color: m.syntheticShare > 0 ? '#f3d27a' : undefined }}>{pct(m.syntheticShare)}</dd>
        </dl>
      </div>

      <div className="tw-card">
        <h4>Reminder effect (what a nudge does)</h4>
        <p>Factor on the <i>remaining</i> time to pay after a reminder. 1.0 means reminders do nothing; 0.6 means a 40% shorter wait.</p>
        <div style={{ position: 'relative', height: 34, margin: '12px 4px 22px' }}>
          <div style={{ position: 'absolute', top: 14, left: 0, right: 0, height: 4, borderRadius: 4, background: 'rgba(148,163,184,.18)' }} />
          <div style={{ position: 'absolute', top: 10, height: 12, left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})`, background: 'rgba(45,212,191,.35)', borderRadius: 6 }} />
          <div style={{ position: 'absolute', top: 4, left: pos(k.kappa), width: 3, height: 24, background: '#e6f1ff', borderRadius: 2, transform: 'translateX(-1px)' }} />
          <div style={{ position: 'absolute', top: 4, left: pos(1), width: 1, height: 24, background: 'var(--muted)' }} />
          <span style={{ position: 'absolute', top: 30, left: pos(1), transform: 'translateX(-50%)', fontSize: 10, color: 'var(--muted)' }}>no effect</span>
        </div>
        <dl className="tw-kv" style={{ marginTop: 14 }}>
          <dt>Estimate</dt><dd>×{k.kappa.toFixed(2)} (80% range {k.lo.toFixed(2)}–{k.hi.toFixed(2)})</dd>
          <dt>Reminded invoices observed</dt><dd>{k.nObs}</dd>
          <dt>Basis</dt><dd>{k.basis === 'estimated' ? 'estimated from this ledger' : 'prior only (too little data)'}</dd>
        </dl>
        <p style={{ color: '#f3d27a' }}>Caution: reminders here are chosen by a merchant, not randomised. The estimate assumes reminded and un-reminded invoices of the same payer are otherwise comparable, and that repeat reminders are weaker (an assumption, not learned).</p>
      </div>

      <div className="tw-card">
        <h4>Backtest (synthetic data, rolling origin)</h4>
        {!bt && <p>Run <span className="tw-mono">npm run backtest</span> to generate the report.</p>}
        {bt && bt.map((r) => (
          <div key={r.scenario} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
            <b style={{ color: 'var(--bright)', fontSize: 12.5 }}>{r.scenario}</b>
            <p>{r.description}</p>
            <dl className="tw-kv">
              <dt>80% interval coverage</dt><dd>{pct(r.coverage.find((c) => Math.abs(c.nominal - 0.8) < 1e-9)?.observed ?? NaN, 0)} (target 80%)</dd>
              <dt>Pinball loss (lower is better)</dt><dd>{r.pinball.model.toFixed(2)} vs {r.pinball.payerMedianBaseline.toFixed(2)} payer-median, {r.pinball.dueDateBaseline.toFixed(2)} due-date</dd>
              {r.kappa && (<><dt>Reminder effect recovered</dt><dd>×{r.kappa.estimate.toFixed(2)} (truth ×{r.kappa.truth.toFixed(2)})</dd></>)}
            </dl>
          </div>
        ))}
        {nudge.length > 0 && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <b style={{ color: 'var(--bright)', fontSize: 12.5 }}>Reminder-effect recovery</b>
            <p>Simulated truth vs estimate over {nudge.length} runs; the 80% range contained the truth in {nudge.filter((n) => n.truth >= n.lo && n.truth <= n.hi).length} of them.</p>
            <div className="tw-mono" style={{ color: 'var(--muted)' }}>{nudge.map((n) => `×${n.truth.toFixed(2)} → ×${n.estimate.toFixed(2)}`).join('   ')}</div>
          </div>
        )}
        <p>These numbers measure how well the method recovers a known simulated truth. They are not evidence about real customers.</p>
      </div>
    </div>
  );
}

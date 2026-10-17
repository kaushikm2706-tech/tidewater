import React from 'react';
import type { Proposal, Snapshot } from '@shared/types';
import { api, ApiError, type RankedNudge } from '../api';
import { dayShort, pct, usd } from '../format';

interface Props {
  snap: Snapshot;
  onChanged: () => void;
  toast: (msg: string, err?: boolean) => void;
}

export function ActionQueue({ snap, onChanged, toast }: Props) {
  const pending = snap.proposals.filter((p) => p.status === 'pending');
  const history = snap.proposals.filter((p) => p.status !== 'pending').slice(0, 8);
  const [ranked, setRanked] = React.useState<RankedNudge[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const find = async () => {
    setBusy('rank');
    try {
      setRanked(await api.rank(6));
    } catch (e) {
      toast(String((e as Error).message), true);
    } finally {
      setBusy(null);
    }
  };
  const draft = async (id: string) => {
    setBusy(id);
    try {
      await api.propose(id, 'user');
      setRanked((r) => r && r.filter((x) => x.invoiceId !== id));
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tw-scroll">
      <div className="tw-card" style={{ background: 'linear-gradient(180deg,#0d1b2d,#0a1626)' }}>
        <h4>Human-in-the-loop</h4>
        <p>The Collector agent drafts reminders; nothing reaches a customer until you confirm it here. PayPal sends it, and the server re-checks the reminder policy at confirmation.</p>
        <div className="tw-row" style={{ marginTop: 8 }}>
          <button className="tw-btn primary" onClick={find} disabled={busy === 'rank'}>{busy === 'rank' ? 'Ranking…' : 'Find reminders worth sending'}</button>
          <span className="tw-pill">no LLM needed</span>
        </div>
      </div>

      {ranked && (
        <div className="tw-card">
          <div className="tw-row between"><h4>Best candidates by modelled 14-day cash gain</h4><button className="tw-btn" onClick={() => setRanked(null)}>Close</button></div>
          {ranked.length === 0 && <p>No invoice currently passes the reminder policy with a positive expected gain.</p>}
          {ranked.map((r) => (
            <div key={r.invoiceId} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <div className="tw-row between">
                <div><b style={{ color: 'var(--bright)' }}>{r.number}</b> · {r.payerName} · {usd(r.amount, r.currency)}</div>
                <div className="tw-gain" style={{ fontSize: 16 }}>+{usd(r.expectedGain14d, r.currency)}</div>
              </div>
              <p>{r.why}</p>
              <button className="tw-btn" disabled={busy === r.invoiceId} onClick={() => draft(r.invoiceId)}>Draft reminder</button>
            </div>
          ))}
        </div>
      )}

      <div className="tw-row between" style={{ margin: '4px 2px 8px' }}>
        <b style={{ color: 'var(--bright)' }}>Awaiting your approval</b>
        <span className="tw-pill">{pending.length}</span>
      </div>
      {pending.length === 0 && <div className="tw-empty">No pending drafts.<br />Ask the Collector agent, or use “Find reminders”.</div>}
      {pending.map((p) => <ProposalCard key={p.id} p={p} now={snap.now} onChanged={onChanged} toast={toast} />)}

      {history.length > 0 && (
        <>
          <div style={{ margin: '14px 2px 8px', color: 'var(--muted)', fontSize: 12 }}>Recent decisions</div>
          {history.map((p) => (
            <div key={p.id} className="tw-card" style={{ padding: 10 }}>
              <div className="tw-row between">
                <span>{p.invoiceNumber} · {p.payerName}</span>
                <span className={`tw-pill ${p.status === 'executed' ? 'good' : p.status === 'rejected' ? '' : 'bad'}`}>{p.status === 'executed' ? 'sent' : p.status}</span>
              </div>
              {p.result && <p>{p.result}</p>}
              {p.policyNote && <p>{p.policyNote}</p>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ProposalCard({ p, now, onChanged, toast }: { p: Proposal; now: number; onChanged: () => void; toast: Props['toast'] }) {
  const [subject, setSubject] = React.useState(p.subject);
  const [note, setNote] = React.useState(p.note);
  const [busy, setBusy] = React.useState<'confirm' | 'reject' | null>(null);
  const edited = subject !== p.subject || note !== p.note;
  const act = async (kind: 'confirm' | 'reject') => {
    setBusy(kind);
    try {
      if (kind === 'confirm') {
        await api.confirm(p.id, edited ? { subject, note } : {});
        toast(`Reminder for ${p.invoiceNumber} sent via PayPal.`);
      } else {
        await api.reject(p.id);
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), true);
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const eff = p.effect;
  return (
    <div className="tw-card">
      <div className="tw-row between">
        <div><b style={{ color: 'var(--bright)' }}>{p.invoiceNumber}</b> · {p.payerName}</div>
        <span className={`tw-pill ${p.createdBy === 'agent' ? 'agent' : ''}`}>{p.createdBy === 'agent' ? 'Collector agent' : 'you'}</span>
      </div>
      <div className="tw-row between" style={{ marginTop: 6 }}>
        <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{usd(p.amount, p.currency)} · likely paid {p.before.median ? dayShort(p.before.median) : 'unclear'}</span>
        {eff && <span className="tw-gain">+{usd(eff.deltaExpected14d, p.currency)}</span>}
      </div>
      {eff && (
        <div style={{ marginTop: 8 }}>
          <div className="tw-row between" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            <span>Paid within 14 days</span>
            <span>{pct(p.before.probPaid14d)} → <b style={{ color: 'var(--teal)' }}>{pct(Math.min(1, p.before.probPaid14d + eff.deltaP14))}</b> ({eff.basis === 'estimated' ? 'estimated effect' : 'prior only'})</span>
          </div>
          <div className="tw-bar" style={{ marginTop: 4 }}><i style={{ width: `${Math.min(100, (p.before.probPaid14d + eff.deltaP14) * 100)}%` }} /></div>
        </div>
      )}
      <p style={{ marginTop: 8 }}>{p.reason}</p>
      {p.policyNote && <p style={{ color: '#f3d27a' }}>⚠ {p.policyNote}</p>}
      <label className="tw-label">Subject</label>
      <input className="tw-input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
      <label className="tw-label">Message to payer</label>
      <textarea className="tw-textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      <div className="tw-row" style={{ marginTop: 10 }}>
        <button className="tw-btn primary" disabled={busy !== null} onClick={() => act('confirm')}>{busy === 'confirm' ? 'Sending…' : edited ? 'Confirm edited & send' : 'Confirm & send'}</button>
        <button className="tw-btn danger" disabled={busy !== null} onClick={() => act('reject')}>Reject</button>
        <span className="tw-spacer" />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>drafted {dayShort(p.createdAt)}</span>
      </div>
    </div>
  );
}

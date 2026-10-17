import React from 'react';
import type { AuditEntry } from '@shared/types';
import { api } from '../api';
import { dayShort } from '../format';

const LABEL: Record<string, string> = {
  'proposal.created': 'Reminder drafted',
  'proposal.confirmed': 'Human confirmed',
  'proposal.rejected': 'Human rejected',
  'proposal.blocked-by-policy': 'Blocked by policy',
  'proposal.blocked-at-confirm': 'Blocked at confirmation',
  'paypal.reminder-sent': 'Reminder sent via PayPal',
  'paypal.reminder-failed': 'PayPal rejected reminder',
  'invoice.paid': 'Invoice paid',
  'outcome.paid-after-reminder': 'Paid after a reminder',
  'invoice.created': 'Invoice created',
  'payment.recorded': 'Payment recorded (demo)',
  'clock.advanced': 'Simulated clock advanced',
  'seed.simulator': 'Synthetic ledger seeded',
  'seed.sandbox': 'Sandbox seeded',
};

export function AuditPanel({ version, now }: { version: number; now: number }) {
  const [rows, setRows] = React.useState<AuditEntry[]>([]);
  React.useEffect(() => { api.audit(120).then(setRows).catch(() => {}); }, [version]);
  return (
    <div className="tw-scroll">
      <div className="tw-card"><h4>Audit trail</h4><p>Every proposal, human decision, PayPal call and outcome, with the forecast at the time. Dates are the {`app's`} clock (simulated when no PayPal sandbox is connected).</p></div>
      {rows.map((r) => (
        <div key={r.id} className="tw-card" style={{ padding: 10 }}>
          <div className="tw-row between">
            <b style={{ color: 'var(--bright)', fontSize: 12.5 }}>{LABEL[r.action] ?? r.action}</b>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>{dayShort(r.ts)}</span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 3 }}>{r.actor}{r.invoiceId ? ` · ${r.invoiceId}` : ''}</div>
          {r.action === 'outcome.paid-after-reminder' && <Outcome d={r.detail} />}
          {r.action.includes('blocked') && <div style={{ fontSize: 12, marginTop: 4 }}>{String(r.detail.reason ?? '')}</div>}
        </div>
      ))}
      {!rows.length && <div className="tw-empty">Nothing yet.</div>}
      <span hidden>{now}</span>
    </div>
  );
}

function Outcome({ d }: { d: Record<string, unknown> }) {
  const after = typeof d.daysAfterReminder === 'number' ? d.daysAfterReminder : null;
  const pred = typeof d.predictedMedianDaysAfterReminderBeforeNudge === 'number' ? d.predictedMedianDaysAfterReminderBeforeNudge : null;
  return (
    <div style={{ fontSize: 12, marginTop: 4 }}>
      Paid {after !== null ? `${after.toFixed(1)} days after the reminder` : 'after the reminder'}{pred !== null ? `; the pre-nudge forecast median was ${pred.toFixed(1)} days out.` : '.'}
    </div>
  );
}

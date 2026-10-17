import { DAY_MS } from '../forecast/math';
import type { Invoice, InvoiceForecast, Payer, Proposal } from '../../shared/types';

export function proposalFromRow(r: any, invoices: Invoice[], payers: Map<string, Payer>): Proposal {
  const inv = invoices.find((i) => i.id === r.invoice_id);
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNumber: inv?.number ?? r.invoice_id,
    payerName: inv ? (payers.get(inv.payerId)?.name ?? inv.payerId) : 'Unknown',
    amount: inv?.amount ?? 0,
    currency: inv?.currency ?? 'USD',
    subject: r.subject,
    note: r.note,
    createdBy: r.created_by,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
    executedAt: r.executed_at ?? null,
    reason: r.reason,
    before: JSON.parse(r.before_json),
    effect: r.effect_json ? JSON.parse(r.effect_json) : null,
    result: r.result ?? null,
    policyNote: r.policy_note ?? null,
  };
}

export const POLICY = {
  minDaysBetweenReminders: 5,
  maxRemindersPerInvoice: 3,
  /** do not nag before the invoice is nearly due */
  earliestDaysBeforeDue: 3,
};

export interface PolicyVerdict {
  ok: boolean;
  reason: string | null;
}

/** Guardrails enforced on the server, independent of whatever the LLM wants to do. */
export function checkPolicy(inv: Invoice, now: number): PolicyVerdict {
  if (inv.status !== 'SENT' && inv.status !== 'PARTIALLY_PAID') return { ok: false, reason: `Invoice ${inv.number} is ${inv.status}; only sent, unpaid invoices can be reminded.` };
  if (inv.reminders.length >= POLICY.maxRemindersPerInvoice) return { ok: false, reason: `Invoice ${inv.number} already had ${inv.reminders.length} reminders (limit ${POLICY.maxRemindersPerInvoice}). Escalate to a call instead.` };
  const last = inv.reminders.length ? Math.max(...inv.reminders) : null;
  if (last !== null && (now - last) / DAY_MS < POLICY.minDaysBetweenReminders) {
    return { ok: false, reason: `A reminder went out ${((now - last) / DAY_MS).toFixed(1)} days ago; wait at least ${POLICY.minDaysBetweenReminders} days between reminders.` };
  }
  const daysToDue = (inv.dueAt - now) / DAY_MS;
  if (daysToDue > POLICY.earliestDaysBeforeDue) return { ok: false, reason: `Invoice ${inv.number} is not due for ${daysToDue.toFixed(0)} more days; too early to nudge (policy: within ${POLICY.earliestDaysBeforeDue} days of the due date).` };
  return { ok: true, reason: null };
}

const usd = (n: number, c = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);

/** Deterministic fallback text when no LLM drafted the reminder. Tone scales with lateness. */
export function draftReminder(f: Pick<InvoiceForecast, 'number' | 'payerName' | 'amount' | 'currency' | 'daysToDue'>): { subject: string; note: string } {
  const amt = usd(f.amount, f.currency);
  if (f.daysToDue > 0) {
    return {
      subject: `Friendly heads-up: invoice ${f.number} is due soon`,
      note: `Hi ${f.payerName}, a quick reminder that invoice ${f.number} for ${amt} is due in ${Math.ceil(f.daysToDue)} day${Math.ceil(f.daysToDue) === 1 ? '' : 's'}. You can pay it securely with PayPal using the link on the invoice. Thank you!`,
    };
  }
  const late = Math.ceil(-f.daysToDue);
  if (late <= 14) {
    return {
      subject: `Reminder: invoice ${f.number} (${amt}) is ${late} day${late === 1 ? '' : 's'} past due`,
      note: `Hi ${f.payerName}, our records show invoice ${f.number} for ${amt} is now ${late} day${late === 1 ? '' : 's'} past due. If it is already on its way, thank you; otherwise you can pay it with PayPal from the invoice link. Let us know if anything is blocking payment.`,
    };
  }
  return {
    subject: `Action needed: invoice ${f.number} (${amt}) is ${late} days overdue`,
    note: `Hi ${f.payerName}, invoice ${f.number} for ${amt} is now ${late} days overdue. Please arrange payment through the PayPal link on the invoice, or reply to let us know when we can expect it so we can keep our records accurate. Thank you for your prompt attention.`,
  };
}

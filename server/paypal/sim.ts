import { DAY_MS, makeRng } from '../forecast/math';
import { PERSONAS, applyReminder, drawLatentT0, type Persona } from '../sim/generator';
import type { Store, SimInvoiceRow } from '../db';
import type { Clock } from '../clock';
import type { NewInvoiceInput, PayPalPort, ReminderInput, RemoteInvoice } from './port';
import { PayPalError } from './port';

const GENERIC: Persona = {
  id: 'generic',
  name: 'Generic payer',
  email: '',
  medianDays: 32,
  sigma: 0.5,
  ghostProb: 0.05,
  amountMedian: 3000,
  amountSigma: 0.5,
  netChoices: [30],
  ratePer30: 0,
  kappa: 0.75,
};

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function adjustBusinessDay(ms: number): number {
  const dow = new Date(ms).getUTCDay();
  if (dow === 6) return ms + 2 * DAY_MS;
  if (dow === 0) return ms + DAY_MS;
  return ms;
}

const toRemote = (r: SimInvoiceRow): RemoteInvoice => ({
  id: r.id,
  number: r.number,
  status: r.status,
  amount: r.amount,
  currency: r.currency,
  sentAt: r.sentAt,
  dueAt: r.dueAt,
  paidAt: r.paidAt,
  payerEmail: r.payerEmail,
  payerName: r.payerName,
});

/**
 * An in-process stand-in for PayPal Invoicing with *hidden* payer behaviour. The forecaster never
 * reads `payAt`; it only sees what a real PayPal account would show: invoices and payment dates.
 */
export class SimPayPal implements PayPalPort {
  readonly kind = 'simulator' as const;
  private seq = 0;

  constructor(private store: Store, private clock: Clock) {}

  private persona(payerId: string): Persona {
    return PERSONAS.find((p) => p.id === payerId) ?? GENERIC;
  }

  async createAndSend(input: NewInvoiceInput): Promise<RemoteInvoice> {
    const now = this.clock.now();
    const id = `SIM-INV2-${now.toString(36).toUpperCase()}${(++this.seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`;
    const p = this.persona(input.payerId);
    const rng = makeRng(hashSeed(input.number + input.payerId + String(now)));
    const t0 = drawLatentT0(rng, p, input.netDays, input.amount, 'lognormal');
    const payAt = Number.isFinite(t0) ? adjustBusinessDay(now + t0 * DAY_MS) : null;
    const row: SimInvoiceRow = {
      id,
      number: input.number,
      payerId: input.payerId,
      payerEmail: input.payerEmail,
      payerName: input.payerName,
      amount: input.amount,
      currency: input.currency,
      netDays: input.netDays,
      sentAt: now,
      dueAt: now + input.netDays * DAY_MS,
      status: 'SENT',
      paidAt: null,
      payAt,
      kappa: Math.min(1, Math.max(0.3, p.kappa * Math.exp(0.1 * rng.gauss()))),
      remindersApplied: 0,
    };
    this.store.insertSimInvoice(row);
    return toRemote(row);
  }

  /** Insert a pre-built row (used by the seeder for the synthetic history). */
  seedRow(row: SimInvoiceRow) {
    this.store.insertSimInvoice(row);
  }

  async remind(invoiceId: string, _input: ReminderInput): Promise<{ at: number }> {
    const row = this.store.getSimInvoice(invoiceId);
    if (!row) throw new PayPalError('Invoice not found', 404, 'SIM', null);
    if (row.status !== 'SENT' && row.status !== 'PARTIALLY_PAID') throw new PayPalError(`Invoice is ${row.status}, cannot remind`, 422, 'SIM', null);
    const now = this.clock.now();
    if (row.payAt !== null) {
      const T = (row.payAt - row.sentAt) / DAY_MS;
      const r = (now - row.sentAt) / DAY_MS;
      if (T > r) {
        const newT = applyReminder(T, r, row.kappa, row.remindersApplied > 0);
        this.store.updateSimInvoice(invoiceId, { payAt: adjustBusinessDay(row.sentAt + newT * DAY_MS) });
      }
    }
    this.store.updateSimInvoice(invoiceId, { remindersApplied: row.remindersApplied + 1 });
    return { at: now };
  }

  async recordPayment(invoiceId: string): Promise<void> {
    const row = this.store.getSimInvoice(invoiceId);
    if (!row) throw new PayPalError('Invoice not found', 404, 'SIM', null);
    if (row.status === 'PAID' || row.status === 'MARKED_AS_PAID') return;
    this.store.updateSimInvoice(invoiceId, { status: 'PAID', paidAt: this.clock.now() });
  }

  /** Called by the clock-advance endpoint: pay everything whose hidden payment time has arrived. */
  settleDue(now: number): string[] {
    const paid: string[] = [];
    for (const r of this.store.getSimInvoices()) {
      if ((r.status === 'SENT' || r.status === 'PARTIALLY_PAID') && r.payAt !== null && r.payAt <= now) {
        this.store.updateSimInvoice(r.id, { status: 'PAID', paidAt: r.payAt });
        paid.push(r.id);
      }
    }
    return paid;
  }

  async getInvoice(invoiceId: string): Promise<RemoteInvoice> {
    const row = this.store.getSimInvoice(invoiceId);
    if (!row) throw new PayPalError('Invoice not found', 404, 'SIM', null);
    return toRemote(row);
  }

  async listInvoices(): Promise<RemoteInvoice[]> {
    return this.store.getSimInvoices().map(toRemote);
  }
}

import { DAY_MS } from '../forecast/math';
import { generateLedger, PERSONAS } from '../sim/generator';
import type { Store, SimInvoiceRow } from '../db';
import type { Ledger } from './ledger';

export const SEED = 20261017;
export const SEED_OPTIONS = { seed: SEED, volume: 2.0, recentBoost: 2.2 } as const;

/** Simulator: a ~320-invoice synthetic ledger with hidden payer behaviour. Everything is labelled synthetic. */
export async function seedSimulator(store: Store, ledger: Ledger, now: number) {
  const { invoices } = generateLedger({ now, ...SEED_OPTIONS });
  store.tx(() => {
    for (const p of PERSONAS) store.upsertPayer({ id: p.id, name: p.name, email: p.email, synthetic: true });
    for (const g of invoices) {
      const p = PERSONAS.find((x) => x.id === g.payerId)!;
      const row: SimInvoiceRow = {
        id: g.id,
        number: g.number,
        payerId: g.payerId,
        payerEmail: p.email,
        payerName: p.name,
        amount: g.amount,
        currency: 'USD',
        netDays: g.netDays,
        sentAt: g.sentAt,
        dueAt: g.dueAt,
        status: g.paidAt !== null ? 'PAID' : 'SENT',
        paidAt: g.paidAt,
        payAt: g.ghost ? null : g.sentAt + g.trueT * DAY_MS,
        kappa: g.kappa,
        remindersApplied: g.reminders.length,
      };
      store.insertSimInvoice(row);
    }
  });
  await ledger.sync();
  store.tx(() => {
    for (const g of invoices) for (const at of g.reminders) store.addReminder(g.id, at, 'synthetic-history', null, null);
  });
  store.addAudit(now, 'system', 'seed.simulator', null, { invoices: invoices.length, seed: SEED, note: 'synthetic data' });
  ledger.bump();
  return { invoices: invoices.length };
}

/**
 * Sandbox: synthetic *history* lives only in Tidewater's database (PayPal's sandbox cannot be back-dated),
 * and is labelled as such. A few live sandbox invoices are created through the real API on top.
 */
export async function seedSandbox(store: Store, ledger: Ledger, now: number, liveInvoices = 6) {
  const { invoices } = generateLedger({ now, ...SEED_OPTIONS });
  const history = invoices.filter((g) => g.paidAt !== null || now - g.sentAt > 120 * DAY_MS);
  store.tx(() => {
    for (const p of PERSONAS) store.upsertPayer({ id: p.id, name: p.name, email: p.email, synthetic: true });
    for (const g of history) {
      store.upsertInvoice({
        id: g.id, number: g.number, payerId: g.payerId, amount: g.amount, currency: 'USD', netDays: g.netDays,
        sentAt: g.sentAt, dueAt: g.dueAt, status: g.paidAt !== null ? 'PAID' : 'SENT', paidAt: g.paidAt,
        source: 'synthetic-history', synthetic: true,
      });
      for (const at of g.reminders) store.addReminder(g.id, at, 'synthetic-history', null, null);
    }
  });
  const created: string[] = [];
  const picks = PERSONAS.slice(0, liveInvoices);
  for (const p of picks) {
    const inv = await ledger.createInvoice({ payerId: p.id, amount: Math.round(p.amountMedian / 5) * 5, netDays: p.netChoices[0], description: `Services for ${p.name} (Tidewater sandbox demo)` });
    created.push(inv.id);
  }
  store.addAudit(now, 'system', 'seed.sandbox', null, { syntheticHistory: history.length, liveInvoices: created.length });
  ledger.bump();
  return { history: history.length, live: created.length };
}

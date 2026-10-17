/**
 * Exercises the live PayPal *sandbox* client end to end: create -> send -> read -> remind -> record payment -> read.
 * Run it once with your sandbox credentials to confirm field names and response shapes before relying on the app:
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_INVOICER_EMAIL=... npm run paypal:smoke
 */
import { loadConfig } from '../config';
import { LivePayPal } from '../paypal/live';

const cfg = loadConfig();
if (cfg.paypal.mode !== 'sandbox') {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app credentials) first.');
  process.exit(2);
}
const pp = new LivePayPal(cfg.paypal);
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  process.stdout.write(`${name} ... `);
  try {
    const r = await fn();
    console.log('ok');
    return r;
  } catch (e: any) {
    console.log('FAILED');
    console.error(`  ${e.message}${e.debugId ? ` (paypal-debug-id ${e.debugId})` : ''}`);
    if (e.body) console.error('  ' + JSON.stringify(e.body).slice(0, 600));
    process.exit(1);
  }
};

const inv = await step('create + send invoice', () =>
  pp.createAndSend({ number: `TW-SMOKE-${Date.now().toString(36).toUpperCase()}`, payerId: 'smoke', payerEmail: process.env.SMOKE_PAYER_EMAIL ?? 'buyer@example.com', payerName: 'Smoke Test Buyer', amount: 12.34, currency: 'USD', netDays: 14, description: 'Tidewater smoke test' }),
);
console.log(`  id=${inv.id} status=${inv.status} due=${new Date(inv.dueAt).toISOString().slice(0, 10)} amount=${inv.amount}`);
const got = await step('read invoice back', () => pp.getInvoice(inv.id));
if (got.amount !== inv.amount) console.warn(`  note: amount mismatch ${got.amount} vs ${inv.amount}`);
await step('send reminder', () => pp.remind(inv.id, { subject: 'Smoke test reminder', note: 'This is a Tidewater smoke test.' }));
await step('record payment', () => pp.recordPayment(inv.id));
const paid = await step('read after payment', () => pp.getInvoice(inv.id));
console.log(`  status=${paid.status} paidAt=${paid.paidAt ? new Date(paid.paidAt).toISOString() : 'null'}`);
const all = await step('list invoices', () => pp.listInvoices());
console.log(`  ${all.length} invoices visible`);
console.log('\nAll sandbox calls succeeded.');

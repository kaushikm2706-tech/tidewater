import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config';
import { LivePayPal } from '../server/paypal/live';

/**
 * A local mock of the PayPal Invoicing v2 endpoints Tidewater uses. This verifies OUR request shapes,
 * retry/auth behaviour and response mapping against the documented API. It cannot prove PayPal's
 * servers accept them; `npm run paypal:smoke` does that against a real sandbox.
 */
interface Rec { method: string; url: string; auth: string | undefined; body: any }
let server: http.Server;
let base = '';
const calls: Rec[] = [];
let tokenIssued = 0;
let flaky429 = 0;
const invoices = new Map<string, any>();

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = req.url ?? '';
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg123' }); res.end(JSON.stringify(body)); };
    if (url === '/v1/oauth2/token') {
      tokenIssued++;
      calls.push({ method: 'POST', url, auth: req.headers.authorization, body: raw });
      return send(200, { access_token: 'tok-' + tokenIssued, expires_in: 3600 });
    }
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, url, auth: req.headers.authorization, body });
    if (flaky429 > 0 && url.startsWith('/v2/invoicing/invoices/INV2-1')) { flaky429--; return send(429, { name: 'RATE_LIMIT_REACHED' }); }
    if (req.method === 'POST' && url === '/v2/invoicing/invoices') {
      const id = 'INV2-' + (invoices.size + 1);
      invoices.set(id, { id, status: 'DRAFT', detail: body.detail, primary_recipients: body.primary_recipients, amount: { currency_code: body.detail.currency_code, value: body.items[0].unit_amount.value }, payments: { transactions: [] } });
      return send(201, { id, href: `${base}/v2/invoicing/invoices/${id}`, rel: 'self', method: 'GET' });
    }
    let m = /^\/v2\/invoicing\/invoices\/([^/?]+)\/(send|remind|payments)$/.exec(url);
    if (req.method === 'POST' && m) {
      const inv = invoices.get(m[1]);
      if (!inv) return send(404, { name: 'RESOURCE_NOT_FOUND' });
      if (m[2] === 'send') inv.status = 'SENT';
      if (m[2] === 'payments') { inv.status = 'PAID'; inv.payments.transactions.push({ payment_date: body.payment_date, amount: body.amount }); }
      return send(200, m[2] === 'payments' ? { payment_id: 'PAY-1' } : {});
    }
    m = /^\/v2\/invoicing\/invoices\/([^/?]+)$/.exec(url);
    if (req.method === 'GET' && m) return invoices.has(m[1]) ? send(200, invoices.get(m[1])) : send(404, { name: 'RESOURCE_NOT_FOUND' });
    if (req.method === 'GET' && url.startsWith('/v2/invoicing/invoices?')) {
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      const all = [...invoices.values()];
      const slice = all.slice(page - 1, page); // page size of 1 to force paging
      return send(200, { total_items: all.length, total_pages: all.length, items: slice });
    }
    return send(404, { name: 'NOT_FOUND', url });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const mk = () => new LivePayPal(loadConfig({ PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_API_BASE: base, PAYPAL_INVOICER_EMAIL: 'merchant@example.com', TIDEWATER_DB: ':memory:' }).paypal);

describe('LivePayPal against a local mock of the Invoicing v2 API', () => {
  it('authenticates with basic auth, creates then sends an invoice with a specific due date, and maps the result', async () => {
    const pp = mk();
    const out = await pp.createAndSend({ number: 'TW-1', payerId: 'x', payerEmail: 'buyer@example.com', payerName: 'Buyer Co', amount: 1234.5, currency: 'USD', netDays: 30, description: 'Work' });
    const tok = calls.find((c) => c.url === '/v1/oauth2/token')!;
    expect(tok.auth).toBe('Basic ' + Buffer.from('cid:sec').toString('base64'));
    const create = calls.find((c) => c.url === '/v2/invoicing/invoices' && c.method === 'POST')!;
    expect(create.auth).toMatch(/^Bearer tok-/);
    expect(create.body.detail.payment_term.term_type).toBe('DUE_ON_DATE_SPECIFIED');
    expect(create.body.detail.payment_term.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(create.body.items[0].unit_amount).toEqual({ currency_code: 'USD', value: '1234.50' });
    expect(calls.some((c) => /\/INV2-\d+\/send$/.test(c.url))).toBe(true);
    expect(out.status).toBe('SENT');
    expect(out.amount).toBeCloseTo(1234.5);
    expect(out.payerEmail).toBe('buyer@example.com');
    expect((out.dueAt - out.sentAt) / 86_400_000).toBeCloseTo(30, 0);
  });

  it('sends reminders and records payments, then reads the paid date back', async () => {
    const pp = mk();
    const inv = await pp.createAndSend({ number: 'TW-2', payerId: 'x', payerEmail: 'b@example.com', payerName: 'B', amount: 50, currency: 'USD', netDays: 7, description: 'W' });
    await pp.remind(inv.id, { subject: 'Hi', note: 'Please pay' });
    const remind = calls.filter((c) => c.url.endsWith(`/${inv.id}/remind`)).pop()!;
    expect(remind.body).toMatchObject({ subject: 'Hi', note: 'Please pay' });
    await pp.recordPayment(inv.id);
    const after = await pp.getInvoice(inv.id);
    expect(after.status).toBe('PAID');
    expect(after.paidAt).not.toBeNull();
  });

  it('pages through the invoice list', async () => {
    const pp = mk();
    const list = await pp.listInvoices();
    expect(list.length).toBe(invoices.size);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('retries on 429 and succeeds, and surfaces PayPal errors with the debug id', async () => {
    const pp = mk();
    flaky429 = 1;
    const r = await pp.getInvoice('INV2-1');
    expect(r.id).toBe('INV2-1');
    await expect(pp.getInvoice('NOPE')).rejects.toMatchObject({ status: 404, debugId: 'dbg123' });
  });

  it('refuses to start against a non-sandbox PayPal host', () => {
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', PAYPAL_API_BASE: 'https://api-m.paypal.com', TIDEWATER_DB: ':memory:' })).toThrow(/sandbox/i);
  });
});

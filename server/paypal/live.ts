/**
 * PayPal Invoicing v2 client for the SANDBOX REST API.
 *
 * Endpoints used (paths from PayPal's Invoicing v2 reference):
 *   POST /v1/oauth2/token
 *   POST /v2/invoicing/invoices                         create a draft  (returns a HATEOAS link)
 *   POST /v2/invoicing/invoices/{id}/send               send it
 *   POST /v2/invoicing/invoices/{id}/remind             send a reminder
 *   POST /v2/invoicing/invoices/{id}/payments           record a payment
 *   GET  /v2/invoicing/invoices/{id}                    read one
 *   GET  /v2/invoicing/invoices?page=&page_size=        list
 *   POST /v1/notifications/verify-webhook-signature     webhook verification
 *
 * Endpoint paths (create, remind, payments) and invoicing webhook event names were checked against
 * PayPal's published reference; request-body details beyond that were not verifiable from it.
 * This file has been exercised against a local mock of those endpoints (tests/paypal-live.test.ts)
 * but NOT against PayPal's servers from the build environment (no sandbox credentials were
 * available). `npm run paypal:smoke` runs the full create -> send -> remind -> pay -> read loop
 * against your sandbox so you can confirm field names and response shapes on first run.
 */
import { DAY_MS } from '../forecast/math';
import type { InvoiceStatus } from '../../shared/types';
import type { Config } from '../config';
import type { NewInvoiceInput, PayPalPort, ReminderInput, RemoteInvoice } from './port';
import { PayPalError } from './port';

type Json = Record<string, any>;

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseDate = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? t : null;
};
const money = (n: number) => n.toFixed(2);

function mapStatus(s: string | undefined): InvoiceStatus {
  switch (s) {
    case 'DRAFT':
    case 'SCHEDULED':
      return 'DRAFT';
    case 'SENT':
    case 'UNPAID':
    case 'PAYMENT_PENDING':
      return 'SENT';
    case 'PARTIALLY_PAID':
      return 'PARTIALLY_PAID';
    case 'PAID':
      return 'PAID';
    case 'MARKED_AS_PAID':
      return 'MARKED_AS_PAID';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

export class LivePayPal implements PayPalPort {
  readonly kind = 'sandbox' as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: Config['paypal'], private fetchImpl: typeof fetch = fetch) {}

  // ---------------------------------------------------------------- transport
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.cfg.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || !body.access_token) throw new PayPalError(`OAuth failed (${res.status}): ${body.error_description ?? body.error ?? 'unknown'}`, res.status, res.headers.get('paypal-debug-id'), body);
    this.token = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000 };
    return this.token.value;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.accessToken();
      const res = await this.fetchImpl(`${this.cfg.apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      const text = await res.text();
      let parsed: any = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }
      if (res.status === 401) {
        this.token = null;
        lastErr = new PayPalError('Unauthorized', 401, res.headers.get('paypal-debug-id'), parsed);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new PayPalError(`PayPal ${res.status}`, res.status, res.headers.get('paypal-debug-id'), parsed);
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const detail = parsed?.details?.[0]?.description ?? parsed?.message ?? parsed?.name ?? 'request failed';
        throw new PayPalError(`PayPal ${method} ${path} -> ${res.status}: ${detail}`, res.status, res.headers.get('paypal-debug-id'), parsed);
      }
      return { status: res.status, body: parsed as T };
    }
    throw lastErr instanceof Error ? lastErr : new PayPalError('PayPal request failed', 0, null, null);
  }

  // ---------------------------------------------------------------- mapping
  private fromPayPal(inv: Json): RemoteInvoice {
    const detail = inv.detail ?? {};
    const invoiceDate = parseDate(detail.invoice_date) ?? parseDate(detail.metadata?.create_time) ?? Date.now();
    const term = detail.payment_term ?? {};
    let dueAt = parseDate(term.due_date);
    if (dueAt === null) {
      const m = /^NET_(\d+)$/.exec(term.term_type ?? '');
      dueAt = invoiceDate + (m ? Number(m[1]) : 0) * DAY_MS;
    }
    const status = mapStatus(inv.status);
    let paidAt: number | null = null;
    if (status === 'PAID' || status === 'MARKED_AS_PAID') {
      const tx: Json[] = inv.payments?.transactions ?? [];
      const dates = tx.map((t) => parseDate(t.payment_date)).filter((x): x is number => x !== null);
      // PayPal stores a payment *date*; use midday UTC so day arithmetic is not skewed by timezones.
      paidAt = dates.length ? Math.max(...dates) + 12 * 3600_000 : Date.now();
    }
    const billing = inv.primary_recipients?.[0]?.billing_info ?? {};
    const n = billing.name ?? {};
    const name = billing.business_name ?? [n.given_name, n.surname].filter(Boolean).join(' ') ?? '';
    return {
      id: inv.id,
      number: detail.invoice_number ?? inv.id,
      status,
      amount: Number(inv.amount?.value ?? inv.amount?.breakdown?.item_total?.value ?? 0),
      currency: inv.amount?.currency_code ?? detail.currency_code ?? 'USD',
      sentAt: invoiceDate,
      dueAt,
      paidAt,
      payerEmail: billing.email_address ?? '',
      payerName: name || billing.email_address || 'Unknown payer',
    };
  }

  // ---------------------------------------------------------------- port
  async createAndSend(input: NewInvoiceInput): Promise<RemoteInvoice> {
    const today = Date.now();
    const draft = {
      detail: {
        invoice_number: input.number,
        invoice_date: isoDate(today),
        currency_code: input.currency,
        note: input.description,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: isoDate(today + input.netDays * DAY_MS) },
      },
      invoicer: {
        name: { business_name: this.cfg.invoicerName },
        ...(this.cfg.invoicerEmail ? { email_address: this.cfg.invoicerEmail } : {}),
      },
      primary_recipients: [{ billing_info: { business_name: input.payerName, email_address: input.payerEmail } }],
      items: [{ name: input.description, quantity: '1', unit_amount: { currency_code: input.currency, value: money(input.amount) } }],
      configuration: { allow_tip: false, tax_inclusive: false },
    };
    const created = await this.call<Json>('POST', '/v2/invoicing/invoices', draft);
    const id = created.body.id ?? String(created.body.href ?? '').split('/').filter(Boolean).pop();
    if (!id) throw new PayPalError('Create invoice returned no id/href', created.status, null, created.body);
    await this.call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, { send_to_invoicer: false });
    return this.getInvoice(id);
  }

  async remind(invoiceId: string, input: ReminderInput): Promise<{ at: number }> {
    await this.call('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, {
      subject: input.subject,
      note: input.note,
      send_to_invoicer: false,
    });
    return { at: Date.now() };
  }

  async recordPayment(invoiceId: string): Promise<void> {
    const inv = await this.getInvoice(invoiceId);
    await this.call('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`, {
      method: 'BANK_TRANSFER',
      payment_date: isoDate(Date.now()),
      amount: { currency_code: inv.currency, value: money(inv.amount) },
      note: 'Recorded by Tidewater sandbox payer simulation',
    });
  }

  async getInvoice(invoiceId: string): Promise<RemoteInvoice> {
    const r = await this.call<Json>('GET', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    return this.fromPayPal(r.body);
  }

  async listInvoices(): Promise<RemoteInvoice[]> {
    const out: RemoteInvoice[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await this.call<Json>('GET', `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
      const items: Json[] = r.body.items ?? [];
      for (const it of items) out.push(this.fromPayPal(it));
      const totalPages = Number(r.body.total_pages ?? 1);
      if (page >= totalPages || items.length === 0) break;
    }
    return out;
  }

  /** Server-side webhook verification (PayPal's "verify-webhook-signature" API). */
  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const h = (n: string) => String(headers[n.toLowerCase()] ?? '');
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return false;
    }
    const r = await this.call<Json>('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: this.cfg.webhookId,
      webhook_event: event,
    });
    return r.body.verification_status === 'SUCCESS';
  }
}

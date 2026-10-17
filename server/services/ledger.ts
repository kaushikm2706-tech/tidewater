import type { Config } from '../config';
import type { Clock } from '../clock';
import { VirtualClock } from '../clock';
import type { Store } from '../db';
import { DAY_MS } from '../forecast/math';
import { fitModel, makePredictive, type FittedModel, type Observation } from '../forecast/model';
import { computeKpis, computeTide, forecastInvoices, simulateNudges, summarisePayers } from '../forecast/portfolio';
import type { PayPalPort, RemoteInvoice } from '../paypal/port';
import { SimPayPal } from '../paypal/sim';
import type {
  AppMode,
  DataSource,
  Invoice,
  InvoiceForecast,
  ModelSummary,
  NudgeSimulation,
  Payer,
  Proposal,
  Snapshot,
} from '../../shared/types';
import { proposalFromRow } from './proposals';

const SENT_LIKE = new Set(['SENT', 'PARTIALLY_PAID', 'PAID', 'MARKED_AS_PAID']);

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'payer';
}

export interface SyncResult {
  upserted: number;
  newlyPaid: string[];
}

/** Unpaid for longer than this: the model treats the invoice as a non-payer (see ModelConfig.ghostHorizonDays). */
export const STALE_DAYS = 120;

interface Computed {
  key: string;
  model: FittedModel;
  forecasts: InvoiceForecast[];
  /** open invoices still worth forecasting + everything paid; stale unpaid invoices are held out */
  invoices: Invoice[];
  stale: Invoice[];
  payers: Map<string, Payer>;
}

export class Ledger {
  private version = 0;
  private computed: Computed | null = null;
  private tideCache = new Map<string, Snapshot['tide']>();

  constructor(
    readonly store: Store,
    readonly port: PayPalPort,
    readonly clock: Clock,
    readonly cfg: Config,
    private llmConfigured: () => { configured: boolean; model: string | null },
  ) {}

  now(): number {
    return this.clock.now();
  }

  bump() {
    this.version++;
    this.computed = null;
    this.tideCache.clear();
  }

  mode(): AppMode {
    const llm = this.llmConfigured();
    return {
      paypal: this.port.kind,
      paypalConfigured: this.cfg.paypal.mode === 'sandbox',
      llm: llm.configured ? 'configured' : 'offline-planner',
      llmModel: llm.model,
      clock: this.clock.kind,
      syntheticHistory: this.store.getInvoices().some((i) => i.synthetic),
      version: this.cfg.version,
    };
  }

  // ------------------------------------------------------------------ sync with PayPal
  private sourceFor(remote: RemoteInvoice): { source: DataSource; synthetic: boolean } {
    if (remote.id.startsWith('SYN-')) return { source: 'synthetic-history', synthetic: true };
    return { source: this.port.kind === 'sandbox' ? 'paypal-sandbox' : 'sim', synthetic: false };
  }

  async sync(): Promise<SyncResult> {
    const remote = await this.port.listInvoices();
    const before = new Map(this.store.getInvoices().map((i) => [i.id, i]));
    const newlyPaid: string[] = [];
    let upserted = 0;
    this.store.tx(() => {
      for (const r of remote) {
        let payer = this.store.findPayerByEmail(r.payerEmail);
        const known = [...before.values()].find((i) => i.id === r.id);
        if (!payer && known) payer = this.store.getPayers().find((p) => p.id === known.payerId) ?? null;
        if (!payer) {
          payer = { id: slug(r.payerName || r.payerEmail), name: r.payerName, email: r.payerEmail, synthetic: r.id.startsWith('SYN-') };
          this.store.upsertPayer(payer);
        }
        const { source, synthetic } = this.sourceFor(r);
        if (r.status === 'DRAFT') continue; // drafts are not receivables yet
        this.store.upsertInvoice({
          id: r.id,
          number: r.number,
          payerId: known?.payerId ?? payer.id,
          amount: r.amount,
          currency: r.currency,
          netDays: Math.max(1, Math.round((r.dueAt - r.sentAt) / DAY_MS)),
          sentAt: r.sentAt,
          dueAt: r.dueAt,
          status: r.status,
          paidAt: r.paidAt,
          source,
          synthetic,
        });
        upserted++;
        const was = before.get(r.id);
        if ((r.status === 'PAID' || r.status === 'MARKED_AS_PAID') && was && was.status !== 'PAID' && was.status !== 'MARKED_AS_PAID') newlyPaid.push(r.id);
      }
    });
    if (upserted || newlyPaid.length) this.bump();
    for (const id of newlyPaid) this.recordPaidOutcome(id);
    return { upserted, newlyPaid };
  }

  /** Close the loop: compare what the model said at proposal time with what actually happened. */
  private recordPaidOutcome(invoiceId: string) {
    const inv = this.store.getInvoice(invoiceId);
    if (!inv || inv.paidAt === null) return;
    const rows = this.store.getProposalRows(500).filter((r) => r.invoice_id === invoiceId && r.status === 'executed');
    const daysToPay = (inv.paidAt - inv.sentAt) / DAY_MS;
    if (rows.length) {
      const last = rows[0];
      const before = JSON.parse(last.before_json) as Proposal['before'];
      const afterReminderDays = last.executed_at ? (inv.paidAt - last.executed_at) / DAY_MS : null;
      const predictedDays = before.median !== null && last.executed_at ? (before.median - last.executed_at) / DAY_MS : null;
      this.store.addAudit(this.now(), 'system', 'outcome.paid-after-reminder', invoiceId, {
        daysToPay,
        daysAfterReminder: afterReminderDays,
        predictedMedianDaysAfterReminderBeforeNudge: predictedDays,
        proposalId: last.id,
      });
    } else {
      this.store.addAudit(this.now(), 'system', 'invoice.paid', invoiceId, { daysToPay });
    }
  }

  async handleWebhookEvent(event: any): Promise<{ handled: boolean; invoiceId?: string }> {
    const type: string = event?.event_type ?? '';
    if (!type.startsWith('INVOICING.')) return { handled: false };
    const id: string | undefined = event?.resource?.invoice?.id ?? event?.resource?.id;
    if (!id) return { handled: false };
    this.store.addAudit(this.now(), 'paypal-webhook', type, id, { eventId: event?.id ?? null });
    try {
      const remote = await this.port.getInvoice(id);
      const before = this.store.getInvoice(id);
      let payer = this.store.findPayerByEmail(remote.payerEmail);
      if (!payer) {
        payer = { id: slug(remote.payerName || remote.payerEmail), name: remote.payerName, email: remote.payerEmail, synthetic: false };
        this.store.upsertPayer(payer);
      }
      if (remote.status !== 'DRAFT') {
        const { source, synthetic } = this.sourceFor(remote);
        this.store.upsertInvoice({
          id: remote.id,
          number: remote.number,
          payerId: before?.payerId ?? payer.id,
          amount: remote.amount,
          currency: remote.currency,
          netDays: Math.max(1, Math.round((remote.dueAt - remote.sentAt) / DAY_MS)),
          sentAt: remote.sentAt,
          dueAt: remote.dueAt,
          status: remote.status,
          paidAt: remote.paidAt,
          source,
          synthetic,
        });
        this.bump();
        if ((remote.status === 'PAID' || remote.status === 'MARKED_AS_PAID') && before && before.status !== 'PAID' && before.status !== 'MARKED_AS_PAID') this.recordPaidOutcome(id);
      }
    } catch (e) {
      // The poller will reconcile; a failed webhook fetch must never crash the process.
      this.store.addAudit(this.now(), 'system', 'webhook.reconcile-failed', id, { error: String((e as Error).message) });
    }
    return { handled: true, invoiceId: id };
  }

  // ------------------------------------------------------------------ analytics
  private observations(invoices: Invoice[]): Observation[] {
    return invoices
      .filter((i) => SENT_LIKE.has(i.status) || i.status === 'CANCELLED')
      .map((i) => ({
        invoiceId: i.id,
        payerId: i.payerId,
        sentAt: i.sentAt,
        netDays: i.netDays,
        amount: i.amount,
        paidAt: i.status === 'PAID' || i.status === 'MARKED_AS_PAID' ? i.paidAt : null,
        cancelled: i.status === 'CANCELLED',
        reminders: i.reminders,
      }));
  }

  private compute(): Computed {
    const now = this.now();
    const key = `${this.version}:${Math.floor(now / DAY_MS)}`;
    if (this.computed && this.computed.key === key) return this.computed;
    const all = this.store.getInvoices();
    const payers = new Map(this.store.getPayers().map((p) => [p.id, p]));
    const model = fitModel(this.observations(all), now);
    const isStale = (i: Invoice) => (i.status === 'SENT' || i.status === 'PARTIALLY_PAID') && (now - i.sentAt) / DAY_MS > STALE_DAYS;
    const stale = all.filter(isStale);
    const invoices = all.filter((i) => !isStale(i));
    const forecasts = forecastInvoices(model, invoices, payers, now);
    this.computed = { key, model, forecasts, invoices, stale, payers };
    return this.computed;
  }

  model(): FittedModel {
    return this.compute().model;
  }

  forecasts(): InvoiceForecast[] {
    return this.compute().forecasts;
  }

  forecastFor(invoiceId: string): InvoiceForecast | null {
    return this.compute().forecasts.find((f) => f.invoiceId === invoiceId) ?? null;
  }

  private modelSummary(c: Computed): ModelSummary {
    const m = c.model;
    const synth = c.invoices.length ? c.invoices.filter((i) => i.synthetic).length / c.invoices.length : 0;
    return {
      fittedAt: m.now,
      nInvoices: m.diagnostics.nInvoices,
      nEvents: m.diagnostics.nEvents,
      nCensored: m.diagnostics.nCensored,
      nGhostLabelled: m.diagnostics.nGhost,
      nPayers: m.payers.size,
      iterations: m.diagnostics.iterations,
      converged: m.diagnostics.converged,
      logLik: m.diagnostics.logLik,
      populationMedianDays: Math.exp(m.muA),
      populationSigma: m.sigma0,
      ghostBase: m.ghost0,
      betaTerms: m.beta[0],
      betaAmount: m.beta[1],
      nudge: m.nudge,
      syntheticShare: synth,
    };
  }

  snapshot(scenarioIds: string[] = []): Snapshot {
    const c = this.compute();
    const now = this.now();
    const key = `tide:${c.key}:${scenarioIds.slice().sort().join(',')}`;
    let tide = this.tideCache.get(key);
    if (!tide) {
      tide = computeTide(c.model, c.invoices, now, scenarioIds.length ? { scenarioIds: new Set(scenarioIds), scenarioKappa: c.model.nudge.kappa } : {});
      this.tideCache.set(key, tide);
    }
    const currency = c.invoices.find((i) => i.currency)?.currency ?? 'USD';
    const proposals = this.store.getProposalRows(60).map((r) => proposalFromRow(r, c.invoices, c.payers));
    return {
      now,
      mode: this.mode(),
      invoices: c.forecasts,
      tide,
      payers: summarisePayers(c.model, c.invoices, c.payers),
      kpis: { ...computeKpis(c.model, c.invoices, c.forecasts, now, currency), staleCount: c.stale.length, staleAmount: c.stale.reduce((a, i) => a + i.amount, 0) },
      model: this.modelSummary(c),
      proposals,
      generatedAt: Date.now(),
    };
  }

  /** Cumulative payment probability for one open invoice over the next `horizon` days, with and without a reminder sent now. */
  curveFor(invoiceId: string, horizon = 75) {
    const c = this.compute();
    const inv = c.invoices.find((i) => i.id === invoiceId);
    if (!inv || (inv.status !== 'SENT' && inv.status !== 'PARTIALLY_PAID')) return null;
    const now = this.now();
    const input = { payerId: inv.payerId, netDays: inv.netDays, amount: inv.amount, sentAt: inv.sentAt, reminders: inv.reminders };
    const base = makePredictive(c.model, input, now);
    const nudged = makePredictive(c.model, input, now, { nudgeNow: { kappa: c.model.nudge.kappa } });
    const points = [];
    for (let k = 0; k <= horizon; k++) {
      const t = base.elapsedDays + k;
      points.push({ k, cdf: base.cdfDays(t), cdfNudged: nudged.cdfDays(t) });
    }
    return {
      invoiceId,
      horizon,
      daysToDue: (inv.dueAt - now) / DAY_MS,
      ghostProb: base.ghostProb,
      kappa: c.model.nudge.kappa,
      kappaBasis: c.model.nudge.basis,
      points,
    };
  }

  simulate(ids: string[]): NudgeSimulation {
    const c = this.compute();
    return simulateNudges(c.model, c.invoices, c.payers, this.now(), ids);
  }

  invoice(id: string): Invoice | null {
    return this.store.getInvoice(id);
  }

  payer(id: string): Payer | null {
    return this.store.getPayers().find((p) => p.id === id) ?? null;
  }

  // ------------------------------------------------------------------ writes through PayPal
  async createInvoice(input: { payerId?: string; payerName?: string; payerEmail?: string; amount: number; netDays: number; description: string; currency?: string }): Promise<Invoice> {
    let payer: Payer | null = null;
    if (input.payerId) payer = this.payer(input.payerId);
    if (!payer && input.payerEmail) payer = this.store.findPayerByEmail(input.payerEmail);
    if (!payer) {
      if (!input.payerName || !input.payerEmail) throw new Error('Unknown payer: provide payerId, or payerName and payerEmail.');
      payer = { id: slug(input.payerName), name: input.payerName, email: input.payerEmail, synthetic: false };
      this.store.upsertPayer(payer);
    }
    const number = `TW-${Date.now().toString(36).toUpperCase()}`;
    const remote = await this.port.createAndSend({
      number,
      payerEmail: payer.email,
      payerName: payer.name,
      payerId: payer.id,
      amount: input.amount,
      currency: input.currency ?? 'USD',
      netDays: input.netDays,
      description: input.description,
    });
    const { source, synthetic } = this.sourceFor(remote);
    this.store.upsertInvoice({
      id: remote.id,
      number: remote.number,
      payerId: payer.id,
      amount: remote.amount,
      currency: remote.currency,
      netDays: input.netDays,
      sentAt: remote.sentAt,
      dueAt: remote.dueAt,
      status: remote.status === 'DRAFT' ? 'SENT' : remote.status,
      paidAt: remote.paidAt,
      source,
      synthetic,
    });
    this.store.addAudit(this.now(), 'user', 'invoice.created', remote.id, { number: remote.number, amount: remote.amount, payer: payer.name, netDays: input.netDays, via: this.port.kind });
    this.bump();
    return this.store.getInvoice(remote.id)!;
  }

  /** Demo control: make this payer pay now (simulator) / record a payment (sandbox). */
  async payNow(invoiceId: string): Promise<void> {
    await this.port.recordPayment(invoiceId);
    this.store.addAudit(this.now(), 'demo-payer', 'payment.recorded', invoiceId, { via: this.port.kind });
    await this.sync();
  }

  /** Simulator only: advance the virtual clock; payers whose hidden time has come pay. */
  async advance(days: number): Promise<{ now: number; paid: string[] }> {
    if (!(this.clock instanceof VirtualClock) || !(this.port instanceof SimPayPal)) throw new Error('The clock can only be advanced in simulator mode.');
    const target = this.clock.now() + days * DAY_MS;
    // Settle in daily steps so audit timestamps are right.
    const paid: string[] = [];
    for (let t = this.clock.now() + DAY_MS; t <= target + 1; t += DAY_MS) {
      this.clock.set(Math.min(t, target));
      const p = this.port.settleDue(this.clock.now());
      paid.push(...p);
    }
    this.clock.set(target);
    const r = await this.sync();
    this.store.addAudit(target, 'demo-clock', 'clock.advanced', null, { days, paid: paid.length });
    return { now: target, paid: r.newlyPaid.length ? r.newlyPaid : paid };
  }
}

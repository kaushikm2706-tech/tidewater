import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { buildApp, llmStatus, seed, type App } from './app';
import { VirtualClock } from './clock';
import { loadConfig, type Config } from './config';
import { LivePayPal } from './paypal/live';
import { SimPayPal } from './paypal/sim';
import { httpError } from './services/actions';
import { proposalFromRow } from './services/proposals';
import { DAY_MS } from './forecast/math';
import { DailyCap, rateLimit, securityHeaders } from './ratelimit';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function createServer(app: App) {
  const { ledger, actions, store, cfg } = app;
  const api = express();
  api.disable('x-powered-by');
  if (cfg.trustProxy > 0) api.set('trust proxy', cfg.trustProxy);
  api.use(securityHeaders);
  const llmCap = new DailyCap(cfg.limits.llmDailyCap);

  // The webhook needs the raw body for signature verification, so it is mounted before express.json().
  api.post('/api/paypal/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!(app.port instanceof LivePayPal)) return res.status(409).json({ error: 'Webhooks are only used in sandbox mode.' });
    const ok = await app.port.verifyWebhook(req.headers, raw).catch(() => false);
    if (!ok) {
      store.addAudit(ledger.now(), 'paypal-webhook', 'webhook.rejected', null, { reason: 'signature verification failed or webhook id not configured' });
      return res.status(401).json({ error: 'signature verification failed' });
    }
    const result = await ledger.handleWebhookEvent(JSON.parse(raw));
    res.json({ ok: true, ...result });
  }));

  api.use(express.json({ limit: '1mb' }));
  // Abuse limits for a public deployment (the webhook above is exempt: PayPal must always get through).
  api.use('/api', rateLimit({ windowMs: 60_000, max: cfg.limits.writesPerMinute, message: 'Too many requests. Please slow down and try again in a minute.', applies: (r) => r.method === 'POST' }));
  api.use('/api/admin/reseed', rateLimit({ windowMs: 60_000, max: cfg.limits.resetsPerMinute, message: 'Too many demo resets. Try again in a minute.' }));
  api.use('/api/llm/chat', rateLimit({ windowMs: 60_000, max: cfg.limits.llmPerMinute, message: 'Too many assistant requests. Try again in a minute.' }));

  api.get('/api/health', (_req, res) => res.json({ ok: true, version: cfg.version, now: ledger.now(), mode: ledger.mode() }));
  api.get('/api/mode', (_req, res) => res.json(ledger.mode()));

  api.get('/api/snapshot', wrap((req, res) => {
    const ids = String(req.query.scenario ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    res.json(ledger.snapshot(ids));
  }));

  api.get('/api/invoices/:id', wrap((req, res) => {
    const inv = ledger.invoice(String(req.params.id));
    if (!inv) throw httpError(404, 'Invoice not found');
    res.json({ invoice: inv, payer: ledger.payer(inv.payerId), forecast: ledger.forecastFor(inv.id) });
  }));

  api.get('/api/invoices/:id/curve', wrap((req, res) => {
    const c = ledger.curveFor(String(req.params.id));
    if (!c) throw httpError(404, 'No open, forecastable invoice with that id');
    res.json(c);
  }));

  const createSchema = z.object({
    payerId: z.string().optional(),
    payerName: z.string().min(1).max(120).optional(),
    payerEmail: z.string().email().optional(),
    amount: z.number().positive().max(10_000_000),
    netDays: z.number().int().min(1).max(120),
    description: z.string().min(1).max(200),
  });
  api.post('/api/invoices', wrap(async (req, res) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) throw httpError(400, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    try {
      res.status(201).json(await ledger.createInvoice(body.data));
    } catch (e) {
      if (e instanceof Error && !(e as any).status) throw httpError(400, e.message);
      throw e;
    }
  }));

  api.post('/api/simulate-nudge', wrap((req, res) => {
    const ids = z.object({ invoiceIds: z.array(z.string()).min(1).max(200) }).safeParse(req.body);
    if (!ids.success) throw httpError(400, 'invoiceIds: array of invoice ids required');
    res.json(ledger.simulate(ids.data.invoiceIds));
  }));

  api.get('/api/rank-nudges', wrap((req, res) => {
    const limit = Math.min(25, Math.max(1, Number(req.query.limit ?? 8) || 8));
    res.json(actions.rank(limit));
  }));

  api.get('/api/proposals', wrap((_req, res) => {
    const inv = store.getInvoices();
    const payers = new Map(store.getPayers().map((p) => [p.id, p]));
    res.json(store.getProposalRows(100).map((r) => proposalFromRow(r, inv, payers)));
  }));
  api.post('/api/proposals', wrap((req, res) => {
    const b = z.object({ invoiceId: z.string(), subject: z.string().max(200).optional(), note: z.string().max(2000).optional(), reason: z.string().max(600).optional(), createdBy: z.enum(['agent', 'user']).default('user') }).safeParse(req.body);
    if (!b.success) throw httpError(400, 'invoiceId required');
    const r = actions.propose(b.data);
    if (!r.ok) return res.status(r.blockedBy === 'not-found' ? 404 : 422).json({ error: r.message, blockedBy: r.blockedBy });
    res.status(r.deduplicated ? 200 : 201).json({ proposal: r.proposal, deduplicated: r.deduplicated });
  }));
  api.post('/api/proposals/:id/confirm', wrap(async (req, res) => {
    const b = z.object({ subject: z.string().max(200).optional(), note: z.string().max(2000).optional() }).safeParse(req.body ?? {});
    if (!b.success) throw httpError(400, 'invalid edits');
    res.json(await actions.confirm(String(req.params.id), b.data));
  }));
  api.post('/api/proposals/:id/reject', wrap((req, res) => res.json(actions.reject(String(req.params.id)))));

  api.get('/api/audit', wrap((req, res) => res.json(store.getAudit(Math.min(500, Number(req.query.limit ?? 200) || 200)))));

  api.post('/api/dev/pay/:id', wrap(async (req, res) => {
    const inv = ledger.invoice(String(req.params.id));
    if (!inv) throw httpError(404, 'Invoice not found');
    if (inv.synthetic) throw httpError(400, 'Synthetic history invoices cannot be paid.');
    await ledger.payNow(inv.id);
    res.json({ ok: true });
  }));
  api.post('/api/sim/advance', wrap(async (req, res) => {
    const b = z.object({ days: z.number().min(0.5).max(90) }).safeParse(req.body);
    if (!b.success) throw httpError(400, 'days: 0.5-90');
    try {
      res.json(await ledger.advance(b.data.days));
    } catch (e) {
      throw httpError(409, (e as Error).message);
    }
  }));
  api.post('/api/sync', wrap(async (_req, res) => res.json(await ledger.sync())));

  api.get('/api/model/summary', wrap((_req, res) => res.json(ledger.snapshot().model)));
  api.get('/api/model/backtest', (_req, res) => {
    const f = path.resolve(import.meta.dirname, 'data/backtest.json');
    if (!fs.existsSync(f)) return res.status(404).json({ error: 'Run `npm run backtest` to generate it.' });
    res.type('json').send(fs.readFileSync(f, 'utf8'));
  });

  api.post('/api/admin/reseed', wrap(async (_req, res) => {
    if (app.port.kind !== 'simulator') throw httpError(409, 'Reseeding is only available in simulator mode.');
    store.reset();
    (app.clock as VirtualClock).set(Date.now());
    ledger.bump();
    res.json(await seed(app));
  }));

  // ---------------------------------------------------------------- LLM proxy (OpenAI-compatible)
  api.get('/api/llm/status', (_req, res) => res.json(llmStatus(cfg)));
  api.post('/api/llm/chat', wrap(async (req, res) => {
    const st = llmStatus(cfg);
    if (!st.configured) return res.status(503).json({ error: 'No LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.' });
    const body = z.object({ messages: z.array(z.any()).min(1).max(200), tools: z.array(z.any()).max(40).optional(), tool_choice: z.any().optional(), temperature: z.number().min(0).max(2).optional(), stream: z.boolean().optional(), max_tokens: z.number().int().min(64).max(4096).optional() }).safeParse(req.body);
    if (!body.success) throw httpError(400, 'messages required');
    // A model "turn" is one provider call, so the cap bounds spend on the key regardless of who calls.
    if (!llmCap.take()) return res.status(429).json({ error: "This demo's daily AI budget is used up. Try again after 00:00 UTC, or run Tidewater locally (no key needed for the offline planner)." });
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    const payload = JSON.stringify({ max_tokens: 1536, ...body.data, model: cfg.llm.model });
    // Free provider tiers cap tokens per minute; when told to wait a few seconds, wait and retry (up to 3 tries).
    let up: globalThis.Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      up = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
        body: payload,
        signal: ctrl.signal,
      }).catch((e) => { throw httpError(502, `LLM provider unreachable: ${(e as Error).message}`); });
      if (up.status !== 429 || attempt === 2) break;
      const waitS = Number(up.headers.get('retry-after'));
      if (!Number.isFinite(waitS) || waitS <= 0 || waitS > 25) break;
      await up.arrayBuffer().catch(() => null);
      await new Promise((r) => setTimeout(r, Math.ceil(waitS * 1000) + 250));
      if (ctrl.signal.aborted) return;
    }
    if (!up) throw httpError(502, 'LLM provider unreachable');
    res.status(up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/json');
    if (!up.body) return res.end(await up.text());
    const reader = up.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  }));

  api.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (fs.existsSync(cfg.webDist)) {
    api.use(express.static(cfg.webDist, { maxAge: '1h', index: false }));
    api.get(/.*/, (_req, res) => res.sendFile(path.join(cfg.webDist, 'index.html')));
  }

  api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: status >= 500 && status !== 502 ? 'Internal error' : String(err?.message ?? 'error') });
  });
  return api;
}

export function startPoller(app: App) {
  if (app.cfg.paypal.mode !== 'sandbox') return null;
  const t = setInterval(() => app.ledger.sync().catch((e) => console.warn('[poll] sync failed:', (e as Error).message)), Math.max(10, app.cfg.paypal.pollSeconds) * 1000);
  t.unref();
  return t;
}

export async function main(cfg: Config = loadConfig()) {
  const app = await buildApp(cfg);
  const server = createServer(app);
  startPoller(app);
  server.listen(cfg.port, () => {
    const m = app.ledger.mode();
    console.log(`Tidewater ${cfg.version} on http://localhost:${cfg.port}  paypal=${m.paypal} llm=${m.llm} invoices=${app.store.countInvoices()}`);
  });
  return { app, server };
}

export { DAY_MS, SimPayPal };

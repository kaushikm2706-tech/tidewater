import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { createServer } from '../server/server';
import type { AuditEntry, Proposal, Snapshot } from '../shared/types';

const NOW = Date.UTC(2026, 9, 17, 12);
let app: App;
let srv: http.Server;
let base = '';

const get = async <T>(p: string) => (await (await fetch(base + p)).json()) as T;
const post = async (p: string, body: unknown = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

beforeAll(async () => {
  app = await buildApp(loadConfig({ TIDEWATER_DB: ':memory:', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' }), { now: NOW });
  srv = createServer(app).listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}, 60_000);
afterAll(() => srv.close());

describe('Tidewater API (simulator mode)', () => {
  let snap: Snapshot;

  it('seeds a labelled-synthetic ledger and serves a coherent snapshot', async () => {
    snap = await get<Snapshot>('/api/snapshot');
    expect(snap.mode.paypal).toBe('simulator');
    expect(snap.mode.syntheticHistory).toBe(true);
    expect(snap.model.syntheticShare).toBeGreaterThan(0.9);
    expect(snap.invoices.length).toBeGreaterThanOrEqual(25);
    expect(snap.tide).toHaveLength(76);
    const t = snap.tide;
    for (let i = 1; i < t.length; i++) {
      expect(t[i].expected).toBeGreaterThanOrEqual(t[i - 1].expected - 1e-6);
      expect(t[i].p10).toBeLessThanOrEqual(t[i].p90 + 1e-6);
    }
    expect(snap.kpis.openCount).toBe(snap.invoices.length);
    // forecast must never include invoices unpaid for more than 120 days
    expect(snap.invoices.every((f) => (snap.now - f.sentAt) / 86_400_000 <= 120)).toBe(true);
    expect(snap.kpis.staleCount).toBeGreaterThan(0);
  });

  it('never exposes the simulator\'s hidden payment times', async () => {
    const txt = JSON.stringify(snap);
    expect(txt).not.toMatch(/payAt|pay_at|latentT0|trueT/);
  });

  it('the agent can only propose; the server enforces the reminder policy', async () => {
    const early = snap.invoices.find((f) => f.daysToDue > 10)!;
    const blocked = await post('/api/proposals', { invoiceId: early.invoiceId, createdBy: 'agent' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.blockedBy).toBe('policy');
    expect(blocked.body.error).toMatch(/too early/i);

    const ranked = await get<any[]>('/api/rank-nudges?limit=5');
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.expectedGain14d > 0)).toBe(true);
    expect([...ranked].sort((a, b) => b.expectedGain14d - a.expectedGain14d).map((r) => r.invoiceId)).toEqual(ranked.map((r) => r.invoiceId));
  });

  let proposal: Proposal;
  it('proposal -> pending, deduplicated, nothing sent yet', async () => {
    const top = (await get<any[]>('/api/rank-nudges?limit=1'))[0];
    const r = await post('/api/proposals', { invoiceId: top.invoiceId, createdBy: 'agent' });
    expect(r.status).toBe(201);
    proposal = r.body.proposal;
    expect(proposal.status).toBe('pending');
    expect(proposal.effect!.deltaExpected14d).toBeGreaterThan(0);
    const again = await post('/api/proposals', { invoiceId: top.invoiceId, createdBy: 'agent' });
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.proposal.id).toBe(proposal.id);
    const inv = await get<any>(`/api/invoices/${encodeURIComponent(top.invoiceId)}`);
    const sim = app.store.getSimInvoice(top.invoiceId)!;
    expect(sim.remindersApplied).toBe(inv.invoice.reminders.length); // PayPal has not been touched
  });

  it('a human confirms: PayPal sends, the reminder is recorded, and the policy now blocks a repeat', async () => {
    const before = app.store.getInvoice(proposal.invoiceId)!.reminders.length;
    const edit = await post(`/api/proposals/${proposal.id}/confirm`, { note: proposal.note + ' (edited by human)' });
    expect(edit.status).toBe(200);
    expect(edit.body.status).toBe('executed');
    expect(edit.body.note).toMatch(/edited by human/);
    expect(app.store.getInvoice(proposal.invoiceId)!.reminders.length).toBe(before + 1);
    expect(app.store.getSimInvoice(proposal.invoiceId)!.remindersApplied).toBeGreaterThan(0);
    const repeat = await post('/api/proposals', { invoiceId: proposal.invoiceId, createdBy: 'agent' });
    expect(repeat.status).toBe(422);
    expect(repeat.body.error).toMatch(/at least 5 days/);
    const twice = await post(`/api/proposals/${proposal.id}/confirm`, {});
    expect(twice.status).toBe(409);
  });

  it('rejecting a proposal sends nothing', async () => {
    const next = (await get<any[]>('/api/rank-nudges?limit=3'))[0];
    const remindersBefore = app.store.getInvoice(next.invoiceId)!.reminders.length;
    const r = await post('/api/proposals', { invoiceId: next.invoiceId, createdBy: 'user' });
    const rej = await post(`/api/proposals/${r.body.proposal.id}/reject`);
    expect(rej.body.status).toBe('rejected');
    expect(app.store.getInvoice(next.invoiceId)!.reminders.length).toBe(remindersBefore);
    expect(app.store.getSimInvoice(next.invoiceId)!.remindersApplied).toBe(remindersBefore);
    const confirmAfter = await post(`/api/proposals/${r.body.proposal.id}/confirm`);
    expect(confirmAfter.status).toBe(409);
  });

  it('advancing the clock settles invoices whose hidden time has arrived and closes the loop in the audit trail', async () => {
    const r = await post('/api/sim/advance', { days: 30 });
    expect(r.status).toBe(200);
    expect(r.body.paid.length).toBeGreaterThan(0);
    const after = await get<Snapshot>('/api/snapshot');
    expect(after.now).toBe(NOW + 30 * 86_400_000);
    const audit = await get<AuditEntry[]>('/api/audit?limit=200');
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['proposal.created', 'proposal.confirmed', 'paypal.reminder-sent', 'proposal.rejected', 'clock.advanced', 'invoice.paid']) expect(actions.has(a), a).toBe(true);
    // audit entries for reminders carry the forecast the decision was based on
    const created = audit.find((a) => a.action === 'proposal.created')!;
    expect((created.detail as any).forecast).toBeTruthy();
  });

  it('validates input and refuses simulator-only controls elsewhere', async () => {
    expect((await post('/api/invoices', { amount: -5, netDays: 30, description: 'x' })).status).toBe(400);
    expect((await post('/api/sim/advance', { days: 1000 })).status).toBe(400);
    expect((await post('/api/paypal/webhook', {})).status).toBe(409);
    const created = await post('/api/invoices', { payerId: 'northwind', amount: 1000, netDays: 14, description: 'Test invoice' });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^SIM-INV2-/);
    expect((await post(`/api/dev/pay/SYN-NORTHWIND-1`)).status).toBe(404);
  });
});

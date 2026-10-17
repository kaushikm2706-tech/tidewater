import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, DataSource, Invoice, InvoiceStatus, Payer, Proposal } from '../shared/types';

export interface SimInvoiceRow {
  id: string;
  number: string;
  payerId: string;
  payerEmail: string;
  payerName: string;
  amount: number;
  currency: string;
  netDays: number;
  sentAt: number;
  dueAt: number;
  status: InvoiceStatus;
  paidAt: number | null;
  /** hidden ground truth: absolute payment time (ms) or null for a ghost; never exposed through the API */
  payAt: number | null;
  kappa: number;
  remindersApplied: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payers (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, number TEXT NOT NULL, payer_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL,
  net_days INTEGER NOT NULL, sent_at INTEGER NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL,
  paid_at INTEGER, source TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL, sent_at INTEGER NOT NULL, source TEXT NOT NULL,
  note TEXT, proposal_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_inv ON reminders(invoice_id);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, subject TEXT NOT NULL, note TEXT NOT NULL, created_by TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, executed_at INTEGER, reason TEXT NOT NULL,
  before_json TEXT NOT NULL, effect_json TEXT, result TEXT, policy_note TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  invoice_id TEXT, detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sim_invoices (
  id TEXT PRIMARY KEY, number TEXT NOT NULL, payer_id TEXT NOT NULL, payer_email TEXT NOT NULL, payer_name TEXT NOT NULL,
  amount REAL NOT NULL, currency TEXT NOT NULL, net_days INTEGER NOT NULL, sent_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
  status TEXT NOT NULL, paid_at INTEGER, pay_at INTEGER, kappa REAL NOT NULL, reminders_applied INTEGER NOT NULL DEFAULT 0
);
`;

/** All SQL lives here. node:sqlite is built into Node >= 22.13 (still flagged experimental upstream). */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- meta
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- payers
  upsertPayer(p: Payer) {
    this.db
      .prepare('INSERT INTO payers(id, name, email, synthetic) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, synthetic=excluded.synthetic')
      .run(p.id, p.name, p.email, p.synthetic ? 1 : 0);
  }
  getPayers(): Payer[] {
    return (this.db.prepare('SELECT id, name, email, synthetic FROM payers ORDER BY name').all() as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      synthetic: !!r.synthetic,
    }));
  }
  findPayerByEmail(email: string): Payer | null {
    const r = this.db.prepare('SELECT id, name, email, synthetic FROM payers WHERE lower(email) = lower(?)').get(email) as any;
    return r ? { id: r.id, name: r.name, email: r.email, synthetic: !!r.synthetic } : null;
  }

  // ---- invoices
  upsertInvoice(inv: Omit<Invoice, 'reminders'>) {
    this.db
      .prepare(
        `INSERT INTO invoices(id, number, payer_id, amount, currency, net_days, sent_at, due_at, status, paid_at, source, synthetic)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET number=excluded.number, payer_id=excluded.payer_id, amount=excluded.amount,
           currency=excluded.currency, net_days=excluded.net_days, sent_at=excluded.sent_at, due_at=excluded.due_at,
           status=excluded.status, paid_at=excluded.paid_at, source=excluded.source, synthetic=excluded.synthetic`,
      )
      .run(inv.id, inv.number, inv.payerId, inv.amount, inv.currency, inv.netDays, inv.sentAt, inv.dueAt, inv.status, inv.paidAt, inv.source, inv.synthetic ? 1 : 0);
  }
  getInvoices(): Invoice[] {
    const rows = this.db.prepare('SELECT * FROM invoices ORDER BY sent_at').all() as any[];
    const rem = this.db.prepare('SELECT invoice_id, sent_at FROM reminders ORDER BY sent_at').all() as any[];
    const byInv = new Map<string, number[]>();
    for (const r of rem) {
      const arr = byInv.get(r.invoice_id) ?? [];
      arr.push(r.sent_at);
      byInv.set(r.invoice_id, arr);
    }
    return rows.map((r) => this.toInvoice(r, byInv.get(r.id) ?? []));
  }
  getInvoice(id: string): Invoice | null {
    const r = this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
    if (!r) return null;
    const rem = (this.db.prepare('SELECT sent_at FROM reminders WHERE invoice_id = ? ORDER BY sent_at').all(id) as any[]).map((x) => x.sent_at as number);
    return this.toInvoice(r, rem);
  }
  findInvoiceByNumber(n: string): Invoice | null {
    const r = this.db.prepare('SELECT id FROM invoices WHERE number = ?').get(n) as any;
    return r ? this.getInvoice(r.id) : null;
  }
  private toInvoice(r: any, reminders: number[]): Invoice {
    return {
      id: r.id,
      number: r.number,
      payerId: r.payer_id,
      amount: r.amount,
      currency: r.currency,
      netDays: r.net_days,
      sentAt: r.sent_at,
      dueAt: r.due_at,
      status: r.status as InvoiceStatus,
      paidAt: r.paid_at ?? null,
      source: r.source as DataSource,
      synthetic: !!r.synthetic,
      reminders,
    };
  }
  countInvoices(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as any).n as number;
  }

  // ---- reminders
  addReminder(invoiceId: string, sentAt: number, source: string, note: string | null, proposalId: string | null) {
    this.db.prepare('INSERT INTO reminders(invoice_id, sent_at, source, note, proposal_id) VALUES(?,?,?,?,?)').run(invoiceId, sentAt, source, note, proposalId);
  }

  // ---- proposals
  insertProposal(p: Proposal) {
    this.db
      .prepare(
        `INSERT INTO proposals(id, invoice_id, subject, note, created_by, status, created_at, decided_at, executed_at, reason, before_json, effect_json, result, policy_note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.id, p.invoiceId, p.subject, p.note, p.createdBy, p.status, p.createdAt, p.decidedAt, p.executedAt, p.reason, JSON.stringify(p.before), p.effect ? JSON.stringify(p.effect) : null, p.result, p.policyNote);
  }
  updateProposal(id: string, patch: Partial<Pick<Proposal, 'status' | 'decidedAt' | 'executedAt' | 'result' | 'policyNote' | 'subject' | 'note'>>) {
    const cols: string[] = [];
    const vals: any[] = [];
    const map: Record<string, string> = { status: 'status', decidedAt: 'decided_at', executedAt: 'executed_at', result: 'result', policyNote: 'policy_note', subject: 'subject', note: 'note' };
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${map[k]} = ?`);
      vals.push(v ?? null);
    }
    if (!cols.length) return;
    this.db.prepare(`UPDATE proposals SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  getProposalRows(limit = 100): any[] {
    return this.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
  }
  getProposalRow(id: string): any | null {
    return (this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as any) ?? null;
  }
  pendingProposalForInvoice(invoiceId: string): any | null {
    return (this.db.prepare("SELECT * FROM proposals WHERE invoice_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(invoiceId) as any) ?? null;
  }

  // ---- audit
  addAudit(ts: number, actor: string, action: string, invoiceId: string | null, detail: Record<string, unknown>) {
    this.db.prepare('INSERT INTO audit(ts, actor, action, invoice_id, detail_json) VALUES(?,?,?,?,?)').run(ts, actor, action, invoiceId, JSON.stringify(detail));
  }
  getAudit(limit = 200): AuditEntry[] {
    return (this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      invoiceId: r.invoice_id ?? null,
      detail: JSON.parse(r.detail_json),
    }));
  }

  // ---- simulator "remote" invoices (what PayPal would hold, plus hidden ground truth)
  insertSimInvoice(r: SimInvoiceRow) {
    this.db
      .prepare(
        `INSERT INTO sim_invoices(id, number, payer_id, payer_email, payer_name, amount, currency, net_days, sent_at, due_at, status, paid_at, pay_at, kappa, reminders_applied)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(r.id, r.number, r.payerId, r.payerEmail, r.payerName, r.amount, r.currency, r.netDays, r.sentAt, r.dueAt, r.status, r.paidAt, r.payAt, r.kappa, r.remindersApplied);
  }
  getSimInvoices(): SimInvoiceRow[] {
    return (this.db.prepare('SELECT * FROM sim_invoices ORDER BY sent_at').all() as any[]).map((r) => this.toSim(r));
  }
  getSimInvoice(id: string): SimInvoiceRow | null {
    const r = this.db.prepare('SELECT * FROM sim_invoices WHERE id = ?').get(id) as any;
    return r ? this.toSim(r) : null;
  }
  updateSimInvoice(id: string, patch: Partial<Pick<SimInvoiceRow, 'status' | 'paidAt' | 'payAt' | 'remindersApplied'>>) {
    const map: Record<string, string> = { status: 'status', paidAt: 'paid_at', payAt: 'pay_at', remindersApplied: 'reminders_applied' };
    const cols: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${map[k]} = ?`);
      vals.push(v ?? null);
    }
    if (cols.length) this.db.prepare(`UPDATE sim_invoices SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  private toSim(r: any): SimInvoiceRow {
    return {
      id: r.id,
      number: r.number,
      payerId: r.payer_id,
      payerEmail: r.payer_email,
      payerName: r.payer_name,
      amount: r.amount,
      currency: r.currency,
      netDays: r.net_days,
      sentAt: r.sent_at,
      dueAt: r.due_at,
      status: r.status as InvoiceStatus,
      paidAt: r.paid_at ?? null,
      payAt: r.pay_at ?? null,
      kappa: r.kappa,
      remindersApplied: r.reminders_applied,
    };
  }

  /** Wipe everything (used by reseed). */
  reset() {
    this.db.exec('DELETE FROM payers; DELETE FROM invoices; DELETE FROM reminders; DELETE FROM proposals; DELETE FROM audit; DELETE FROM meta; DELETE FROM sim_invoices;');
  }
}

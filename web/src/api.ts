import type { AuditEntry, BacktestReport, NudgeSimulation, Proposal, Snapshot } from '@shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new ApiError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
  return body as T;
}
const post = <T>(path: string, body?: unknown) => j<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export interface RankedNudge {
  invoiceId: string;
  number: string;
  payerName: string;
  amount: number;
  currency: string;
  daysToDue: number;
  probPaid14dBefore: number;
  probPaid14dAfter: number;
  expectedGain14d: number;
  ghostProb: number;
  why: string;
}

export interface InvoiceCurve {
  invoiceId: string;
  horizon: number;
  daysToDue: number;
  ghostProb: number;
  kappa: number;
  kappaBasis: 'estimated' | 'prior';
  points: { k: number; cdf: number; cdfNudged: number }[];
}

export const api = {
  snapshot: (scenario: string[] = []) => j<Snapshot>(`/api/snapshot${scenario.length ? `?scenario=${encodeURIComponent(scenario.join(','))}` : ''}`),
  curve: (id: string) => j<InvoiceCurve>(`/api/invoices/${encodeURIComponent(id)}/curve`),
  rank: (limit = 8) => j<RankedNudge[]>(`/api/rank-nudges?limit=${limit}`),
  simulate: (invoiceIds: string[]) => post<NudgeSimulation>('/api/simulate-nudge', { invoiceIds }),
  propose: (invoiceId: string, createdBy: 'agent' | 'user' = 'user', extra: { subject?: string; note?: string; reason?: string } = {}) =>
    post<{ proposal: Proposal; deduplicated: boolean }>('/api/proposals', { invoiceId, createdBy, ...extra }),
  confirm: (id: string, edits: { subject?: string; note?: string } = {}) => post<Proposal>(`/api/proposals/${id}/confirm`, edits),
  reject: (id: string) => post<Proposal>(`/api/proposals/${id}/reject`),
  audit: (limit = 100) => j<AuditEntry[]>(`/api/audit?limit=${limit}`),
  createInvoice: (b: { payerId?: string; payerName?: string; payerEmail?: string; amount: number; netDays: number; description: string }) => post<{ id: string }>('/api/invoices', b),
  pay: (id: string) => post<{ ok: true }>(`/api/dev/pay/${encodeURIComponent(id)}`),
  advance: (days: number) => post<{ now: number; paid: string[] }>('/api/sim/advance', { days }),
  reseed: () => post<{ invoices?: number }>('/api/admin/reseed'),
  backtest: () => j<{ reports: BacktestReport[]; nudge: { truth: number; estimate: number; lo: number; hi: number }[] }>('/api/model/backtest'),
  llmStatus: () => j<{ configured: boolean; model: string | null }>('/api/llm/status'),
};

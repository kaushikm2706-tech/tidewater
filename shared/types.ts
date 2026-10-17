/** Types shared by the server and the web app. Plain data only: no behaviour lives here. */

export type DataSource = 'sim' | 'paypal-sandbox' | 'synthetic-history';

export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'MARKED_AS_PAID'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface Payer {
  id: string;
  name: string;
  email: string;
  synthetic: boolean;
}

export interface Invoice {
  id: string;
  number: string;
  payerId: string;
  amount: number;
  currency: string;
  netDays: number;
  sentAt: number; // epoch ms
  dueAt: number; // epoch ms
  status: InvoiceStatus;
  paidAt: number | null;
  source: DataSource;
  synthetic: boolean;
  reminders: number[]; // epoch ms of reminders actually sent
}

/** Quantiles of the payment time, as epoch ms (null when the quantile lies in the "never pays" mass). */
export interface QuantileSet {
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export interface InvoiceForecast {
  invoiceId: string;
  number: string;
  payerId: string;
  payerName: string;
  amount: number;
  currency: string;
  netDays: number;
  sentAt: number;
  dueAt: number;
  elapsedDays: number;
  daysToDue: number;
  quantiles: QuantileSet;
  /** Expected days past due at the median (negative = early). */
  medianLatenessDays: number | null;
  /** p90 - p10 of the payment date, in days: how unsure we are. */
  spreadDays: number | null;
  probPaidByDue: number;
  probPaid7d: number;
  probPaid14d: number;
  probPaid30d: number;
  ghostProb: number;
  /** 0..1 blend of lateness and non-payment risk used for colour. */
  risk: number;
  remindersSent: number;
  lastReminderAt: number | null;
  source: DataSource;
}

export interface TidePoint {
  day: string; // YYYY-MM-DD
  dayIndex: number;
  /** cumulative expected cash collected by end of this day */
  expected: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** cumulative amount the invoices say is due by this day (the naive "due date" forecast) */
  naive: number;
  /** cumulative expected cash if the proposed nudges were sent now (null when no scenario) */
  scenario: number | null;
}

export interface NudgeEffect {
  /** multiplicative factor on remaining time-to-pay after a reminder (1 = no effect) */
  kappa: number;
  lo: number;
  hi: number;
  nObs: number;
  /** how it was obtained */
  basis: 'estimated' | 'prior';
}

export interface ModelSummary {
  fittedAt: number;
  nInvoices: number;
  nEvents: number;
  nCensored: number;
  nGhostLabelled: number;
  nPayers: number;
  iterations: number;
  converged: boolean;
  logLik: number;
  populationMedianDays: number;
  populationSigma: number;
  ghostBase: number;
  betaTerms: number;
  betaAmount: number;
  nudge: NudgeEffect;
  syntheticShare: number;
}

export interface PayerSummary {
  payerId: string;
  name: string;
  nInvoices: number;
  nPaid: number;
  medianDaysAt30: number;
  sigma: number;
  ghostProb: number;
  openAmount: number;
  openCount: number;
  synthetic: boolean;
}

export interface Kpis {
  outstanding: number;
  openCount: number;
  expected7d: number;
  expected14d: number;
  expected30d: number;
  dueByDate30d: number;
  /** expected30d - dueByDate30d : how much the due dates over-promise (negative) or under-promise */
  dueDateGap30d: number;
  atRisk: number;
  atRiskCount: number;
  expectedDaysToCash: number;
  /** unpaid for more than 120 days: held out of the forecast and treated as non-paying */
  staleCount: number;
  staleAmount: number;
  currency: string;
}

export interface Snapshot {
  now: number;
  mode: AppMode;
  invoices: InvoiceForecast[];
  tide: TidePoint[];
  payers: PayerSummary[];
  kpis: Kpis;
  model: ModelSummary;
  proposals: Proposal[];
  generatedAt: number;
}

export interface AppMode {
  paypal: 'simulator' | 'sandbox';
  paypalConfigured: boolean;
  llm: 'configured' | 'offline-planner';
  llmModel: string | null;
  clock: 'virtual' | 'real';
  syntheticHistory: boolean;
  version: string;
}

export type ProposalStatus = 'pending' | 'confirmed' | 'executed' | 'rejected' | 'failed' | 'blocked';

export interface NudgeSimulation {
  invoiceIds: string[];
  kappa: number;
  kappaBasis: 'estimated' | 'prior';
  repeatAssumption: boolean;
  deltaExpected7d: number;
  deltaExpected14d: number;
  deltaExpected30d: number;
  perInvoice: {
    invoiceId: string;
    number: string;
    payerName: string;
    amount: number;
    deltaP14: number;
    deltaExpected14d: number;
    medianBefore: number | null;
    medianAfter: number | null;
  }[];
  tide: TidePoint[];
}

export interface Proposal {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  payerName: string;
  amount: number;
  currency: string;
  subject: string;
  note: string;
  createdBy: 'agent' | 'user';
  status: ProposalStatus;
  createdAt: number;
  decidedAt: number | null;
  executedAt: number | null;
  reason: string;
  /** forecast at the time of proposal */
  before: { median: number | null; probPaid14d: number; ghostProb: number };
  /** modelled effect of sending it */
  effect: { deltaP14: number; deltaExpected14d: number; kappa: number; basis: 'estimated' | 'prior' } | null;
  result: string | null;
  policyNote: string | null;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  invoiceId: string | null;
  detail: Record<string, unknown>;
}

export interface BacktestReport {
  generatedAt: number;
  scenario: string;
  description: string;
  nTrain: number;
  nTest: number;
  coverage: { nominal: number; observed: number }[];
  pitHistogram: number[];
  pinball: { model: number; payerMedianBaseline: number; globalBaseline: number; dueDateBaseline: number };
  maeMedianDays: { model: number; payerMedianBaseline: number; globalBaseline: number; dueDateBaseline: number };
  kappa: { truth: number; estimate: number; lo: number; hi: number } | null;
  ghost?: { meanPredicted: number; observed: number; brierModel: number; brierBaseRate: number; n: number };
  notes: string[];
}

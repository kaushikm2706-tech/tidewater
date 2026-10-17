import type { InvoiceStatus } from '../../shared/types';

export interface NewInvoiceInput {
  number: string;
  payerEmail: string;
  payerName: string;
  /** stable local payer id (used by the simulator to look up payer behaviour) */
  payerId: string;
  amount: number;
  currency: string;
  netDays: number;
  description: string;
}

export interface RemoteInvoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  amount: number;
  currency: string;
  /** invoice date, epoch ms (UTC midnight for PayPal, which only stores a date) */
  sentAt: number;
  dueAt: number;
  paidAt: number | null;
  payerEmail: string;
  payerName: string;
}

export interface ReminderInput {
  subject: string;
  note: string;
}

/**
 * Everything Tidewater needs from PayPal, and nothing more. Two implementations:
 *  - LivePayPal: PayPal Invoicing v2 against the *sandbox* REST API
 *  - SimPayPal : an in-process simulator with hidden synthetic payer behaviour
 * Both are exercised by the same service code, so the live path is never a special case.
 */
export interface PayPalPort {
  readonly kind: 'simulator' | 'sandbox';
  createAndSend(input: NewInvoiceInput): Promise<RemoteInvoice>;
  remind(invoiceId: string, input: ReminderInput): Promise<{ at: number }>;
  /** Marks an invoice paid (sandbox: "record payment"; simulator: the payer pays now). */
  recordPayment(invoiceId: string): Promise<void>;
  getInvoice(invoiceId: string): Promise<RemoteInvoice>;
  listInvoices(): Promise<RemoteInvoice[]>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId: string | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}

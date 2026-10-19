import type { NextFunction, Request, Response } from 'express';

/**
 * Small in-memory limiters for the public demo. They protect the LLM key's quota and the shared
 * simulator from being hammered. State lives in the process, so it resets on restart; that is fine
 * for a single-instance demo and is not a substitute for a provider-side spend limit.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface LimiterOptions {
  windowMs: number;
  max: number;
  message: string;
  /** Which requests count. Default: every request that reaches the middleware. */
  applies?: (req: Request) => boolean;
  now?: () => number;
}

export function rateLimit(opts: LimiterOptions) {
  const buckets = new Map<string, Bucket>();
  const now = opts.now ?? Date.now;
  return (req: Request, res: Response, next: NextFunction) => {
    if (opts.max <= 0 || (opts.applies && !opts.applies(req))) return next();
    const t = now();
    if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
    const key = req.ip ?? 'unknown';
    let b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > opts.max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((b.resetAt - t) / 1000))));
      return res.status(429).json({ error: opts.message });
    }
    next();
  };
}

/** A global per-UTC-day budget, e.g. for how many LLM calls the demo will make in total. */
export class DailyCap {
  private day = '';
  private used = 0;
  constructor(readonly limit: number, private now: () => number = Date.now) {}
  /** Returns true if the call is allowed (and counts it). A limit of 0 or less means unlimited. */
  take(): boolean {
    if (this.limit <= 0) return true;
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
  get remaining() {
    return this.limit <= 0 ? Infinity : Math.max(0, this.limit - this.used);
  }
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

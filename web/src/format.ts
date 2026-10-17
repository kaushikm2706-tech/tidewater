export const usd = (n: number, currency = 'USD', compact = false) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: compact ? 1 : 0, notation: compact ? 'compact' : 'standard' }).format(n);
export const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
export const day = (ms: number | null | undefined) => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 10));
export const dayShort = (ms: number | null | undefined) => (ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
export const signed = (n: number, f: (x: number) => string) => (n >= 0 ? '+' : '−') + f(Math.abs(n));
export const ago = (ms: number, now: number) => {
  const d = (now - ms) / 86_400_000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)}d ago`;
};

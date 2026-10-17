/**
 * Numerical primitives for the forecaster. Every function here is checked against
 * Python's `math.erfc` / `statistics.NormalDist` in `tests/math.test.ts`.
 */

const SQRT2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const SQRT_PI = Math.sqrt(Math.PI);

/** Complementary error function. Series below 2.5, Lentz continued fraction above. */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 2 - erfc(-x);
  if (x === 0) return 1;
  if (x < 2.5) {
    // Maclaurin series for erf, then erfc = 1 - erf. Alternating and well conditioned below 2.5.
    let term = x;
    let sum = x;
    const x2 = x * x;
    for (let n = 1; n < 120; n++) {
      term *= -x2 / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return 1 - (2 / SQRT_PI) * sum;
  }
  if (x > 27) return 0;
  // erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + (1/2)/(x + (2/2)/(x + (3/2)/(x + ...))))
  const tiny = 1e-300;
  let f = x;
  let C = x;
  let D = 0;
  for (let k = 1; k < 500; k++) {
    const a = k / 2;
    D = x + a * D;
    if (D === 0) D = tiny;
    C = x + a / C;
    if (C === 0) C = tiny;
    D = 1 / D;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x * x) / (SQRT_PI * f);
}

/** Standard normal CDF. */
export function normCdf(z: number): number {
  return 0.5 * erfc(-z / SQRT2);
}

/** Standard normal survival function 1 - Phi(z); keeps relative precision in the upper tail. */
export function normSf(z: number): number {
  return 0.5 * erfc(z / SQRT2);
}

export function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

/** Inverse survival function: z such that normSf(z) = t, for t in (0, 1). */
export function normIsf(t: number): number {
  if (!(t > 0)) return Infinity;
  if (!(t < 1)) return -Infinity;
  if (t === 0.5) return 0;
  if (t > 0.5) return -normIsfSmall(1 - t);
  return normIsfSmall(t);
}

/** Halley iteration on f(z) = ln Q(z) - ln t, which stays accurate deep in the tail. */
function normIsfSmall(t: number): number {
  const s = Math.sqrt(-2 * Math.log(t));
  // rough starting point (rational tail approximation), refined below
  let z = s - (2.515517 + 0.802853 * s + 0.010328 * s * s) / (1 + 1.432788 * s + 0.189269 * s * s + 0.001308 * s * s * s);
  for (let i = 0; i < 30; i++) {
    const q = normSf(z);
    if (q <= 0) {
      z -= 0.5;
      continue;
    }
    const pdf = normPdf(z);
    const f = Math.log(q) - Math.log(t);
    const fp = -pdf / q;
    const fpp = (z * pdf * q - pdf * pdf) / (q * q);
    const step = (f * fp) / (fp * fp - 0.5 * f * fpp);
    z -= step;
    if (Math.abs(step) < 1e-13 * Math.max(1, Math.abs(z))) break;
  }
  return z;
}

/** Inverse CDF (probit). */
export function normPpf(p: number): number {
  return -normIsf(p);
}

/** Mean and variance of y | y > c for y ~ N(m, s^2). */
export function truncatedBelowMoments(m: number, s: number, c: number): { mean: number; variance: number } {
  const alpha = (c - m) / s;
  const sf = normSf(alpha);
  const lambda = sf < 1e-300 ? alpha + 1 / alpha : normPdf(alpha) / sf;
  const mean = m + s * lambda;
  const variance = s * s * Math.max(1e-9, 1 + alpha * lambda - lambda * lambda);
  return { mean, variance };
}

/** Seeded PRNG (mulberry32): deterministic and fast; used by the generator and Monte Carlo. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0;
    while (u === 0) u = next();
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, gauss };
}

export type Rng = ReturnType<typeof makeRng>;

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const DAY_MS = 86_400_000;

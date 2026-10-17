import { describe, expect, it } from 'vitest';
import { erfc, normCdf, normIsf, normPpf, makeRng, truncatedBelowMoments, quantile } from '../server/forecast/math';

// Reference values were generated with Python 3 (`math.erfc`, `statistics.NormalDist`).
const ERFC: [number, number][] = [
  [0.0, 1.0], [0.1, 0.8875370839817152], [0.5, 0.4795001221869535], [1, 0.15729920705028513],
  [1.7, 0.016209541409225436], [2.4, 0.0006885138966450789], [2.5, 0.0004069520174449589],
  [2.6, 0.00023603441652934908], [3, 2.2090496998585438e-05], [4, 1.541725790028002e-08],
  [5, 1.5374597944280351e-12], [6, 2.1519736712498916e-17], [8, 1.1224297172982928e-29],
  [10, 2.088487583762545e-45], [15, 7.212994172451206e-100], [20, 5.3958656116079005e-176],
];
const ISF: [number, number][] = [
  [0.3, 0.5244005127080407], [0.1, 1.2815515655446008], [0.01, 2.3263478740408408],
  [1e-4, 3.71901648545568], [1e-6, 4.753424308822899], [1e-9, 5.9978070150076865],
  [1e-12, 7.034483825301132], [1e-15, 7.941345326170995], [0.7, -0.5244005127080407],
  [0.9, -1.2815515655446008], [0.99, -2.3263478740408408],
];
const CDF: [number, number][] = [
  [-5, 2.8665157186802404e-07], [-3, 0.0013498980316301035], [-1, 0.15865525393145707], [0, 0.5],
  [0.5, 0.6914624612740131], [1.96, 0.9750021048517796], [3, 0.9986501019683699],
];

const relErr = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

describe('erfc', () => {
  it.each(ERFC)('matches Python at x=%s', (x, ref) => {
    expect(relErr(erfc(x), ref)).toBeLessThan(1e-9);
  });
  it('is symmetric: erfc(-x) = 2 - erfc(x)', () => {
    expect(erfc(-1.3)).toBeCloseTo(2 - erfc(1.3), 12);
  });
});

describe('normal distribution', () => {
  it.each(CDF)('cdf(%s)', (z, ref) => {
    expect(relErr(normCdf(z), ref)).toBeLessThan(1e-9);
  });
  it.each(ISF)('isf(%s)', (t, ref) => {
    expect(Math.abs(normIsf(t) - ref)).toBeLessThan(1e-7);
  });
  it('ppf inverts cdf on a grid', () => {
    for (let p = 0.001; p < 1; p += 0.0173) {
      expect(Math.abs(normCdf(normPpf(p)) - p)).toBeLessThan(1e-10);
    }
  });
});

describe('truncated normal moments', () => {
  it('matches a Monte Carlo estimate', () => {
    const rng = makeRng(7);
    const m = 1.2, s = 0.8, c = 1.9;
    const xs: number[] = [];
    while (xs.length < 200000) {
      const y = m + s * rng.gauss();
      if (y > c) xs.push(y);
    }
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length;
    const t = truncatedBelowMoments(m, s, c);
    expect(Math.abs(t.mean - mu)).toBeLessThan(0.01);
    expect(Math.abs(t.variance - v)).toBeLessThan(0.01);
  });
  it('stays finite far into the tail', () => {
    const t = truncatedBelowMoments(0, 1, 40);
    expect(Number.isFinite(t.mean)).toBe(true);
    expect(t.variance).toBeGreaterThan(0);
  });
});

describe('rng and quantile', () => {
  it('is deterministic for a seed', () => {
    const a = makeRng(42), b = makeRng(42);
    for (let i = 0; i < 5; i++) expect(a.next()).toBe(b.next());
  });
  it('gaussian has ~zero mean and unit variance', () => {
    const r = makeRng(3);
    const xs = Array.from({ length: 100000 }, () => r.gauss());
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length;
    expect(Math.abs(mu)).toBeLessThan(0.02);
    expect(Math.abs(v - 1)).toBeLessThan(0.03);
  });
  it('quantile interpolates', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });
});

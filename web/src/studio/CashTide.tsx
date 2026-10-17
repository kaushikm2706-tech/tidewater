import React from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { useMappedRows, useSize } from './useRows';
import { usd } from '../format';

export const CASH_TIDE_FIELDS = ['dayIndex', 'expected', 'p10', 'p25', 'p75', 'p90', 'naive', 'scenario'] as const;

interface Pt { i: number; expected: number; p10: number; p25: number; p75: number; p90: number; naive: number; scenario: number | null }

const C = { teal: '#2dd4bf', tealSoft: '#14b8a6', amber: '#fbbf24', slate: '#7c8aa5', grid: 'rgba(148,163,184,.12)', text: '#9fb0c8', bright: '#e6f1ff', coral: '#fb7185' };

function monotone(pts: [number, number][]): string {
  return pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
}

export function CashTide(props: AgWidgetParams<any>) {
  const { rows, keys, error, ready } = useMappedRows(props, CASH_TIDE_FIELDS);
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);

  const data: Pt[] = React.useMemo(() => {
    const out: Pt[] = rows.map((r) => ({
      i: Number(r[keys.dayIndex]),
      expected: Number(r[keys.expected] ?? 0),
      p10: Number(r[keys.p10] ?? 0),
      p25: Number(r[keys.p25] ?? 0),
      p75: Number(r[keys.p75] ?? 0),
      p90: Number(r[keys.p90] ?? 0),
      naive: Number(r[keys.naive] ?? 0),
      scenario: keys.scenario && r[keys.scenario] != null ? Number(r[keys.scenario]) : null,
    }));
    return out.filter((p) => Number.isFinite(p.i)).sort((a, b) => a.i - b.i);
  }, [rows, keys]);

  if (error) return <div className="tw-widget-msg">Cash Tide could not read its data: {error}</div>;
  if (!ready || !data.length || w < 80 || h < 60) return <div ref={ref} className="tw-widget-fill">{ready && !data.length ? <div className="tw-widget-msg">No open invoices to forecast.</div> : null}</div>;

  const m = { l: 56, r: 22, t: 14, b: 46 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const n = data.length;
  const maxI = data[n - 1].i;
  const hasScenario = data.some((d) => d.scenario !== null);
  const rawMax = Math.max(...data.map((d) => Math.max(d.p90, d.naive, d.scenario ?? 0)), 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const niceMax = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((f) => f * mag).find((v) => v >= rawMax * 1.02) ?? rawMax;
  const ymax = niceMax;
  const X = (i: number) => m.l + (i / maxI) * iw;
  const Y = (v: number) => m.t + ih - (v / ymax) * ih;

  const line = (get: (d: Pt) => number) => monotone(data.map((d) => [X(d.i), Y(get(d))]));
  const band = (lo: (d: Pt) => number, hi: (d: Pt) => number) =>
    `${data.map((d, k) => `${k ? 'L' : 'M'}${X(d.i).toFixed(1)},${Y(hi(d)).toFixed(1)}`).join('')}${[...data].reverse().map((d) => `L${X(d.i).toFixed(1)},${Y(lo(d)).toFixed(1)}`).join('')}Z`;
  const step = data.map((d, k) => `${k ? `L${X(d.i).toFixed(1)},${Y(data[k - 1].naive).toFixed(1)}` : 'M' + X(d.i).toFixed(1) + ',' + Y(d.naive).toFixed(1)}L${X(d.i).toFixed(1)},${Y(d.naive).toFixed(1)}`).join('');

  const yTicks = Array.from({ length: 5 }, (_, k) => ymax * (k / 4));
  const xTicks = [0, 15, 30, 45, 60, 75].filter((t) => t <= maxI);
  const gapAt = data.find((d) => d.i === Math.min(30, maxI)) ?? data[n - 1];
  const gap = gapAt.expected - gapAt.naive;
  const hv = hover !== null ? data[Math.min(n - 1, Math.max(0, hover))] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left - m.l;
    setHover(Math.round((x / iw) * maxI));
  };

  return (
    <div ref={ref} className="tw-widget-fill">
      <svg width={w} height={h} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Cumulative expected cash collected with uncertainty band">
        <defs>
          <linearGradient id="tw-band-outer" x1="0" x2="1">
            <stop offset="0" stopColor={C.teal} stopOpacity=".10" />
            <stop offset="1" stopColor={C.tealSoft} stopOpacity=".22" />
          </linearGradient>
          <linearGradient id="tw-band-inner" x1="0" x2="1">
            <stop offset="0" stopColor={C.teal} stopOpacity=".18" />
            <stop offset="1" stopColor={C.teal} stopOpacity=".42" />
          </linearGradient>
          <linearGradient id="tw-shimmer" x1={m.l} x2={m.l + iw * 0.45} y1="0" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff" stopOpacity=".28" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
            <animateTransform attributeName="gradientTransform" type="translate" from={`${-iw * 0.6} 0`} to={`${iw * 1.1} 0`} dur="5.5s" repeatCount="indefinite" />
          </linearGradient>
          <filter id="tw-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <clipPath id="tw-clip"><rect x={m.l} y={m.t - 4} width={iw} height={ih + 8} /></clipPath>
        </defs>

        {yTicks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + iw} y1={Y(t)} y2={Y(t)} stroke={C.grid} />
            <text x={m.l - 8} y={Y(t) + 4} textAnchor="end" fontSize="10.5" fill={C.text}>{usd(t, 'USD', true)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}>
            <line x1={X(t)} x2={X(t)} y1={m.t} y2={m.t + ih} stroke={C.grid} strokeDasharray="2 5" />
            <text x={X(t)} y={h - 28} textAnchor="middle" fontSize="10.5" fill={C.text}>{t === 0 ? 'today' : `+${t}d`}</text>
          </g>
        ))}

        <g clipPath="url(#tw-clip)">
          <path d={band((d) => d.p10, (d) => d.p90)} fill="url(#tw-band-outer)" />
          <path d={band((d) => d.p25, (d) => d.p75)} fill="url(#tw-band-inner)" />
          <path d={band((d) => d.p25, (d) => d.p75)} fill="url(#tw-shimmer)" style={{ mixBlendMode: 'screen' }} />
          <path d={line((d) => d.p90)} fill="none" stroke={C.teal} strokeOpacity=".35" strokeWidth="1" />
          <path d={line((d) => d.p10)} fill="none" stroke={C.teal} strokeOpacity=".35" strokeWidth="1" />
          <path d={step} fill="none" stroke={C.slate} strokeWidth="1.5" strokeDasharray="5 4" />
          {hasScenario && (
            <>
              <path d={`${line((d) => d.scenario ?? d.expected)}${[...data].reverse().map((d) => `L${X(d.i).toFixed(1)},${Y(d.expected).toFixed(1)}`).join('')}Z`} fill={C.amber} fillOpacity=".16" />
              <path className="tw-draw" pathLength={1} d={line((d) => d.scenario ?? d.expected)} fill="none" stroke={C.amber} strokeWidth="2.2" filter="url(#tw-glow)" />
            </>
          )}
          <path className="tw-draw" pathLength={1} d={line((d) => d.expected)} fill="none" stroke={C.bright} strokeWidth="2.4" filter="url(#tw-glow)" />
        </g>

        {gap < -1 && (() => {
          const label = `due dates over-promise ${usd(-gap, 'USD', true)} by day ${gapAt.i}`;
          const room = X(gapAt.i) - m.l;
          const left = room > 250;
          return (
            <g>
              <line x1={X(gapAt.i)} x2={X(gapAt.i)} y1={Y(gapAt.naive)} y2={Y(gapAt.expected)} stroke={C.coral} strokeWidth="1.6" />
              <circle cx={X(gapAt.i)} cy={Y(gapAt.naive)} r="3" fill={C.coral} />
              <circle cx={X(gapAt.i)} cy={Y(gapAt.expected)} r="3" fill={C.bright} />
              <text x={X(gapAt.i) + (left ? -8 : 8)} y={(Y(gapAt.naive) + Y(gapAt.expected)) / 2 + 4} textAnchor={left ? 'end' : 'start'} fontSize="11" fontWeight="600" fill={C.coral} paintOrder="stroke" stroke="#0a1322" strokeWidth="4">{label}</text>
            </g>
          );
        })()}

        {hv && (
          <g pointerEvents="none">
            <line x1={X(hv.i)} x2={X(hv.i)} y1={m.t} y2={m.t + ih} stroke="#cfe3ff" strokeOpacity=".5" />
            <circle cx={X(hv.i)} cy={Y(hv.expected)} r="4.5" fill={C.bright} stroke="#0b1423" strokeWidth="2" />
            <Tooltip x={Math.min(X(hv.i) + 12, w - 188)} y={m.t + 4} d={hv} />
          </g>
        )}
      </svg>
      <div className="tw-legend">
        <span><i style={{ background: C.bright }} />expected cash</span>
        <span><i style={{ background: 'rgba(45,212,191,.45)' }} />50% range</span>
        <span><i style={{ background: 'rgba(45,212,191,.2)' }} />80% range</span>
        <span><i style={{ background: C.slate }} />due-date promise</span>
        {hasScenario && <span><i style={{ background: C.amber }} />if nudges sent</span>}
      </div>
    </div>
  );
}

function Tooltip({ x, y, d }: { x: number; y: number; d: Pt }) {
  const rows: [string, string, string?][] = [
    [`Day +${d.i}`, '', C.text],
    ['Expected', usd(d.expected), C.bright],
    ['80% range', `${usd(d.p10, 'USD', true)} – ${usd(d.p90, 'USD', true)}`, C.teal],
    ['Due-date promise', usd(d.naive), C.slate],
  ];
  if (d.scenario !== null) rows.push(['If nudged', usd(d.scenario), C.amber]);
  return (
    <g transform={`translate(${x},${y})`}>
      <rect width="176" height={rows.length * 17 + 12} rx="8" fill="#0a1626" stroke="rgba(148,163,184,.3)" opacity=".96" />
      {rows.map(([a, b, col], k) => (
        <g key={a} transform={`translate(10,${22 + k * 17})`}>
          <text fontSize="11" fill={k === 0 ? C.text : C.text} fontWeight={k === 0 ? 700 : 400}>{a}</text>
          <text x="156" textAnchor="end" fontSize="11" fontWeight="600" fill={col}>{b}</text>
        </g>
      ))}
    </g>
  );
}

import React from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { useMappedRows, useSize } from './useRows';
import { UiBridgeContext } from './context';
import { usd, pct } from '../format';

export const PAYER_ORBIT_FIELDS = ['name', 'days', 'sigma', 'ghost', 'open', 'count', 'payerId'] as const;

interface P { id: string; name: string; days: number; sigma: number; ghost: number; open: number; count: number }

const RINGS = [15, 30, 45, 60, 75];

/** ghost probability -> colour: teal (reliable) .. amber .. coral (may never pay) */
function tone(g: number) {
  const t = Math.min(1, g / 0.2);
  const stops = [[45, 212, 191], [251, 191, 36], [251, 113, 133]];
  const [a, b, f] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

export function PayerOrbit(props: AgWidgetParams<any>) {
  const { rows, keys, error, ready } = useMappedRows(props, PAYER_ORBIT_FIELDS);
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = React.useState<string | null>(null);
  const bridge = React.useContext(UiBridgeContext);
  const [t, setT] = React.useState(0);
  const pausedRef = React.useRef(false);
  pausedRef.current = hover !== null;
  React.useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!pausedRef.current) acc += dt;
      setT(acc);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const payers: P[] = React.useMemo(
    () =>
      rows
        .map((r) => ({
          id: String(r[keys.payerId] ?? r[keys.name]),
          name: String(r[keys.name]),
          days: Number(r[keys.days] ?? 0),
          sigma: Number(r[keys.sigma] ?? 0),
          ghost: Number(r[keys.ghost] ?? 0),
          open: Number(r[keys.open] ?? 0),
          count: Number(r[keys.count] ?? 0),
        }))
        .filter((p) => Number.isFinite(p.days))
        .sort((a, b) => a.days - b.days),
    [rows, keys],
  );

  if (error) return <div className="tw-widget-msg">Payer Orbit could not read its data: {error}</div>;
  if (!ready || !payers.length || w < 80 || h < 80) return <div ref={ref} className="tw-widget-fill" />;

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 26;
  const maxDays = 80;
  const rad = (d: number) => 22 + (Math.min(d, maxDays) / maxDays) * (R - 22);
  const maxOpen = Math.max(1, ...payers.map((p) => p.open));
  const labelled = new Set([...payers].sort((a, b) => b.open - a.open).slice(0, 5).map((p) => p.id));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const placed = payers.map((p, k) => {
    const r = rad(p.days);
    // Kepler-ish: inner orbits turn faster. Angular position is cosmetic; radius is the data.
    const a = -Math.PI / 2 + k * golden * 1.6 + (t * 0.35) / Math.sqrt(1 + p.days / 12);
    const size = 4.5 + 15 * Math.sqrt(p.open / maxOpen);
    // uncertainty halo: radial extent of +/- one sigma on the log scale
    const lo = rad(p.days * Math.exp(-p.sigma));
    const hi = rad(p.days * Math.exp(p.sigma));
    return { p, a, r, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), size, lo, hi };
  });
  const hv = placed.find((q) => q.p.id === hover);

  return (
    <div ref={ref} className="tw-widget-fill">
      <svg width={w} height={h} role="img" aria-label="Payer orbit: each payer's typical days to pay, uncertainty and non-payment risk">
        <defs>
          <radialGradient id="tw-core"><stop offset="0" stopColor="#2dd4bf" stopOpacity=".55" /><stop offset="1" stopColor="#2dd4bf" stopOpacity="0" /></radialGradient>
          <filter id="tw-pglow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <circle cx={cx} cy={cy} r="46" fill="url(#tw-core)" />
        <text x={cx} y={cy + 3} textAnchor="middle" fontSize="10.5" fill="#9fb0c8" letterSpacing=".08em">CASH</text>
        {RINGS.map((d) => (
          <g key={d}>
            <circle cx={cx} cy={cy} r={rad(d)} fill="none" stroke="rgba(148,163,184,.16)" strokeDasharray="1 6" />
            <text x={cx + 4} y={cy - rad(d) - 3} fontSize="9.5" fill="#6f819d">{d}d</text>
          </g>
        ))}
        {placed.map(({ p, a, x, y, size, lo, hi }) => {
          const on = hover === p.id || bridge.selectedPayer === p.id;
          const col = tone(p.ghost);
          const arcFlat = `M${cx + lo * Math.cos(a)},${cy + lo * Math.sin(a)} L${cx + hi * Math.cos(a)},${cy + hi * Math.sin(a)}`;
          return (
            <g key={p.id} style={{ cursor: 'pointer' }} onPointerEnter={() => setHover(p.id)} onPointerLeave={() => setHover(null)} onClick={() => bridge.onSelectPayer?.(bridge.selectedPayer === p.id ? null : p.id)} opacity={hover && !on ? 0.4 : 1}>
              <path d={arcFlat} stroke={col} strokeOpacity=".5" strokeWidth="2" strokeLinecap="round" />
              <circle cx={x} cy={y} r={size} fill={col} fillOpacity=".92" filter="url(#tw-pglow)" stroke={on ? '#fff' : 'none'} strokeWidth="2" />
              {(on || labelled.has(p.id)) && <text x={x} y={y - size - 5} textAnchor="middle" fontSize="10.5" fill={on ? '#fff' : '#b8c7dc'} fontWeight={on ? 700 : 500} paintOrder="stroke" stroke="#0a1322" strokeWidth="3">{p.name.split(' ')[0]}</text>}
            </g>
          );
        })}
        {hv && (
          <g pointerEvents="none" transform={`translate(${w - 200},10)`}>
            <rect width="188" height="98" rx="9" fill="#0a1626" stroke="rgba(148,163,184,.3)" opacity=".97" />
            <text x="12" y="20" fontSize="12" fontWeight="700" fill="#e6f1ff">{hv.p.name}</text>
            <text x="12" y="38" fontSize="11" fill="#9fb0c8">Typical: {hv.p.days.toFixed(0)} days at net-30</text>
            <text x="12" y="54" fontSize="11" fill="#9fb0c8">Spread ×/÷ {Math.exp(hv.p.sigma).toFixed(2)}</text>
            <text x="12" y="70" fontSize="11" fill="#9fb0c8">May never pay: {pct(hv.p.ghost, 1)}</text>
            <text x="12" y="86" fontSize="11" fill="#9fb0c8">Open: {usd(hv.p.open)} · {hv.p.count} inv</text>
          </g>
        )}
      </svg>
      <div className="tw-legend">
        <span><i style={{ background: '#2dd4bf' }} />reliable</span>
        <span><i style={{ background: '#fbbf24' }} />slipping</span>
        <span><i style={{ background: '#fb7185' }} />may never pay</span>
        <span>distance = days to pay · size = open $ · tick = uncertainty</span>
      </div>
    </div>
  );
}

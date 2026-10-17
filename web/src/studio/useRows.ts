import React from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { useDataVersion } from './context';

/**
 * Reads the rows a custom widget is mapped to, through Studio's own data engine (so Studio filters
 * and cross-filters apply). `names` are the data-mapping keys; each must hold exactly one field.
 */
export function useMappedRows(props: AgWidgetParams<any>, names: readonly string[]) {
  const version = useDataVersion();
  const [state, setState] = React.useState<{ rows: Record<string, any>[]; keys: Record<string, string>; error: string | null; ready: boolean }>({ rows: [], keys: {}, error: null, ready: false });
  const mappingSig = names.map((n) => (props.dataMapping as any)[n]?.[0]?.key ?? '').join('|');

  React.useEffect(() => {
    let cancelled = false;
    const fields: any[] = [];
    const keys: Record<string, string> = {};
    for (const n of names) {
      const f = (props.dataMapping as any)[n]?.[0];
      if (f) {
        fields.push(f);
        keys[n] = f.key;
      }
    }
    if (!fields.length) {
      setState({ rows: [], keys, error: null, ready: true });
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await props.widgetApi.getData({ fields });
        if (cancelled) return;
        setState({ rows: res.results.rows as any[], keys, error: null, ready: true });
        props.widgetApi.setDisplayState('displayed');
      } catch (e: any) {
        if (!cancelled) setState({ rows: [], keys, error: String(e?.message ?? e), ready: true });
      }
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappingSig, version]);

  return state;
}

export function useSize<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

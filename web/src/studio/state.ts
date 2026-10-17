/** The shipped report: a finished dashboard on first load. Everything is plain JSON (Studio's own state format). */
const kpi = (id: string, field: string, title: string, color: string) => ({
  type: 'value',
  dataMapping: { value: [{ id: `kpi.${field}`, aggregation: 'sum' }] },
  format: {
    title: { enabled: true, text: title, color: '#8fa3bf', typography: { fontSize: 12, fontWeight: 'normal' }, textAlign: 'left' },
    style: { color, typography: { fontSize: 26, fontWeight: 'bold' }, verticalAlign: 'center', textAlign: 'left', textScaling: { enabled: true } },
    widget: { backgroundColor: '#0c1626', borderEnabled: true, borderColor: 'rgba(148,163,184,.16)', borderRadius: 14 },
  },
});

const chartShell = { widget: { backgroundColor: '#0a1322', borderEnabled: true, borderColor: 'rgba(148,163,184,.16)', borderRadius: 14 } };

const ref = (table: string, f: string, agg?: string) => ({ id: `${table}.${f}`, ...(agg ? { aggregation: agg } : {}) });

export const INITIAL_STATE: any = {
  selectedPageId: 'main',
  pages: [
    {
      id: 'main',
      layout: { columns: 24, rowHeight: 28, backgroundColor: '#060b14', widgetPadding: 6, pagePadding: 10 },
      widgets: {
        kOutstanding: kpi('kOutstanding', 'outstanding', 'Outstanding receivables', '#e6f1ff'),
        kExp14: kpi('kExp14', 'expected14d', 'Expected in next 14 days', '#2dd4bf'),
        kExp30: kpi('kExp30', 'expected30d', 'Expected in next 30 days', '#2dd4bf'),
        kGap: kpi('kGap', 'gap', 'Due-date gap at 30 days', '#fb7185'),
        kRisk: kpi('kRisk', 'atRisk', 'At risk (late or may never pay)', '#fbbf24'),
        kDays: kpi('kDays', 'daysToCash', 'Expected days to cash', '#e6f1ff'),
        tide: {
          type: 'cashTide',
          dataMapping: {
            dayIndex: [ref('tide', 'dayIndex')],
            expected: [ref('tide', 'expected', 'sum')],
            p10: [ref('tide', 'p10', 'sum')],
            p25: [ref('tide', 'p25', 'sum')],
            p75: [ref('tide', 'p75', 'sum')],
            p90: [ref('tide', 'p90', 'sum')],
            naive: [ref('tide', 'naive', 'sum')],
            scenario: [ref('tide', 'scenario', 'sum')],
          },
          format: { title: { enabled: true, text: 'Cash Tide: when will invoiced money actually arrive?', color: '#e6f1ff', typography: { fontSize: 15, fontWeight: 'bold' } }, ...chartShell },
        },
        orbit: {
          type: 'payerOrbit',
          dataMapping: {
            name: [ref('payers', 'name')],
            days: [ref('payers', 'days', 'sum')],
            sigma: [ref('payers', 'sigma', 'sum')],
            ghost: [ref('payers', 'ghost', 'sum')],
            open: [ref('payers', 'open', 'sum')],
            count: [ref('payers', 'count', 'sum')],
            payerId: [ref('payers', 'payerId')],
          },
          format: { title: { enabled: true, text: 'Payer Orbit', color: '#e6f1ff', typography: { fontSize: 15, fontWeight: 'bold' } }, ...chartShell },
        },
        grid: {
          type: 'grid',
          dataMapping: { cols: ['number', 'payer', 'amount', 'due', 'median', 'late', 'pDue', 'p14', 'ghost', 'risk', 'reminders'].map((f) => ref('invoices', f)) },
          format: { title: { enabled: true, text: 'Open invoices, ranked by dollars at risk', color: '#e6f1ff', typography: { fontSize: 15, fontWeight: 'bold' } }, ...chartShell },
        },
      },
      widgetLayout: {
        kOutstanding: { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 4 },
        kExp14: { xTrack: 4, yTrack: 0, xSpan: 4, ySpan: 4 },
        kExp30: { xTrack: 8, yTrack: 0, xSpan: 4, ySpan: 4 },
        kGap: { xTrack: 12, yTrack: 0, xSpan: 4, ySpan: 4 },
        kRisk: { xTrack: 16, yTrack: 0, xSpan: 4, ySpan: 4 },
        kDays: { xTrack: 20, yTrack: 0, xSpan: 4, ySpan: 4 },
        tide: { xTrack: 0, yTrack: 4, xSpan: 15, ySpan: 14 },
        orbit: { xTrack: 15, yTrack: 4, xSpan: 9, ySpan: 14 },
        grid: { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: 13 },
      },
    },
  ],
};

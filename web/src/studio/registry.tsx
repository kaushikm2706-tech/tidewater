import { createWidgets } from 'ag-studio-react';
import type { AgWidgetDefinition } from 'ag-studio-react';
import { CashTide, CASH_TIDE_FIELDS } from './CashTide';
import { PayerOrbit, PAYER_ORBIT_FIELDS } from './PayerOrbit';

const TIDE_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='6' fill='%230a1322'/%3E%3Cpath d='M4 40 C14 36 22 28 44 12 L44 26 C24 36 14 40 4 44Z' fill='%232dd4bf' fill-opacity='.35'/%3E%3Cpath d='M4 42 C16 38 26 30 44 19' fill='none' stroke='%23e6f1ff' stroke-width='2.4' stroke-linecap='round'/%3E%3Cpath d='M4 24 h8 v-5 h8 v-6 h8 v-5 h16' fill='none' stroke='%2394a3b8' stroke-width='1.4' stroke-dasharray='3 3'/%3E%3C/svg%3E";
const ORBIT_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='6' fill='%230a1322'/%3E%3Ccircle cx='24' cy='24' r='7' fill='none' stroke='%23475569' stroke-dasharray='1 3'/%3E%3Ccircle cx='24' cy='24' r='14' fill='none' stroke='%23475569' stroke-dasharray='1 3'/%3E%3Ccircle cx='24' cy='24' r='20' fill='none' stroke='%23475569' stroke-dasharray='1 3'/%3E%3Ccircle cx='24' cy='24' r='3' fill='%232dd4bf'/%3E%3Ccircle cx='36' cy='14' r='4.5' fill='%23fbbf24'/%3E%3Ccircle cx='12' cy='30' r='3.5' fill='%232dd4bf'/%3E%3Ccircle cx='30' cy='38' r='5' fill='%23fb7185'/%3E%3C/svg%3E";

const numeric = { type: 'field', supportedRoles: ['numeric'], required: false } as const;

const cashTide: AgWidgetDefinition = {
  id: 'cashTide',
  label: 'Cash Tide',
  icon: { url: TIDE_ICON },
  dataMapping: {
    dayIndex: { type: 'field', supportedRoles: ['numeric', 'category', 'temporal'], required: true },
    expected: { ...numeric, required: true },
    p10: numeric,
    p25: numeric,
    p75: numeric,
    p90: numeric,
    naive: numeric,
    scenario: numeric,
  },
  formatShape: () => ({ parse: (v: any) => v ?? {} }) as any,
  form: (p: any) => p.createDefaults({ dataMappingItems: CASH_TIDE_FIELDS.map((k) => ({ key: k, label: k })) }),
  comp: CashTide as any,
  defaultSize: { width: 640, height: 360 },
  minSize: { width: 280, height: 200 },
  ai: { label: 'Cash Tide', description: 'Cumulative expected cash collected over the next 75 days as a probability ribbon (p10-p90 and p25-p75 bands) against the naive due-date promise.', usage: 'Map dayIndex plus expected, p10, p25, p75, p90, naive and optionally scenario from the "tide" table.' },
} as any;

const payerOrbit: AgWidgetDefinition = {
  id: 'payerOrbit',
  label: 'Payer Orbit',
  icon: { url: ORBIT_ICON },
  dataMapping: {
    name: { type: 'field', supportedRoles: ['category'], required: true },
    days: { ...numeric, required: true },
    sigma: numeric,
    ghost: numeric,
    open: numeric,
    count: numeric,
    payerId: { type: 'field', supportedRoles: ['category'], required: false },
  },
  formatShape: () => ({ parse: (v: any) => v ?? {} }) as any,
  form: (p: any) => p.createDefaults({ dataMappingItems: PAYER_ORBIT_FIELDS.map((k) => ({ key: k, label: k })) }),
  comp: PayerOrbit as any,
  defaultSize: { width: 420, height: 420 },
  minSize: { width: 260, height: 260 },
  ai: { label: 'Payer Orbit', description: 'Radial map of payers: distance from the centre is typical days-to-pay, dot size is open dollars, colour is probability of never paying.', usage: 'Map name, days, sigma, ghost, open, count and payerId from the "payers" table.' },
} as any;

export const widgets = (cfg: any) =>
  createWidgets<any>({
    additionalTypes: [cashTide, payerOrbit] as any,
    menu: [{ label: 'Tidewater', widgetIds: ['cashTide', 'payerOrbit'] }, ...cfg.menu],
  });

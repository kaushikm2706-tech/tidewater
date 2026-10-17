import type { Config } from './config';
import { RealClock, VirtualClock, type Clock } from './clock';
import { Store } from './db';
import { LivePayPal } from './paypal/live';
import { SimPayPal } from './paypal/sim';
import type { PayPalPort } from './paypal/port';
import { Actions } from './services/actions';
import { Ledger } from './services/ledger';
import { seedSandbox, seedSimulator } from './services/seed';

export interface App {
  cfg: Config;
  store: Store;
  port: PayPalPort;
  clock: Clock;
  ledger: Ledger;
  actions: Actions;
}

export function llmStatus(cfg: Config) {
  const configured = Boolean(cfg.llm.baseUrl && cfg.llm.apiKey && cfg.llm.model);
  return { configured, model: configured ? cfg.llm.model : null };
}

export async function buildApp(cfg: Config, opts: { now?: number; seed?: boolean } = {}): Promise<App> {
  const store = new Store(cfg.dbFile);
  let clock: Clock;
  let port: PayPalPort;
  if (cfg.paypal.mode === 'sandbox') {
    clock = new RealClock();
    port = new LivePayPal(cfg.paypal);
  } else {
    const start = opts.now ?? Date.now();
    clock = new VirtualClock(store, start);
    if (!store.getMeta('sim_now')) (clock as VirtualClock).set(start);
    port = new SimPayPal(store, clock);
  }
  const ledger = new Ledger(store, port, clock, cfg, () => llmStatus(cfg));
  const actions = new Actions(ledger);
  const app: App = { cfg, store, port, clock, ledger, actions };
  if (opts.seed !== false && store.countInvoices() === 0) {
    if (!process.env.VITEST) console.log(cfg.paypal.mode === 'sandbox' ? 'First run: seeding synthetic history and creating live sandbox invoices (takes up to a minute)...' : 'First run: seeding synthetic simulator data...');
    await seed(app);
  }
  else await ledger.sync().catch((e) => console.warn('[sync] initial sync failed:', (e as Error).message));
  return app;
}

export async function seed(app: App) {
  const now = app.clock.now();
  if (app.cfg.paypal.mode === 'sandbox') return seedSandbox(app.store, app.ledger, now);
  return seedSimulator(app.store, app.ledger, now);
}

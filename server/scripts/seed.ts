/** Wipe the local database and reseed it (simulator: synthetic ledger; sandbox: synthetic history + a few live sandbox invoices). */
import { buildApp, seed } from '../app';
import { loadConfig } from '../config';

const cfg = loadConfig();
const app = await buildApp(cfg, { seed: false });
if (cfg.paypal.mode === 'sandbox') console.log('Sandbox mode: creating live invoices in your PayPal sandbox account.');
app.store.reset();
if (app.clock.kind === 'virtual') (app.clock as any).set(Date.now());
const r = await seed(app);
console.log(`Seeded (${cfg.paypal.mode}):`, r, '->', cfg.dbFile);
process.exit(0);

import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Load `.env` from the project root (Node does not do this by itself). Variables already set in the
// real environment win. Skipped under the test runner so a local .env can never change test behaviour.
if (!process.env.VITEST) {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch {
    /* no .env file: fine, run in simulator mode */
  }
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export interface Config {
  port: number;
  dbFile: string;
  paypal: {
    mode: 'simulator' | 'sandbox';
    clientId: string;
    clientSecret: string;
    apiBase: string;
    invoicerEmail: string;
    invoicerName: string;
    webhookId: string;
    pollSeconds: number;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  webDist: string;
  version: string;
}

export const SANDBOX_HOSTS = ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'];

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  const get = (name: string, fb = '') => (overrides[name] !== undefined ? overrides[name]! : env(name, fb));
  const clientId = get('PAYPAL_CLIENT_ID');
  const clientSecret = get('PAYPAL_CLIENT_SECRET');
  const requested = get('PAYPAL_MODE', clientId && clientSecret ? 'sandbox' : 'simulator');
  const mode: 'simulator' | 'sandbox' = requested === 'sandbox' && clientId && clientSecret ? 'sandbox' : 'simulator';
  const apiBase = get('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
  const host = new URL(apiBase).host;
  if (mode === 'sandbox' && !SANDBOX_HOSTS.includes(host) && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    throw new Error(`Refusing to start: PAYPAL_API_BASE host "${host}" is not a PayPal sandbox host. Tidewater only talks to the sandbox.`);
  }
  return {
    port: Number(get('PORT', '8787')),
    dbFile: get('TIDEWATER_DB', path.join(root, 'server/data/tidewater.db')),
    paypal: {
      mode,
      clientId,
      clientSecret,
      apiBase,
      invoicerEmail: get('PAYPAL_INVOICER_EMAIL'),
      invoicerName: get('PAYPAL_INVOICER_NAME', 'Tidewater Demo Merchant'),
      webhookId: get('PAYPAL_WEBHOOK_ID'),
      pollSeconds: Number(get('PAYPAL_POLL_SECONDS', '45')),
    },
    llm: {
      baseUrl: get('LLM_BASE_URL').replace(/\/+$/, ''),
      apiKey: get('LLM_API_KEY'),
      model: get('LLM_MODEL'),
    },
    webDist: path.join(root, 'dist/web'),
    version: '0.1.0',
  };
}

// Entry point: `npm start`. Reads settings from the environment (or .env).
import { buildApp } from './app.ts';
import { PortalClient } from './portal.ts';
import { Store } from './store.ts';

const env = process.env;
if (!env.PORTAL_EMAIL || !env.PORTAL_PASSWORD) {
  console.error('Set PORTAL_EMAIL and PORTAL_PASSWORD. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const portal = new PortalClient({
  baseUrl: (env.PORTAL_URL ?? 'https://urja-ops.flockenergy.tech').replace(/\/+$/, ''),
  email: env.PORTAL_EMAIL,
  password: env.PORTAL_PASSWORD,
});
const store = new Store(portal, Number(env.SNAPSHOT_TTL_SECONDS ?? 900) * 1000);
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const app = buildApp(store, { log });

// Sync before taking traffic, but start even if the portal is down:
// /health says so, and the next request tries again.
await store.refresh().then(
  (s) => log(`Synced ${s.meters.length} meters and ${s.transformers.length} transformers from the portal`),
  (err: Error) => log(`ERROR Initial sync failed: ${err.message}`),
);

const port = Number(env.PORT ?? 3000);
// Express 5 hands a failed listen (e.g. port in use) to this callback.
app.listen(port, '127.0.0.1', (err?: Error) => {
  if (err) throw err;
  log(`Listening on http://127.0.0.1:${port} (docs at /docs)`);
});

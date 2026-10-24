// The HTTP API end to end: a real Express server on a free port, over a fake portal source.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import { PortalError } from '../src/portal.ts';
import { Store, type PortalSource } from '../src/store.ts';
import { rawMeters, rawReadings, rawTransformers } from './fixtures.ts';

function fakePortal(overrides: Partial<PortalSource> = {}) {
  const calls = { exportMeters: 0, readings: 0 };
  const portal: PortalSource = {
    exportMeters: async () => (calls.exportMeters++, structuredClone(rawMeters)),
    transformers: async () => structuredClone(rawTransformers),
    readings: async (id) => (calls.readings++, rawMeters.some((m) => m.meterId === id) ? structuredClone(rawReadings) : null),
    ...overrides,
  };
  return { portal, calls };
}

/** Starts the app for one test and returns a GET helper; the server closes when the test ends. */
async function api(t: TestContext, store = new Store(fakePortal().portal)) {
  const server = buildApp(store).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (url: string) => {
    const res = await fetch(base + url);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
}

test('GET /meters filters by status, network level and text', async (t) => {
  const get = await api(t);
  const faulty = await get('/meters?status=faulty');
  assert.equal(faulty.status, 200);
  assert.deepEqual(faulty.body.items.map((m: { id: string }) => m.id), ['J100001']);

  const onDt2 = await get('/meters?transformer=DT-002&installType=ct_operated');
  assert.deepEqual(onDt2.body.items.map((m: { id: string }) => m.id), ['J100003']);

  // Feeder F-001 exists under two divisions; a path picks one of them.
  assert.equal((await get('/meters?feeder=F-001')).body.total, 6);
  const underD2 = await get('/meters?path=Z-01/C-01/D-02');
  assert.deepEqual(underD2.body.items.map((m: { id: string }) => m.id), ['J100003', 'J100004', 'J100005']);
  assert.equal((await get('/meters?path=Z-01/C-01/D-0')).body.total, 0, 'a path matches whole codes only');

  const text = await get('/meters?q=se00002');
  assert.deepEqual(text.body.items.map((m: { id: string }) => m.id), ['J100002']);
});

test('GET /meters?near returns the nearest meters first, with distances', async (t) => {
  const get = await api(t);
  const { body } = await get('/meters?near=26.9,75.8&radiusKm=2');
  assert.deepEqual(body.items.map((m: { id: string; distanceKm: number }) => [m.id, m.distanceKm]).slice(0, 2), [
    ['J100000', 0],
    ['J100003', 0],
  ]);
  assert.ok(body.items.every((m: { distanceKm: number }) => m.distanceKm <= 2));
  assert.ok(!body.items.some((m: { id: string }) => m.id === 'J100002'), 'J100002 is ~15 km away');
});

test('GET /meters paginates, applies defaults, and rejects bad input with the standard error shape', async (t) => {
  const get = await api(t);
  const page = await get('/meters?limit=2&offset=2');
  assert.deepEqual([page.body.total, page.body.items.length, page.body.items[0].id], [6, 2, 'J100002']);
  assert.deepEqual([page.body.limit, page.body.offset], [2, 2], 'query strings are coerced to numbers');

  const defaults = await get('/meters');
  assert.deepEqual([defaults.body.limit, defaults.body.offset], [50, 0]);

  for (const url of ['/meters?status=broken', '/meters?limit=0', '/meters?near=here']) {
    const bad = await get(url);
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'bad_request'], url);
  }
});

test('GET /meters/:id returns the clean meter, or 404', async (t) => {
  const get = await api(t);
  const { status, body } = await get('/meters/J100003');
  assert.equal(status, 200);
  assert.deepEqual([body.status, body.phase, body.installType], ['decommissioned', 'single', 'ct_operated']);
  assert.equal(body.hierarchy.transformer.code, 'DT-002');
  assert.equal(body.build, undefined, 'portal internals are not leaked');

  const missing = await get('/meters/NOPE');
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'not_found']);
  const noRoute = await get('/nope');
  assert.deepEqual([noRoute.status, noRoute.body.error.code], [404, 'not_found']);
});

test('GET /meters/:id/readings filters by IST day and totals the usage', async (t) => {
  const get = await api(t);
  const all = await get('/meters/J100000/readings');
  assert.equal(all.status, 200);
  assert.deepEqual(
    [all.body.intervalMinutes, all.body.readings.length, all.body.totalKwhUsed, all.body.duplicatesDropped],
    [30, 3, 0.84, 0],
  );

  const window = await get('/meters/J100000/readings?from=2026-06-24T00:15:00%2B05:30&to=2026-06-24T00:30:00%2B05:30');
  assert.deepEqual(window.body.readings.map((r: { timestamp: string }) => r.timestamp), ['2026-06-24T00:30:00+05:30']);

  const nextDay = await get('/meters/J100000/readings?from=2026-06-25');
  assert.equal(nextDay.body.readings.length, 0);
});

test('readings are cached, and the last good answer is served when the portal fails', async (t) => {
  let fail = false;
  const { portal, calls } = fakePortal();
  const readings = portal.readings;
  portal.readings = async (id) => {
    if (fail) throw new PortalError('portal down');
    return readings(id);
  };
  const get = await api(t, new Store(portal));
  await get('/meters/J100000/readings');
  await get('/meters/J100000/readings');
  assert.equal(calls.readings, 1, 'second call is served from cache');

  fail = true;
  assert.equal((await get('/meters/J100001/readings')).status, 502, 'nothing cached for this meter yet');
});

test('a stale snapshot is served at once, and a failed refresh keeps it', async (t) => {
  let fail = false;
  const { portal, calls } = fakePortal();
  const exportMeters = portal.exportMeters;
  portal.exportMeters = async () => {
    if (fail) throw new PortalError('portal down');
    return exportMeters();
  };
  const get = await api(t, new Store(portal, 0)); // every snapshot is stale at once
  assert.equal((await get('/meters')).body.total, 6);

  fail = true;
  assert.equal((await get('/meters')).body.total, 6, 'old data is still served');
  await new Promise((resolve) => setImmediate(resolve));
  const health = await get('/health');
  assert.deepEqual([health.status, health.body.status, health.body.lastError], [200, 'degraded', 'portal down']);
  assert.ok(calls.exportMeters >= 1);
});

test('GET /health is 503 before the first sync, and the API answers 502 while the portal is down', async (t) => {
  const { portal } = fakePortal({
    exportMeters: async () => {
      throw new PortalError('Portal unreachable');
    },
  });
  const get = await api(t, new Store(portal));
  assert.equal((await get('/health')).status, 503);
  const res = await get('/meters');
  assert.deepEqual([res.status, res.body.error.code], [502, 'portal_unavailable']);
});

test('a rate-limited portal becomes 503 with Retry-After', async (t) => {
  const { portal } = fakePortal({
    readings: async () => {
      throw new PortalError('Portal answered 429 for readings of J100000', 429);
    },
  });
  const get = await api(t, new Store(portal));
  const res = await get('/meters/J100000/readings');
  assert.deepEqual([res.status, res.headers.get('retry-after'), res.body.error.code], [503, '60', 'portal_rate_limited']);
});

test('GET /hierarchy and /transformers expose the tree and the data-quality report', async (t) => {
  const get = await api(t);
  const h = await get('/hierarchy');
  assert.equal(h.status, 200);
  assert.equal(h.body.tree[0].children[0].children[0].children[0].children[0].children[0].children[0].level, 'transformer');
  assert.equal(h.body.dataQuality.repairs.length, 3);
  assert.equal(h.body.dataQuality.reusedCodes[0].code, 'F-001');

  const t1 = await get('/transformers/DT-001');
  assert.deepEqual([t1.body.capacityKva, t1.body.meters.total], [100, 3]);
  assert.equal((await get('/transformers/DT-999')).status, 404);
});

test('openapi.json is served and lists every route with its operationId', async (t) => {
  const get = await api(t);
  const { status, body } = await get('/openapi.json');
  assert.equal(status, 200);
  assert.equal(body.openapi, '3.1.0');
  assert.deepEqual(
    Object.entries(body.paths).map(([path, item]) => `${path} ${(item as { get: { operationId: string } }).get.operationId}`),
    [
      '/meters listMeters',
      '/meters/{id} getMeter',
      '/meters/{id}/readings getMeterReadings',
      '/transformers listTransformers',
      '/transformers/{code} getTransformer',
      '/hierarchy getHierarchy',
      '/health getHealth',
    ],
  );
});

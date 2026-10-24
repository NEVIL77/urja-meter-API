// PortalClient against a fake portal that enforces the real one's rules:
// form-action sign-in, cookie sessions that expire, and signed exports.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { PortalClient, PortalError } from '../src/portal.ts';
import { rawMeters, rawReadings, rawTransformers } from './fixtures.ts';

const SECRET = 'test-secret';
const fake = {
  sessions: new Set<string>(),
  signIns: 0,
  failNext: 0, // answer this many requests with 503
  rateLimited: false, // answer every data request with 429
  requests: 0,
  clockSkewS: 0, // how far the fake portal's clock is ahead of ours
};
let baseUrl = '';
const server = createServer(async (req, res) => handle(req, res));

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  Object.assign(fake, { signIns: 0, failNext: 0, clockSkewS: 0, rateLimited: false, requests: 0 });
  fake.sessions.clear();
});

const client = (password = 'right', rate = { burst: 50, perSecond: 1 }) =>
  new PortalClient({ baseUrl, email: 'operator@urja.local', password, retryDelaysMs: [1, 1], rate });

test('signs in once and reuses the session', async () => {
  const portal = client();
  assert.equal((await portal.transformers()).length, 3);
  assert.equal((await portal.readings('J100000'))!.length, 3);
  assert.equal(fake.signIns, 1);
});

test('signs the export with the secret from /portal/keys', async () => {
  assert.equal((await client().exportMeters()).length, rawMeters.length);
});

test('signs with the portal clock when ours is off', async () => {
  fake.clockSkewS = 1_000;
  assert.equal((await client().exportMeters()).length, rawMeters.length);
});

test('signs in again when the session expires, once for concurrent callers', async () => {
  const portal = client();
  await portal.transformers();
  fake.sessions.clear();
  await Promise.all([portal.readings('J100000'), portal.readings('J100001'), portal.transformers()]);
  assert.equal(fake.signIns, 2);
});

test('retries when the portal answers 503', async () => {
  const portal = client();
  await portal.signIn();
  fake.failNext = 2;
  assert.equal((await portal.readings('J100000'))!.length, 3);
});

test('gives up with a PortalError when the portal keeps failing', async () => {
  const portal = client();
  await portal.signIn();
  fake.failNext = 10;
  await assert.rejects(portal.transformers(), PortalError);
});

test('a 429 is not retried, since the portal blocks for a minute', async () => {
  const portal = client();
  await portal.signIn();
  fake.rateLimited = true;
  fake.requests = 0;
  await assert.rejects(portal.transformers(), (err: PortalError) => err.status === 429);
  assert.equal(fake.requests, 1);
});

test('calls are paced to the configured rate instead of bursting', async () => {
  const portal = client('right', { burst: 2, perSecond: 20 });
  const started = Date.now();
  await Promise.all(['J100000', 'J100001', 'J100002', 'J100003'].map((id) => portal.readings(id)));
  // Sign-in plus four reads is five calls: two from the burst, three at 50 ms apart.
  assert.ok(Date.now() - started >= 140, `took ${Date.now() - started} ms`);
});

test('a wrong password is a PortalError, not a hang or a crash', async () => {
  await assert.rejects(client('wrong').transformers(), /sign-in failed/);
});

test('an unknown meter has no readings', async () => {
  assert.equal(await client().readings('NOPE'), null);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', baseUrl);
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      date: new Date(Date.now() + fake.clockSkewS * 1000).toUTCString(),
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  fake.requests++;
  if (fake.failNext > 0) {
    fake.failNext--;
    return send(503, { error: 'unavailable' });
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    if (req.headers.origin !== baseUrl) return send(403, { message: 'Cross-site POST form submissions are forbidden' });
    if (form.get('password') !== 'right') return send(200, { type: 'failure', status: 400 });
    const token = `t${++fake.signIns}`;
    fake.sessions.add(token);
    return send(200, { type: 'redirect', status: 303, location: '/meters' }, {
      'set-cookie': `better-auth.session_token=${token}; Path=/; HttpOnly; SameSite=Lax`,
    });
  }

  const token = /better-auth\.session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!token || !fake.sessions.has(token)) return send(401, { error: 'unauthorized', message: 'A valid session is required.' });

  if (fake.rateLimited) return send(429, { error: 'rate_limited', message: 'Rate limit exceeded; slow down.' });
  if (url.pathname === '/portal/keys') return send(200, { data: { signingSecret: SECRET } });
  if (url.pathname === '/portal/export') {
    const ts = String(req.headers['x-timestamp'] ?? '');
    const query = url.search.slice(1);
    const expected = createHmac('sha256', SECRET).update(['GET', url.pathname, query, ts].join('\n')).digest('hex');
    const portalNow = Date.now() / 1000 + fake.clockSkewS;
    if (req.headers['x-signature'] !== expected || Math.abs(portalNow - Number(ts)) > 300) {
      return send(401, { error: 'signature_invalid', message: 'Missing or invalid request signature.' });
    }
    return send(200, { data: rawMeters, total: rawMeters.length });
  }
  if (url.pathname === '/portal/dts') {
    const page = Number(url.searchParams.get('page') ?? 1);
    return send(200, { data: rawTransformers.slice((page - 1) * 2, page * 2), total: rawTransformers.length, page, pageSize: 2 });
  }
  const energy = /^\/portal\/meters\/([^/]+)\/energy$/.exec(url.pathname);
  if (energy) {
    if (!rawMeters.some((m) => m.meterId === energy[1])) return send(404, { error: 'not_found', message: 'Meter not found' });
    return send(200, { data: rawReadings });
  }
  return send(404, { error: 'not_found' });
}

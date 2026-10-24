// The only module that talks to the Urja Meter Ops portal. Everything the
// portal returns is typed here exactly as it arrives; domain.ts turns it into
// the clean shapes the API serves. See PROTOCOL.md for how each call works.
import { createHmac } from 'node:crypto';

export const PORTAL_LEVELS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'] as const;
export type PortalLevel = (typeof PORTAL_LEVELS)[number];

export interface RawNode { code: string; name: string }

export interface RawExportMeter {
  meterId: string;
  serialNo: string;
  make: string;
  phaseType: string;
  installStatus: string;
  installType: string;
  dtCode: string;
  build: string;
  geo: { lat: number; lng: number };
  hierarchy: Record<PortalLevel, RawNode>;
}

export interface RawTransformer { code: string; name: string; feederCode: string; capacityKva: number }

export interface RawReading { timestamp: string; kwh: string; kvah: string; voltR: string }

export class PortalError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
  }
}

export interface PortalOptions {
  baseUrl: string;
  email: string;
  password: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  /** Our own pacing, to stay under the portal's rate limit (about 120 requests a minute, see PROTOCOL.md). */
  rate?: { burst: number; perSecond: number };
}

type HeaderMap = Record<string, string>;

export class PortalClient {
  readonly #opts: Required<PortalOptions>;
  readonly #cookies = new Map<string, string>();
  #signingIn: Promise<void> | null = null;
  #sessionNumber = 0; // goes up on every sign-in
  #secret: string | null = null;
  // Portal clock minus ours. Export signatures are only accepted within ±300 s
  // of the portal's clock, so we sign with its time rather than ours.
  #skewMs = 0;
  #tokens: number;
  #tokensAt = Date.now();

  constructor(opts: PortalOptions) {
    this.#opts = { timeoutMs: 15_000, retryDelaysMs: [500, 2_000], rate: { burst: 50, perSecond: 1 }, ...opts };
    this.#tokens = this.#opts.rate.burst;
  }

  /** Every meter with its hierarchy and location, in one signed call. */
  async exportMeters(): Promise<RawExportMeter[]> {
    // The portal ignores `page`: any value returns the whole dataset.
    return dataOf<RawExportMeter[]>(await this.#signedGet('/portal/export', 'page=1'), true);
  }

  async transformers(): Promise<RawTransformer[]> {
    const all: RawTransformer[] = [];
    for (let page = 1; ; page++) {
      const body = await this.#getJson(`/portal/dts?page=${page}`);
      const rows = dataOf<RawTransformer[]>(body, true);
      all.push(...rows);
      const total = (body as { total?: number }).total ?? 0;
      if (rows.length === 0 || all.length >= total) return all;
    }
  }

  /** Readings for one meter, or null when the portal does not know the meter. */
  async readings(meterId: string): Promise<RawReading[] | null> {
    const res = await this.#request(`/portal/meters/${encodeURIComponent(meterId)}/energy`);
    if (res.status === 404) return null;
    if (!res.ok) throw new PortalError(`Portal answered ${res.status} for readings of ${meterId}`, res.status);
    return dataOf<RawReading[]>(await res.json(), true);
  }

  /** Signs in. Concurrent callers that all found an expired session share one sign-in. */
  signIn(): Promise<void> {
    this.#signingIn ??= this.#doSignIn().finally(() => {
      this.#signingIn = null;
    });
    return this.#signingIn;
  }

  async #doSignIn(): Promise<void> {
    this.#cookies.clear();
    // The login page is a SvelteKit form action. With `x-sveltekit-action` it
    // answers JSON: {type:"redirect"} on success, {type:"failure"} otherwise.
    const res = await this.#send('/login', () => ({
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-sveltekit-action': 'true',
    }), new URLSearchParams({ email: this.#opts.email, password: this.#opts.password }).toString());
    const body = (await res.json().catch(() => null)) as { type?: string } | null;
    if (!res.ok || body?.type !== 'redirect' || this.#cookies.size === 0) {
      throw new PortalError(`Portal sign-in failed (HTTP ${res.status}, ${body?.type ?? 'no body'})`, res.status);
    }
    this.#sessionNumber++;
  }

  async #signedGet(path: string, query: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      this.#secret ??= dataOf<{ signingSecret: string }>(await this.#getJson('/portal/keys')).signingSecret;
      const secret = this.#secret;
      const res = await this.#request(`${path}?${query}`, () => {
        const ts = String(Math.floor((Date.now() + this.#skewMs) / 1000));
        const signature = createHmac('sha256', secret).update(['GET', path, query, ts].join('\n')).digest('hex');
        return { 'x-timestamp': ts, 'x-signature': signature };
      });
      if (res.ok) return res.json();
      // A rejected signature means the secret rotated or our clock estimate was
      // off; the response has just refreshed the estimate, so fetch the secret again once.
      if (res.status === 401 && attempt === 1) {
        this.#secret = null;
        continue;
      }
      throw new PortalError(`Portal answered ${res.status} for ${path}`, res.status);
    }
  }

  async #getJson(path: string): Promise<unknown> {
    const res = await this.#request(path);
    if (!res.ok) throw new PortalError(`Portal answered ${res.status} for ${path}`, res.status);
    return res.json();
  }

  /** A request with a session: signs in first if needed, and once more if the session expired. */
  async #request(path: string, headers: () => HeaderMap = () => ({})): Promise<Response> {
    if (this.#cookies.size === 0) await this.signIn();
    const session = this.#sessionNumber;
    let res = await this.#send(path, headers);
    if (res.status === 401 && (await errorCode(res)) === 'unauthorized') {
      // Sessions last an hour. Sign in again, unless another request already did while this one was in flight.
      if (session === this.#sessionNumber) await this.signIn();
      res = await this.#send(path, headers);
    }
    return res;
  }

  /**
   * One HTTP call, retried on network errors, timeouts and 5xx. Not on 429:
   * the portal then blocks for about a minute, so retrying only adds load.
   */
  async #send(path: string, headers: () => HeaderMap, body?: string): Promise<Response> {
    const delays = this.#opts.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      await this.#takeToken();
      try {
        const res = await fetch(this.#opts.baseUrl + path, {
          method: body === undefined ? 'GET' : 'POST',
          // SvelteKit rejects form posts whose Origin is not its own.
          headers: { ...headers(), cookie: this.#cookieHeader(), origin: this.#opts.baseUrl },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#opts.timeoutMs),
        });
        this.#remember(res);
        if (res.status < 500 || attempt >= delays.length) return res;
      } catch (err) {
        if (attempt >= delays.length) {
          throw new PortalError(`Portal unreachable: ${(err as Error).message}`);
        }
      }
      await sleep(delays[attempt]!);
    }
  }

  /** Token bucket: up to `burst` calls at once, then `perSecond`. Callers wait their turn instead of failing. */
  async #takeToken(): Promise<void> {
    const { burst, perSecond } = this.#opts.rate;
    for (;;) {
      const now = Date.now();
      this.#tokens = Math.min(burst, this.#tokens + ((now - this.#tokensAt) / 1000) * perSecond);
      this.#tokensAt = now;
      if (this.#tokens >= 1) {
        this.#tokens--;
        return;
      }
      await sleep(((1 - this.#tokens) / perSecond) * 1000);
    }
  }

  #remember(res: Response): void {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(cookie)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    const date = Date.parse(res.headers.get('date') ?? '');
    if (!Number.isNaN(date)) this.#skewMs = date - Date.now();
  }

  #cookieHeader(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unwraps the portal's `{data: ...}` envelope, failing loudly if the shape changed. */
function dataOf<T>(body: unknown, array = false): T {
  const data = (body as { data?: unknown } | null)?.data;
  if (data === undefined || data === null || (array && !Array.isArray(data))) {
    throw new PortalError('Portal response is missing its data field; the portal may have changed');
  }
  return data as T;
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json().catch(() => null)) as { error?: string } | null;
  return body?.error;
}

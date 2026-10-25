import { createHmac } from 'node:crypto';
import type { RawNode, RawExportMeter, RawTransformer, RawReading, PortalOptions, HeaderMap } from './portal.types.js';

export const PORTAL_LEVELS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'] as const;
export type PortalLevel = (typeof PORTAL_LEVELS)[number];
export type { RawNode, RawExportMeter, RawTransformer, RawReading, PortalOptions };

export class PortalError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
  }
}

export class PortalClient {
  readonly #opts: Required<PortalOptions>;
  readonly #cookies = new Map<string, string>();
  #signingIn: Promise<void> | null = null;
  #sessionNumber = 0;
  #secret: string | null = null;

  #skewMs = 0;
  #tokens: number;
  #tokensAt = Date.now();

  constructor(opts: PortalOptions) {
    this.#opts = { timeoutMs: 15_000, retryDelaysMs: [500, 2_000], rate: { burst: 50, perSecond: 1 }, ...opts };
    this.#tokens = this.#opts.rate.burst;
  }

  
  async exportMeters(): Promise<RawExportMeter[]> {
  
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
  
  async readings(meterId: string): Promise<RawReading[] | null> {
    const res = await this.#request(`/portal/meters/${encodeURIComponent(meterId)}/energy`);
    if (res.status === 404) return null;
    if (!res.ok) throw new PortalError(`Portal answered ${res.status} for readings of ${meterId}`, res.status);
    return dataOf<RawReading[]>(await res.json(), true);
  }

  signIn(): Promise<void> {
    this.#signingIn ??= this.#doSignIn().finally(() => {
      this.#signingIn = null;
    });
    return this.#signingIn;
  }

  async #doSignIn(): Promise<void> {
    this.#cookies.clear();

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
        const signature = createHmac('sha256', secret).update(['GET', path, query, ts].join('\n')).digest('hex'); // for export signature 
        return { 'x-timestamp': ts, 'x-signature': signature };
      });
      if (res.ok) return res.json();

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

  async #request(path: string, headers: () => HeaderMap = () => ({})): Promise<Response> {
    if (this.#cookies.size === 0) await this.signIn();
    const session = this.#sessionNumber;
    let res = await this.#send(path, headers);
    if (res.status === 401 && (await errorCode(res)) === 'unauthorized') {

      if (session === this.#sessionNumber) await this.signIn();
      res = await this.#send(path, headers);
    }
    return res;
  }

  /**
   * 
   */
  async #send(path: string, headers: () => HeaderMap, body?: string): Promise<Response> {
    const delays = this.#opts.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      await this.#takeToken();
      try {
        const res = await fetch(this.#opts.baseUrl + path, {
          method: body === undefined ? 'GET' : 'POST',

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

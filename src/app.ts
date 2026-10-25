// HTTP routes on Express. Every route is declared once in apiRoutes(): that one
// entry registers the Express handler, validates the request (Ajv, against the
// TypeBox schemas) and becomes its entry in openapi.json (src/openapi.ts).
import { Ajv } from 'ajv';
import express, { type NextFunction, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { Type, type Static, type TObject, type TSchema } from 'typebox';
import { InstallType, intervalMinutes, LEVELS, Meter, Phase, Reading, Status, Transformer } from './domain.ts';
import { Repair, ReusedCode, treeNodeSchema } from './hierarchy.ts';
import { openApiDocument } from './openapi.ts';
import { PortalError } from './portal.ts';
import { findMeters, type Store } from './store.ts'; 

export class ApiProblem extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** A handler result that needs a status other than 200. */
class Reply {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

const problem = (code: string, message: string) => ({ error: { code, message } });

export interface Route {
  path: string;
  operationId: string;
  tag: 'meters' | 'network' | 'service';
  summary: string;
  description?: string;
  params?: TObject;
  query?: TObject;
  responses: Record<number, TSchema>;
  handler: (input: { params: Record<string, unknown>; query: Record<string, unknown> }) => Promise<unknown>;
}

/** Declares a route; the handler's params and query are typed from their schemas. */
function route<P extends TObject, Q extends TObject>(
  r: Omit<Route, 'params' | 'query' | 'handler'> & {
    params?: P;
    query?: Q;
    handler: (input: { params: Static<P>; query: Static<Q> }) => Promise<unknown>;
  },
): Route {
  return r as unknown as Route;
}

// ---------- schemas ----------

const ApiError = Type.Object(
  { error: Type.Object({ code: Type.String({ examples: ['not_found'] }), message: Type.String() }) },
  { description: 'Every error has this shape.' },
);

const SyncedAt = Type.String({ format: 'date-time', description: 'When the data was last copied from the portal.' });

function levelCode(level: string, example: string) {
  return Type.Optional(
    Type.String({ examples: [example], description: `Exact ${level} code. Codes repeat across branches; see /hierarchy.` }),
  );
}

const MeterQuery = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1, description: 'Part of a meter id or serial number, any case.' })),
  status: Type.Optional(Status),
  phase: Type.Optional(Phase),
  installType: Type.Optional(InstallType),
  make: Type.Optional(Type.String({ examples: ['Genus'] })),
  zone: levelCode('zone', 'Z-01'),
  circle: levelCode('circle', 'C-01'),
  division: levelCode('division', 'D-01'),
  subdivision: levelCode('subdivision', 'SD-01'),
  substation: levelCode('substation', 'SS-01'),
  feeder: levelCode('feeder', 'F-001'),
  transformer: levelCode('transformer', 'DT-001'),
  path: Type.Optional(
    Type.String({
      examples: ['Z-01/C-01/D-01'],
      description: 'Meters under one node of the tree, by its path from /hierarchy. Unlike codes, paths are unique.',
    }),
  ),
  near: Type.Optional(
    Type.String({
      pattern: '^-?\\d+(\\.\\d+)?,-?\\d+(\\.\\d+)?$',
      examples: ['26.9124,75.7873'],
      description: 'lat,lng. Keeps meters within radiusKm and sorts them nearest first.',
    }),
  ),
  radiusKm: Type.Number({ default: 1, exclusiveMinimum: 0, maximum: 50 }),
  limit: Type.Integer({ default: 50, minimum: 1, maximum: 500 }),
  offset: Type.Integer({ default: 0, minimum: 0 }),
});

const MeterPage = Type.Object({
  syncedAt: SyncedAt,
  total: Type.Integer({ description: 'Matches before limit and offset.' }),
  limit: Type.Integer(),
  offset: Type.Integer(),
  items: Type.Array(
    Type.Object({
      ...Meter.properties,
      distanceKm: Type.Optional(Type.Number({ description: 'Only present when near is given.' })),
    }),
  ),
});

const Bound = (description: string) =>
  Type.Optional(
    Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2}))?$',
      description,
    }),
  );

const Readings = Type.Object({
  meterId: Type.String(),
  fetchedAt: Type.String({ format: 'date-time', description: 'When these readings were fetched from the portal.' }),
  intervalMinutes: Type.Union([Type.Integer(), Type.Null()], { description: 'Usually 30 or 1440 (daily).' }),
  totalKwhUsed: Type.Number({ description: 'Sum of kwhUsed over the returned readings.' }),
  duplicatesDropped: Type.Integer({
    description: 'Rows the portal sent twice for the same time. We keep the most complete one.',
  }),
  readings: Type.Array(Reading),
});

const Health = Type.Object({
  status: Type.Enum(['ok', 'degraded', 'down'], {
    description: 'degraded: the last refresh failed, so older data is being served. down: no data yet.',
  }),
  syncedAt: Type.Union([SyncedAt, Type.Null()]),
  meters: Type.Integer(),
  lastError: Type.Union([Type.String(), Type.Null()]),
});

const errors = {
  400: ApiError,
  404: ApiError,
  502: Type.Object(ApiError.properties, { description: 'The portal failed or answered something unexpected.' }),
  503: Type.Object(ApiError.properties, {
    description: 'The portal is rate-limiting us. Retry after the number of seconds in the Retry-After header.',
  }),
};

const MeterId = Type.Object({ id: Type.String({ examples: ['J100000'] }) });

// ---------- routes ----------

export function apiRoutes(store: Store): Route[] {
  return [
    route({
      path: '/meters',
      operationId: 'listMeters',
      tag: 'meters',
      summary: 'Search and filter meters',
      query: MeterQuery,
      responses: { 200: MeterPage, ...errors },
      handler: async ({ query }) => {
        const { limit, offset, near, ...filter } = query;
        const snapshot = await store.snapshot();
        const matches = findMeters(snapshot.meters, { ...filter, near: near === undefined ? undefined : parseNear(near) });
        return {
          syncedAt: snapshot.syncedAt.toISOString(),
          total: matches.length,
          limit,
          offset,
          items: matches.slice(offset, offset + limit),
        };
      },
    }),

    route({
      path: '/meters/:id',
      operationId: 'getMeter',
      tag: 'meters',
      summary: 'One meter, with its place in the network and its location',
      params: MeterId,
      responses: { 200: Meter, ...errors },
      handler: async ({ params }) => {
        const meter = (await store.snapshot()).byId.get(params.id);
        if (!meter) throw new ApiProblem(404, 'not_found', `Meter ${params.id} not found`);
        return meter;
      },
    }),

    route({
      path: '/meters/:id/readings',
      operationId: 'getMeterReadings',
      tag: 'meters',
      summary: 'Energy readings for one meter, oldest first',
      description:
        'Readings are fetched from the portal on demand and cached for five minutes. If the portal fails, the last good readings are served; check fetchedAt.',
      params: MeterId,
      query: Type.Object({
        from: Bound('Start, inclusive. A bare date means 00:00 IST that day.'),
        to: Bound('End, inclusive. A bare date includes that whole IST day.'),
      }),
      responses: { 200: Readings, ...errors },
      handler: async ({ params, query }) => {
        const { id } = params;
        if (!(await store.snapshot()).byId.has(id)) throw new ApiProblem(404, 'not_found', `Meter ${id} not found`);
        const result = await store.readings(id);
        if (!result) throw new ApiProblem(404, 'not_found', `The portal has no readings for meter ${id}`);
        const from = parseBound(query.from, false) ?? -Infinity;
        const before = parseBound(query.to, true) ?? Infinity;
        const readings = result.rows.filter((r) => Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) < before);
        const total = readings.reduce((sum, r) => sum + (r.kwhUsed ?? 0), 0);
        return {
          meterId: id,
          fetchedAt: result.fetchedAt.toISOString(),
          intervalMinutes: intervalMinutes(result.rows),
          totalKwhUsed: Math.round(total * 100) / 100,
          duplicatesDropped: result.duplicatesDropped,
          readings,
        };
      },
    }),

    route({
      path: '/transformers',
      operationId: 'listTransformers',
      tag: 'network',
      summary: 'Every distribution transformer, with capacity and meter counts',
      responses: { 200: Type.Object({ syncedAt: SyncedAt, items: Type.Array(Transformer) }), ...errors },
      handler: async () => {
        const snapshot = await store.snapshot();
        return { syncedAt: snapshot.syncedAt.toISOString(), items: snapshot.transformers };
      },
    }),

    route({
      path: '/transformers/:code',
      operationId: 'getTransformer',
      tag: 'network',
      summary: 'One distribution transformer. Its meters are at /meters?transformer={code}',
      params: Type.Object({ code: Type.String({ examples: ['DT-001'] }) }),
      responses: { 200: Transformer, ...errors },
      handler: async ({ params }) => {
        const found = (await store.snapshot()).transformers.find((t) => t.code === params.code);
        if (!found) throw new ApiProblem(404, 'not_found', `Transformer ${params.code} not found`);
        return found;
      },
    }),

    route({
      path: '/hierarchy',
      operationId: 'getHierarchy',
      tag: 'network',
      summary: 'The network as a tree, zone down to transformer, with meter counts at every node',
      description:
        'dataQuality lists what we fixed or could not fix in the portal data: per-meter hierarchy copies we repaired, and codes the portal files under more than one parent.',
      responses: {
        200: Type.Object({
          syncedAt: SyncedAt,
          levels: Type.Array(Type.String(), { examples: [[...LEVELS]] }),
          tree: Type.Array(treeNodeSchema()),
          dataQuality: Type.Object({ repairs: Type.Array(Repair), reusedCodes: Type.Array(ReusedCode) }),
        }),
        ...errors,
      },
      handler: async () => {
        const s = await store.snapshot();
        return {
          syncedAt: s.syncedAt.toISOString(),
          levels: [...LEVELS],
          tree: s.tree,
          dataQuality: { repairs: s.repairs, reusedCodes: s.reusedCodes },
        };
      },
    }),

    route({
      path: '/health',
      operationId: 'getHealth',
      tag: 'service',
      summary: 'Whether the service has data, and how fresh it is',
      responses: { 200: Health, 503: Health },
      handler: async () => {
        const { syncedAt, meters, lastError } = store.status;
        const status = syncedAt === null ? 'down' : lastError ? 'degraded' : 'ok';
        const body = { status, syncedAt: syncedAt?.toISOString() ?? null, meters, lastError };
        return syncedAt === null ? new Reply(503, body) : body;
      },
    }),
  ];
}

// ---------- the Express app ----------

// coerceTypes: query strings arrive as text ("50" → 50). useDefaults: fills limit, offset, radiusKm.
const ajv = new Ajv({ coerceTypes: true, useDefaults: true, strict: false });
const EMPTY = Type.Object({});

export function buildApp(store: Store, { log = (_message: string) => {} } = {}) {
  const routes = apiRoutes(store);
  const doc = openApiDocument(routes);
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    const started = performance.now();
    res.on('finish', () =>
      log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - started)}ms`),
    );
    next();
  });

  app.get('/', (_req, res) => res.redirect('/docs'));
  app.get('/openapi.json', (_req, res) => {
    res.json(doc);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));

  for (const r of routes) {
    const checkParams = ajv.compile(r.params ?? EMPTY);
    const checkQuery = ajv.compile(r.query ?? EMPTY);
    // Express 5 passes a rejected promise to the error handler below.
    app.get(r.path, async (req, res) => {
      // Copies: Ajv writes coerced values and defaults into them, and Express 5's req.query is read-only.
      const params: Record<string, unknown> = { ...req.params };
      const query: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
      if (!checkParams(params)) throw new ApiProblem(400, 'bad_request', ajv.errorsText(checkParams.errors, { dataVar: 'params' }));
      if (!checkQuery(query)) throw new ApiProblem(400, 'bad_request', ajv.errorsText(checkQuery.errors, { dataVar: 'querystring' }));
      const result = await r.handler({ params, query });
      if (result instanceof Reply) res.status(result.status).json(result.body);
      else res.json(result);
    });
  }

  app.use((req, res) => {
    res.status(404).json(problem('not_found', `No route ${req.method} ${req.originalUrl}`));
  });

  // Express recognises an error handler by its four parameters.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiProblem) {
      res.status(err.statusCode).json(problem(err.code, err.message));
    } else if (err instanceof PortalError && err.status === 429) {
      // The portal blocks for about a minute once its rate limit is hit, and says so in no header.
      log(`WARN ${err.message}`);
      res.status(503).set('retry-after', '60').json(problem('portal_rate_limited', err.message));
    } else if (err instanceof PortalError) {
      log(`WARN ${err.message}`);
      res.status(502).json(problem('portal_unavailable', err.message));
    } else {
      log(`ERROR ${(err as Error)?.stack ?? String(err)}`);
      res.status(500).json(problem('internal', 'Unexpected error'));
    }
  });

  return app;
}

function parseNear(value: string): { lat: number; lng: number } {
  const [lat, lng] = value.split(',').map(Number) as [number, number];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ApiProblem(400, 'bad_request', 'near must be a valid lat,lng');
  return { lat, lng };
}

/** Milliseconds since epoch. For `to`, the instant just after the bound, so callers can compare with `<`. */
function parseBound(value: string | undefined, isEnd: boolean): number | undefined {
  if (value === undefined) return undefined;
  const dateOnly = !value.includes('T');
  const ms = Date.parse(dateOnly ? `${value}T00:00:00+05:30` : value);
  if (Number.isNaN(ms)) throw new ApiProblem(400, 'bad_request', `Not a valid date: ${value}`);
  if (!isEnd) return ms;
  return dateOnly ? ms + 86_400_000 : ms + 1;
}

// Builds openapi.json from the route table in app.ts, so the spec cannot drift
// from the routes. TypeBox schemas are plain JSON Schema, which OpenAPI 3.1 uses as-is.
import type { TObject, TSchema } from 'typebox';
import type { Route } from './app.ts';

export function openApiDocument(routes: Route[]) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Urja Meter API',
      version: '1.0.0',
      description:
        'A clean, read-only API over the Urja Meter Ops portal: smart meters, where they sit in the network, and their readings.',
    },
    servers: [{ url: 'http://localhost:3000' }],
    // No auth: the service is meant to run inside the utility's network. See README, "Skipped".
    security: [],
    tags: [
      { name: 'meters', description: 'Meters and their readings' },
      { name: 'network', description: 'Transformers and the network hierarchy' },
      { name: 'service', description: 'The service itself' },
    ],
    // Express writes path parameters as :id, OpenAPI as {id}.
    paths: Object.fromEntries(routes.map((r) => [r.path.replace(/:(\w+)/g, '{$1}'), { get: operation(r) }])),
  };
}

function operation(r: Route) {
  return {
    operationId: r.operationId,
    summary: r.summary,
    ...(r.description && { description: r.description }),
    tags: [r.tag],
    parameters: [...parameters(r.params, 'path'), ...parameters(r.query, 'query')],
    responses: Object.fromEntries(
      Object.entries(r.responses).map(([status, schema]) => [
        status,
        {
          description: describe(schema) ?? (status === '200' ? 'OK' : 'Error'),
          content: { 'application/json': { schema } },
        },
      ]),
    ),
  };
}

/** One OpenAPI parameter per schema property; the description moves up to the parameter. */
function parameters(object: TObject | undefined, location: 'path' | 'query') {
  if (!object) return [];
  const required = new Set((object as { required?: string[] }).required ?? []);
  return Object.entries(object.properties as Record<string, TSchema>).map(([name, schema]) => {
    const { description, ...rest } = schema as TSchema & { description?: string };
    return {
      name,
      in: location,
      required: location === 'path' || required.has(name),
      ...(description && { description }),
      schema: rest,
    };
  });
}

const describe = (schema: TSchema) => (schema as { description?: string }).description;

// Writes openapi.json from the route table: `npm run openapi`. No portal access needed.
import { writeFileSync } from 'node:fs';
import { apiRoutes } from '../src/app.ts';
import { openApiDocument } from '../src/openapi.ts';
import { Store, type PortalSource } from '../src/store.ts';

const doc = openApiDocument(apiRoutes(new Store({} as PortalSource)));
writeFileSync(new URL('../openapi.json', import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);
console.log('Wrote openapi.json');

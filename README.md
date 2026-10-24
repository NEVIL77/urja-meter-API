# How to run

You need **Node.js 24** or newer.

1. Clone the project and open this folder.

2. make `.env` and fill in the portal login:

```
PORTAL_URL=https://urja-ops.flockenergy.tech
PORTAL_EMAIL=
PORTAL_PASSWORD=

PORT=3000
SNAPSHOT_TTL_SECONDS=900
```
here please enter the portal email and password , if help needed see the PROTOCOL.md for email and password.

3. Install dependencies:

```
npm i
```

4. Start the API:

```
npm start
```

The service runs (api end point ) at http://localhost:3000. 
to sea the swagger : http://localhost:3000/docs .

API list 

## API Endpoints list

| Endpoint | What it gives you |
|---|---|
| `GET /meters` | Search and filter meters. Filters: `q` (part of a meter ID or serial number), `status`, `phase`, `installType`, `make`, one code per level (`zone` … `transformer`), `path` (one node of the tree), and `near=lat,lng` with `radiusKm`, which also sorts nearest first. Paged with `limit` (default 50, max 500) and `offset`. |
| `GET /meters/{id}` | One meter: details, its place in the network, and its location. |
| `GET /meters/{id}/readings` | Energy readings, oldest first, with the kWh used per interval. Optional `from` and `to` take a date (a whole IST day) or a date-time with a time zone. |
| `GET /transformers` | All 40 distribution transformers, with capacity (kVA), place in the network and meter counts by status. |
| `GET /transformers/{code}` | One transformer. Its meters are at `/meters?transformer={code}`. |
| `GET /hierarchy` | The network as a tree from zone down to transformer, with meter counts at every node, plus a data-quality report. |
| `GET /health` | `ok`, `degraded` (the last refresh failed, so older data is being served) or `down` (no data yet), with the time of the last sync. |



## How it is built

```
  consumer ──HTTP──▶ app.ts        routes, validation, error shape, OpenAPI
                       │
                     store.ts      in-memory snapshot + readings cache + queries
                       │
       domain.ts ◀─────┤           clean types, unit and time conversion
    hierarchy.ts ◀─────┤           repairs the hierarchy, builds the tree
                       │
                     portal.ts     sign-in, cookies, export signing, pacing, retries
                       │
               Urja Meter Ops portal
```


| File | Job |
|---|---|
| [src/portal.ts](./src/portal.ts) | The only code that talks to the portal. Raw portal types live here. |
| [src/domain.ts](./src/domain.ts) | The API's schemas (TypeBox) and the functions that clean raw records |
| [src/hierarchy.ts](./src/hierarchy.ts) | Hierarchy repair, the tree, and reused-code detection |
| [src/store.ts](./src/store.ts) | The snapshot, refresh and caching, filters and distance search |
| [src/app.ts](./src/app.ts) | Express app. One route table registers each handler, its request validation (Ajv) and its OpenAPI entry. |
| [src/openapi.ts](./src/openapi.ts) | Builds `openapi.json` from that route table |
| [src/main.ts](./src/main.ts) | Reads settings and starts everything |
| [scripts/export-openapi.ts](./scripts/export-openapi.ts) | Writes `openapi.json` |



## Observations & Improvement Areas ( More Details and screenshot in the PROTOCOL.md )

While working with the portal and building this API, I noticed a few things worth calling out — some are bugs, some are security concerns, and some are missed opportunities with the data we already have.

### 1. Export API ignores pagination — security and performance risk

🔴 The `/portal/export` endpoint accepts a `page` parameter, but it ignores it and always returns the full dataset in one response. Right now that is 403 meters, so it feels fine. But this does not scale, and it opens a real door for abuse. Details and suggested fixes are in ❌ [PROTOCOL.md → Export API pagination bug](./PROTOCOL.md#export-pagination-bug).

### 2. Bug: the web portal does not redirect after session expiry

When the session cookie expires, the portal API correctly returns a `401`. But the web app does not react to that — it just sits there. A user is still looking at data they can no longer load, with no prompt to log in again. See ❌ [PROTOCOL.md → Session bug](./PROTOCOL.md#session-bug).

### 3. The data we have is being under-used

The API already carries lat/long for every meter, a clean 7-level hierarchy, energy readings, and status information. That is enough to build something genuinely useful:

- **Theft and loss detection** — if a transformer delivers 1,000 kWh but its meters only record 800 kWh, the gap is visible immediately. With the map coordinates we can show exactly where on the grid this is happening.
- **Outage isolation** — a feeder trip would tell us exactly which transformers and meters lost power, without anyone needing to call in from the field.
- **Field navigation** — a newly joined technician with no local knowledge could open a map and walk straight to the meter. The coordinates are already there.

The companion web client I built demonstrates some of this using the public API data. The same ideas apply directly here once the data is connected to a proper dashboard.

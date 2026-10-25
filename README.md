# Urja Meter API

## What this project actually is

A facade API that sits between external consumers and the portal. It hides the portal, normalizes its data, and shields it with caching.

## Important files

- [PROTOCOL.md](./PROTOCOL.md) — how the portal works, as I discovered it.
- [openapi.json](./openapi.json) — the OpenAPI description of this API. A rendered view is at `http://localhost:3000/docs` once the API is running.
- [REFLECTION.md](./REFLECTION.md) — my reflection answers.

## How to run

You need **Node.js 24** or newer.

1. Clone the project and open this folder.
2. Make a `.env` file and fill in the portal login:

```
PORTAL_URL=https://urja-ops.flockenergy.tech
PORTAL_EMAIL=
PORTAL_PASSWORD=
PORT=3000
SNAPSHOT_TTL_SECONDS=900
```

Enter the portal email and password here. If you need help, see [PROTOCOL.md](./PROTOCOL.md) for the email and password.

3. Install dependencies:

```
npm i
```

4. Start the API:

```
npm start
```

The API runs at http://localhost:3000. The Swagger UI is at http://localhost:3000/docs.

## API endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /meters` | Search and filter meters. Filters: `q` (part of a meter ID or serial number), `status`, `phase`, `installType`, `make`, one code per level (`zone` … `transformer`), `path` (one node of the tree), and `near=lat,lng` with `radiusKm`, which also sorts nearest first. Paged with `limit` (default 50, max 500) and `offset`. |
| `GET /meters/{id}` | One meter: details, its place in the network, and its location. |
| `GET /meters/{id}/readings` | Energy readings, oldest first, with the kWh used per interval. Optional `from` and `to` take a date (a whole IST day) or a date-time with a time zone. |
| `GET /transformers` | All 40 distribution transformers, with capacity (kVA), place in the network and meter counts by status. |
| `GET /transformers/{code}` | One transformer. Its meters are at `/meters?transformer={code}`. |
| `GET /hierarchy` | The network as a tree from zone down to transformer, with meter counts at every node, plus a data-quality report. |
| `GET /health` | `ok`, `degraded` (the last refresh failed, so older data is being served) or `down` (no data yet), with the time of the last sync. |

## Sample request

```bash
curl "http://localhost:3000/meters?limit=1"
```

Sample response:

```json
{
  "syncedAt": "2026-10-25T10:23:38.725Z",
  "total": 403,
  "limit": 1,
  "offset": 0,
  "items": [
    {
      "id": "J100000",
      "serialNo": "SE33962",
      "make": "HPL",
      "phase": "single",
      "status": "decommissioned",
      "installType": "whole_current",
      "location": { "lat": 26.938961002479868, "lng": 75.83095696146852 },
      "hierarchy": {
        "zone": { "code": "Z-01", "name": "Jaipur Zone 1" },
        "circle": { "code": "C-01", "name": "Circle 1" },
        "division": { "code": "D-01", "name": "Division 1" },
        "subdivision": { "code": "SD-01", "name": "Subdivision 1" },
        "substation": { "code": "SS-01", "name": "Substation 1" },
        "feeder": { "code": "F-001", "name": "Feeder 1" },
        "transformer": { "code": "DT-001", "name": "Malviya Nagar DT 1" }
      }
    }
  ]
}
```

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

### Data flow

Urja Meter Ops Portal  
        ↓  
`PortalClient` — Authenticates and fetches data  
        ↓  
Raw Data — `RawExportMeter[]`, `RawTransformer[]`, `RawReading[]`  
        ↓  
`domain.ts` — Transforms raw data into clean API data shapes  
        ↓  
`hierarchy.ts` — Repairs the per-meter hierarchy copies and builds the tree  
        ↓  
`Store` — Keeps the clean snapshot in memory (refreshed every `SNAPSHOT_TTL_SECONDS`), caches readings for 5 minutes, runs filters and searches  
        ↓  
`buildApp` (`app.ts`) — Validates the request, calls the Store, returns JSON, maps errors  
        ↓  
Consumer — Gets clean JSON from `/meters`, `/transformers`, `/hierarchy`, `/health`; docs at `/docs`

### Each file and what it does

| File | What it does |
|---|---|
| `portal.ts` (PortalClient) | Fetches data. |
| `store.ts` (Store) | Manages data. |
| `app.ts` (buildApp) | Exposes data through your own APIs. |
| `domain.ts` | Cleans raw data into the API's own shapes. |
| `hierarchy.ts` | Repairs the network hierarchy and builds the tree. |
| `openapi.ts` | Generates `openapi.json` from the routes. |
| `main.ts` | Loads settings and starts everything. |
| `scripts/export-openapi.ts` | Writes `openapi.json` to disk. |

## Assumptions

- ⚠️ Portal timestamps (`DD/MM/YYYY HH:mm`) are in IST (+05:30), because the portal does not say.
- The network is small (403 meters, 40 transformers), so the whole export fits in memory and a snapshot is cheap to rebuild.
- One shared portal account is enough for all API consumers.
- kWh and kVAh are cumulative registers that only go up, so usage per interval is the difference between readings.
- The transformer list is the portal's master record for the hierarchy, so it is used to repair damaged per-meter copies.
  - Example (made up to show the idea): the transformer list says `DT-001` belongs to feeder `F-001`, but meter `J100005` says `DT-001` belongs to feeder `F-009`. The API corrects the meter to `F-001` and records the fix in `dataQuality` on `/hierarchy`.
- The API runs locally and is only reachable from the same machine (it binds to 127.0.0.1), so it has no caller authentication.

## Design decisions and trade-offs

| Decision | Benefit | Trade-off |
|---|---|---|
| Layered files (portal → domain/hierarchy → store → app) | Easy to test, and the portal can be swapped | More files |
| In-memory snapshot instead of a database | Simple and fast for 403 meters | Data is lost on restart and it will not scale to 10,000+ meters |
| Normalised output (ISO/IST timestamps, `null` for blanks, de-duplication) | Clean data for consumers | The output differs from the portal's raw data |
| Hierarchy repaired from the transformer list | A consistent tree | Trusts that list over the per-meter copies |
| One shared portal login, no caller authentication | Simple | Only safe locally (bound to 127.0.0.1) |

**Example: hierarchy repair (made up to show the idea)**

- ✅ **Benefit:** the transformer list says `DT-001` is on feeder `F-001`, but meter `J100005` says `F-009`. The API fixes the meter to `F-001`, so the tree is consistent.
- ⚠️ **Trade-off:** if the transformer list is the one that is wrong and `DT-001` is really on `F-009`, the API still "fixes" the meter to `F-001`, so a correct meter becomes wrong.

## What I intentionally skipped, and why

- **Authentication for API callers:** the API runs locally (bound to 127.0.0.1) and uses one shared portal login.
- **A database or persistent storage:** an in-memory snapshot is enough for 403 meters.
- **Write endpoints:** the portal is read-only (all its calls are GET), so the API only reads.
- **Fixing the portal's export pagination bug:** it cannot be fixed from outside. It is documented in [PROTOCOL.md](./PROTOCOL.md) instead.
- **Confirming the portal's time zone:** the portal does not say, so IST is assumed.
- **Dashboard, theft and loss detection, outage analysis, PWA:** these go beyond the brief and are listed as future work.
- **Google Maps navigation:** meters already carry latitude and longitude, so a new employee could be guided to a meter on a map. Only meters have coordinates in the data I use, so substations and transformers would need their own location data first. This is listed as future work.

## 💡 What I would improve with more time

- **Authentication:** add API keys or login for callers of this API.
- **Persistent storage:** use a database or disk cache, so data survives restarts and the API scales past 10,000+ meters.
- **Background refresh:** refresh the snapshot on a timer, so no request waits on the portal.
- **Time zone:** confirm with the portal owner whether timestamps are IST or UTC.
- **Map navigation:** link meters to Google Maps (they already have latitude and longitude), and add locations for substations and transformers.
- **Analytics dashboard:** theft and loss detection (transformer kWh against the sum of its meters), outage isolation by feeder, and peak-load times by zone.
- **PWA:** cache API responses with a service worker.
- **Role-based export:** let each employee export only their own zone or sub-division, as suggested in [PROTOCOL.md](./PROTOCOL.md).

## Observations & improvement areas

More details and screenshots are in [PROTOCOL.md](./PROTOCOL.md).

While working with the portal and building this API, I noticed a few things worth calling out — some are bugs, some are security concerns, and some are missed opportunities with the data we already have.

### 1. 🚨 BUG: Export API ignores pagination — security and performance risk

🔴 The `/portal/export` endpoint accepts a `page` parameter, but it ignores it and always returns the full dataset in one response. Right now that is 403 meters, so it feels fine. But this does not scale, and it opens a real door for abuse. Details and suggested fixes are in 🔗 [PROTOCOL.md → Export API pagination bug](./PROTOCOL.md#export-pagination-bug).

### 2. ⚠️ BUG: the web portal does not redirect after session expiry

When the session cookie expires, the portal API correctly returns a `401`. But the web app does not react to that — it just sits there. A user is still looking at data they can no longer load, with no prompt to log in again. See 🔗 [PROTOCOL.md → Session bug](./PROTOCOL.md#session-bug).

### 3. 💡 IMPROVEMENT: the data we have is being under-used

The API already carries lat/long for every meter, a clean 7-level hierarchy, energy readings, and status information. That is enough to build something genuinely useful:

- **Theft and loss detection** — if a transformer delivers 1,000 kWh but its meters only record 800 kWh, the gap is visible immediately. With the map coordinates we can show exactly where on the grid this is happening.
- **Outage isolation** — a feeder trip would tell us exactly which transformers and meters lost power, without anyone needing to call in from the field.
- **Field navigation** — a newly joined technician with no local knowledge could open a map and walk straight to the meter. The coordinates are already there.

The companion web client I built demonstrates some of this using the public API data. The same ideas apply directly here once the data is connected to a proper dashboard.

## Reflection

My reflection answers are in [REFLECTION.md](./REFLECTION.md).

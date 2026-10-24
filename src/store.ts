// An in-memory copy of the portal, built from the bulk export, plus a
// short-lived cache of per-meter readings. The whole network is 403 meters,
// so a snapshot is cheap to rebuild and queries are plain array scans.
import {
  countMeters,
  LEVELS,
  toMeter,
  toReadings,
  type Level,
  type Meter,
  type Reading,
  type Transformer,
} from './domain.ts';
import { buildTree, resolveHierarchies, type Repair, type ReusedCode, type TreeNode } from './hierarchy.ts';
import type { PortalClient, RawExportMeter, RawTransformer } from './portal.ts';

export type PortalSource = Pick<PortalClient, 'exportMeters' | 'transformers' | 'readings'>;

export interface Snapshot {
  syncedAt: Date;
  meters: Meter[];
  byId: Map<string, Meter>;
  transformers: Transformer[];
  tree: TreeNode[];
  repairs: Repair[];
  reusedCodes: ReusedCode[];
}

export interface MeterReadings {
  fetchedAt: Date;
  rows: Reading[];
  duplicatesDropped: number;
}

// The portal's readings stop at 30 June 2026, so freshness barely matters;
// five minutes only spares it repeat calls for a meter someone is looking at.
const READINGS_TTL_MS = 5 * 60_000;

export class Store {
  readonly #portal: PortalSource;
  readonly #ttlMs: number;
  #current: Snapshot | null = null;
  #refreshing: Promise<Snapshot> | null = null;
  #lastError: string | null = null;
  // ponytail: unbounded, fine for 403 meters; use an LRU if the network grows.
  readonly #readings = new Map<string, MeterReadings>();

  constructor(portal: PortalSource, ttlMs = 15 * 60_000) {
    this.#portal = portal;
    this.#ttlMs = ttlMs;
  }

  get status() {
    return {
      syncedAt: this.#current?.syncedAt ?? null,
      meters: this.#current?.meters.length ?? 0,
      lastError: this.#lastError,
    };
  }

  /**
   * The current snapshot. The first call waits for a sync; after that a stale
   * snapshot is served at once while a refresh runs in the background, and a
   * failed refresh keeps the old snapshot.
   */
  async snapshot(): Promise<Snapshot> {
    const current = this.#current;
    if (!current) return this.refresh();
    if (Date.now() - current.syncedAt.getTime() >= this.#ttlMs) this.refresh().catch(() => {});
    return current;
  }

  refresh(): Promise<Snapshot> {
    this.#refreshing ??= Promise.all([this.#portal.exportMeters(), this.#portal.transformers()])
      .then(
        ([meters, transformers]) => {
          this.#current = buildSnapshot(meters, transformers);
          this.#lastError = null;
          return this.#current;
        },
        (err: Error) => {
          this.#lastError = err.message;
          throw err;
        },
      )
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  /** Readings for a meter, or null if the portal does not know it. Serves the last good answer if the portal fails. */
  async readings(meterId: string): Promise<MeterReadings | null> {
    const cached = this.#readings.get(meterId);
    if (cached && Date.now() - cached.fetchedAt.getTime() < READINGS_TTL_MS) return cached;
    try {
      const raw = await this.#portal.readings(meterId);
      if (raw === null) return null;
      const fresh = { fetchedAt: new Date(), ...toReadings(raw) };
      this.#readings.set(meterId, fresh);
      return fresh;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  }
}

export function buildSnapshot(raw: RawExportMeter[], rawTransformers: RawTransformer[], syncedAt = new Date()): Snapshot {
  const { byTransformer, repairs } = resolveHierarchies(raw, rawTransformers);
  const meters = raw.map((r) => toMeter(r, byTransformer.get(r.dtCode)!)).sort((a, b) => a.id.localeCompare(b.id));
  const metersByDt = Map.groupBy(meters, (m) => m.hierarchy.transformer.code);
  const listed = new Map(rawTransformers.map((t) => [t.code, t]));
  // Include transformers that only meters mention, as well as listed ones with no meters.
  const codes = [...new Set([...listed.keys(), ...metersByDt.keys()])].sort();
  const transformers = codes.map((code) => {
    const hierarchy = byTransformer.get(code) ?? null;
    return {
      code,
      name: listed.get(code)?.name ?? hierarchy?.transformer.name ?? '',
      capacityKva: listed.get(code)?.capacityKva ?? null,
      hierarchy,
      meters: countMeters(metersByDt.get(code) ?? []),
    };
  });
  const { tree, reusedCodes } = buildTree(meters);
  return { syncedAt, meters, byId: new Map(meters.map((m) => [m.id, m])), transformers, tree, repairs, reusedCodes };
}

export interface MeterFilter extends Partial<Record<Level, string>> {
  q?: string;
  path?: string;
  status?: Meter['status'];
  phase?: Meter['phase'];
  installType?: Meter['installType'];
  make?: string;
  near?: { lat: number; lng: number };
  radiusKm?: number;
}

/** Filters meters. With `near`, keeps those within `radiusKm` and sorts nearest first. */
export function findMeters(meters: Meter[], f: MeterFilter): Array<Meter & { distanceKm?: number }> {
  const text = f.q?.toLowerCase();
  const make = f.make?.toLowerCase();
  const matches = meters.filter(
    (m) =>
      (!text || m.id.toLowerCase().includes(text) || m.serialNo.toLowerCase().includes(text)) &&
      (!f.status || m.status === f.status) &&
      (!f.phase || m.phase === f.phase) &&
      (!f.installType || m.installType === f.installType) &&
      (!make || m.make.toLowerCase() === make) &&
      LEVELS.every((level) => !f[level] || m.hierarchy[level].code === f[level]) &&
      (!f.path || `${pathOf(m)}/`.startsWith(`${f.path}/`)),
  );
  const { near } = f;
  if (!near) return matches;
  // ponytail: a linear scan, fine to ~100k meters; past that use a spatial index (PostGIS, SQLite R*Tree).
  return matches
    .map((m) => ({ ...m, distanceKm: Math.round(distanceKm(near, m.location) * 1000) / 1000 }))
    .filter((m) => m.distanceKm <= (f.radiusKm ?? 1))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** The meter's place as a path of codes, e.g. "Z-01/C-01/D-01/SD-01/SS-01/F-001/DT-001". */
export const pathOf = (m: Meter) => LEVELS.map((level) => m.hierarchy[level].code).join('/');

/** Great-circle distance (haversine). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// The clean shapes this API serves, and the functions that turn raw portal
// records into them. The TypeBox schemas are the single source for the
// TypeScript types, request validation and openapi.json.
import { Type, type Static } from 'typebox';
import { PortalError, type RawExportMeter, type RawReading } from './portal.ts';

export const LEVELS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'transformer'] as const;
export type Level = (typeof LEVELS)[number];

const NodeRef = Type.Object({ code: Type.String(), name: Type.String() });

export const Hierarchy = Type.Object(
  {
    zone: NodeRef,
    circle: NodeRef,
    division: NodeRef,
    subdivision: NodeRef,
    substation: NodeRef,
    feeder: NodeRef,
    transformer: NodeRef,
  },
  { description: 'Where the meter sits in the network, from zone down to its distribution transformer.' },
);
export type Hierarchy = Static<typeof Hierarchy>;

export const Status = Type.Enum(['installed', 'faulty', 'decommissioned']);
export const Phase = Type.Enum(['single', 'three']);
export const InstallType = Type.Enum(['whole_current', 'ct_operated']);

export const Meter = Type.Object({
  id: Type.String({ examples: ['J100000'] }),
  serialNo: Type.String({ examples: ['SE33962'] }),
  make: Type.String({ examples: ['HPL'] }),
  phase: Phase,
  status: Status,
  installType: InstallType,
  location: Type.Object({ lat: Type.Number(), lng: Type.Number() }),
  hierarchy: Hierarchy,
});
export type Meter = Static<typeof Meter>;

export const MeterCounts = Type.Object({
  total: Type.Integer(),
  installed: Type.Integer(),
  faulty: Type.Integer(),
  decommissioned: Type.Integer(),
});
export type MeterCounts = Static<typeof MeterCounts>;

export const Transformer = Type.Object({
  code: Type.String({ examples: ['DT-001'] }),
  name: Type.String({ examples: ['Malviya Nagar DT 1'] }),
  capacityKva: Type.Union([Type.Number(), Type.Null()], { description: 'Null when the portal lists no capacity.' }),
  hierarchy: Type.Union([Hierarchy, Type.Null()], { description: 'Null when no meter tells us where it sits.' }),
  meters: MeterCounts,
});
export type Transformer = Static<typeof Transformer>;

export const Reading = Type.Object({
  timestamp: Type.String({
    format: 'date-time',
    description: 'India Standard Time (+05:30). The portal sends DD/MM/YYYY HH:mm with no time zone.',
  }),
  kwhCumulative: nullableNumber('Active energy register in kWh. It only goes up. Null when the portal sent it blank.'),
  kvahCumulative: nullableNumber('Apparent energy register in kVAh. It only goes up. Null when the portal sent it blank.'),
  voltageR: nullableNumber('R-phase voltage in volts. Null when the portal sent it blank.'),
  kwhUsed: nullableNumber(
    'kWh used since the previous reading that had a kWh value. Null for the first reading, when this one has no kWh value, and if the register went backwards.',
  ),
});
export type Reading = Static<typeof Reading>;

function nullableNumber(description: string) {
  return Type.Union([Type.Number(), Type.Null()], { description });
}

/** Lowercase, underscored: "CT Operated" becomes "ct_operated". */
const slug = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '_');

export function toMeter(raw: RawExportMeter, hierarchy: Hierarchy): Meter {
  return {
    id: raw.meterId,
    serialNo: raw.serialNo,
    make: raw.make,
    phase: slug(raw.phaseType) as Meter['phase'],
    status: slug(raw.installStatus) as Meter['status'],
    installType: slug(raw.installType) as Meter['installType'],
    location: { lat: raw.geo.lat, lng: raw.geo.lng },
    hierarchy,
  };
}

export function countMeters(meters: Meter[]): MeterCounts {
  const counts = { total: 0, installed: 0, faulty: 0, decommissioned: 0 };
  for (const m of meters) {
    counts.total++;
    counts[m.status]++;
  }
  return counts;
}

/** "24/06/2026 05:30" becomes "2026-06-24T05:30:00+05:30". The meters are in Jaipur, so we read them as IST. */
export function portalTimeToIso(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value.trim());
  const iso = match && `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+05:30`;
  if (!iso || Number.isNaN(Date.parse(iso))) throw new PortalError(`Unexpected reading timestamp "${value}"`);
  return iso;
}

/**
 * Clean, sorted readings. Some meters send a second, half-blank row for the
 * same timestamp, so one row is kept per timestamp: the one with the fewest blanks.
 */
export function toReadings(raw: RawReading[]): { rows: Reading[]; duplicatesDropped: number } {
  const byTime = new Map<string, Omit<Reading, 'kwhUsed'>>();
  for (const r of raw) {
    const row = {
      timestamp: portalTimeToIso(r.timestamp),
      kwhCumulative: toNumber(r.kwh),
      kvahCumulative: toNumber(r.kvah),
      voltageR: toNumber(r.voltR),
    };
    const kept = byTime.get(row.timestamp);
    if (!kept || blanks(row) < blanks(kept)) byTime.set(row.timestamp, row);
  }
  const sorted = [...byTime.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let lastKwh: number | null = null;
  const rows = sorted.map((row) => {
    const kwh = row.kwhCumulative;
    const used = kwh === null || lastKwh === null ? null : round2(kwh - lastKwh);
    if (kwh !== null) lastKwh = kwh;
    // A register that goes backwards means a reset or a swapped meter, not negative use.
    return { ...row, kwhUsed: used !== null && used < 0 ? null : used };
  });
  return { rows, duplicatesDropped: raw.length - rows.length };
}

const blanks = (row: object) => Object.values(row).filter((v) => v === null).length;

/** The usual gap between readings, in minutes: 30 for interval meters, 1440 for daily ones. */
export function intervalMinutes(readings: Reading[]): number | null {
  const gaps = readings.slice(1).map((r, i) => (Date.parse(r.timestamp) - Date.parse(readings[i]!.timestamp)) / 60_000);
  if (gaps.length === 0) return null;
  return gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
}

/** Blank becomes null, as the portal does send blanks. Anything else that is not a number is a format change, so it fails loudly. */
function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) throw new PortalError(`Unexpected reading value "${value}"`);
  return n;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

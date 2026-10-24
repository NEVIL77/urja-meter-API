// Small hand-made portal data with the same kinds of damage the real export has.
import { PORTAL_LEVELS, type PortalLevel, type RawExportMeter, type RawReading, type RawTransformer } from '../src/portal.ts';

type Path = Record<PortalLevel, [code: string, name: string]>;

const PATH_A: Path = {
  zone: ['Z-01', 'Jaipur Zone 1'],
  circle: ['C-01', 'Circle 1'],
  division: ['D-01', 'Division 1'],
  subdivision: ['SD-01', 'Subdivision 1'],
  substation: ['SS-01', 'Substation 1'],
  feeder: ['F-001', 'Feeder 1'],
  dt: ['DT-001', 'Malviya Nagar DT 1'],
};

// Feeder F-001 again, but under a different substation: the portal reuses codes like this.
const PATH_B: Path = {
  ...PATH_A,
  division: ['D-02', 'Division 2'],
  subdivision: ['SD-02', 'Subdivision 2'],
  substation: ['SS-02', 'Substation 2'],
  dt: ['DT-002', 'Mansarovar DT 2'],
};

function meter(
  meterId: string,
  path: Path,
  fields: Partial<RawExportMeter>,
  damage?: Partial<Record<PortalLevel, Partial<{ code: string; name: string }>>>,
): RawExportMeter {
  const hierarchy = Object.fromEntries(
    PORTAL_LEVELS.map((l) => [l, { code: path[l][0], name: path[l][1], ...damage?.[l] }]),
  ) as RawExportMeter['hierarchy'];
  return {
    meterId,
    serialNo: `SE${meterId.slice(-5)}`,
    make: 'Genus',
    phaseType: 'single',
    installStatus: 'Installed',
    installType: 'Whole Current',
    dtCode: path.dt[0],
    build: 'legacy',
    geo: { lat: 26.9, lng: 75.8 },
    hierarchy,
    ...fields,
  };
}

export const rawMeters: RawExportMeter[] = [
  meter('J100000', PATH_A, { geo: { lat: 26.9, lng: 75.8 } }),
  meter('J100001', PATH_A, { installStatus: 'Faulty', geo: { lat: 26.91, lng: 75.8 } }),
  meter('J100002', PATH_A, { make: 'HPL', phaseType: 'three', geo: { lat: 27.0, lng: 75.9 } }, { circle: { code: '' } }),
  meter('J100003', PATH_B, { installStatus: 'Decommissioned', installType: 'CT Operated', build: 'v2' }, { dt: { name: 'Old Mansarovar Xfmr' } }),
  meter('J100004', PATH_B, { build: 'v2' }, { feeder: { name: '' } }),
  meter('J100005', PATH_B, { build: 'v2' }),
];

export const rawTransformers: RawTransformer[] = [
  { code: 'DT-001', name: 'Malviya Nagar DT 1', feederCode: 'F-001', capacityKva: 100 },
  { code: 'DT-002', name: 'Mansarovar DT 2', feederCode: 'F-001', capacityKva: 63 },
  { code: 'DT-003', name: 'Vaishali DT 3', feederCode: 'F-003', capacityKva: 250 },
];

// Deliberately out of order, as nothing in the portal promises order.
export const rawReadings: RawReading[] = [
  { timestamp: '24/06/2026 00:30', kwh: '100.84', kvah: '110.5', voltR: '229' },
  { timestamp: '24/06/2026 00:00', kwh: '100.42', kvah: '110', voltR: '230' },
  { timestamp: '24/06/2026 01:00', kwh: '101.26', kvah: '111', voltR: '228' },
];

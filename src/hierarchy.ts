// Rebuilds the network hierarchy from the portal's messy per-meter copies of it.
import { Type, type Static, type TSchema } from 'typebox';
import { countMeters, LEVELS, MeterCounts, type Hierarchy, type Level, type Meter } from './domain.ts';
import { PORTAL_LEVELS, type RawExportMeter, type RawTransformer } from './portal.ts';

const LevelEnum = Type.Enum([...LEVELS]);

export const Repair = Type.Object({
  meterId: Type.String(),
  level: LevelEnum,
  field: Type.Enum(['code', 'name']),
  portalValue: Type.String(),
  resolvedTo: Type.String(),
});
export type Repair = Static<typeof Repair>;

/**
 * The portal repeats the whole hierarchy on every meter, and some copies are
 * damaged: a blank code, a blank name, or an old transformer name. All meters
 * on one transformer share one path, so per transformer and level we take the
 * most common non-blank value. Transformer names come from the transformer
 * list, which is the portal's master record for them.
 */
export function resolveHierarchies(
  raw: RawExportMeter[],
  transformers: RawTransformer[],
): { byTransformer: Map<string, Hierarchy>; repairs: Repair[] } {
  const masterNames = new Map(transformers.map((t) => [t.code, t.name]));
  const byTransformer = new Map<string, Hierarchy>();
  for (const [dtCode, meters] of Map.groupBy(raw, (m) => m.dtCode)) {
    const hierarchy = {} as Hierarchy;
    LEVELS.forEach((level, i) => {
      const copies = meters.map((m) => m.hierarchy[PORTAL_LEVELS[i]!]);
      hierarchy[level] = {
        code: level === 'transformer' ? dtCode : mostCommon(copies.map((c) => c.code)),
        name: (level === 'transformer' && masterNames.get(dtCode)) || mostCommon(copies.map((c) => c.name)),
      };
    });
    byTransformer.set(dtCode, hierarchy);
  }

  const repairs: Repair[] = [];
  for (const m of raw) {
    const resolved = byTransformer.get(m.dtCode)!;
    LEVELS.forEach((level, i) => {
      const copy = m.hierarchy[PORTAL_LEVELS[i]!];
      for (const field of ['code', 'name'] as const) {
        if (copy[field] !== resolved[level][field]) {
          repairs.push({ meterId: m.meterId, level, field, portalValue: copy[field], resolvedTo: resolved[level][field] });
        }
      }
    });
  }
  return { byTransformer, repairs };
}

export interface TreeNode {
  level: Level;
  code: string;
  name: string;
  /** Codes from the zone down, joined with "/". Codes repeat across branches, so this is the real identity. */
  path: string;
  meters: MeterCounts;
  children: TreeNode[];
}

export const ReusedCode = Type.Object({
  level: LevelEnum,
  code: Type.String(),
  parents: Type.Array(Type.String(), { description: 'Paths of the different parents this code appears under.' }),
});
export type ReusedCode = Static<typeof ReusedCode>;

export function buildTree(meters: Meter[]): { tree: TreeNode[]; reusedCodes: ReusedCode[] } {
  const roots: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();
  for (const meter of meters) {
    let siblings = roots;
    let path = '';
    for (const level of LEVELS) {
      const { code, name } = meter.hierarchy[level];
      path = path ? `${path}/${code}` : code;
      let node = nodes.get(path);
      if (!node) {
        node = { level, code, name, path, meters: countMeters([]), children: [] };
        nodes.set(path, node);
        siblings.push(node);
      }
      node.meters.total++;
      node.meters[meter.status]++;
      siblings = node.children;
    }
  }
  sortTree(roots);

  // A real feeder hangs off one substation, yet the portal files F-001 under
  // two of them, and SD-01 under three divisions. We report these instead of guessing.
  const parentsOf = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    if (node.level === 'zone') continue;
    const key = `${node.level}\u0000${node.code}`;
    const parents = parentsOf.get(key) ?? new Set<string>();
    parents.add(node.path.slice(0, node.path.lastIndexOf('/')));
    parentsOf.set(key, parents);
  }
  const reusedCodes = [...parentsOf]
    .filter(([, parents]) => parents.size > 1)
    .map(([key, parents]) => {
      const [level, code] = key.split('\u0000') as [Level, string];
      return { level, code, parents: [...parents].sort(byCode) };
    });
  return { tree: roots, reusedCodes };
}

/** The tree's JSON Schema. Depth is fixed at seven levels, so it is spelled out rather than recursive. */
export function treeNodeSchema(depth = 0): TSchema {
  const last = depth === LEVELS.length - 1;
  return Type.Object({
    level: Type.Literal(LEVELS[depth]!),
    code: Type.String(),
    name: Type.String(),
    path: Type.String({ description: 'Codes from the zone down, joined with "/". Use this, not code, to identify a node.' }),
    meters: MeterCounts,
    children: last ? Type.Array(Type.Unknown(), { maxItems: 0 }) : Type.Array(treeNodeSchema(depth + 1)),
  });
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values.map((s) => s.trim()).filter(Boolean)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  for (const [value, n] of counts) if (n > (counts.get(best) ?? 0)) best = value;
  return best;
}

const byCode = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => byCode(a.code, b.code));
  for (const n of nodes) sortTree(n.children);
}

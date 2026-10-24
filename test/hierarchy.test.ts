import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSnapshot } from '../src/store.ts';
import { rawMeters, rawTransformers } from './fixtures.ts';

test('damaged hierarchy copies are repaired from the other meters on the same transformer', () => {
  const s = buildSnapshot(rawMeters, rawTransformers);
  assert.deepEqual(s.byId.get('J100002')!.hierarchy.circle, { code: 'C-01', name: 'Circle 1' });
  assert.deepEqual(s.byId.get('J100004')!.hierarchy.feeder, { code: 'F-001', name: 'Feeder 1' });
  // The transformer list is the master record for transformer names.
  assert.equal(s.byId.get('J100003')!.hierarchy.transformer.name, 'Mansarovar DT 2');
  assert.deepEqual(
    s.repairs.map((r) => [r.meterId, r.level, r.field, r.portalValue, r.resolvedTo]),
    [
      ['J100002', 'circle', 'code', '', 'C-01'],
      ['J100003', 'transformer', 'name', 'Old Mansarovar Xfmr', 'Mansarovar DT 2'],
      ['J100004', 'feeder', 'name', '', 'Feeder 1'],
    ],
  );
});

test('the tree counts meters at every level and flags codes filed under two parents', () => {
  const { tree, reusedCodes } = buildSnapshot(rawMeters, rawTransformers);
  assert.equal(tree.length, 1);
  const zone = tree[0]!;
  assert.deepEqual(zone.meters, { total: 6, installed: 4, faulty: 1, decommissioned: 1 });
  assert.deepEqual(zone.children[0]!.children.map((d) => d.path), ['Z-01/C-01/D-01', 'Z-01/C-01/D-02']);
  assert.deepEqual(reusedCodes, [
    { level: 'feeder', code: 'F-001', parents: ['Z-01/C-01/D-01/SD-01/SS-01', 'Z-01/C-01/D-02/SD-02/SS-02'] },
  ]);
});

test('transformers include capacity and meter counts, and listed ones with no meters', () => {
  const { transformers } = buildSnapshot(rawMeters, rawTransformers);
  assert.deepEqual(
    transformers.map((t) => [t.code, t.capacityKva, t.meters.total, t.hierarchy?.feeder.code ?? null]),
    [
      ['DT-001', 100, 3, 'F-001'],
      ['DT-002', 63, 3, 'F-001'],
      ['DT-003', 250, 0, null],
    ],
  );
});

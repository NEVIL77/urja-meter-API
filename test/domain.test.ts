import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intervalMinutes, portalTimeToIso, toReadings } from '../src/domain.ts';
import { rawReadings } from './fixtures.ts';

const row = (timestamp: string, kwh: string, voltR = '230') => ({ timestamp, kwh, kvah: '1', voltR });

test('portal timestamps become ISO 8601 in IST', () => {
  assert.equal(portalTimeToIso('24/06/2026 05:30'), '2026-06-24T05:30:00+05:30');
  assert.throws(() => portalTimeToIso('2026-06-24 05:30'), /Unexpected reading timestamp/);
  assert.throws(() => portalTimeToIso('31/13/2026 05:30'), /Unexpected reading timestamp/);
});

test('readings are sorted, numeric, and carry the kWh used since the previous one', () => {
  const { rows } = toReadings(rawReadings);
  assert.deepEqual(
    rows.map((r) => [r.timestamp, r.kwhCumulative, r.kwhUsed]),
    [
      ['2026-06-24T00:00:00+05:30', 100.42, null],
      ['2026-06-24T00:30:00+05:30', 100.84, 0.42],
      ['2026-06-24T01:00:00+05:30', 101.26, 0.42],
    ],
  );
  assert.equal(rows[0]!.voltageR, 230);
  assert.equal(intervalMinutes(rows), 30);
});

test('a half-blank duplicate row is dropped in favour of the complete one', () => {
  // As sent for J100089: a second 30/06 row with kwh and voltR blank.
  const { rows, duplicatesDropped } = toReadings([
    row('29/06/2026 00:00', '12724.7'),
    row('30/06/2026 00:00', '', ''),
    row('30/06/2026 00:00', '12732.34', '229'),
  ]);
  assert.equal(duplicatesDropped, 1);
  assert.deepEqual(rows.map((r) => [r.kwhCumulative, r.voltageR, r.kwhUsed]), [
    [12724.7, 230, null],
    [12732.34, 229, 7.64],
  ]);
});

test('a blank value is null, and usage bridges it from the last known register', () => {
  const { rows } = toReadings([row('24/06/2026 00:00', '10'), row('25/06/2026 00:00', ''), row('26/06/2026 00:00', '13')]);
  assert.deepEqual(rows.map((r) => r.kwhUsed), [null, null, 3]);
});

test('a register that goes backwards is not negative use', () => {
  const { rows } = toReadings([row('24/06/2026 00:00', '500'), row('25/06/2026 00:00', '3')]);
  assert.equal(rows[1]!.kwhUsed, null);
  assert.equal(intervalMinutes(rows), 1440);
});

test('a value that is neither blank nor a number fails loudly', () => {
  assert.throws(() => toReadings([row('24/06/2026 00:00', 'N/A')]), /Unexpected reading value/);
});

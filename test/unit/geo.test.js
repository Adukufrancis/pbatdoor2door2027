import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGeoIndex, nearest, nearestBruteForce, MAX_METRES } from '../../geo.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'geo');
const idx = loadGeoIndex(dir);

test('loads every polling unit that has GPS', () => {
  assert.ok(idx.size > 160_000, `only ${idx.size} units`);
});

test('grid lookup returns exactly what the original linear scan returns', () => {
  // Random points across Nigeria's bounding box, plus points at real units and far outside.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const points = [[6.5244, 3.3792], [9.0765, 7.3986], [5.5167, 5.75], [0, 0], [51.5, -0.12], [13.9, 14.6]];
  for (let i = 0; i < 300; i++) points.push([4 + rand() * 10, 2.7 + rand() * 12]);
  for (let i = 0; i < 50; i++) { const j = Math.floor(rand() * idx.size); points.push([idx.lat[j] + 0.001, idx.lng[j] - 0.001]); }
  for (const [lat, lng] of points) {
    assert.deepEqual(nearest(idx, lat, lng), nearestBruteForce(idx, lat, lng), `mismatch at ${lat},${lng}`);
  }
});

test('results are sorted, at most six, and within range', () => {
  const r = nearest(idx, 6.5244, 3.3792);
  assert.ok(r.length > 0 && r.length <= 6);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].metres <= r[i].metres);
  for (const u of r) { assert.ok(u.metres < MAX_METRES); assert.equal(u.state, 'Lagos'); }
});

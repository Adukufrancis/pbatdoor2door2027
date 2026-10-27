// "Polling units near me": an in-memory index of every polling unit that has GPS.
// public/geo/<state>.json holds INEC's state > LGA > ward > polling unit lists; each unit is
// [name, code, lat, lng] (lat/lng missing where INEC has no location).
//
// Points are bucketed into CELL-degree grid cells. CELL is larger than MAX_METRES in degrees
// (25 km ≈ 0.225° of latitude, ≈ 0.23° of longitude at Nigeria's latitudes), so the 3×3 cells
// around a query always contain every unit within MAX_METRES.
import fs from 'node:fs';
import path from 'node:path';

const CELL = 0.25;
const RESULTS = 6;
export const MAX_METRES = 25000;
const METRES_PER_DEGREE = 111320;

const cellKey = (cy, cx) => cy * 100000 + cx;

export function loadGeoIndex(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const lat = [], lng = [], ref = [];
  for (const [state, slug] of Object.entries(index)) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${slug}.json`), 'utf8'));
    for (const L of data.lgas) for (const W of L.w) for (const P of W.p) {
      if (P.length < 4) continue;
      lat.push(P[2]); lng.push(P[3]); ref.push([state, L.n, W.n, P[0], P[1]]);
    }
  }
  return buildIndex(lat, lng, ref);
}

export function buildIndex(latArr, lngArr, ref) {
  const lat = Float64Array.from(latArr), lng = Float64Array.from(lngArr);
  const cells = new Map();
  for (let i = 0; i < lat.length; i++) {
    const k = cellKey(Math.floor(lat[i] / CELL), Math.floor(lng[i] / CELL));
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(i);
  }
  return { lat, lng, ref, cells, size: lat.length };
}

function consider(best, d, i) {
  if (best.length < RESULTS || d < best[best.length - 1][0]) {
    best.push([d, i]); best.sort((a, b) => a[0] - b[0]); if (best.length > RESULTS) best.pop();
  }
}

function format(idx, best) {
  return best.map(([d, i]) => {
    const [state, lga, ward, name, code] = idx.ref[i];
    return { state, lga, ward, name, code, metres: Math.round(Math.sqrt(d) * METRES_PER_DEGREE) };
  }).filter((r) => r.metres < MAX_METRES);
}

/** Up to six nearest polling units within MAX_METRES, closest first. */
export function nearest(idx, qlat, qlng) {
  const k = Math.cos((qlat * Math.PI) / 180);
  const cy = Math.floor(qlat / CELL), cx = Math.floor(qlng / CELL);
  const best = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const list = idx.cells.get(cellKey(cy + dy, cx + dx));
    if (!list) continue;
    for (const i of list) {
      const ay = idx.lat[i] - qlat, ax = (idx.lng[i] - qlng) * k;
      consider(best, ay * ay + ax * ax, i);
    }
  }
  return format(idx, best);
}

/** Reference implementation (the original linear scan), used by the tests. */
export function nearestBruteForce(idx, qlat, qlng) {
  const k = Math.cos((qlat * Math.PI) / 180);
  const best = [];
  for (let i = 0; i < idx.size; i++) {
    const ay = idx.lat[i] - qlat, ax = (idx.lng[i] - qlng) * k;
    consider(best, ay * ay + ax * ax, i);
  }
  return format(idx, best);
}

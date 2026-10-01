import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLayout,
  clampTableSeats,
  placePose,
  routeBetween,
  samePlace,
  tableSeatDemand,
  MAX_COLS,
  MAX_TABLE_SEATS,
  MIN_TABLES,
  MIN_TABLE_SEATS,
  type OfficeLayout,
  type Place,
} from '../src/renderer/office3d/layout';

const layoutOf = (director = 1, pm = 4, worker = 1, tables = 2, tableSeats = 6) =>
  buildLayout({ director, pm, worker, tables, tableSeats });

test('buildLayout seats every agent once and keeps vacant desks distinct', () => {
  const layout = layoutOf(1, 4, 2);
  assert.equal(layout.desks.length, 1 + 4 + 2);
  assert.equal(new Set(layout.desks.map(d => `${d.x}|${d.z}`)).size, layout.desks.length, 'no two desks overlap');
  assert.deepEqual(
    layout.desks.map(d => d.zone),
    ['director', 'pm', 'pm', 'pm', 'pm', 'worker', 'worker'],
  );
  assert.ok(layout.desks.every(d => !d.vacant));
});

test('a zone with nobody in it keeps one vacant desk, and an empty office shows four', () => {
  const missing = layoutOf(0, 2, 0);
  assert.deepEqual(
    missing.desks.map(d => [d.zone, d.vacant]),
    [
      ['director', true],
      ['pm', false],
      ['pm', false],
      ['worker', true],
    ],
  );
  const empty = buildLayout({ director: 0, pm: 0, worker: 0, tables: 0, tableSeats: 0, empty: true });
  assert.equal(empty.desks.length, 4);
  assert.ok(empty.desks.every(d => d.zone === 'worker' && d.vacant));
});

test('desk rows wrap at MAX_COLS and rows never overlap', () => {
  const layout = layoutOf(1, 4, 12);
  const workers = layout.desks.filter(d => d.zone === 'worker');
  assert.equal(new Set(workers.map(d => d.x)).size, MAX_COLS);
  const rows = [...new Set(layout.desks.map(d => d.z))].sort((a, b) => a - b);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i] - rows[i - 1] >= 2.9, 'rows leave room for chair + aisle');
});

test('the floor grows with the team and always fits every desk, table and the corridor', () => {
  const small = layoutOf(1, 1, 1);
  const large = layoutOf(1, 4, 30, 5, 12);
  assert.ok(large.bounds.maxZ > small.bounds.maxZ);
  for (const layout of [small, large]) {
    for (const d of layout.desks) {
      assert.ok(d.x < layout.corridorX && d.seat.z < layout.bounds.maxZ);
      assert.ok(d.aisleZ > d.seat.z, 'the aisle is on the chair side of the desk');
    }
    for (const t of layout.tables) {
      assert.ok(t.x - t.radius > layout.corridorX);
      assert.ok(t.x + t.radius < layout.bounds.maxX && t.z + t.radius < layout.bounds.maxZ);
    }
  }
});

test('meeting tables: at least two, chairs clamp, every chair faces the table centre', () => {
  assert.equal(layoutOf(1, 1, 1, 0, 0).tables.length, MIN_TABLES);
  assert.equal(clampTableSeats(1), MIN_TABLE_SEATS);
  assert.equal(clampTableSeats(7), 8);
  assert.equal(clampTableSeats(99), MAX_TABLE_SEATS);
  assert.equal(tableSeatDemand([3, 9, 5]), 10);
  assert.equal(tableSeatDemand([]), MIN_TABLE_SEATS);
  const layout = layoutOf(1, 1, 1, 3, 10);
  assert.equal(layout.tables.length, 3);
  for (const table of layout.tables) {
    assert.equal(table.seats.length, 10);
    for (const s of table.seats) {
      const toCentre = Math.atan2(table.x - s.seat.x, table.z - s.seat.z);
      assert.ok(Math.abs(Math.atan2(Math.sin(toCentre - s.yaw), Math.cos(toCentre - s.yaw))) < 1e-9);
    }
  }
});

const desk = (layout: OfficeLayout, i: number): Place => ({ kind: 'desk', desk: layout.desks[i] });
const chair = (layout: OfficeLayout, t: number, s: number): Place => ({
  kind: 'table',
  table: layout.tables[t],
  seat: s,
});

/** A route may run along aisles, the corridor and table lanes/rings — never through a desk. */
function crossesDesk(layout: OfficeLayout, a: { x: number; z: number }, b: { x: number; z: number }) {
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const z = a.z + ((b.z - a.z) * i) / steps;
    for (const d of layout.desks) if (Math.abs(x - d.x) < 0.78 && Math.abs(z - d.z) < 0.36) return true;
  }
  return false;
}

test('routes start in the origin seat, end in the destination seat and never cross a desk', () => {
  const layout = layoutOf(1, 4, 6, 2, 8);
  for (let i = 0; i < layout.desks.length; i++)
    for (const [t, s] of [
      [0, 0],
      [0, 5],
      [1, 3],
    ] as const) {
      for (const [from, to] of [
        [desk(layout, i), chair(layout, t, s)],
        [chair(layout, t, s), desk(layout, i)],
      ]) {
        const route = routeBetween(layout, from, to);
        const first = route.points[0];
        const last = route.points.at(-1)!;
        assert.deepEqual(first, placePose(from).pos);
        assert.deepEqual(last, placePose(to).pos);
        for (let k = 1; k < route.points.length; k++)
          assert.ok(!crossesDesk(layout, route.points[k - 1], route.points[k]), `desk ${i} leg ${k}`);
        assert.ok(route.length > 0 && Number.isFinite(route.length));
      }
    }
});

test('desk to desk on one aisle slides along the aisle without visiting the corridor', () => {
  const layout = layoutOf(1, 4, 1);
  const pm = layout.desks.filter(d => d.zone === 'pm');
  const route = routeBetween(layout, { kind: 'desk', desk: pm[0] }, { kind: 'desk', desk: pm[3] });
  assert.ok(route.points.every(p => p.x < layout.corridorX));
});

test('samePlace tells identical seats from different ones', () => {
  const layout = layoutOf(1, 2, 2, 2, 6);
  assert.ok(samePlace(desk(layout, 0), desk(layout, 0)));
  assert.ok(!samePlace(desk(layout, 0), desk(layout, 1)));
  assert.ok(samePlace(chair(layout, 1, 2), chair(layout, 1, 2)));
  assert.ok(!samePlace(chair(layout, 1, 2), chair(layout, 0, 2)));
  assert.ok(!samePlace(desk(layout, 0), chair(layout, 0, 0)));
});

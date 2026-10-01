/**
 * The 3D office floor plan, as pure data. World units are metres, +x is right, +z is toward the
 * viewer in the default camera and y is up (the engine owns y). Everything the scene draws or an
 * avatar walks to comes from here, so the floor plan and the walking routes cannot drift apart and
 * both can be unit-tested without a GPU.
 */
export type ZoneKey = 'director' | 'pm' | 'worker';

export interface Vec2 {
  x: number;
  z: number;
}
export interface DeskSlot {
  index: number;
  zone: ZoneKey;
  /** Position within its zone, in join order. */
  order: number;
  /** Desk centre. The person sits on the +z side, facing -z, so the screen faces the default camera. */
  x: number;
  z: number;
  /** Where the person's hips rest when seated. */
  seat: Vec2;
  /** The aisle point in front of the chair — where a person stands before walking away. */
  approach: Vec2;
  /** The row's aisle line (constant z). */
  aisleZ: number;
  vacant: boolean;
}
export interface TableSeat {
  seat: Vec2;
  /** Angle around the table centre (radians, 0 = +x, π/2 = +z). */
  angle: number;
  /** Yaw that makes the person face the table centre. */
  yaw: number;
}
export interface MeetingTable {
  index: number;
  x: number;
  z: number;
  radius: number;
  seats: TableSeat[];
  /** Horizontal lane north of this table's row; people reach the table from it. */
  laneZ: number;
  /** Where the lane meets the table's walking ring (north of the table). */
  gate: Vec2;
}
export interface ZoneSign {
  key: ZoneKey;
  text: string;
  x: number;
  z: number;
  width: number;
}
export interface OfficeLayout {
  desks: DeskSlot[];
  tables: MeetingTable[];
  signs: ZoneSign[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Vertical corridor between the work area and the meeting wing. */
  corridorX: number;
  /** Where the lounge / amenities begin (right of the corridor). */
  wing: { x0: number; x1: number; z0: number; z1: number };
}
export interface LayoutInput {
  director: number;
  pm: number;
  worker: number;
  /** Meeting tables to draw (at least 2 — empty rooms stay visible). */
  tables: number;
  /** Chairs per table (the largest meeting present, clamped). */
  tableSeats: number;
  /** No agents at all: four vacant worker desks, no director or PM row. */
  empty?: boolean;
}

export const POD = { x: 2.5, z: 3.0 } as const;
export const MAX_COLS = 5;
export const FIRST_DESK_X = 2.6;
export const FIRST_DESK_Z = 1.9;
export const ZONE_GAP = 0.9;
export const MIN_TABLES = 2;
export const FIRST_TABLE_Z = 4.4;
export const MIN_TABLE_SEATS = 6;
export const MAX_TABLE_SEATS = 16;
/** Distance from a table's edge to the lane people walk along to reach it. */
export const LANE_OFFSET = 1.7;
/** How far outside the table edge the walking ring runs (outside the chairs). */
export const RING_OFFSET = 1.35;

const ZONE_TEXT: Record<ZoneKey, string> = {
  director: 'DIRECTOR',
  pm: 'PROJECT MANAGERS',
  worker: 'WORKERS',
};

export function clampTableSeats(people: number): number {
  const even = Math.ceil(Math.max(0, people) / 2) * 2;
  return Math.min(MAX_TABLE_SEATS, Math.max(MIN_TABLE_SEATS, even));
}

export function buildLayout(input: LayoutInput): OfficeLayout {
  const zones: { key: ZoneKey; count: number }[] = input.empty
    ? [{ key: 'worker', count: 4 }]
    : (
        [
          ['director', input.director],
          ['pm', input.pm],
          ['worker', input.worker],
        ] as const
      ).map(([key, n]) => ({ key, count: Math.max(1, n) }));
  const desks: DeskSlot[] = [];
  const signs: ZoneSign[] = [];
  let z = FIRST_DESK_Z;
  let widestCols = 3;
  for (const zone of zones) {
    const cols = Math.min(zone.count, MAX_COLS);
    widestCols = Math.max(widestCols, cols);
    const rows = Math.ceil(zone.count / cols);
    signs.push({ key: zone.key, text: ZONE_TEXT[zone.key], x: FIRST_DESK_X - 1.5, z: z - 1.3, width: 4.6 });
    for (let order = 0; order < zone.count; order++) {
      const col = order % cols;
      const row = Math.floor(order / cols);
      const x = FIRST_DESK_X + col * POD.x;
      const dz = z + row * POD.z;
      const vacant = input.empty
        ? true
        : order >= (zone.key === 'director' ? input.director : zone.key === 'pm' ? input.pm : input.worker);
      desks.push({
        index: desks.length,
        zone: zone.key,
        order,
        x,
        z: dz,
        seat: { x, z: dz + 0.82 },
        approach: { x, z: dz + 1.9 },
        aisleZ: dz + 1.9,
        vacant,
      });
    }
    z += (rows - 1) * POD.z + POD.z + ZONE_GAP;
  }
  const lastDeskZ = desks.length ? Math.max(...desks.map(d => d.z)) : FIRST_DESK_Z;
  const workW = FIRST_DESK_X + (widestCols - 1) * POD.x + 2.2;
  const corridorX = workW + 0.6;
  const wingX0 = corridorX + 1.2;
  const tableCount = Math.max(MIN_TABLES, input.tables);
  const seatsPer = clampTableSeats(input.tableSeats);
  const radius = Math.max(0.95, seatsPer * 0.13);
  const gap = radius * 2 + 3.2;
  const tables: MeetingTable[] = [];
  for (let index = 0; index < tableCount; index++) {
    const x = wingX0 + 2.6 + (index % 2) * gap;
    const tz = FIRST_TABLE_Z + Math.floor(index / 2) * gap;
    const seats: TableSeat[] = [];
    for (let s = 0; s < seatsPer; s++) {
      const angle = (s / seatsPer) * Math.PI * 2 + Math.PI / seatsPer;
      const sx = x + Math.cos(angle) * (radius + 0.5);
      const sz = tz + Math.sin(angle) * (radius + 0.5);
      seats.push({ seat: { x: sx, z: sz }, angle, yaw: Math.atan2(x - sx, tz - sz) });
    }
    const laneZ = tz - (radius + LANE_OFFSET);
    tables.push({ index, x, z: tz, radius, seats, laneZ, gate: { x, z: laneZ } });
  }
  const rowsOfTables = Math.ceil(tableCount / 2);
  const tablesBottom = FIRST_TABLE_Z + (rowsOfTables - 1) * gap + radius + 2.2;
  const maxZ = Math.max(lastDeskZ + 3.0, tablesBottom + 4.6, 13.5);
  const maxX = wingX0 + 5.2 + gap + radius + 2.0;
  return {
    desks,
    tables,
    signs,
    bounds: { minX: 0, maxX, minZ: 0, maxZ },
    corridorX,
    wing: { x0: wingX0, x1: maxX, z0: 0, z1: maxZ },
  };
}

/** A seat somewhere in the office: a desk or a chair at a meeting table. */
export type Place = { kind: 'desk'; desk: DeskSlot } | { kind: 'table'; table: MeetingTable; seat: number };

export function placePose(place: Place): { pos: Vec2; yaw: number } {
  if (place.kind === 'desk') return { pos: place.desk.seat, yaw: Math.PI };
  const seat = place.table.seats[place.seat % place.table.seats.length];
  return { pos: seat.seat, yaw: seat.yaw };
}
export function samePlace(a: Place, b: Place): boolean {
  return a.kind === 'desk' && b.kind === 'desk'
    ? a.desk.index === b.desk.index
    : a.kind === 'table' && b.kind === 'table' && a.table.index === b.table.index && a.seat === b.seat;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
const wrapPi = (a: number) => {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r <= -Math.PI) r += Math.PI * 2;
  return r;
};

/** Points from a seat out onto the walking network; the last point lies on an aisle or a lane. */
function exitPoints(place: Place): Vec2[] {
  if (place.kind === 'desk') return [place.desk.seat, place.desk.approach];
  const { table } = place;
  const seat = table.seats[place.seat % table.seats.length];
  const R = table.radius + RING_OFFSET;
  const north = -Math.PI / 2;
  const delta = wrapPi(north - seat.angle);
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 6)));
  const points: Vec2[] = [seat.seat];
  for (let i = 0; i <= steps; i++) {
    const a = seat.angle + (delta * i) / steps;
    points.push({ x: table.x + Math.cos(a) * R, z: table.z + Math.sin(a) * R });
  }
  points.push(table.gate);
  return points;
}

/**
 * Walk from one seat to another along the aisle network only: out of the chair onto the row's
 * aisle (or around the table's ring to its lane), along it to the corridor, along the corridor to
 * the destination's aisle or lane, then in. Never straight across desks or through a table.
 */
export function routeBetween(layout: OfficeLayout, from: Place, to: Place): Route {
  const out = exitPoints(from);
  const inbound = exitPoints(to).reverse();
  const points: Vec2[] = [];
  const push = (p: Vec2) => {
    const last = points.at(-1);
    if (!last || !near(last.x, p.x) || !near(last.z, p.z)) points.push({ x: p.x, z: p.z });
  };
  for (const p of out) push(p);
  const a = out.at(-1)!;
  const b = inbound[0];
  if (!near(a.z, b.z)) {
    push({ x: layout.corridorX, z: a.z });
    push({ x: layout.corridorX, z: b.z });
  }
  for (const p of inbound) push(p);
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return { points, length };
}
export interface Route {
  /** Waypoints on the floor in walking order: the origin seat first, the destination seat last. */
  points: Vec2[];
  length: number;
}

/** Heading that makes a person face along a leg of a route (local +z is the avatar's front). */
export function yawToward(from: Vec2, to: Vec2): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** Total people a table must seat, per meeting id — drives the chair count. */
export function tableSeatDemand(meetingSizes: readonly number[]): number {
  return clampTableSeats(Math.max(0, ...meetingSizes));
}

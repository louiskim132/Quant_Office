/**
 * The 3D office floor plan, as pure data. World units are metres, +x is right, +z is toward the
 * viewer in the default camera and y is up (the engine owns y). Everything the scene draws or an
 * avatar walks to comes from here, so the floor plan and the walking routes cannot drift apart and
 * both can be unit-tested without a GPU.
 *
 * The building is one clean rectangle: the work area on the left, a vertical corridor with the
 * entrance at its foot, and a wing on the right holding glass meeting rooms (top) and the rest
 * area (bottom). Meeting rooms and the rest area are walled with glass and open onto aisles.
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
export interface RoomSeat {
  seat: Vec2;
  /** Yaw that makes the person face the table. */
  yaw: number;
  /** Waypoints from the chair to the room's gate (the aisle outside its door); the last is the gate. */
  exit: Vec2[];
}
export interface MeetingRoom {
  index: number;
  /** The glass room's footprint. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Table centre and size. */
  x: number;
  z: number;
  length: number;
  width: number;
  seats: RoomSeat[];
  /** The door sits in the south wall, centred on this x. */
  doorX: number;
  /** Horizontal aisle south of this room's row; people reach the door from it. */
  laneZ: number;
  gate: Vec2;
}
export type RestKind = 'sofa' | 'chair' | 'stool' | 'play';
export interface RestSpot {
  index: number;
  kind: RestKind;
  seat: Vec2;
  yaw: number;
  /** Waypoints from the spot to the rest area's gate on the corridor; the last is the gate. */
  exit: Vec2[];
}
export interface RestArea {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The west-wall door and the corridor point outside it. */
  doorZ: number;
  gate: Vec2;
  /** Ping-pong table centre and length (along x). */
  table: { x: number; z: number; length: number };
  /** Spots in the order they fill: the first person resting takes the first spot. */
  spots: RestSpot[];
  /** Furniture anchors for the scene builder. */
  stools: Vec2[];
  sofas: Vec2[];
  chairs: Vec2[];
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
  rooms: MeetingRoom[];
  rest: RestArea;
  signs: ZoneSign[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Vertical corridor between the work area and the wing. */
  corridorX: number;
  /** The wing (right of the corridor): meeting rooms on top, rest area below. */
  wing: { x0: number; x1: number; z0: number; z1: number };
  /** The front door, centred on the corridor. */
  entrance: Vec2;
}
export interface LayoutInput {
  director: number;
  pm: number;
  worker: number;
  /** Meeting rooms to draw (at least 2 — empty rooms stay visible). */
  tables: number;
  /** Chairs per room (the largest meeting present, clamped). */
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
export const MIN_TABLE_SEATS = 6;
export const MAX_TABLE_SEATS = 16;
/** Height of every wall and of the glass rooms; fixed, so the view never changes with the camera. */
export const WALL_HEIGHT = 3.1;
export const ROOM_HEIGHT = 2.6;
export const ROOM_Z0 = 0.5;
const TABLE_WIDTH = 1.2;
const ROOM_HALF_DEPTH = TABLE_WIDTH / 2 + 1.35;
const LANE = 1.7;
export const REST_DEPTH = 7.6;
export const REST_MIN_WIDTH = 10.6;
const REST_LANE_V = 4.0;

const ZONE_TEXT: Record<ZoneKey, string> = {
  director: 'DIRECTOR',
  pm: 'PROJECT MANAGERS',
  worker: 'WORKERS',
};

export function clampTableSeats(people: number): number {
  const even = Math.ceil(Math.max(0, people) / 2) * 2;
  return Math.min(MAX_TABLE_SEATS, Math.max(MIN_TABLE_SEATS, even));
}

/** Chairs per long side of a room's table; the remaining two sit at the ends. */
export const seatsPerSide = (seats: number) => (clampTableSeats(seats) - 2) / 2;
export const tableLength = (seats: number) => Math.max(2.6, seatsPerSide(seats) * 0.85 + 0.3);
const roomWidth = (seats: number) => tableLength(seats) + 3.3;

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

  // Meeting rooms: two per row, side by side, each with a long table and a door in its south wall.
  const roomCount = Math.max(MIN_TABLES, input.tables);
  const seatsPer = clampTableSeats(input.tableSeats);
  const length = tableLength(seatsPer);
  const wingW = Math.max(REST_MIN_WIDTH, roomWidth(seatsPer) * 2 + 0.3);
  const colW = (wingW - 0.3) / 2;
  const rowCount = Math.ceil(roomCount / 2);
  const roomDepth = ROOM_HALF_DEPTH * 2;
  const rooms: MeetingRoom[] = [];
  const perSide = seatsPerSide(seatsPer);
  for (let index = 0; index < roomCount; index++) {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x0 = wingX0 + col * (colW + 0.3);
    const z0 = ROOM_Z0 + row * (roomDepth + LANE);
    const z1 = z0 + roomDepth;
    const tx = x0 + colW / 2;
    const tz = z0 + roomDepth / 2;
    const north = tz - TABLE_WIDTH / 2 - 0.42;
    const south = tz + TABLE_WIDTH / 2 + 0.42;
    const northLine = tz - TABLE_WIDTH / 2 - 1.12;
    const southLine = tz + TABLE_WIDTH / 2 + 1.12;
    const doorX = tx + length / 2 + 1.05;
    const westX = tx - length / 2 - 1.05;
    const laneZ = z1 + LANE / 2;
    const out = (...pts: Vec2[]): Vec2[] => [...pts, { x: doorX, z: z1 }, { x: doorX, z: laneZ }];
    const seats: RoomSeat[] = [];
    for (let i = 0; i < perSide; i++) {
      const sx = tx - length / 2 + ((i + 0.5) * length) / perSide;
      seats.push({
        seat: { x: sx, z: north },
        yaw: 0,
        exit: out({ x: sx, z: northLine }, { x: doorX, z: northLine }),
      });
    }
    for (let i = 0; i < perSide; i++) {
      const sx = tx - length / 2 + ((i + 0.5) * length) / perSide;
      seats.push({
        seat: { x: sx, z: south },
        yaw: Math.PI,
        exit: out({ x: sx, z: southLine }, { x: doorX, z: southLine }),
      });
    }
    seats.push({
      seat: { x: tx + length / 2 + 0.42, z: tz },
      yaw: -Math.PI / 2,
      exit: out({ x: doorX, z: tz }),
    });
    seats.push({
      seat: { x: tx - length / 2 - 0.42, z: tz },
      yaw: Math.PI / 2,
      exit: out({ x: westX, z: tz }, { x: westX, z: southLine }, { x: doorX, z: southLine }),
    });
    rooms.push({
      index,
      x0,
      x1: x0 + colW,
      z0,
      z1,
      x: tx,
      z: tz,
      length,
      width: TABLE_WIDTH,
      seats,
      doorX,
      laneZ,
      gate: { x: doorX, z: laneZ },
    });
  }
  const roomsBottom = ROOM_Z0 + rowCount * roomDepth + (rowCount - 1) * LANE + LANE;
  const maxZ = Math.max(lastDeskZ + 3.0, roomsBottom + REST_DEPTH, 13.5);
  const maxX = wingX0 + wingW;
  const rest = buildRest(wingX0, maxX, maxZ, corridorX);
  return {
    desks,
    rooms,
    rest,
    signs,
    bounds: { minX: 0, maxX, minZ: 0, maxZ },
    corridorX,
    wing: { x0: wingX0, x1: maxX, z0: 0, z1: maxZ },
    entrance: { x: corridorX, z: maxZ },
  };
}

/** The rest area: stools at a counter, a ping-pong table, sofas and armchairs, all open to one lane. */
function buildRest(x0: number, x1: number, maxZ: number, corridorX: number): RestArea {
  const z0 = maxZ - REST_DEPTH;
  const doorZ = z0 + REST_LANE_V;
  const gate = { x: corridorX, z: doorZ };
  const extra = x1 - x0 - REST_MIN_WIDTH;
  const at = (u: number, v: number): Vec2 => ({ x: x0 + u, z: z0 + v });
  const toDoor = (p: Vec2): Vec2[] => [{ x: p.x, z: doorZ }, { x: x0 + 0.9, z: doorZ }, { x: x0, z: doorZ }, gate];
  const stools = [0, 1, 2, 3, 4, 5].map(i => at(1.0 + i * 0.8, 1.5));
  const sofas = [0, 1, 2].map(i => at(1.7 + i * 0.85, 6.75));
  const chairs = [0, 1, 2, 3].map(i => at(6.2 + i * 1.2 + extra, 6.6));
  const table = { ...at(7.9 + extra, 2.1), length: 2.74 };
  const west = at(5.9 + extra, 2.1);
  const east = at(9.9 + extra, 2.1);
  type Raw = { kind: RestKind; seat: Vec2; yaw: number };
  const sofa = (i: number): Raw => ({ kind: 'sofa', seat: sofas[i], yaw: Math.PI });
  const chair = (i: number): Raw => ({ kind: 'chair', seat: chairs[i], yaw: Math.PI });
  const stool = (i: number): Raw => ({ kind: 'stool', seat: stools[i], yaw: Math.PI });
  const play = (p: Vec2, yaw: number): Raw => ({ kind: 'play', seat: p, yaw });
  // Fill order: a couple of people share a sofa and a chair first, then the table fills as a pair.
  const order: Raw[] = [
    sofa(0),
    chair(0),
    play(west, Math.PI / 2),
    play(east, -Math.PI / 2),
    sofa(1),
    chair(1),
    stool(0),
    sofa(2),
    chair(2),
    stool(1),
    chair(3),
    stool(2),
    stool(3),
    stool(4),
    stool(5),
  ];
  const spots: RestSpot[] = order.map((raw, index) => ({ index, ...raw, exit: toDoor(raw.seat) }));
  return { x0, x1, z0, z1: maxZ, doorZ, gate, table, spots, stools, sofas, chairs };
}

/** A seat somewhere in the office: a desk, a chair in a meeting room, or a spot in the rest area. */
export type Place =
  | { kind: 'desk'; desk: DeskSlot }
  | { kind: 'room'; room: MeetingRoom; seat: number }
  | { kind: 'rest'; rest: RestArea; spot: number };

export type PoseKind = 'seated' | 'standing';

export function placePose(place: Place): { pos: Vec2; yaw: number; pose: PoseKind } {
  if (place.kind === 'desk') return { pos: place.desk.seat, yaw: Math.PI, pose: 'seated' };
  if (place.kind === 'room') {
    const seat = place.room.seats[place.seat % place.room.seats.length];
    return { pos: seat.seat, yaw: seat.yaw, pose: 'seated' };
  }
  const spot = place.rest.spots[place.spot % place.rest.spots.length];
  return { pos: spot.seat, yaw: spot.yaw, pose: spot.kind === 'play' ? 'standing' : 'seated' };
}
export function samePlace(a: Place, b: Place): boolean {
  if (a.kind === 'desk') return b.kind === 'desk' && a.desk.index === b.desk.index;
  if (a.kind === 'room') return b.kind === 'room' && a.room.index === b.room.index && a.seat === b.seat;
  return b.kind === 'rest' && a.spot === b.spot;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.05;

/** Points from a seat out onto the walking network; the last point lies on an aisle or a lane. */
function exitPoints(place: Place): Vec2[] {
  if (place.kind === 'desk') return [place.desk.seat, place.desk.approach];
  if (place.kind === 'room') {
    const seat = place.room.seats[place.seat % place.room.seats.length];
    return [seat.seat, ...seat.exit];
  }
  const spot = place.rest.spots[place.spot % place.rest.spots.length];
  return [spot.seat, ...spot.exit];
}

/**
 * Walk from one seat to another along the aisle network only: out of the chair, through the room's
 * door (or along the row's aisle) to the corridor, along the corridor to the destination's aisle,
 * lane or door, then in. Never straight across desks or through a table.
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

/** Total people a room must seat, per meeting id — drives the chair count. */
export function tableSeatDemand(meetingSizes: readonly number[]): number {
  return clampTableSeats(Math.max(0, ...meetingSizes));
}

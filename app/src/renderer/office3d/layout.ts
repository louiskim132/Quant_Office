/**
 * The 3D office floor plan, as pure data. World units are metres, +x is right, +z is toward the
 * viewer in the default camera and y is up (the engine owns y). Everything the scene draws or an
 * avatar walks to comes from here, so the floor plan and the walking routes cannot drift apart and
 * both can be unit-tested without a GPU.
 *
 * The building is a single-storey glass pavilion set in a planted courtyard (after UC San Diego's
 * 64 Degrees at Revelle College). Inside: planted work neighbourhoods on the left, separated by
 * planter boxes, with the director's studio and the live status board at the back; a wide
 * polished-concrete "street" with the entrance at its foot; and a wing on the right holding glass
 * meeting rooms (back) and the café lounge (front). Aisles follow open-plan planning practice:
 * main street 3 m, row aisles about 2.7 m behind the chairs.
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
  /** Waypoints from the spot to the lounge's gate on the street; the last is the gate. */
  exit: Vec2[];
}
export interface Facing extends Vec2 {
  yaw: number;
}
export interface RestArea {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The west-wall door and the street point outside it. */
  doorZ: number;
  gate: Vec2;
  /** Ping-pong table centre and length (along x). */
  table: { x: number; z: number; length: number };
  /** Spots in the order they fill: the first person resting takes the first spot. */
  spots: RestSpot[];
  /** Furniture anchors for the scene builder. */
  stools: Vec2[];
  /** The three seats of the sofa. */
  sofas: Vec2[];
  /** Armchairs, each facing its group's table. */
  chairs: Facing[];
  /** The café counter along the north wall. */
  counter: { x0: number; x1: number; z: number };
  /** Low table between the sofa and its two armchairs, and the round table of the fireside group. */
  coffee: Vec2;
  round: Vec2;
  /** The stone fireplace on the east wall: its front face and extent along z. */
  fireplace: { x: number; z0: number; z1: number };
}
export interface ZoneSign {
  key: ZoneKey;
  text: string;
  x: number;
  z: number;
  width: number;
}
export interface Divider {
  /** A long planter box between two neighbourhoods. */
  x0: number;
  x1: number;
  z: number;
}
export interface OfficeLayout {
  desks: DeskSlot[];
  rooms: MeetingRoom[];
  rest: RestArea;
  signs: ZoneSign[];
  dividers: Divider[];
  /**
   * The live status board: at the back of the director's studio, behind and to the left of the
   * director's desk, turned toward the default camera so the two never overlap in that view.
   */
  board: Facing;
  /** Potted trees along the street edges, clear of every aisle, lane and door. */
  streetPlants: Vec2[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** The street (main corridor) between the work area and the wing. */
  corridorX: number;
  corridorWidth: number;
  /** Right-hand edge of the work area. */
  workX1: number;
  /** The wing (right of the corridor): meeting rooms on top, café lounge below. */
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
  /** Highest occupied lounge slot, including stable gaps left by departing agents. */
  restSeats?: number;
  /** No agents at all: four vacant worker desks, no director or PM row. */
  empty?: boolean;
}

export const POD = { x: 3.4, z: 4.2 } as const;
export const MAX_COLS = 5;
export const FIRST_DESK_X = 4.4;
export const FIRST_DESK_Z = 3.6;
export const ZONE_GAP = 1.6;
export const MIN_TABLES = 2;
export const MIN_TABLE_SEATS = 6;
export const MAX_TABLE_SEATS = 16;
/** Height of every wall and of the glass rooms; fixed, so the view never changes with the camera. */
export const WALL_HEIGHT = 3.1;
export const ROOM_HEIGHT = 2.6;
export const ROOM_Z0 = 1.4;
export const CORRIDOR_WIDTH = 3.0;
const SEAT_DZ = 0.82;
const AISLE_DZ = 2.1;
const WORK_EAST_MARGIN = 2.6;
const TABLE_WIDTH = 1.3;
const ROOM_HALF_DEPTH = TABLE_WIDTH / 2 + 1.9;
const ROOM_GAP = 0.4;
const LANE = 2.4;
export const REST_DEPTH = 11.0;
export const REST_MIN_WIDTH = 15.6;
const REST_LANE_V = 4.6;
/** A planted walkway inside the east wall of the meeting wing, so no chair sits under the roof edge. */
export const EAST_WALK = 1.4;
/** How far a street plant keeps from any line people cross the street on. */
const STREET_CLEAR = 1.2;
/** The status board's place in the first slot of the first row: a little left, and set back toward the wall. */
const BOARD_DX = -0.2;
const BOARD_BACK = 1.6;

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
export const tableLength = (seats: number) => Math.max(3.0, seatsPerSide(seats) * 0.95 + 0.4);
const roomWidth = (seats: number) => tableLength(seats) + 4.4;

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
  const dividers: Divider[] = [];
  let z = FIRST_DESK_Z;
  let widestCols = 3;
  let board: Facing = { x: 0, z: 0, yaw: Math.PI / 4 };
  const zoneSpans: { z0: number; z1: number }[] = [];
  zones.forEach((zone, zi) => {
    // The first row gives its first slot to the status board, set back toward the planted wall; its
    // desks start one slot to the right, so from the default camera the board stands clear above
    // and to the left of the director instead of behind the desk.
    const shift = zi === 0 ? 1 : 0;
    const cols = Math.min(zone.count, MAX_COLS - shift);
    widestCols = Math.max(widestCols, cols + shift);
    const rows = Math.ceil(zone.count / cols);
    if (zi === 0) board = { x: FIRST_DESK_X + BOARD_DX, z: z - BOARD_BACK, yaw: Math.PI / 4 };
    signs.push({ key: zone.key, text: ZONE_TEXT[zone.key], x: FIRST_DESK_X - 2.5, z, width: 2.2 });
    for (let order = 0; order < zone.count; order++) {
      const col = (order % cols) + shift;
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
        seat: { x, z: dz + SEAT_DZ },
        approach: { x, z: dz + AISLE_DZ },
        aisleZ: dz + AISLE_DZ,
        vacant,
      });
    }
    zoneSpans.push({ z0: z, z1: z + (rows - 1) * POD.z });
    z += (rows - 1) * POD.z + POD.z + ZONE_GAP;
  });
  const lastDeskZ = desks.length ? Math.max(...desks.map(d => d.z)) : FIRST_DESK_Z;
  const workX1 = FIRST_DESK_X + (widestCols - 1) * POD.x + WORK_EAST_MARGIN;
  const corridorX = workX1 + CORRIDOR_WIDTH / 2;
  const wingX0 = corridorX + CORRIDOR_WIDTH / 2;
  // A planter box between neighbourhoods, halfway between one zone's last aisle and the next desks.
  for (let i = 1; i < zoneSpans.length; i++) {
    const after = zoneSpans[i - 1].z1 + AISLE_DZ;
    const before = zoneSpans[i].z0 - 0.4;
    dividers.push({ x0: FIRST_DESK_X - 1.6, x1: workX1 - 1.4, z: (after + before) / 2 });
  }

  // Meeting rooms: two per row, side by side, each with a long table and a door in its south wall.
  const roomCount = Math.max(MIN_TABLES, input.tables);
  const seatsPer = clampTableSeats(input.tableSeats);
  const length = tableLength(seatsPer);
  const wingW = Math.max(REST_MIN_WIDTH, roomWidth(seatsPer) * 2 + ROOM_GAP);
  const colW = (wingW - ROOM_GAP) / 2;
  const rowCount = Math.ceil(roomCount / 2);
  const roomDepth = ROOM_HALF_DEPTH * 2;
  const rooms: MeetingRoom[] = [];
  const perSide = seatsPerSide(seatsPer);
  const sideSeat = TABLE_WIDTH / 2 + 0.45;
  const sideLine = TABLE_WIDTH / 2 + 1.2;
  for (let index = 0; index < roomCount; index++) {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x0 = wingX0 + col * (colW + ROOM_GAP);
    const z0 = ROOM_Z0 + row * (roomDepth + LANE);
    const z1 = z0 + roomDepth;
    const tx = x0 + colW / 2;
    const tz = z0 + roomDepth / 2;
    const north = tz - sideSeat;
    const south = tz + sideSeat;
    const northLine = tz - sideLine;
    const southLine = tz + sideLine;
    const doorX = tx + length / 2 + 1.3;
    const westX = tx - length / 2 - 1.3;
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
      seat: { x: tx + length / 2 + 0.45, z: tz },
      yaw: -Math.PI / 2,
      exit: out({ x: doorX, z: tz }),
    });
    seats.push({
      seat: { x: tx - length / 2 - 0.45, z: tz },
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
  const restCapacity = Math.max(17, input.director + input.pm + input.worker, input.restSeats ?? 0);
  const restDepth = REST_DEPTH + (restCapacity > 17 ? 2.4 + Math.ceil((restCapacity - 17) / 6) * 1.5 : 0);
  const maxZ = Math.max(lastDeskZ + 4.2, roomsBottom + restDepth, 19.0);
  const maxX = wingX0 + wingW + EAST_WALK;
  const rest = buildRest(wingX0, maxX, maxZ, corridorX, restCapacity, restDepth);
  const crossings = [
    ...new Set([...desks.map(d => d.aisleZ), ...rooms.map(r => r.laneZ), rest.doorZ].map(v => +v.toFixed(3))),
  ];
  return {
    desks,
    rooms,
    rest,
    signs,
    dividers,
    board,
    streetPlants: streetPlants(corridorX, maxZ, crossings),
    bounds: { minX: 0, maxX, minZ: 0, maxZ },
    corridorX,
    corridorWidth: CORRIDOR_WIDTH,
    workX1,
    wing: { x0: wingX0, x1: maxX, z0: 0, z1: maxZ },
    entrance: { x: corridorX, z: maxZ },
  };
}

/** Potted trees along both edges of the street, alternating sides, never beside a crossing line. */
function streetPlants(corridorX: number, maxZ: number, crossings: readonly number[]): Vec2[] {
  const out: Vec2[] = [];
  const edge = CORRIDOR_WIDTH / 2 - 0.38;
  let side = -1;
  let last = -Infinity;
  for (let z = 1.2; z <= maxZ - 2.6; z += 0.25) {
    if (z - last < 3.6) continue;
    if (crossings.some(c => Math.abs(c - z) < STREET_CLEAR)) continue;
    out.push({ x: corridorX + side * edge, z: +z.toFixed(2) });
    side = -side;
    last = z;
  }
  return out;
}

/**
 * The café lounge, after the 64 Degrees dining room: a counter with stools along the back wall, a
 * ping-pong table, a sofa group around a low table and a fireside group of armchairs. One lane
 * runs from the west door across the room; every seat reaches it without walking through
 * furniture. Seats keep well back from the front glass, where the roof edge would hide them from
 * the default camera.
 */
function buildRest(x0: number, x1: number, maxZ: number, corridorX: number, capacity: number, depth: number): RestArea {
  const z0 = maxZ - depth;
  const doorZ = z0 + REST_LANE_V;
  const gate = { x: corridorX, z: doorZ };
  const e = x1 - x0 - REST_MIN_WIDTH;
  const at = (u: number, v: number): Vec2 => ({ x: x0 + u, z: z0 + v });
  const west = x0 + 0.9;
  const tail: Vec2[] = [{ x: west, z: doorZ }, { x: x0, z: doorZ }, gate];
  // Up to the lane, then west along it to the door.
  const toLane = (...pts: Vec2[]): Vec2[] => [...pts, { x: pts.at(-1)!.x, z: doorZ }, ...tail];
  const stools = [0, 1, 2, 3, 4, 5].map(i => at(1.3 + i * 1.05, 1.85));
  // The sofa faces south, toward the default camera, with an armchair at each end of its low table.
  const sofas = [0, 1, 2].map(i => at(2.1 + i * 0.9, 5.95));
  const chairs: Facing[] = [
    { ...at(1.05, 7.45), yaw: Math.PI / 2 },
    { ...at(4.95, 7.45), yaw: -Math.PI / 2 },
    { ...at(10.7 + e, 5.85), yaw: 0 },
    { ...at(12.1 + e, 5.85), yaw: 0 },
    { ...at(10.7 + e, 8.15), yaw: Math.PI },
    { ...at(12.1 + e, 8.15), yaw: Math.PI },
  ];
  // Each armchair steps out to a side that is clear of furniture before walking north.
  const chairExit: Vec2[][] = [
    [{ x: west, z: z0 + 6.75 }],
    [at(5.75, 7.45), { x: x0 + 5.75, z: doorZ }],
    [at(9.9 + e, 5.85), { x: x0 + 9.9 + e, z: doorZ }],
    [at(12.9 + e, 5.85), { x: x0 + 12.9 + e, z: doorZ }],
    [at(9.9 + e, 8.15), { x: x0 + 9.9 + e, z: doorZ }],
    [at(12.9 + e, 8.15), { x: x0 + 12.9 + e, z: doorZ }],
  ];
  const table = { ...at(11.4 + e, 2.5), length: 2.74 };
  const westPlayer = at(9.4 + e, 2.5);
  const eastPlayer = at(13.4 + e, 2.5);
  type Raw = { kind: RestKind; seat: Vec2; yaw: number; exit: Vec2[] };
  const sofa = (i: number): Raw => ({
    kind: 'sofa',
    seat: sofas[i],
    yaw: 0,
    // Out onto the leg-room line in front of the sofa, west to the wall strip, then up to the lane.
    exit: [{ x: sofas[i].x, z: z0 + 6.6 }, { x: west, z: z0 + 6.6 }, ...tail],
  });
  const chair = (i: number): Raw => ({
    kind: 'chair',
    seat: chairs[i],
    yaw: chairs[i].yaw,
    exit: [...chairExit[i], ...tail],
  });
  const stool = (i: number): Raw => ({ kind: 'stool', seat: stools[i], yaw: Math.PI, exit: toLane(stools[i]) });
  const play = (p: Vec2, yaw: number): Raw => ({ kind: 'play', seat: p, yaw, exit: toLane(p) });
  // Fill order: a couple of people share the sofa group first, then the table fills as a pair.
  const order: Raw[] = [
    sofa(0),
    chair(0),
    play(westPlayer, Math.PI / 2),
    play(eastPlayer, -Math.PI / 2),
    sofa(1),
    chair(2),
    stool(0),
    sofa(2),
    chair(3),
    stool(1),
    chair(1),
    chair(4),
    chair(5),
    stool(2),
    stool(3),
    stool(4),
    stool(5),
  ];
  // Additional cafe rows keep every resting person visible with a clear route to the west aisle.
  for (let i = 0; order.length < capacity; i++) {
    const seat = at(1.3 + (i % 6) * 1.05, 11 + Math.floor(i / 6) * 1.5);
    stools.push(seat);
    order.push({
      kind: 'stool',
      seat,
      yaw: Math.PI,
      exit: [{ x: seat.x, z: seat.z + 0.6 }, { x: west, z: seat.z + 0.6 }, ...tail],
    });
  }
  const spots: RestSpot[] = order.map((raw, index) => ({
    index,
    kind: raw.kind,
    seat: raw.seat,
    yaw: raw.yaw,
    // The first waypoint repeats the seat when the exit starts there; drop it so legs are never empty.
    exit: raw.exit.filter((p, i) => i > 0 || Math.hypot(p.x - raw.seat.x, p.z - raw.seat.z) > 1e-6),
  }));
  return {
    x0,
    x1,
    z0,
    z1: maxZ,
    doorZ,
    gate,
    table,
    spots,
    stools,
    sofas,
    chairs,
    counter: { x0: x0 + 0.6, x1: x0 + 7.6, z: z0 + 0.62 },
    coffee: at(3.0, 7.45),
    round: at(11.4 + e, 7.0),
    fireplace: { x: x1 - 0.85, z0: z0 + 5.6, z1: z0 + 8.4 },
  };
}

/** A seat somewhere in the office: a desk, a chair in a meeting room, or a spot in the lounge. */
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
 * door (or along the row's aisle) to the street, along the street to the destination's aisle,
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

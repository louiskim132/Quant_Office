import * as THREE from 'three';
import { buildEnvironment, type Theme } from './environment';
import { Batch, Kit, mulberry32, textTexture } from './kit';
import { ROOM_HEIGHT, WALL_HEIGHT, type MeetingRoom, type OfficeLayout, type Vec2 } from './layout';

export type { Theme } from './environment';
export type MonitorState = 'off' | 'working' | 'stalled' | 'unknown' | 'away' | 'done' | 'failed';

export interface BoardSummary {
  working: number;
  idle: number;
  attention: number;
  meeting: number;
  total: number;
}
export interface PingPong {
  ball: THREE.Mesh;
  from: Vec2;
  to: Vec2;
  /** Table-top height. */
  y: number;
}
export interface World {
  group: THREE.Group;
  screens: THREE.Mesh[];
  setMonitor(deskIndex: number, state: MonitorState): void;
  setBoard(summary: BoardSummary): void;
  /** The carpet of each meeting room, so a busy room can be lit. */
  roomFloors: THREE.Mesh[];
  floorMaterials: { idle: THREE.MeshStandardMaterial; busy: THREE.MeshStandardMaterial };
  pingPong: PingPong;
}

// An all-white interior: pale oak floor, white desks and walls, graphite and soft grey seating,
// with a few saturated accents (armchairs, plants) so it reads as a lived-in office.
const FLOOR_PLANKS = ['#e6d2ae', '#e0cba5', '#eadab9', '#dcc59c', '#e4d0ab'];
const CHAIR_COLORS = ['#3a4250', '#434d63', '#3d5654', '#524a63', '#484d57'];
const WHITE = '#f8f8f6';
const LIGHT_GREY = '#e8eaed';
const STEEL = '#c3c9d1';
const GRAPHITE = '#2b3037';
const FRAME_WHITE = '#f3f5f7';
const INK = 'rgba(70, 78, 90, 0.62)';

function parquet(kit: Kit): THREE.CanvasTexture {
  const rand = mulberry32(7);
  const tex = textTexture(kit, 1024, 1024, (ctx, w, h) => {
    const plankW = 64;
    const plankL = 256;
    for (let row = 0; row * plankW < h; row++) {
      const offset = (row % 3) * (plankL / 3);
      for (let col = -1; col * plankL - offset < w; col++) {
        const x = col * plankL - offset;
        ctx.fillStyle = FLOOR_PLANKS[Math.floor(rand() * FLOOR_PLANKS.length)];
        ctx.fillRect(x, row * plankW, plankL, plankW);
        ctx.strokeStyle = 'rgba(150, 120, 80, 0.07)';
        ctx.lineWidth = 1;
        for (let g = 0; g < 3; g++) {
          const gy = row * plankW + 10 + rand() * (plankW - 20);
          ctx.beginPath();
          ctx.moveTo(x + rand() * 30, gy);
          ctx.lineTo(x + plankL - rand() * 30, gy + (rand() - 0.5) * 3);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(140, 110, 70, 0.2)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, row * plankW + 1, plankL - 2, plankW - 2);
      }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function monitorTexture(kit: Kit, state: MonitorState): THREE.CanvasTexture {
  return textTexture(kit, 160, 96, (ctx, w, h) => {
    const bars = (color: string, rows: number, seed: number) => {
      const rand = mulberry32(seed);
      ctx.fillStyle = color;
      for (let i = 0; i < rows; i++) {
        const indent = Math.floor(rand() * 3) * 14;
        ctx.fillRect(12 + indent, 12 + i * 11, 18 + rand() * (w - 60 - indent), 5);
      }
    };
    const glyph = (text: string, color: string) => {
      ctx.fillStyle = color;
      ctx.font = 'bold 56px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2 + 3);
    };
    const bg = {
      off: '#0b1013',
      working: '#07302b',
      stalled: '#2d2308',
      unknown: '#1a2227',
      away: '#101a2c',
      done: '#0c2a17',
      failed: '#301210',
    }[state];
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    if (state === 'working') bars('#6fe8cb', 7, 3);
    else if (state === 'stalled') bars('#e2b95a', 3, 5);
    else if (state === 'unknown') glyph('?', '#9fb0b6');
    else if (state === 'done') glyph('✓', '#7bd09b');
    else if (state === 'failed') glyph('✕', '#ee7c6a');
    else if (state === 'away') {
      ctx.fillStyle = '#4b6aa6';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, 'rgba(255,255,255,0.08)');
      g.addColorStop(0.5, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  });
}

// ---- walls ------------------------------------------------------------------------------------

type Axis = 'x' | 'z';
interface Gap {
  from: number;
  to: number;
  /** Clear height of the opening; glass continues above it. */
  h: number;
}
interface Run {
  axis: Axis;
  /** The wall's constant coordinate (z for an x-run, x for a z-run). */
  fixed: number;
  from: number;
  to: number;
  h: number;
  sill: number;
  header: number;
  step: number;
  frame: string;
  post: number;
  thick: number;
  gaps?: Gap[];
  frostBand?: boolean;
}

function seg(
  b: Batch,
  axis: Axis,
  fixed: number,
  t0: number,
  t1: number,
  y0: number,
  y1: number,
  thick: number,
  color: string,
) {
  if (t1 - t0 < 1e-4 || y1 - y0 < 1e-4) return;
  if (axis === 'x') b.box(t1 - t0, y1 - y0, thick, color, (t0 + t1) / 2, y0, fixed);
  else b.box(thick, y1 - y0, t1 - t0, color, fixed, y0, (t0 + t1) / 2);
}

/**
 * A glass curtain wall: an opaque sill, a header band and slim posts, with transparent glass
 * between them. Gaps leave an opening (a door) with glass kept above it. The wall never changes
 * height, so the whole office stays visible from every side.
 */
function wallRun(solid: Batch, glass: Batch, frost: Batch | null, r: Run) {
  const gaps = [...(r.gaps ?? [])].sort((a, c) => a.from - c.from);
  const pieces: [number, number][] = [];
  let cursor = r.from;
  for (const g of gaps) {
    if (g.from > cursor) pieces.push([cursor, g.from]);
    cursor = g.to;
  }
  if (cursor < r.to) pieces.push([cursor, r.to]);
  const top = r.h - r.header;
  seg(solid, r.axis, r.fixed, r.from, r.to, top, r.h, r.thick, r.frame);
  for (const [a, c] of pieces) {
    if (r.sill > 0) seg(solid, r.axis, r.fixed, a, c, 0, r.sill, r.thick, r.frame);
    seg(glass, r.axis, r.fixed, a, c, r.sill, top, 0.03, '#d9eefa');
    if (r.frostBand && frost) seg(frost, r.axis, r.fixed, a, c, 0.95, 1.25, 0.045, '#ffffff');
    const n = Math.max(1, Math.round((c - a) / r.step));
    for (let i = 0; i <= n; i++) {
      const p = a + ((c - a) * i) / n;
      seg(solid, r.axis, r.fixed, p - r.post / 2, p + r.post / 2, r.sill, top, r.thick * 0.7, r.frame);
    }
  }
  for (const g of gaps) {
    seg(glass, r.axis, r.fixed, g.from, g.to, g.h, top, 0.03, '#d9eefa');
    for (const p of [g.from, g.to])
      seg(solid, r.axis, r.fixed, p - r.post / 2, p + r.post / 2, 0, top, r.thick * 0.7, r.frame);
  }
}

export function buildWorld(layout: OfficeLayout, kit: Kit, theme: Theme): World {
  const root = new THREE.Group();
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const door = layout.entrance.x;

  // The building's slab: a crisp rectangle, stepped above the plaza.
  const b = new Batch();
  const glass = new Batch();
  const frost = new Batch();
  b.box(width + 0.5, 0.3, depth + 0.5, '#f3f4f6', minX + width / 2, -0.31, minZ + depth / 2);

  // Floor: pale oak everywhere, with a stone-tile corridor and a lobby mat.
  const floorTex = parquet(kit);
  floorTex.repeat.set(width / 8, depth / 8);
  const floor = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(width, depth)),
    kit.own(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9, metalness: 0 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(minX + width / 2, 0, minZ + depth / 2);
  floor.receiveShadow = true;
  root.add(floor);
  b.box(2.4, 0.012, depth, '#eceff2', layout.corridorX, 0, depth / 2);
  for (const edge of [-1.2, 1.2]) b.box(0.05, 0.014, depth, '#d3d8de', layout.corridorX + edge, 0, depth / 2);
  b.box(2.6, 0.02, 1.0, '#4b525c', door, 0, maxZ - 0.9);

  // Director's rug.
  const director = layout.desks.filter(d => d.zone === 'director');
  if (director.length) {
    const cx = (Math.min(...director.map(d => d.x)) + Math.max(...director.map(d => d.x))) / 2;
    const rw = Math.max(...director.map(d => d.x)) - Math.min(...director.map(d => d.x)) + 3.6;
    b.box(rw, 0.012, 3.5, '#dfe4ea', cx, 0, director[0].z + 0.55);
    b.box(rw - 0.3, 0.016, 3.2, '#e9edf2', cx, 0, director[0].z + 0.55);
  }

  // Desks, monitors and chairs.
  const screenSpots: { x: number; y: number; z: number }[] = [];
  layout.desks.forEach((d, i) => {
    const top = d.zone === 'director' ? '#efe3cf' : WHITE;
    b.box(1.6, 0.05, 0.8, top, d.x, 0.7, d.z);
    b.box(0.05, 0.7, 0.74, STEEL, d.x - 0.76, 0, d.z);
    b.box(0.05, 0.7, 0.74, STEEL, d.x + 0.76, 0, d.z);
    b.box(1.5, 0.42, 0.03, LIGHT_GREY, d.x, 0.28, d.z - 0.33);
    b.box(0.42, 0.56, 0.68, LIGHT_GREY, d.x + 0.52, 0.02, d.z);
    b.box(0.22, 0.015, 0.16, '#2a3038', d.x, 0.75, d.z - 0.2);
    b.box(0.045, 0.2, 0.045, '#2a3038', d.x, 0.765, d.z - 0.2);
    b.box(0.6, 0.36, 0.04, '#1c2128', d.x, 0.96, d.z - 0.2);
    screenSpots.push({ x: d.x, y: 0.96 + 0.18, z: d.z - 0.2 + 0.0215 });
    b.box(0.38, 0.02, 0.13, '#cfd5da', d.x, 0.75, d.z + 0.12);
    b.box(0.06, 0.02, 0.09, '#cfd5da', d.x + 0.3, 0.75, d.z + 0.14);
    b.cylinder(0.04, 0.035, 0.09, i % 2 ? '#e8e2d4' : '#e9915b', d.x + 0.58, 0.75, d.z - 0.05, 10);
    const cc = CHAIR_COLORS[(d.zone === 'director' ? 4 : i) % CHAIR_COLORS.length];
    const sx = d.seat.x;
    const sz = d.seat.z;
    b.box(0.5, 0.07, 0.48, cc, sx, 0.43, sz + 0.04);
    b.box(0.5, 0.4, 0.06, cc, sx, 0.52, sz + 0.24);
    b.cylinder(0.03, 0.03, 0.28, '#30363f', sx, 0.15, sz + 0.04, 8);
    b.box(0.52, 0.03, 0.07, '#30363f', sx, 0.04, sz + 0.04);
    b.box(0.07, 0.03, 0.52, '#30363f', sx, 0.04, sz + 0.04);
  });

  // Meeting rooms: glass-walled, each with its own long table, chairs and a whiteboard.
  const roomFloors: THREE.Mesh[] = [];
  const idleFloor = kit.own(new THREE.MeshStandardMaterial({ color: '#dde1e7', roughness: 1 }));
  const busyFloor = kit.own(
    new THREE.MeshStandardMaterial({ color: '#cfe2f8', roughness: 1, emissive: '#5b8fd0', emissiveIntensity: 0.28 }),
  );
  const pingPongSpec = layout.rest.table;
  for (const room of layout.rooms) {
    const carpet = new THREE.Mesh(
      kit.own(new THREE.BoxGeometry(room.x1 - room.x0, 0.016, room.z1 - room.z0)),
      idleFloor,
    );
    carpet.position.set((room.x0 + room.x1) / 2, 0.008, (room.z0 + room.z1) / 2);
    carpet.receiveShadow = true;
    root.add(carpet);
    roomFloors.push(carpet);
    meetingRoom(b, glass, frost, room);
  }

  // The rest area.
  restArea(b, glass, frost, layout);

  // Outside walls: a continuous glass curtain wall on all four sides, with the entrance in front.
  const wall = {
    h: WALL_HEIGHT,
    sill: 0.45,
    header: 0.3,
    step: 1.7,
    frame: FRAME_WHITE,
    post: 0.1,
    thick: 0.2,
  };
  wallRun(b, glass, null, { ...wall, axis: 'x', fixed: minZ, from: minX, to: maxX });
  wallRun(b, glass, null, { ...wall, axis: 'z', fixed: minX, from: minZ, to: maxZ });
  wallRun(b, glass, null, { ...wall, axis: 'z', fixed: maxX, from: minZ, to: maxZ });
  wallRun(b, glass, null, {
    ...wall,
    axis: 'x',
    fixed: maxZ,
    from: minX,
    to: maxX,
    gaps: [{ from: door - 1.1, to: door + 1.1, h: 2.4 }],
  });
  for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) b.box(0.24, WALL_HEIGHT, 0.24, FRAME_WHITE, x, 0, z);
  entrance(b, glass, door, maxZ);

  // Lobby, plants and the free-standing status totem.
  plants(b, layout);
  b.box(1.9, 0.5, 0.5, '#e4e7ec', door - 4.6, 0, maxZ - 0.9);
  b.box(1.9, 0.06, 0.52, '#f8f8f6', door - 4.6, 0.5, maxZ - 0.9);

  const solid = kit.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02 }));
  root.add(b.build(kit, solid));
  const glassMaterial = kit.own(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.2,
      roughness: 0.08,
      metalness: 0.2,
      depthWrite: false,
    }),
  );
  const glassMesh = glass.build(kit, glassMaterial, { cast: false, receive: false });
  glassMesh.renderOrder = 4;
  root.add(glassMesh);
  if (frost.size) {
    const frostMaterial = kit.own(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        roughness: 0.6,
        metalness: 0,
        depthWrite: false,
      }),
    );
    const frostMesh = frost.build(kit, frostMaterial, { cast: false, receive: false });
    frostMesh.renderOrder = 4;
    root.add(frostMesh);
  }
  root.add(buildEnvironment(layout, kit, theme));

  // Screens: one shared material per state; each desk's plane just points at the right one.
  const states: MonitorState[] = ['off', 'working', 'stalled', 'unknown', 'away', 'done', 'failed'];
  const screenMaterials = Object.fromEntries(
    states.map(state => [
      state,
      kit.own(new THREE.MeshBasicMaterial({ map: monitorTexture(kit, state), toneMapped: false })),
    ]),
  ) as Record<MonitorState, THREE.MeshBasicMaterial>;
  const screenGeometry = kit.own(new THREE.PlaneGeometry(0.54, 0.3));
  const screens = screenSpots.map(spot => {
    const m = new THREE.Mesh(screenGeometry, screenMaterials.off);
    m.position.set(spot.x, spot.y, spot.z);
    root.add(m);
    return m;
  });

  // Signs painted on the floor.
  const floorText = (
    text: string,
    planeW: number,
    planeH: number,
    x: number,
    z: number,
    font: number,
    spacing: number,
    center = false,
  ) => {
    const px = 100;
    const tex = textTexture(kit, Math.round(planeW * px), Math.round(planeH * px), (ctx, w, h) => {
      ctx.font = `600 ${font}px ui-monospace, Consolas, monospace`;
      ctx.fillStyle = INK;
      ctx.textBaseline = 'middle';
      ctx.textAlign = center ? 'center' : 'left';
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spacing}px`;
      ctx.fillText(text, center ? w / 2 : 6, h / 2);
    });
    const plane = new THREE.Mesh(
      kit.own(new THREE.PlaneGeometry(planeW, planeH)),
      kit.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(x, 0.03, z);
    root.add(plane);
  };
  for (const sign of layout.signs) floorText(sign.text, 6.4, 0.96, sign.x + 3.2, sign.z, 44, 7);
  layout.rooms.forEach((room, i) => {
    const name = i === 0 ? 'COLLABORATION' : i === 1 ? 'REVIEW' : `ROOM ${i + 1}`;
    floorText(name, 3.6, 0.5, room.x, room.z1 - 0.34, 28, 4, true);
  });
  floorText('REST AREA', 3.6, 0.5, layout.rest.x0 + 5.3, layout.rest.z0 + 5.15, 28, 5, true);

  // Ping-pong ball: the engine moves it while both players are at the table.
  const ball = new THREE.Mesh(
    kit.own(new THREE.SphereGeometry(0.03, 10, 8)),
    kit.own(new THREE.MeshBasicMaterial({ color: '#ff9a3c' })),
  );
  ball.visible = false;
  root.add(ball);

  // Entrance sign on the canopy fascia and the double-sided status totem.
  entranceSign(kit, root, door, maxZ);
  const board = statusTotem(kit, root, door - 3.2, maxZ - 1.9);

  return {
    group: root,
    screens,
    roomFloors,
    floorMaterials: { idle: idleFloor, busy: busyFloor },
    pingPong: {
      ball,
      from: { x: pingPongSpec.x - pingPongSpec.length / 2 + 0.25, z: pingPongSpec.z },
      to: { x: pingPongSpec.x + pingPongSpec.length / 2 - 0.25, z: pingPongSpec.z },
      y: 0.8,
    },
    setMonitor(deskIndex, state) {
      const screen = screens[deskIndex];
      if (screen) screen.material = screenMaterials[state];
    },
    setBoard: board,
  };
}

function plants(b: Batch, layout: OfficeLayout) {
  const { maxZ } = layout.bounds;
  const door = layout.entrance.x;
  const spots: [number, number][] = [
    [0.8, 0.9],
    [layout.corridorX - 1.7, 0.9],
    [0.8, maxZ - 0.9],
    [door - 1.9, maxZ - 0.8],
    [door + 1.9, maxZ - 0.8],
    [door - 6.1, maxZ - 0.9],
  ];
  const lastRow = Math.max(...layout.desks.map(d => d.z));
  for (const d of layout.desks) if (d.z === lastRow && d.order % 3 === 2) spots.push([d.x + 1.25, d.z - 0.2]);
  for (const [x, z] of spots) plant(b, x, z, 1);
}

function plant(b: Batch, x: number, z: number, scale: number) {
  b.cylinder(0.2 * scale, 0.15 * scale, 0.34 * scale, '#f1f1ee', x, 0, z, 10);
  b.cylinder(0.025, 0.03, 0.4 * scale, '#5b4630', x, 0.34 * scale, z, 6);
  b.sphere(0.3 * scale, '#4d9b6b', x, 0.62 * scale, z, 1.15);
  b.sphere(0.2 * scale, '#63b07f', x + 0.12 * scale, 0.92 * scale, z - 0.05, 1.1);
  b.cone(0.16 * scale, 0.5 * scale, '#3f8a5d', x - 0.1 * scale, 0.8 * scale, z + 0.06);
}

function meetingRoom(b: Batch, glass: Batch, frost: Batch, room: MeetingRoom) {
  const frame = {
    h: ROOM_HEIGHT,
    sill: 0,
    header: 0.1,
    step: 1.5,
    frame: GRAPHITE,
    post: 0.06,
    thick: 0.08,
    frostBand: true,
  };
  wallRun(b, glass, frost, { ...frame, axis: 'x', fixed: room.z0, from: room.x0, to: room.x1 });
  wallRun(b, glass, frost, { ...frame, axis: 'z', fixed: room.x0, from: room.z0, to: room.z1 });
  wallRun(b, glass, frost, { ...frame, axis: 'z', fixed: room.x1, from: room.z0, to: room.z1 });
  wallRun(b, glass, frost, {
    ...frame,
    axis: 'x',
    fixed: room.z1,
    from: room.x0,
    to: room.x1,
    gaps: [{ from: room.doorX - 0.6, to: room.doorX + 0.6, h: 2.2 }],
  });
  // Table: white top on two steel pedestals, with a cable box.
  b.box(room.length, 0.05, room.width, '#f7f7f4', room.x, 0.7, room.z);
  b.box(0.1, 0.7, room.width * 0.7, STEEL, room.x - room.length / 2 + 0.4, 0, room.z);
  b.box(0.1, 0.7, room.width * 0.7, STEEL, room.x + room.length / 2 - 0.4, 0, room.z);
  b.box(0.24, 0.012, 0.16, GRAPHITE, room.x, 0.75, room.z);
  // Chairs, every one facing the table.
  room.seats.forEach(s => {
    const back = (d: number) => ({ x: s.seat.x - Math.sin(s.yaw) * d, z: s.seat.z - Math.cos(s.yaw) * d });
    b.box(0.46, 0.07, 0.46, '#d3d8df', s.seat.x, 0.43, s.seat.z, s.yaw);
    const bk = back(0.22);
    b.box(0.46, 0.36, 0.05, '#c1c7d0', bk.x, 0.5, bk.z, s.yaw);
    b.cylinder(0.03, 0.03, 0.28, '#4a515c', s.seat.x, 0.15, s.seat.z, 8);
    b.cylinder(0.22, 0.22, 0.03, '#4a515c', s.seat.x, 0.04, s.seat.z, 10);
  });
  // A rolling whiteboard in the far corner, and a plant in the other.
  const wx = room.x0 + 0.65;
  const wz = room.z0 + 0.4;
  b.box(1.3, 0.9, 0.03, '#fdfdfd', wx, 0.8, wz);
  b.box(1.36, 0.05, 0.05, GRAPHITE, wx, 0.77, wz);
  b.box(1.36, 0.05, 0.05, GRAPHITE, wx, 1.7, wz);
  b.box(0.05, 0.95, 0.05, GRAPHITE, wx - 0.66, 0.77, wz);
  b.box(0.05, 0.95, 0.05, GRAPHITE, wx + 0.66, 0.77, wz);
  b.box(0.05, 0.8, 0.05, STEEL, wx - 0.55, 0, wz);
  b.box(0.05, 0.8, 0.05, STEEL, wx + 0.55, 0, wz);
  plant(b, room.x0 + 0.5, room.z1 - 0.5, 0.75);
}

function restArea(b: Batch, glass: Batch, frost: Batch, layout: OfficeLayout) {
  const rest = layout.rest;
  const at = (u: number, v: number): Vec2 => ({ x: rest.x0 + u, z: rest.z0 + v });
  const extra = rest.x1 - rest.x0 - 10.6;
  const w = rest.x1 - rest.x0;
  const d = rest.z1 - rest.z0;
  // Floor: warm wood patch with a blue-grey lounge rug.
  b.box(w, 0.012, d, '#efe3cd', rest.x0 + w / 2, 0, rest.z0 + d / 2);
  b.box(w - 1.2, 0.016, 2.5, '#d4dfeb', rest.x0 + w / 2, 0, rest.z0 + 6.25);
  b.box(w - 1.6, 0.018, 2.1, '#dfe8f2', rest.x0 + w / 2, 0, rest.z0 + 6.25);
  // Glass walls: north and the west wall with its door. South and east are the building's own.
  const frame = {
    h: ROOM_HEIGHT,
    sill: 0,
    header: 0.1,
    step: 1.5,
    frame: GRAPHITE,
    post: 0.06,
    thick: 0.08,
    frostBand: true,
  };
  wallRun(b, glass, frost, { ...frame, axis: 'x', fixed: rest.z0, from: rest.x0, to: rest.x1 });
  wallRun(b, glass, frost, {
    ...frame,
    axis: 'z',
    fixed: rest.x0,
    from: rest.z0,
    to: rest.z1,
    gaps: [{ from: rest.doorZ - 0.8, to: rest.doorZ + 0.8, h: 2.2 }],
  });
  // Kitchenette along the back wall: counter, appliances and a row of stools.
  const c0 = at(0.4, 0.2);
  b.box(5.4, 0.9, 0.7, '#f2f2ef', c0.x + 2.7, 0, c0.z + 0.35);
  b.box(5.46, 0.05, 0.74, GRAPHITE, c0.x + 2.7, 0.9, c0.z + 0.35);
  b.box(0.5, 0.22, 0.3, '#2f3439', c0.x + 0.9, 0.95, c0.z + 0.25);
  b.box(0.7, 0.05, 0.45, STEEL, c0.x + 3.2, 0.95, c0.z + 0.35);
  b.box(0.8, 1.85, 0.7, '#e7eaee', c0.x + 5.95, 0, c0.z + 0.35);
  rest.stools.forEach((s, i) => {
    b.cylinder(0.03, 0.03, 0.4, STEEL, s.x, 0, s.z, 6);
    b.cylinder(0.22, 0.22, 0.07, ['#e89b6b', '#6fa8c9', '#f0d27a'][i % 3], s.x, 0.4, s.z, 12);
  });
  // Ping-pong table.
  const t = rest.table;
  b.box(t.length, 0.06, 1.525, '#2f8f78', t.x, 0.72, t.z);
  b.box(0.04, 0.18, 1.55, '#f4f4f0', t.x, 0.78, t.z);
  b.box(t.length - 0.1, 0.062, 0.03, '#f4f4f0', t.x, 0.72, t.z);
  for (const lx of [-1.2, 1.2]) for (const lz of [-0.66, 0.66]) b.box(0.07, 0.72, 0.07, STEEL, t.x + lx, 0, t.z + lz);
  // Sofas and armchairs facing north, with a low table between them.
  const sofaMid = rest.sofas[1];
  b.box(3.1, 0.42, 0.95, '#8ea4c4', sofaMid.x, 0, sofaMid.z + 0.05);
  b.box(3.1, 0.55, 0.24, '#7d94b6', sofaMid.x, 0.3, sofaMid.z + 0.4);
  for (const dx of [-1.45, 1.45]) b.box(0.2, 0.34, 0.95, '#7d94b6', sofaMid.x + dx, 0.3, sofaMid.z + 0.05);
  const armColors = ['#e8825a', '#4fa3a5', '#e9c24d', '#4a6fb0'];
  rest.chairs.forEach((c, i) => {
    b.box(0.95, 0.4, 0.9, armColors[i % 4], c.x, 0, c.z + 0.05);
    b.box(0.95, 0.5, 0.2, armColors[i % 4], c.x, 0.3, c.z + 0.4);
    for (const dx of [-0.42, 0.42]) b.box(0.14, 0.3, 0.9, armColors[i % 4], c.x + dx, 0.3, c.z + 0.05);
  });
  const coffee = at(4.85, 6.0);
  b.cylinder(0.45, 0.45, 0.05, '#f7f7f4', coffee.x, 0.34, coffee.z, 20);
  b.cylinder(0.05, 0.05, 0.34, STEEL, coffee.x, 0, coffee.z, 8);
  // Floor lamp and plants.
  const lampPos = at(0.5, 6.9);
  b.cylinder(0.03, 0.03, 1.5, '#8a8f98', lampPos.x, 0, lampPos.z, 6);
  b.cylinder(0.2, 0.28, 0.3, '#f6edd0', lampPos.x, 1.45, lampPos.z, 12);
  plant(b, at(w - 0.6, 7.0).x, at(w - 0.6, 7.0).z, 1.1);
  plant(b, at(w - 0.6, 0.7).x, at(w - 0.6, 0.7).z, 1.1);
  plant(b, at(0.6, 3.3).x + 0.2, at(0.6, 3.3).z, 0.9);
  void extra;
  void d;
}

function entrance(b: Batch, glass: Batch, door: number, z: number) {
  // Two sliding glass leaves in dark frames, push bars, a threshold and a canopy.
  for (const side of [-1, 1]) {
    const cx = door + side * 0.55;
    const f = '#2f343b';
    b.box(1.05, 0.06, 0.06, f, cx, 0, z + 0.02);
    b.box(1.05, 0.06, 0.06, f, cx, 2.34, z + 0.02);
    b.box(0.06, 2.4, 0.06, f, cx - 0.5, 0, z + 0.02);
    b.box(0.06, 2.4, 0.06, f, cx + 0.5, 0, z + 0.02);
    b.box(0.03, 0.55, 0.05, '#aeb5be', door + side * 0.12, 0.85, z + 0.07);
    glass.box(1.0, 2.3, 0.025, '#e6f3fb', cx, 0.04, z + 0.02);
  }
  b.box(0.04, 2.4, 0.07, '#2f343b', door, 0, z + 0.02);
  b.box(2.3, 0.04, 0.3, '#59606a', door, 0, z + 0.1);
  // Canopy on two slim posts.
  b.box(4.4, 0.16, 1.7, FRAME_WHITE, door, 2.62, z + 0.95);
  b.box(4.4, 0.05, 0.05, '#2f343b', door, 2.62, z + 1.8);
  for (const dx of [-2.05, 2.05]) b.box(0.07, 2.62, 0.07, FRAME_WHITE, door + dx, 0, z + 1.7);
}

function entranceSign(kit: Kit, root: THREE.Group, door: number, z: number) {
  const tex = textTexture(kit, 1024, 120, (ctx, w, h) => {
    ctx.fillStyle = '#f5f6f8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#2b3037';
    ctx.font = '700 54px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '10px';
    ctx.fillText('QUANT RESEARCH OFFICE', w / 2, h / 2 + 3);
  });
  const sign = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(4.2, 0.49)),
    kit.own(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })),
  );
  sign.position.set(door, 2.7, z + 1.84);
  root.add(sign);
}

function statusTotem(kit: Kit, root: THREE.Group, x: number, z: number): (s: BoardSummary) => void {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 288;
  const ctx = canvas.getContext('2d')!;
  const texture = kit.own(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mat = kit.own(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  const frameMat = kit.own(new THREE.MeshStandardMaterial({ color: '#2c3138' }));
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = Math.PI / 4;
  const frame = new THREE.Mesh(kit.own(new THREE.BoxGeometry(2.5, 0.96, 0.08)), frameMat);
  frame.position.y = 1.75;
  const front = new THREE.Mesh(kit.own(new THREE.PlaneGeometry(2.4, 0.9)), mat);
  front.position.set(0, 1.75, 0.045);
  const back = new THREE.Mesh(front.geometry, mat);
  back.position.set(0, 1.75, -0.045);
  back.rotation.y = Math.PI;
  const postGeometry = kit.own(new THREE.BoxGeometry(0.06, 1.3, 0.06));
  for (const dx of [-1.0, 1.0]) {
    const post = new THREE.Mesh(postGeometry, frameMat);
    post.position.set(dx, 0.65, 0);
    group.add(post);
  }
  const base = new THREE.Mesh(kit.own(new THREE.BoxGeometry(2.4, 0.05, 0.5)), frameMat);
  base.position.y = 0.025;
  group.add(frame, front, back, base);
  root.add(group);
  return summary => {
    ctx.fillStyle = '#121a1f';
    ctx.fillRect(0, 0, 768, 288);
    ctx.fillStyle = '#e4b97b';
    ctx.font = '600 30px ui-monospace, Consolas, monospace';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '6px';
    ctx.fillText('QUANT / RESEARCH LAB', 36, 56);
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    const row = (label: string, value: number, color: string, x0: number) => {
      ctx.fillStyle = color;
      ctx.font = '700 84px ui-monospace, Consolas, monospace';
      ctx.fillText(String(value), x0, 170);
      ctx.fillStyle = '#93a3a1';
      ctx.font = '500 24px ui-monospace, Consolas, monospace';
      ctx.fillText(label, x0, 214);
    };
    row('WORKING', summary.working, '#5fd4b8', 36);
    row('IDLE', summary.idle, '#9fb0ae', 280);
    row('IN MEETING', summary.meeting, '#93aef0', 470);
    ctx.fillStyle = summary.attention ? '#eaa84a' : '#6f7e7c';
    ctx.font = '500 24px ui-monospace, Consolas, monospace';
    ctx.fillText(
      summary.attention
        ? `${summary.attention} NEED${summary.attention === 1 ? 'S' : ''} YOU`
        : `${summary.total} AGENTS · NO ALERTS`,
      36,
      260,
    );
    texture.needsUpdate = true;
  };
}

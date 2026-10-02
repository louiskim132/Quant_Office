import * as THREE from 'three';
import { buildEnvironment, type Theme } from './environment';
import { Batch, Kit, mulberry32, textTexture } from './kit';
import { ROOM_HEIGHT, WALL_HEIGHT, type Facing, type MeetingRoom, type OfficeLayout, type Vec2 } from './layout';

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

// Natural materials, after the 64 Degrees dining room and biophilic-office practice: pale oak and
// walnut, polished concrete, linen and wool in muted earth tones, stone, and a lot of planting.
const OAK = '#c99f70';
const OAK_PALE = '#dcc19b';
const WALNUT = '#6f4a30';
const WHITE = '#f3f2ee';
const BONE = '#e7e2d8';
const STEEL = '#b7bcc1';
const GRAPHITE = '#2c3035';
const STONE = '#a49d92';
const FASCIA = '#ece8e1';
const MULLION = '#c9cccd';
const FABRICS = ['#8a9877', '#b8714f', '#d6cab3', '#56707d', '#c7a14c', '#9d8a78'];
const CHAIRS = ['#3d4247', '#4a5a5f', '#5c524a', '#3f4a3d', '#4d4a58'];
const LEAVES = ['#4b7a43', '#5b8c4c', '#3e6a3b', '#6a9a52', '#2f5a37', '#77a35d'];
const POTS = ['#ece7dd', '#b4704f', '#4b4e52', '#d9cfbf'];
const BOOKS = ['#b8574a', '#4f6d8a', '#d8b55a', '#5f8a6a', '#e2ddd2', '#8a5a7a', '#3c4a5a', '#c98a4a'];

const hash = (x: number, z: number) => Math.floor((x * 73.13 + z * 19.71) * 1000) >>> 0;

function planks(kit: Kit): THREE.CanvasTexture {
  const rand = mulberry32(11);
  const tones = ['#d7b98f', '#cfae82', '#dcc09a', '#c9a679', '#d3b489', '#e0c6a2'];
  const tex = textTexture(kit, 1024, 1024, (ctx, w, h) => {
    const plankW = 64;
    const plankL = 512;
    for (let row = 0; row * plankW < h; row++) {
      const offset = Math.floor(rand() * plankL);
      for (let col = -1; col * plankL - offset < w; col++) {
        const x = col * plankL + offset - plankL;
        ctx.fillStyle = tones[Math.floor(rand() * tones.length)];
        ctx.fillRect(x, row * plankW, plankL, plankW);
        // Grain: long faint strokes and the odd knot.
        for (let g = 0; g < 6; g++) {
          ctx.strokeStyle = `rgba(120, 85, 45, ${0.04 + rand() * 0.06})`;
          ctx.lineWidth = 1 + rand();
          const gy = row * plankW + 6 + rand() * (plankW - 12);
          ctx.beginPath();
          ctx.moveTo(x, gy);
          ctx.bezierCurveTo(
            x + plankL * 0.3,
            gy + (rand() - 0.5) * 6,
            x + plankL * 0.7,
            gy + (rand() - 0.5) * 6,
            x + plankL,
            gy,
          );
          ctx.stroke();
        }
        if (rand() < 0.25) {
          ctx.fillStyle = 'rgba(110, 75, 40, 0.18)';
          ctx.beginPath();
          ctx.ellipse(x + rand() * plankL, row * plankW + plankW / 2, 7, 3, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(95, 65, 35, 0.22)';
        ctx.fillRect(x, row * plankW, plankL, 1.5);
        ctx.fillRect(x, row * plankW, 1.5, plankW);
      }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function concrete(kit: Kit): THREE.CanvasTexture {
  const rand = mulberry32(5);
  const tex = textTexture(kit, 512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#d4d0c8';
    ctx.fillRect(0, 0, w, h);
    // Soft clouding, then fine aggregate.
    for (let i = 0; i < 40; i++) {
      const px = rand() * w;
      const py = rand() * h;
      const g = ctx.createRadialGradient(px, py, 0, px, py, 60 + rand() * 140);
      const light = rand() < 0.5;
      g.addColorStop(0, light ? 'rgba(255,255,250,0.05)' : 'rgba(120,112,100,0.035)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(90,85,78,0.1)' : 'rgba(255,255,255,0.16)';
      ctx.fillRect(rand() * w, rand() * h, 1 + rand(), 1 + rand());
    }
    // Saw-cut joints on a 4 m grid (the texture spans 4 m).
    ctx.fillStyle = 'rgba(110,104,96,0.22)';
    ctx.fillRect(0, 0, w, 1.5);
    ctx.fillRect(0, 0, 1.5, h);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function foliage(kit: Kit, seed: number, w = 1024, h = 256): THREE.CanvasTexture {
  const rand = mulberry32(seed);
  return textTexture(kit, w, h, (ctx, cw, ch) => {
    ctx.fillStyle = '#2d4a2c';
    ctx.fillRect(0, 0, cw, ch);
    const greens = ['#3f6b3a', '#4f7f45', '#5f9150', '#6fa05a', '#3a5f3f', '#7fae63', '#2f5534', '#8fb86a'];
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = greens[Math.floor(rand() * greens.length)];
      ctx.beginPath();
      ctx.ellipse(rand() * cw, rand() * ch, 4 + rand() * 9, 2 + rand() * 4, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // A few flowering accents and lighter fern sprays.
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = ['#e8d77a', '#f1f0e6', '#d98f6a'][i % 3];
      ctx.beginPath();
      ctx.arc(rand() * cw, rand() * ch, 1.5 + rand() * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
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

// ---- planting --------------------------------------------------------------------------------

/** Leaves as a loose cluster of ellipsoids around a centre, seeded so a spot always grows the same. */
function crown(b: Batch, x: number, y: number, z: number, r: number, seed: number, count = 6, palette = LEAVES) {
  const rand = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * r * 0.55;
    const s = r * (0.45 + rand() * 0.35);
    b.blob(
      s,
      s * (0.7 + rand() * 0.3),
      s,
      palette[Math.floor(rand() * palette.length)],
      x + Math.cos(a) * d,
      y + rand() * r * 0.6,
      z + Math.sin(a) * d,
      rand() * Math.PI,
    );
  }
}

/** A tall indoor tree (fiddle-leaf fig / olive) in a large pot. */
function indoorTree(b: Batch, x: number, z: number, scale = 1, pot = POTS[0]) {
  const seed = hash(x, z);
  b.cylinder(0.3 * scale, 0.24 * scale, 0.55 * scale, pot, x, 0, z, 16);
  b.cylinder(0.27 * scale, 0.27 * scale, 0.02, '#4a3b2c', x, 0.53 * scale, z, 16);
  b.cylinder(0.035 * scale, 0.05 * scale, 1.3 * scale, '#6b5640', x, 0.5 * scale, z, 6);
  crown(b, x, 1.15 * scale, z, 0.62 * scale, seed, 8);
}

/** A floor plant: pot and a low bushy crown. */
function floorPlant(b: Batch, x: number, z: number, scale = 1, pot = POTS[0]) {
  const seed = hash(x, z) + 7;
  b.cylinder(0.2 * scale, 0.16 * scale, 0.38 * scale, pot, x, 0, z, 14);
  crown(b, x, 0.32 * scale, z, 0.36 * scale, seed, 6);
}

/** Upright snake-plant blades. */
function blades(b: Batch, x: number, y: number, z: number, h: number, seed: number, color = '#3f6b3a') {
  const rand = mulberry32(seed);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    b.cone(
      0.035,
      h * (0.65 + rand() * 0.35),
      i % 2 ? color : '#5d8a4d',
      x + Math.cos(a) * 0.06,
      y,
      z + Math.sin(a) * 0.06,
      4,
      {
        rx: Math.sin(a) * 0.18,
        rz: -Math.cos(a) * 0.18,
      },
    );
  }
}

function deskPlant(b: Batch, x: number, y: number, z: number, seed: number) {
  b.cylinder(0.055, 0.045, 0.09, POTS[seed % POTS.length], x, y, z, 10);
  if (seed % 2) blades(b, x, y + 0.08, z, 0.22, seed);
  else crown(b, x, y + 0.07, z, 0.1, seed, 4);
}

// ---- walls -----------------------------------------------------------------------------------

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
  post: string;
  postW: number;
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
 * A glass wall: a base, a header band and slim mullions, with clear glass between them. Gaps leave
 * an opening (a door) with glass kept above it. The wall never changes height, so the whole office
 * stays visible from every side.
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
    seg(glass, r.axis, r.fixed, a, c, r.sill, top, 0.03, '#dceff7');
    if (r.frostBand && frost) seg(frost, r.axis, r.fixed, a, c, 0.95, 1.3, 0.045, '#ffffff');
    const n = Math.max(1, Math.round((c - a) / r.step));
    for (let i = 0; i <= n; i++) {
      const p = a + ((c - a) * i) / n;
      seg(solid, r.axis, r.fixed, p - r.postW / 2, p + r.postW / 2, r.sill, top, r.thick * 0.6, r.post);
    }
  }
  for (const g of gaps) {
    seg(glass, r.axis, r.fixed, g.from, g.to, g.h, top, 0.03, '#dceff7');
    seg(solid, r.axis, r.fixed, g.from, g.to, g.h - 0.06, g.h, r.thick * 0.6, r.post);
    for (const p of [g.from, g.to])
      seg(solid, r.axis, r.fixed, p - r.postW / 2, p + r.postW / 2, 0, top, r.thick * 0.6, r.post);
  }
}

// ---- the world -------------------------------------------------------------------------------

export function buildWorld(layout: OfficeLayout, kit: Kit, theme: Theme): World {
  const root = new THREE.Group();
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const door = layout.entrance.x;
  const dusk = theme === 'dark';

  const b = new Batch();
  const glass = new Batch();
  const frost = new Batch();
  /** Unlit pieces: lamp shades, the fire, glowing strips. They read as light sources at dusk. */
  const glow = new Batch();

  // The slab: a crisp rectangle a step above the courtyard.
  b.box(width + 1.6, 0.3, depth + 1.6, '#e3dfd7', minX + width / 2, -0.31, minZ + depth / 2);

  // Floors: polished concrete everywhere, pale oak planks in the work neighbourhoods.
  const plane = (w: number, d: number, x: number, z: number, y: number, material: THREE.Material) => {
    const m = new THREE.Mesh(kit.own(new THREE.PlaneGeometry(w, d)), material);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const concreteTex = concrete(kit);
  concreteTex.repeat.set(width / 4, depth / 4);
  plane(
    width,
    depth,
    minX + width / 2,
    minZ + depth / 2,
    0,
    kit.own(new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.42, metalness: 0 })),
  );
  const workW = layout.workX1 - 0.15;
  const oakTex = planks(kit);
  oakTex.repeat.set(workW / 3.2, (depth - 0.3) / 3.2);
  plane(
    workW,
    depth - 0.3,
    0.15 + workW / 2,
    depth / 2,
    0.004,
    kit.own(new THREE.MeshStandardMaterial({ map: oakTex, roughness: 0.62, metalness: 0 })),
  );
  // A slim brass strip where oak meets the street.
  b.box(0.04, 0.008, depth - 0.3, '#b89a5e', layout.workX1, 0, depth / 2);

  // Desks, monitors and chairs.
  const screenSpots: { x: number; y: number; z: number }[] = [];
  layout.desks.forEach((d, i) => {
    const director = d.zone === 'director';
    desk(b, glow, d.x, d.z, director, i, screenSpots, dusk);
    taskChair(b, d.seat.x, d.seat.z, director ? '#3b3430' : CHAIRS[i % CHAIRS.length]);
  });

  // The director's studio: a wool rug, a credenza against the planted wall, and the status board.
  const directors = layout.desks.filter(d => d.zone === 'director');
  if (directors.length) {
    const x0 = Math.min(...directors.map(d => d.x)) - 1.6;
    const x1 = Math.max(layout.board.x + 1.3, Math.max(...directors.map(d => d.x)) + 1.6);
    const zc = directors[0].z + 0.3;
    b.flat(x1 - x0, 3.6, '#bfb3a2', (x0 + x1) / 2, 0.009, zc);
    b.flat(x1 - x0 - 0.3, 3.3, '#d3c8b8', (x0 + x1) / 2, 0.011, zc);
    for (const d of directors) {
      b.rbox(1.8, 0.62, 0.45, 0.03, WALNUT, d.x, 0, d.z - 1.45);
      for (let k = 0; k < 6; k++)
        b.box(0.05, 0.22 + (k % 3) * 0.03, 0.17, BOOKS[k % BOOKS.length], d.x - 0.7 + k * 0.06, 0.62, d.z - 1.45);
      floorPlant(b, d.x + 0.55, d.z - 1.45, 0.5, POTS[1]);
      b.cylinder(0.08, 0.1, 0.02, '#d8c7a5', d.x + 0.05, 0.62, d.z - 1.45, 12);
    }
    indoorTree(b, x0 - 0.2, directors[0].z - 1.6, 1.15, POTS[2]);
  }
  const setBoard = statusBoard(kit, root, b, layout.board);

  // Neighbourhoods: oak planter boxes between them, with a wooden plaque at the west end of each.
  for (const dv of layout.dividers) planter(b, dv.x0, dv.x1, dv.z);
  for (const sign of layout.signs) plaque(kit, root, b, sign.text, sign.x, sign.z);

  // The perimeter: a living wall on the back wall of the work area, bookshelves along the west wall.
  greenWall(kit, root, b, 0.9, layout.workX1 - 0.9);
  bookshelves(b, layout);
  indoorTree(b, 0.95, maxZ - 0.95, 1.1, POTS[1]);
  indoorTree(b, layout.workX1 - 0.9, maxZ - 0.9, 1.0, POTS[0]);

  // The street: potted trees on its edges and a lobby by the door.
  for (const p of layout.streetPlants) indoorTree(b, p.x, p.z, 0.95, POTS[(hash(p.x, p.z) >> 3) % POTS.length]);
  lobby(b, layout);

  // Meeting rooms: glass-walled, each with an oak table, upholstered chairs, a screen and a pendant.
  const roomFloors: THREE.Mesh[] = [];
  const idleFloor = kit.own(new THREE.MeshStandardMaterial({ color: '#b9bdb6', roughness: 1 }));
  const busyFloor = kit.own(
    new THREE.MeshStandardMaterial({ color: '#bcd0e3', roughness: 1, emissive: '#5b8fd0', emissiveIntensity: 0.22 }),
  );
  for (const room of layout.rooms) {
    const carpet = new THREE.Mesh(
      kit.own(new THREE.BoxGeometry(room.x1 - room.x0, 0.012, room.z1 - room.z0)),
      idleFloor,
    );
    carpet.position.set((room.x0 + room.x1) / 2, 0.006, (room.z0 + room.z1) / 2);
    carpet.receiveShadow = true;
    root.add(carpet);
    roomFloors.push(carpet);
    meetingRoom(b, glass, frost, glow, room);
  }

  // The planted walkway inside the meeting wing's east wall.
  const roomsEast = Math.max(...layout.rooms.map(r => r.x1));
  for (let z = 1.3; z < layout.rest.z0 - 0.9; z += 2.7)
    if (Math.round(z / 2.7) % 2) indoorTree(b, (roomsEast + maxX) / 2, z, 0.95, POTS[(Math.round(z) % 3) + 1]);
    else floorPlant(b, (roomsEast + maxX) / 2, z, 0.9, POTS[0]);

  // The café lounge.
  lounge(b, glass, frost, glow, layout);

  // Outside walls: floor-to-ceiling glass under a deep roof edge, after the 64 Degrees pavilion.
  const wall = {
    h: WALL_HEIGHT,
    sill: 0.1,
    header: 0.36,
    step: 1.5,
    frame: FASCIA,
    post: MULLION,
    postW: 0.07,
    thick: 0.22,
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
    gaps: [{ from: door - 1.15, to: door + 1.15, h: 2.45 }],
  });
  roofEdge(b, glow, layout, dusk);
  entrance(kit, root, b, glass, glow, door, maxZ);

  const solid = kit.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }));
  root.add(b.build(kit, solid));
  const glassMaterial = kit.own(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.16,
      roughness: 0.04,
      metalness: 0.1,
      envMapIntensity: 1.4,
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
        opacity: 0.5,
        roughness: 0.7,
        metalness: 0,
        depthWrite: false,
      }),
    );
    const frostMesh = frost.build(kit, frostMaterial, { cast: false, receive: false });
    frostMesh.renderOrder = 4;
    root.add(frostMesh);
  }
  if (glow.size)
    root.add(
      glow.build(kit, kit.own(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })), {
        cast: false,
        receive: false,
      }),
    );
  root.add(...buildEnvironment(layout, kit, theme));
  if (dusk) interiorLights(root, layout);

  // Screens: one shared material per state; each desk's plane just points at the right one.
  const states: MonitorState[] = ['off', 'working', 'stalled', 'unknown', 'away', 'done', 'failed'];
  const screenMaterials = Object.fromEntries(
    states.map(state => [
      state,
      kit.own(new THREE.MeshBasicMaterial({ map: monitorTexture(kit, state), toneMapped: false })),
    ]),
  ) as Record<MonitorState, THREE.MeshBasicMaterial>;
  const screenGeometry = kit.own(new THREE.PlaneGeometry(0.58, 0.33));
  const screens = screenSpots.map(spot => {
    const m = new THREE.Mesh(screenGeometry, screenMaterials.off);
    m.position.set(spot.x, spot.y, spot.z);
    root.add(m);
    return m;
  });

  // Room names, set into the carpet by each door.
  layout.rooms.forEach((room, i) => {
    const name = i === 0 ? 'COLLABORATION' : i === 1 ? 'REVIEW' : `ROOM ${i + 1}`;
    floorText(kit, root, name, 3.6, 0.5, room.x, room.z1 - 0.38, 26, 4, 'rgba(60, 66, 72, 0.5)');
  });
  floorText(
    kit,
    root,
    'CAFÉ · LOUNGE',
    4.2,
    0.5,
    layout.rest.x0 + 7.4,
    layout.rest.z0 + 9.4,
    26,
    5,
    'rgba(70, 64, 56, 0.45)',
  );

  // Ping-pong ball: the engine moves it while both players are at the table.
  const ball = new THREE.Mesh(
    kit.own(new THREE.SphereGeometry(0.03, 10, 8)),
    kit.own(new THREE.MeshBasicMaterial({ color: '#ff9a3c' })),
  );
  ball.visible = false;
  root.add(ball);
  const pong = layout.rest.table;

  return {
    group: root,
    screens,
    roomFloors,
    floorMaterials: { idle: idleFloor, busy: busyFloor },
    pingPong: {
      ball,
      from: { x: pong.x - pong.length / 2 + 0.25, z: pong.z },
      to: { x: pong.x + pong.length / 2 - 0.25, z: pong.z },
      y: 0.8,
    },
    setMonitor(deskIndex, state) {
      const screen = screens[deskIndex];
      if (screen) screen.material = screenMaterials[state];
    },
    setBoard,
  };
}

// ---- furniture -------------------------------------------------------------------------------

function desk(
  b: Batch,
  glow: Batch,
  x: number,
  z: number,
  director: boolean,
  i: number,
  screens: { x: number; y: number; z: number }[],
  dusk: boolean,
) {
  const top = director ? WALNUT : OAK;
  const w = director ? 1.8 : 1.6;
  b.rbox(w, 0.04, 0.8, 0.015, top, x, 0.71, z);
  // White T-legs with feet, a modesty rail, a pedestal.
  for (const side of [-1, 1]) {
    b.box(0.05, 0.71, 0.05, WHITE, x + side * (w / 2 - 0.12), 0, z);
    b.rbox(0.07, 0.03, 0.72, 0.012, WHITE, x + side * (w / 2 - 0.12), 0, z);
  }
  b.box(w - 0.3, 0.04, 0.03, WHITE, x, 0.62, z - 0.3);
  b.rbox(0.42, 0.58, 0.56, 0.02, director ? '#5a3c27' : BONE, x + w / 2 - 0.42, 0.02, z - 0.04);
  // Monitor on a single arm.
  b.rbox(0.2, 0.012, 0.13, 0.006, '#3a3e43', x, 0.75, z - 0.24);
  b.cylinder(0.016, 0.016, 0.24, '#3a3e43', x, 0.76, z - 0.26, 8);
  b.rbox(0.64, 0.38, 0.03, 0.01, '#191c20', x, 0.93, z - 0.22);
  screens.push({ x, y: 0.93 + 0.19, z: z - 0.22 + 0.0165 });
  // Keyboard, mouse, a notebook, a mug or a plant, and a lamp on every other desk.
  b.rbox(0.42, 0.018, 0.13, 0.006, '#d9dbde', x, 0.75, z + 0.12);
  b.blob(0.03, 0.012, 0.05, '#d9dbde', x + 0.32, 0.75, z + 0.14);
  b.rbox(0.18, 0.012, 0.24, 0.004, BOOKS[i % BOOKS.length], x - 0.5, 0.75, z + 0.05, 0.2);
  if (i % 3 === 1) b.cylinder(0.04, 0.035, 0.09, i % 2 ? '#e8e2d4' : '#d9844f', x + 0.55, 0.75, z - 0.05, 10);
  else deskPlant(b, x + 0.6, 0.75, z - 0.22, i + 3);
  if (i % 2 === 0 || director) {
    b.cylinder(0.07, 0.08, 0.02, GRAPHITE, x - 0.62, 0.75, z - 0.25, 12);
    b.cylinder(0.01, 0.01, 0.42, GRAPHITE, x - 0.62, 0.76, z - 0.25, 6);
    b.cylinder(0.05, 0.09, 0.1, GRAPHITE, x - 0.55, 1.12, z - 0.22, 12);
    if (dusk) glow.disc(0.08, '#ffe2b0', x - 0.55, 1.118, z - 0.22, 12);
  }
}

/** A task chair facing -z (its back toward +z): five-star base, gas lift, seat and a reclined back. */
function taskChair(b: Batch, x: number, z: number, fabric: string) {
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    b.box(0.3, 0.025, 0.045, GRAPHITE, x + Math.cos(a) * 0.15, 0.045, z + 0.03 - Math.sin(a) * 0.15, a);
    b.sphere(0.025, GRAPHITE, x + Math.cos(a) * 0.29, 0, z + 0.03 - Math.sin(a) * 0.29, 1, [6, 4]);
  }
  b.cylinder(0.025, 0.025, 0.33, '#5b6168', x, 0.07, z + 0.03, 8);
  b.rbox(0.5, 0.08, 0.48, 0.035, fabric, x, 0.4, z + 0.03);
  b.rbox(0.46, 0.5, 0.06, 0.03, fabric, x, 0.52, z + 0.28, { rx: 0.12 });
  for (const side of [-1, 1]) {
    b.box(0.03, 0.2, 0.03, GRAPHITE, x + side * 0.24, 0.45, z + 0.08);
    b.rbox(0.06, 0.03, 0.26, 0.012, GRAPHITE, x + side * 0.24, 0.64, z + 0.05);
  }
}

/** The live status board: a large screen on a slim stand, turned to face the default camera. */
function statusBoard(kit: Kit, root: THREE.Group, b: Batch, at: Facing): (s: BoardSummary) => void {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const texture = kit.own(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mat = kit.own(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  const group = new THREE.Group();
  group.position.set(at.x, 0, at.z);
  group.rotation.y = at.yaw;
  const frameMat = kit.own(new THREE.MeshStandardMaterial({ color: '#25282c', roughness: 0.5 }));
  const W = 3.3;
  const H = 1.65;
  const y = 0.95 + H / 2;
  const frame = new THREE.Mesh(kit.own(new THREE.BoxGeometry(W + 0.08, H + 0.08, 0.07)), frameMat);
  frame.position.y = y;
  frame.castShadow = true;
  const front = new THREE.Mesh(kit.own(new THREE.PlaneGeometry(W, H)), mat);
  front.position.set(0, y, 0.037);
  const back = new THREE.Mesh(front.geometry, mat);
  back.position.set(0, y, -0.037);
  back.rotation.y = Math.PI;
  group.add(frame, front, back);
  root.add(group);
  // The stand: two oak uprights on weighted feet, baked into the static mesh.
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  for (const dx of [-1.2, 1.2]) {
    const px = at.x + dx * c;
    const pz = at.z - dx * s;
    b.box(0.08, 1.0, 0.08, OAK, px, 0, pz, at.yaw);
    b.rbox(0.12, 0.05, 0.6, 0.02, GRAPHITE, px, 0, pz, at.yaw);
  }
  return summary => {
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#13201f');
    g.addColorStop(1, '#0d1514');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = '#e4b97b';
    ctx.font = '600 38px ui-monospace, Consolas, monospace';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '8px';
    ctx.fillText('OFFICE STATUS', 52, 82);
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    const tile = (label: string, value: number, color: string, x0: number) => {
      ctx.fillStyle = '#ffffff0d';
      ctx.fillRect(x0 - 16, 118, 290, 250);
      ctx.fillStyle = color;
      ctx.font = '700 150px ui-monospace, Consolas, monospace';
      ctx.fillText(String(value), x0, 290);
      ctx.fillStyle = '#9fb0ae';
      ctx.font = '500 32px ui-monospace, Consolas, monospace';
      ctx.fillText(label, x0, 345);
    };
    tile('WORKING', summary.working, '#5fd4b8', 68);
    tile('IDLE', summary.idle, '#c4cfcd', 384);
    tile('IN MEETING', summary.meeting, '#93aef0', 700);
    ctx.fillStyle = summary.attention ? '#eaa84a' : '#7d8e8b';
    ctx.font = '600 34px ui-monospace, Consolas, monospace';
    ctx.fillText(
      summary.attention
        ? `● ${summary.attention} NEED${summary.attention === 1 ? 'S' : ''} YOU`
        : `${summary.total} AGENT${summary.total === 1 ? '' : 'S'} · NO ALERTS`,
      52,
      446,
    );
    texture.needsUpdate = true;
  };
}

function planter(b: Batch, x0: number, x1: number, z: number) {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  b.rbox(len, 0.55, 0.62, 0.03, OAK_PALE, cx, 0, z);
  b.box(len - 0.12, 0.02, 0.5, '#4a3b2c', cx, 0.54, z);
  const rand = mulberry32(hash(x0, z));
  for (let x = x0 + 0.35; x < x1 - 0.2; x += 0.42) {
    const r = rand();
    if (r < 0.28) blades(b, x, 0.55, z + (rand() - 0.5) * 0.2, 0.75 + rand() * 0.3, hash(x, z));
    else if (r < 0.62) crown(b, x, 0.5, z + (rand() - 0.5) * 0.15, 0.3, hash(x, z), 4);
    else grass(b, x, 0.55, z + (rand() - 0.5) * 0.2, 0.5, hash(x, z), ['#7d9a5a', '#93ad6a', '#6b8a4f']);
  }
}

/** Fine leaves fanning out of one point: ornamental grass, ferns in a planter. */
export function grass(b: Batch, x: number, y: number, z: number, h: number, seed: number, palette: string[]) {
  const rand = mulberry32(seed);
  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2;
    const tilt = 0.2 + rand() * 0.45;
    b.cone(0.022, h * (0.6 + rand() * 0.4), palette[i % palette.length], x, y, z, 3, {
      rx: Math.sin(a) * tilt,
      rz: -Math.cos(a) * tilt,
    });
  }
}

function plaque(kit: Kit, root: THREE.Group, b: Batch, text: string, x: number, z: number) {
  const tex = textTexture(kit, 512, 128, (ctx, w, h) => {
    ctx.fillStyle = '#d9bf98';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(120, 85, 45, 0.12)';
    for (let i = 0; i < 9; i++) ctx.fillRect(0, 8 + i * 13, w, 2);
    ctx.fillStyle = '#3b3128';
    ctx.font = '700 46px system-ui, sans-serif';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '5px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
  });
  const mat = kit.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
  const geo = kit.own(new THREE.PlaneGeometry(1.9, 0.47));
  for (const flip of [0, Math.PI]) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, 1.15, z);
    m.rotation.y = Math.PI / 4 + flip;
    m.translateZ(0.026);
    root.add(m);
  }
  b.box(1.96, 0.52, 0.05, WALNUT, x, 0.89, z, Math.PI / 4);
  b.box(0.06, 0.9, 0.06, WALNUT, x, 0, z, Math.PI / 4);
  b.rbox(0.5, 0.04, 0.5, 0.02, GRAPHITE, x, 0, z, Math.PI / 4);
}

function floorText(
  kit: Kit,
  root: THREE.Group,
  text: string,
  planeW: number,
  planeH: number,
  x: number,
  z: number,
  font: number,
  spacing: number,
  ink: string,
) {
  const px = 100;
  const tex = textTexture(kit, Math.round(planeW * px), Math.round(planeH * px), (ctx, w, h) => {
    ctx.font = `600 ${font}px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spacing}px`;
    ctx.fillText(text, w / 2, h / 2);
  });
  const plane = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(planeW, planeH)),
    kit.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(x, 0.03, z);
  root.add(plane);
}

/** A living wall across the back of the work area, on an oak frame with a planter trough. */
function greenWall(kit: Kit, root: THREE.Group, b: Batch, x0: number, x1: number) {
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const tex = foliage(kit, 21, 2048, 256);
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, w / 8), 1);
  const mesh = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(w, 2.2)),
    kit.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 })),
  );
  mesh.position.set(cx, 0.55 + 1.1, 0.21);
  mesh.receiveShadow = true;
  root.add(mesh);
  b.box(w + 0.16, 2.36, 0.08, OAK, cx, 0.47, 0.16);
  b.rbox(w, 0.48, 0.4, 0.03, OAK_PALE, cx, 0, 0.42);
  const rand = mulberry32(31);
  for (let x = x0 + 0.3; x < x1 - 0.2; x += 0.5) crown(b, x, 0.4, 0.42 + (rand() - 0.5) * 0.1, 0.24, hash(x, 0.42), 3);
}

function bookshelves(b: Batch, layout: OfficeLayout) {
  const { maxZ } = layout.bounds;
  const z0 = 2.4;
  const z1 = maxZ - 2.6;
  const rand = mulberry32(17);
  for (let z = z0; z + 2.0 <= z1; z += 2.6) {
    b.rbox(0.42, 1.12, 2.0, 0.02, OAK, 0.42, 0, z + 1.0);
    for (const shelf of [0.08, 0.45, 0.82]) {
      b.box(0.36, 0.02, 1.9, OAK_PALE, 0.45, shelf, z + 1.0);
      let pz = z + 0.12;
      while (pz < z + 1.85) {
        const t = 0.03 + rand() * 0.04;
        const h = 0.22 + rand() * 0.1;
        if (rand() < 0.12) pz += 0.12;
        else
          b.box(0.24, h, t, BOOKS[Math.floor(rand() * BOOKS.length)], 0.47, shelf + 0.02, pz, rand() < 0.08 ? 0.15 : 0);
        pz += t + 0.006;
      }
    }
    floorPlant(b, 0.45, z + 0.45, 0.55, POTS[(Math.round(z) % 3) + 1]);
    deskPlant(b, 0.45, 1.12, z + 1.5, Math.round(z * 3));
  }
}

function lobby(b: Batch, layout: OfficeLayout) {
  const { maxZ } = layout.bounds;
  const x = layout.corridorX;
  // A doormat, a long oak bench and planters either side of the door.
  b.flat(2.4, 1.2, '#3e4248', x, 0.008, maxZ - 0.75);
  b.rbox(0.5, 0.42, 1.8, 0.04, OAK, x - layout.corridorWidth / 2 + 0.4, 0, maxZ - 2.1);
  floorPlant(b, x - 1.9, maxZ - 0.6, 0.9, POTS[2]);
  floorPlant(b, x + 1.9, maxZ - 0.6, 0.9, POTS[2]);
}

function meetingRoom(b: Batch, glass: Batch, frost: Batch, glow: Batch, room: MeetingRoom) {
  const frame = {
    h: ROOM_HEIGHT,
    sill: 0,
    header: 0.1,
    step: 1.5,
    frame: GRAPHITE,
    post: GRAPHITE,
    postW: 0.06,
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
  // An oak table on two steel pedestals, with a cable box.
  b.rbox(room.length, 0.05, room.width, 0.02, OAK, room.x, 0.7, room.z);
  for (const side of [-1, 1]) {
    b.box(0.08, 0.7, room.width * 0.6, STEEL, room.x + side * (room.length / 2 - 0.45), 0, room.z);
    b.rbox(0.14, 0.03, room.width * 0.75, 0.01, STEEL, room.x + side * (room.length / 2 - 0.45), 0, room.z);
  }
  b.rbox(0.28, 0.012, 0.16, 0.004, GRAPHITE, room.x, 0.75, room.z);
  // Chairs, every one facing the table.
  room.seats.forEach((s, i) => {
    const back = (d: number) => ({ x: s.seat.x - Math.sin(s.yaw) * d, z: s.seat.z - Math.cos(s.yaw) * d });
    const fabric = FABRICS[(room.index + i) % 2 ? 0 : 2];
    b.rbox(0.48, 0.08, 0.46, 0.035, fabric, s.seat.x, 0.4, s.seat.z, s.yaw);
    const bk = back(0.22);
    b.rbox(0.46, 0.4, 0.06, 0.03, fabric, bk.x, 0.48, bk.z, { rx: -0.1, ry: s.yaw });
    b.cylinder(0.025, 0.025, 0.36, '#4a515c', s.seat.x, 0.05, s.seat.z, 8);
    b.cylinder(0.2, 0.22, 0.03, '#4a515c', s.seat.x, 0.02, s.seat.z, 14);
  });
  // A linear pendant over the table, hung from the room's header.
  const pl = room.length * 0.7;
  for (const side of [-1, 1]) b.box(0.01, 0.75, 0.01, GRAPHITE, room.x + side * pl * 0.4, 1.85, room.z);
  b.rbox(pl, 0.06, 0.14, 0.02, GRAPHITE, room.x, 1.8, room.z);
  glow.box(pl - 0.08, 0.01, 0.09, '#fff1d6', room.x, 1.795, room.z);
  // A screen on the back wall, a credenza under it, and a plant in the far corner.
  const sx = room.x;
  b.rbox(1.8, 0.6, 0.42, 0.02, OAK_PALE, sx, 0, room.z0 + 0.3);
  b.box(1.5, 0.86, 0.05, '#15181b', sx, 1.05, room.z0 + 0.12);
  b.box(1.4, 0.76, 0.01, '#23333a', sx, 1.1, room.z0 + 0.15);
  floorPlant(b, room.x1 - 0.42, room.z0 + 0.45, 0.85, POTS[1]);
}

/** An armchair centred on (x, z), facing yaw. */
function armchair(b: Batch, x: number, z: number, yaw: number, fabric: string) {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  b.rbox(0.86, 0.36, 0.84, 0.07, fabric, x, 0.05, z, yaw);
  b.rbox(0.66, 0.12, 0.62, 0.05, fabric, x + fx * 0.06, 0.38, z + fz * 0.06, yaw);
  b.rbox(0.86, 0.46, 0.2, 0.07, fabric, x - fx * 0.33, 0.36, z - fz * 0.33, yaw);
  for (const side of [-1, 1]) {
    const px = x + Math.cos(yaw) * side * 0.36;
    const pz = z - Math.sin(yaw) * side * 0.36;
    b.rbox(0.15, 0.3, 0.8, 0.06, fabric, px, 0.38, pz, yaw);
  }
  for (const sx of [-0.33, 0.33])
    for (const sz of [-0.33, 0.33])
      b.cylinder(0.02, 0.015, 0.06, WALNUT, x + Math.cos(yaw) * sx + fx * sz, 0, z - Math.sin(yaw) * sx + fz * sz, 6);
}

function lounge(b: Batch, glass: Batch, frost: Batch, glow: Batch, layout: OfficeLayout) {
  const rest = layout.rest;
  const at = (u: number, v: number): Vec2 => ({ x: rest.x0 + u, z: rest.z0 + v });
  // Glass walls: north and the west wall with its door. South and east are the building's own.
  const frame = {
    h: ROOM_HEIGHT,
    sill: 0,
    header: 0.1,
    step: 1.5,
    frame: GRAPHITE,
    post: GRAPHITE,
    postW: 0.06,
    thick: 0.08,
    frostBand: false,
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

  // The counter: reclaimed-oak front, pale stone top, an espresso machine, jars and greenery.
  const c = rest.counter;
  const cw = c.x1 - c.x0;
  const cx = (c.x0 + c.x1) / 2;
  b.rbox(cw, 0.72, 0.72, 0.03, '#a77d55', cx, 0, c.z);
  for (let x = c.x0 + 0.3; x < c.x1; x += 0.3) b.box(0.012, 0.66, 0.012, '#8f6743', x, 0.03, c.z + 0.362);
  b.rbox(cw + 0.06, 0.04, 0.78, 0.015, '#e9e5dd', cx, 0.72, c.z);
  b.rbox(0.42, 0.36, 0.34, 0.03, '#c4c8cc', c.x0 + 0.7, 0.76, c.z - 0.1);
  b.box(0.36, 0.06, 0.04, GRAPHITE, c.x0 + 0.7, 0.92, c.z + 0.08);
  b.rbox(0.18, 0.32, 0.2, 0.02, GRAPHITE, c.x0 + 1.2, 0.76, c.z - 0.12);
  b.cylinder(0.16, 0.12, 0.08, '#d9cfbf', c.x0 + 2.6, 0.76, c.z, 14);
  for (const [k, color] of ['#e6a33b', '#d95b43', '#9fbf56'].entries())
    b.sphere(0.04, color, c.x0 + 2.56 + k * 0.05, 0.8, c.z + (k - 1) * 0.04, 1, [6, 5]);
  for (let k = 0; k < 5; k++)
    b.cylinder(
      0.05,
      0.05,
      0.16 + (k % 2) * 0.05,
      ['#e8dfc9', '#c9a46e', '#efe8da'][k % 3],
      c.x0 + 3.6 + k * 0.14,
      0.76,
      c.z - 0.18,
      10,
    );
  deskPlant(b, c.x0 + 4.8, 0.76, c.z - 0.1, 4);
  deskPlant(b, c.x1 - 0.5, 0.76, c.z - 0.1, 5);
  b.rbox(0.7, 1.9, 0.68, 0.03, '#e3e5e6', c.x1 + 0.45, 0, c.z - 0.02);
  glow.box(cw - 0.2, 0.012, 0.05, '#ffe5bb', cx, 0.715, c.z + 0.33);
  rest.stools.forEach((s, i) => {
    for (const [dx, dz] of [
      [-0.13, -0.13],
      [0.13, -0.13],
      [-0.13, 0.13],
      [0.13, 0.13],
    ])
      b.cylinder(0.015, 0.018, 0.42, '#2f3338', s.x + dx, 0, s.z + dz, 6);
    b.cylinder(0.19, 0.19, 0.05, i % 2 ? OAK : '#a77d55', s.x, 0.42, s.z, 16);
  });

  // Ping-pong table.
  const t = rest.table;
  b.rbox(t.length, 0.05, 1.525, 0.01, '#2c6f8f', t.x, 0.71, t.z);
  b.box(0.03, 0.16, 1.6, '#f4f4f0', t.x, 0.76, t.z);
  b.box(t.length - 0.06, 0.052, 0.02, '#f4f4f0', t.x, 0.71, t.z);
  for (const lx of [-1.1, 1.1]) for (const lz of [-0.6, 0.6]) b.box(0.06, 0.71, 0.06, GRAPHITE, t.x + lx, 0, t.z + lz);
  b.cylinder(0.08, 0.08, 0.01, '#c4423a', t.x - 0.6, 0.76, t.z + 0.5, 12);

  // Sofa group: a linen sofa facing the room, an armchair at each end of a low oak table, a wool rug.
  const sofa = rest.sofas[1];
  const rugA = at(3.0, 6.9);
  b.flat(5.2, 3.4, '#cbbca4', rugA.x, 0.009, rugA.z);
  b.flat(4.9, 3.1, '#dbcdb6', rugA.x, 0.011, rugA.z);
  const linen = FABRICS[2];
  b.rbox(3.0, 0.36, 0.95, 0.08, '#c3b59c', sofa.x, 0.06, sofa.z - 0.1);
  for (const s of rest.sofas) {
    b.rbox(0.92, 0.14, 0.7, 0.06, linen, s.x, 0.36, s.z - 0.02);
    b.rbox(0.9, 0.44, 0.2, 0.08, linen, s.x, 0.4, s.z - 0.42, { rx: -0.12 });
  }
  for (const side of [-1, 1]) b.rbox(0.2, 0.58, 0.95, 0.08, '#c3b59c', sofa.x + side * 1.5, 0.06, sofa.z - 0.1);
  b.rbox(0.36, 0.3, 0.12, 0.06, FABRICS[1], sofa.x - 1.15, 0.5, sofa.z - 0.3, { rx: -0.25, ry: -0.3 });
  b.rbox(0.34, 0.3, 0.12, 0.06, FABRICS[0], sofa.x + 1.15, 0.5, sofa.z - 0.3, { rx: -0.25, ry: 0.25 });
  for (const sx of [-1.35, 1.35])
    for (const sz of [-0.45, 0.3]) b.cylinder(0.025, 0.02, 0.06, WALNUT, sofa.x + sx, 0, sofa.z + sz, 6);
  const coffee = rest.coffee;
  b.rbox(1.4, 0.05, 0.7, 0.025, OAK, coffee.x, 0.36, coffee.z);
  for (const dx of [-0.6, 0.6])
    for (const dz of [-0.28, 0.28]) b.box(0.04, 0.36, 0.04, WALNUT, coffee.x + dx, 0, coffee.z + dz);
  b.box(0.3, 0.04, 0.22, BOOKS[1], coffee.x - 0.35, 0.41, coffee.z, 0.2);
  b.box(0.26, 0.035, 0.2, BOOKS[2], coffee.x - 0.33, 0.45, coffee.z, 0.35);
  deskPlant(b, coffee.x + 0.35, 0.41, coffee.z, 8);
  const groupA = rest.chairs.slice(0, 2);
  groupA.forEach((ch, i) => armchair(b, ch.x, ch.z, ch.yaw, i ? FABRICS[3] : FABRICS[1]));

  // Fireside group: four armchairs round a table, facing a stone fireplace on the east wall.
  const round = rest.round;
  b.disc(2.1, '#9aa58f', round.x, 0.009, round.z, 40);
  b.disc(1.95, '#aab49e', round.x, 0.011, round.z, 40);
  rest.chairs
    .slice(2)
    .forEach((ch, i) => armchair(b, ch.x, ch.z, ch.yaw, [FABRICS[0], FABRICS[4], FABRICS[5], FABRICS[3]][i]));
  b.cylinder(0.45, 0.45, 0.04, OAK, round.x, 0.4, round.z, 24);
  b.cylinder(0.05, 0.06, 0.4, WALNUT, round.x, 0, round.z, 8);
  b.cylinder(0.25, 0.25, 0.03, WALNUT, round.x, 0, round.z, 16);
  b.cylinder(0.06, 0.05, 0.12, '#e8e2d4', round.x + 0.15, 0.44, round.z - 0.1, 10);
  const f = rest.fireplace;
  const fd = rest.x1 - 0.12 - f.x;
  const fz = (f.z0 + f.z1) / 2;
  b.rbox(fd, 1.15, f.z1 - f.z0, 0.04, STONE, f.x + fd / 2, 0, fz);
  b.rbox(fd * 0.8, 1.45, 1.6, 0.04, '#b2aba0', f.x + fd * 0.55, 1.15, fz);
  for (let k = 0; k < 9; k++) b.box(0.01, 0.012, f.z1 - f.z0 - 0.1, '#8d867c', f.x - 0.002, 0.12 + k * 0.12, fz);
  b.box(0.02, 0.5, 1.3, '#141210', f.x - 0.01, 0.32, fz);
  b.rbox(0.5, 0.06, f.z1 - f.z0 + 0.2, 0.02, '#7c766d', f.x - 0.2, 0, fz);
  b.cylinder(0.05, 0.05, 0.6, '#5b4330', f.x - 0.05, 0.36, fz, 8, { rx: Math.PI / 2 });
  for (let k = 0; k < 5; k++)
    glow.blob(
      0.07 + (k % 2) * 0.03,
      0.12 + (k % 3) * 0.05,
      0.08,
      ['#ffb24a', '#ff8a2a', '#ffd27a'][k % 3],
      f.x - 0.06,
      0.38,
      fz - 0.4 + k * 0.2,
    );

  // A reading lamp, plants between the groups, and planter boxes along the front glass.
  const lamp = at(0.5, 8.7);
  b.cylinder(0.16, 0.18, 0.03, GRAPHITE, lamp.x, 0, lamp.z, 14);
  b.cylinder(0.012, 0.012, 1.45, GRAPHITE, lamp.x, 0.03, lamp.z, 6);
  glow.cylinder(0.17, 0.22, 0.3, '#f1e4c7', lamp.x, 1.42, lamp.z, 16);
  indoorTree(b, rest.x0 + 8.3, rest.z0 + 7.0, 1.05, POTS[1]);
  planter(b, rest.x0 + 0.6, rest.x0 + 6.8, rest.z1 - 0.55);
  planter(b, rest.x0 + 8.6, rest.x1 - 0.6, rest.z1 - 0.55);
  indoorTree(b, rest.x1 - 0.65, rest.z0 + 1.0, 1.0, POTS[0]);
  floorPlant(b, rest.x0 + 8.4, rest.z0 + 0.8, 0.9, POTS[2]);
}

/** The roof edge: a deep fascia that overhangs the glass on every side, with soffit lights at dusk. */
function roofEdge(b: Batch, glow: Batch, layout: OfficeLayout, dusk: boolean) {
  const { maxX, maxZ } = layout.bounds;
  const o = 0.5;
  const y = WALL_HEIGHT - 0.36;
  const h = 0.36;
  b.box(maxX + 2 * o, h, o, FASCIA, maxX / 2, y, -o / 2);
  b.box(maxX + 2 * o, h, o, FASCIA, maxX / 2, y, maxZ + o / 2);
  b.box(o, h, maxZ, FASCIA, -o / 2, y, maxZ / 2);
  b.box(o, h, maxZ, FASCIA, maxX + o / 2, y, maxZ / 2);
  // A thin darker drip edge reads as the slab's shadow line.
  b.box(maxX + 2 * o + 0.02, 0.05, 0.04, '#bdb7ad', maxX / 2, y, maxZ + o);
  b.box(0.04, 0.05, maxZ + 2 * o, '#bdb7ad', maxX + o, y, maxZ / 2);
  if (!dusk) return;
  for (let x = 1.2; x < maxX - 0.6; x += 2.4) {
    glow.disc(0.07, '#fff0cf', x, y - 0.002, maxZ + o / 2, 10);
    glow.disc(0.07, '#fff0cf', x, y - 0.002, -o / 2, 10);
  }
  for (let z = 1.2; z < maxZ - 0.6; z += 2.4) {
    glow.disc(0.07, '#fff0cf', maxX + o / 2, y - 0.002, z, 10);
    glow.disc(0.07, '#fff0cf', -o / 2, y - 0.002, z, 10);
  }
}

/** The entrance: sliding glass doors under a faceted metal canopy, with the office's name above it. */
function entrance(kit: Kit, root: THREE.Group, b: Batch, glass: Batch, glow: Batch, door: number, z: number) {
  for (const side of [-1, 1]) {
    const cx = door + side * 0.57;
    const f = '#30343a';
    b.box(1.1, 0.06, 0.06, f, cx, 0, z + 0.02);
    b.box(1.1, 0.06, 0.06, f, cx, 2.39, z + 0.02);
    b.box(0.06, 2.45, 0.06, f, cx - 0.52, 0, z + 0.02);
    b.box(0.06, 2.45, 0.06, f, cx + 0.52, 0, z + 0.02);
    b.box(0.03, 0.6, 0.05, '#b8a27a', door + side * 0.12, 0.8, z + 0.07);
    glass.box(1.04, 2.35, 0.025, '#e6f3fb', cx, 0.04, z + 0.02);
  }
  b.box(2.4, 0.03, 0.32, '#5a6068', door, 0, z + 0.1);
  // Two round concrete columns carry the canopy, as at the 64 Degrees entrance.
  for (const dx of [-3.1, 3.1]) b.cylinder(0.24, 0.24, WALL_HEIGHT - 0.36, '#d9d4cb', door + dx, 0, z + 1.9, 20);
  // The canopy: a folded plate of dark metal, drawn as a slab with a faceted top.
  const cw = 7.4;
  const cd = 2.7;
  const cy = 2.72;
  b.box(cw, 0.12, cd, '#3a3e44', door, cy, z + cd / 2);
  b.box(cw + 0.04, 0.22, 0.05, '#2b2f34', door, cy - 0.06, z + cd);
  const tex = textTexture(kit, 1024, 384, (ctx, w, h) => {
    ctx.fillStyle = '#474c53';
    ctx.fillRect(0, 0, w, h);
    const n = 7;
    for (let i = 0; i < n; i++) {
      const x0 = (i / n) * w;
      const x1 = ((i + 1) / n) * w;
      ctx.fillStyle = i % 2 ? '#3e434a' : '#535960';
      ctx.beginPath();
      ctx.moveTo(x0, i % 2 ? 0 : h);
      ctx.lineTo(x1, i % 2 ? h : 0);
      ctx.lineTo(x1, i % 2 ? 0 : h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(210,214,220,0.35)';
    ctx.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath();
      ctx.moveTo((i / n) * w, 0);
      ctx.lineTo(((i + (i % 2 ? -1 : 1)) / n) * w, h);
      ctx.stroke();
    }
  });
  const top = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(cw, cd)),
    kit.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.35 })),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.set(door, cy + 0.122, z + cd / 2);
  top.receiveShadow = true;
  root.add(top);
  for (let x = door - cw / 2 + 0.6; x < door + cw / 2 - 0.4; x += 1.2)
    glow.disc(0.06, '#fff0cf', x, cy - 0.002, z + cd / 2, 10);
  // The name in brass letters standing on the canopy, like the 64° sign.
  const sign = textTexture(kit, 1024, 360, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#c9a453';
    ctx.font = '700 300px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '18px';
    ctx.fillText('QRO', w / 2, h - 40);
  });
  const letters = kit.own(new THREE.MeshBasicMaterial({ map: sign, transparent: true, side: THREE.DoubleSide }));
  const plate = new THREE.Mesh(kit.own(new THREE.PlaneGeometry(2.9, 1.02)), letters);
  plate.position.set(door, cy + 0.12 + 0.48, z + 1.1);
  root.add(plate);
  const name = textTexture(kit, 1024, 64, (ctx, w, h) => {
    ctx.fillStyle = '#2b2f34';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d8c08a';
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '12px';
    ctx.fillText('QUANT RESEARCH OFFICE', w / 2, h / 2 + 2);
  });
  const fascia = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(cw, 0.2)),
    kit.own(new THREE.MeshBasicMaterial({ map: name, toneMapped: false })),
  );
  fascia.position.set(door, cy + 0.05, z + cd + 0.027);
  root.add(fascia);
}

/** Warm light from inside the glass at dusk, as in the photograph: a grid of soft lamps. */
function interiorLights(root: THREE.Group, layout: OfficeLayout) {
  const { maxX, maxZ } = layout.bounds;
  const cols = Math.min(5, Math.max(2, Math.round(maxX / 8)));
  const rows = Math.min(3, Math.max(2, Math.round(maxZ / 8)));
  const reach = Math.max(maxX / cols, maxZ / rows) * 1.5;
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const light = new THREE.PointLight('#ffd6a0', 11, reach, 1.3);
      light.position.set(((i + 0.5) * maxX) / cols, 2.8, ((j + 0.5) * maxZ) / rows);
      root.add(light);
    }
}

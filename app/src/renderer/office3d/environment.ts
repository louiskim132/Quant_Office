import * as THREE from 'three';
import { Batch, Kit, mulberry32, softSpot } from './kit';
import type { OfficeLayout } from './layout';

export type Theme = 'dark' | 'light';

interface Palette {
  ground: string;
  lawn: string;
  lawnEdge: string;
  pave: string;
  paveLine: string;
  walk: string;
  mulch: string;
  rock: string[];
  agave: string[];
  grass: string[];
  leaves: string[];
  pine: string[];
  eucalyptus: string[];
  blossom: string[];
  water: string;
  concrete: string;
  concreteDark: string;
  glass: string;
  court: string;
}

// Day: soft southern-California light. Dusk: the blue hour of the photograph, with warm windows.
const DAY: Palette = {
  ground: '#a9b37f',
  lawn: '#93b56c',
  lawnEdge: '#87aa62',
  pave: '#dcd6cb',
  paveLine: '#c6bfb2',
  walk: '#d2ccc1',
  mulch: '#8c7b66',
  rock: ['#e4dfd4', '#d2ccbf', '#c3bcae', '#ece8df'],
  agave: ['#8eaa98', '#9db6a2', '#7f9c8a'],
  grass: ['#b7b07a', '#a4a86a', '#c8bf86', '#8e9a5c'],
  leaves: ['#5f8a4f', '#6f9a5a', '#557d47', '#7ea566'],
  pine: ['#3c5e3f', '#46694a', '#33553a'],
  eucalyptus: ['#7f9878', '#8ea686', '#6f8a6c'],
  blossom: ['#a68fd1', '#b49ddb', '#9a84c7'],
  water: '#8fc3d6',
  concrete: '#d8d3ca',
  concreteDark: '#bdb7ac',
  glass: '#8fa9ba',
  court: '#e9c53a',
};

const DUSK: Palette = {
  ground: '#3a4236',
  lawn: '#3f5a3a',
  lawnEdge: '#36502f',
  pave: '#6d6f73',
  paveLine: '#5c5e62',
  walk: '#66686c',
  mulch: '#3d362f',
  rock: ['#8e8c88', '#7f7d79', '#9a9893', '#86847f'],
  agave: ['#4f6a5e', '#58735f', '#465f53'],
  grass: ['#6c6a4c', '#5d6044', '#76704f', '#535a3c'],
  leaves: ['#35553a', '#3d5f40', '#2f4c34', '#466a46'],
  pine: ['#1f3324', '#253b29', '#1c2e21'],
  eucalyptus: ['#45584a', '#4f6252', '#3d5042'],
  blossom: ['#6f5f93', '#7a689e', '#66568a'],
  water: '#38627a',
  concrete: '#8a8780',
  concreteDark: '#6f6c66',
  glass: '#2a3a52',
  court: '#c9a52a',
};

export const palette = (theme: Theme) => (theme === 'light' ? DAY : DUSK);

/**
 * The campus around the office, after the courtyard of 64 Degrees at UC San Diego's Revelle
 * College: a concrete patio with dining tables under blue umbrellas and Adirondack chairs on a
 * yellow court, drought-tolerant beds of agaves, grasses and pale boulders, a lawn and a river-rock
 * swale, bike racks and slender light poles, pines and eucalyptus, and mid-rise concrete campus
 * buildings with fins, louvres and an open stair. Fixed seeds keep the neighbours the same every
 * time. Tall things stay on the far sides, so nothing stands between the default camera and the
 * office. Nothing outside casts real shadows; soft contact shadows are painted under trees and
 * umbrellas instead, and at dusk windows and lamps glow and pool light on the paving.
 */
export function buildEnvironment(layout: OfficeLayout, kit: Kit, theme: Theme): THREE.Object3D[] {
  const pal = palette(theme);
  const dusk = theme === 'dark';
  const rand = mulberry32(2026);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const { maxX: W, maxZ: D } = layout.bounds;
  const door = layout.entrance.x;
  const b = new Batch();
  const glow = new Batch();
  const shade = new Batch({ uv: true });
  const pools = new Batch({ uv: true });
  const g0 = -0.3;

  // ---- ground and hardscape -------------------------------------------------------------------
  b.box(1400, 0.3, 1400, pal.ground, W / 2, g0 - 0.3, D / 2);
  // Concrete apron around the building and the patio in front of it, scored on a 1.5 m grid.
  const ax0 = -3.5;
  const ax1 = W + 3.5;
  const az0 = -3.5;
  const patioZ = D + 15;
  b.box(ax1 - ax0, 0.02, patioZ - az0, pal.pave, (ax0 + ax1) / 2, g0, (az0 + patioZ) / 2);
  for (let x = ax0 + 1.5; x < ax1; x += 1.5)
    b.box(0.035, 0.022, patioZ - D - 0.6, pal.paveLine, x, g0, (D + 0.6 + patioZ) / 2);
  for (let z = D + 1.5; z < patioZ; z += 1.5) b.box(ax1 - ax0, 0.022, 0.035, pal.paveLine, (ax0 + ax1) / 2, g0, z);
  // Campus walkways: a wide promenade along the front, paths down both sides and behind.
  const promZ0 = patioZ;
  const promZ1 = patioZ + 3.6;
  b.box(160, 0.024, promZ1 - promZ0, pal.walk, W / 2, g0, (promZ0 + promZ1) / 2);
  for (let x = -70; x < W + 80; x += 2) b.box(0.03, 0.026, promZ1 - promZ0, pal.paveLine, x, g0, (promZ0 + promZ1) / 2);
  b.box(3.6, 0.024, 40, pal.walk, door, g0, promZ1 + 20);
  for (const [x, w] of [
    [ax0 - 1.6, 3.2],
    [ax1 + 1.6, 3.2],
  ] as const)
    b.box(w, 0.024, patioZ + 30, pal.walk, x, g0, (patioZ - 30) / 2);
  b.box(W + 14, 0.024, 3.2, pal.walk, W / 2, g0, az0 - 1.6);

  // ---- the patio ------------------------------------------------------------------------------
  // The yellow court with Adirondack chairs under yellow umbrellas, edged by a blue stripe.
  const cx0 = door + 4.2;
  const cx1 = Math.min(ax1 - 1.2, door + 14.5);
  const cz0 = D + 4.2;
  const cz1 = D + 11.2;
  b.box(cx1 - cx0, 0.05, cz1 - cz0, pal.court, (cx0 + cx1) / 2, g0, (cz0 + cz1) / 2);
  for (let x = cx0 + 1.5; x < cx1 - 0.1; x += 1.5)
    b.box(0.03, 0.052, cz1 - cz0, dusk ? '#a8891f' : '#d3b02c', x, g0, (cz0 + cz1) / 2);
  b.box(cx1 - cx0, 0.054, 0.22, '#3d6fb5', (cx0 + cx1) / 2, g0, cz1 - 0.3);
  // Low concrete seat walls on two sides, with uplights.
  b.rbox(cx1 - cx0 + 0.5, 0.45, 0.45, 0.04, pal.concrete, (cx0 + cx1) / 2, g0, cz0 - 0.4);
  b.rbox(0.45, 0.45, cz1 - cz0, 0.04, pal.concrete, cx1 + 0.35, g0, (cz0 + cz1) / 2);
  if (dusk)
    for (let x = cx0 + 0.6; x < cx1; x += 1.8) {
      glow.box(0.12, 0.05, 0.02, '#ffe1a6', x, g0 + 0.1, cz0 - 0.17);
      pools.flat(1.4, 1.4, '#ffcf86', x, g0 + 0.06, cz0 + 0.35);
    }
  const courtUmbrellas = Math.max(1, Math.floor((cx1 - cx0) / 3.4));
  for (let i = 0; i < courtUmbrellas; i++) {
    const ux = cx0 + ((i + 0.5) * (cx1 - cx0)) / courtUmbrellas;
    const uz = (cz0 + cz1) / 2 - 0.4;
    umbrella(b, shade, ux, g0 + 0.05, uz, '#e8c22e', 1.45);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.6 + i;
      adirondack(b, ux + Math.cos(a) * 1.15, g0 + 0.05, uz + Math.sin(a) * 1.15, -a - Math.PI / 2, '#2e3236');
    }
  }
  // Dining tables under blue umbrellas west of the entry path.
  const dx0 = ax0 + 1.4;
  const dx1 = door - 3.6;
  const cols = Math.max(1, Math.floor((dx1 - dx0) / 3.6));
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < 2; j++) {
      const tx = dx0 + ((i + 0.5) * (dx1 - dx0)) / cols + (j % 2) * 0.9;
      const tz = D + 4.6 + j * 4.0;
      umbrella(b, shade, tx, g0, tz, '#2f5f9c', 1.3);
      bistro(b, tx, g0, tz);
    }
  // A stone-rimmed water rill along the building's front, east of the door.
  const rx0 = door + 3.0;
  const rx1 = Math.min(ax1 - 0.6, door + 15);
  b.rbox(rx1 - rx0 + 0.5, 0.32, 1.2, 0.04, pal.concrete, (rx0 + rx1) / 2, g0, D + 2.4);
  b.box(rx1 - rx0, 0.02, 0.8, pal.water, (rx0 + rx1) / 2, g0 + 0.28, D + 2.4);
  for (let x = rx0 + 0.8; x < rx1; x += 2.2)
    b.box(0.6, 0.012, 0.04, dusk ? '#9fc7d8' : '#e6f3f8', x, g0 + 0.305, D + 2.4 + (rand() - 0.5) * 0.4);
  // Planting beds along the patio's south edge, either side of the entry path.
  bed(b, shade, pal, rand, ax0 + 0.6, door - 2.4, patioZ - 3.0, patioZ - 0.4);
  bed(b, shade, pal, rand, door + 2.4, ax1 - 0.6, patioZ - 3.0, patioZ - 0.4);
  // Entry path lights.
  for (let z = D + 2; z < promZ1 + 18; z += 3.2)
    for (const side of [-1, 1]) {
      const x = door + side * 2.0;
      if (z > patioZ - 3.2 && z < patioZ) continue;
      bollard(b, glow, pools, x, g0, z, dusk);
    }

  // ---- foreground landscape -------------------------------------------------------------------
  const fz0 = promZ1 + 0.4;
  const fz1 = fz0 + 26;
  // Lawn on the left, a planted slope with boulders and a river-rock swale on the right.
  b.box(door - 2.2 + 30, 0.06, fz1 - fz0, pal.lawn, (-30 + door - 2.2) / 2, g0, (fz0 + fz1) / 2);
  for (let x = -28; x < door - 3; x += 2.5) b.box(1.1, 0.062, fz1 - fz0, pal.lawnEdge, x, g0, (fz0 + fz1) / 2);
  bed(b, shade, pal, rand, door + 2.2, W + 30, fz0, fz1, true);
  // The swale: a meandering band of river rock.
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const sx = door + 8 + t * 22 + Math.sin(t * 6) * 2.5;
    const sz = fz0 + 2 + t * 14;
    b.box(2.6, 0.03, 1.4, pal.mulch, sx, g0 + 0.03, sz, 0.5 + Math.sin(t * 6) * 0.3);
    for (let k = 0; k < 7; k++)
      b.blob(
        0.12 + rand() * 0.12,
        0.07,
        0.1 + rand() * 0.1,
        pick(pal.rock),
        sx + (rand() - 0.5) * 2.2,
        g0 + 0.03,
        sz + (rand() - 0.5) * 1.1,
        rand() * 3,
        [6, 4],
      );
  }
  // Small trees on the lawn and in the beds; they are far enough out not to hide the office.
  for (let i = 0; i < 7; i++)
    roundTree(b, shade, pal, rand, -18 + i * 3.8 + rand(), fz0 + 6 + rand() * 12, 0.9 + rand() * 0.3, i % 3 === 0);
  for (let i = 0; i < 6; i++)
    roundTree(
      b,
      shade,
      pal,
      rand,
      door + 6 + i * 5 + rand() * 2,
      fz0 + 9 + rand() * 12,
      0.85 + rand() * 0.3,
      i % 2 === 0,
    );
  // A timber bench deck at the path's edge.
  b.rbox(4.0, 0.4, 1.0, 0.03, '#9c7a55', door + 4.6, g0, fz0 + 1.2);
  for (let k = 0; k < 8; k++) b.box(0.02, 0.405, 0.98, '#86664a', door + 2.8 + k * 0.5, g0, fz0 + 1.2);
  // Bike racks with bikes on the promenade, east of the entry path.
  for (let i = 0; i < 9; i++) {
    const x = door + 4 + i * 1.1;
    const z = promZ1 - 0.6;
    for (const dx of [-0.32, 0.32]) b.cylinder(0.025, 0.025, 0.8, '#7d838a', x + dx, g0, z, 6);
    b.box(0.68, 0.05, 0.05, '#7d838a', x, g0 + 0.78, z);
    if (i % 4 !== 3) bike(b, x + 0.15, g0, z + 0.05, pick(['#2e3b4f', '#8c2f2a', '#3a3a3a', '#58704a', '#c9c3b5']));
  }
  // Light poles along the promenade.
  for (let x = -26; x < W + 34; x += 9.5) lightPole(b, glow, pools, x, g0, promZ0 + 0.4, dusk);
  for (let z = -18; z < patioZ; z += 9.5) {
    lightPole(b, glow, pools, ax0 - 3.4, g0, z, dusk);
    lightPole(b, glow, pools, ax1 + 3.4, g0, z, dusk);
  }

  // ---- the sides and the back ------------------------------------------------------------------
  // Lawns on both sides and behind, each with a planted strip along its walk.
  lawn(b, pal, ax1 + 3.2, ax1 + 20, az0 - 24, patioZ);
  lawn(b, pal, ax0 - 24, ax0 - 3.2, az0 - 24, patioZ);
  lawn(b, pal, ax0 - 3.2, ax1 + 3.2, az0 - 24, az0 - 3.2);
  bed(b, shade, pal, rand, ax1 + 3.4, ax1 + 6.6, -2, patioZ - 0.4);
  bed(b, shade, pal, rand, ax0 - 6.6, ax0 - 3.4, -2, patioZ - 0.4);
  bed(b, shade, pal, rand, ax0 - 1, ax1 + 1, az0 - 6.4, az0 - 3.4);
  // Pines and eucalyptus behind and to the left; a few far to the right. They stand far enough out
  // (about 0.67 m of height per metre of distance, the camera's slope) that orbiting round to the
  // back or the side still shows the whole office over them.
  for (let x = -38; x < W + 34; x += 4.2 + rand() * 2.4) {
    const z = az0 - 12 - rand() * 9;
    if (rand() < 0.55) pine(b, shade, pal, rand, x, g0, z, 9 + rand() * 3);
    else eucalyptus(b, shade, pal, rand, x, g0, z, 10 + rand() * 3);
  }
  for (let z = -14; z < patioZ + 8; z += 4.5 + rand() * 2) {
    const x = ax0 - 13 - rand() * 9;
    if (rand() < 0.5) pine(b, shade, pal, rand, x, g0, z, 9 + rand() * 3);
    else eucalyptus(b, shade, pal, rand, x, g0, z, 10 + rand() * 3);
  }
  for (let z = -24; z < -6; z += 5) pine(b, shade, pal, rand, ax1 + 16 + rand() * 4, g0, z, 10 + rand() * 3);
  // Medium trees on the right side, kept short enough to see past.
  for (let z = 1; z < D + 6; z += 6.5)
    roundTree(b, shade, pal, rand, ax1 + 10 + rand() * 3, z + rand() * 2, 0.95, rand() < 0.3);

  // Campus buildings: concrete frames with deep glazing, fins, louvres and an open stair.
  campus(b, glow, pal, rand, dusk, -34, -10, az0 - 46, az0 - 30, 5, 'stairs');
  campus(b, glow, pal, rand, dusk, -2, W - 2, az0 - 44, az0 - 30, 5, 'fins');
  campus(b, glow, pal, rand, dusk, W + 6, W + 32, az0 - 40, az0 - 24, 4, 'louvres');
  campus(b, glow, pal, rand, dusk, -46, -28, -10, D + 16, 4, 'fins');
  campus(b, glow, pal, rand, dusk, ax1 + 26, ax1 + 40, -12, D + 4, 3, 'louvres');
  // A low glass dining wing across the promenade to the right, like the photograph's left pavilion.
  campus(b, glow, pal, rand, dusk, ax1 + 18, ax1 + 34, D + 10, D + 24, 1, 'pavilion');

  const out: THREE.Object3D[] = [
    b.build(kit, kit.own(new THREE.MeshLambertMaterial({ vertexColors: true })), { cast: false, receive: true }),
  ];
  if (glow.size)
    out.push(
      glow.build(kit, kit.own(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })), {
        cast: false,
        receive: false,
      }),
    );
  if (shade.size) {
    const m = shade.build(
      kit,
      kit.own(
        new THREE.MeshBasicMaterial({
          map: softSpot(kit),
          vertexColors: true,
          transparent: true,
          opacity: dusk ? 0.35 : 0.28,
          depthWrite: false,
          // Black spots need no tone mapping; sharing the light pools' shader saves a compile.
          toneMapped: false,
        }),
      ),
      { cast: false, receive: false },
    );
    m.renderOrder = 1;
    out.push(m);
  }
  if (pools.size) {
    const m = pools.build(
      kit,
      kit.own(
        new THREE.MeshBasicMaterial({
          map: softSpot(kit),
          vertexColors: true,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
      { cast: false, receive: false },
    );
    m.renderOrder = 2;
    out.push(m);
  }
  return out;
}

type Rand = () => number;

/** A soft contact shadow on the ground (black, faded by the spot texture), offset away from the sun. */
function contact(shade: Batch, x: number, y: number, z: number, r: number) {
  shade.flat(r * 2.2, r * 2.2, '#000000', x + r * 0.25, y + 0.035, z - r * 0.3);
}

function umbrella(b: Batch, shade: Batch, x: number, y: number, z: number, color: string, r: number) {
  b.cylinder(0.03, 0.03, 2.25, '#c9ccd0', x, y, z, 8);
  b.cylinder(0.22, 0.26, 0.06, '#5a5f66', x, y, z, 12);
  b.cone(r, 0.42, color, x, y + 2.05, z, 8);
  b.cone(r * 1.01, 0.03, color, x, y + 2.02, z, 8);
  b.sphere(0.04, '#d9dcdf', x, y + 2.45, z, 1, [6, 4]);
  contact(shade, x, y, z, r * 0.9);
}

function bistro(b: Batch, x: number, y: number, z: number) {
  b.cylinder(0.4, 0.4, 0.03, '#d7dadd', x, y + 0.72, z, 18);
  b.cylinder(0.03, 0.03, 0.72, '#a9aeb3', x, y, z, 8);
  b.cylinder(0.22, 0.24, 0.02, '#a9aeb3', x, y, z, 12);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const cx = x + Math.cos(a) * 0.72;
    const cz = z + Math.sin(a) * 0.72;
    b.rbox(0.42, 0.04, 0.42, 0.015, '#c3c8cd', cx, y + 0.44, cz, -a);
    b.rbox(0.42, 0.36, 0.03, 0.012, '#c3c8cd', cx + Math.cos(a) * 0.2, y + 0.46, cz + Math.sin(a) * 0.2, {
      rx: 0.08,
      ry: -a + Math.PI / 2,
    });
    for (const [lx, lz] of [
      [-0.17, -0.17],
      [0.17, -0.17],
      [-0.17, 0.17],
      [0.17, 0.17],
    ])
      b.cylinder(0.012, 0.012, 0.44, '#a9aeb3', cx + lx, y, cz + lz, 5);
  }
}

/** An Adirondack chair: slatted seat sloping back, a tall fanned back and wide flat arms. */
function adirondack(b: Batch, x: number, y: number, z: number, yaw: number, color: string) {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  b.rbox(0.66, 0.06, 0.62, 0.02, color, x, y + 0.34, z, { rx: -0.12, ry: yaw });
  b.rbox(0.62, 0.78, 0.05, 0.02, color, x - fx * 0.36, y + 0.32, z - fz * 0.36, { rx: -0.42, ry: yaw });
  for (const side of [-1, 1]) {
    const sx = x + Math.cos(yaw) * side * 0.38;
    const sz = z - Math.sin(yaw) * side * 0.38;
    b.rbox(0.13, 0.03, 0.74, 0.01, color, sx + fx * 0.04, y + 0.6, sz + fz * 0.04, yaw);
    b.box(0.05, 0.6, 0.05, color, sx + fx * 0.32, y, sz + fz * 0.32, yaw);
    b.box(0.05, 0.36, 0.05, color, sx - fx * 0.25, y, sz - fz * 0.25, yaw);
  }
}

function bike(b: Batch, x: number, y: number, z: number, color: string) {
  for (const dx of [-0.5, 0.5]) b.torus(0.33, 0.024, '#1d1f22', x + dx, y + 0.35, z);
  b.box(0.85, 0.035, 0.035, color, x, y + 0.5, z, { rz: 0.0 });
  b.box(0.6, 0.035, 0.035, color, x - 0.2, y + 0.42, z, { rz: 0.55 });
  b.box(0.55, 0.035, 0.035, color, x + 0.2, y + 0.45, z, { rz: -0.62 });
  b.box(0.03, 0.3, 0.03, color, x - 0.12, y + 0.55, z);
  b.rbox(0.2, 0.04, 0.08, 0.02, '#1d1f22', x - 0.14, y + 0.85, z);
  b.box(0.03, 0.4, 0.03, color, x + 0.42, y + 0.5, z, { rz: -0.25 });
  b.box(0.04, 0.03, 0.42, '#1d1f22', x + 0.36, y + 0.9, z);
}

function bollard(b: Batch, glow: Batch, pools: Batch, x: number, y: number, z: number, dusk: boolean) {
  b.cylinder(0.08, 0.08, 0.75, '#4a4f55', x, y, z, 10);
  b.cylinder(0.09, 0.09, 0.06, '#3a3e43', x, y + 0.75, z, 10);
  if (!dusk) return;
  glow.cylinder(0.082, 0.082, 0.08, '#ffe3b0', x, y + 0.62, z, 10);
  pools.flat(1.8, 1.8, '#ffc77a', x, y + 0.05, z);
}

function lightPole(b: Batch, glow: Batch, pools: Batch, x: number, y: number, z: number, dusk: boolean) {
  b.cylinder(0.055, 0.075, 5.6, '#3c4146', x, y, z, 8);
  b.rbox(0.62, 0.12, 0.2, 0.03, '#33373c', x + 0.22, y + 5.55, z);
  if (!dusk) return;
  glow.box(0.5, 0.02, 0.14, '#fff2d2', x + 0.22, y + 5.54, z);
  pools.flat(7, 7, '#ffd08a', x + 0.22, y + 0.055, z);
}

/** Drought-tolerant planting: mulch with agaves, ornamental grasses, pale boulders and a few shrubs. */
function lawn(b: Batch, pal: Palette, x0: number, x1: number, z0: number, z1: number) {
  b.box(x1 - x0, 0.05, z1 - z0, pal.lawn, (x0 + x1) / 2, -0.3, (z0 + z1) / 2);
  // Mowing stripes.
  for (let x = x0 + 1.2; x < x1 - 0.6; x += 2.4) b.box(1.2, 0.052, z1 - z0, pal.lawnEdge, x, -0.3, (z0 + z1) / 2);
}

function bed(
  b: Batch,
  shade: Batch,
  pal: Palette,
  rand: Rand,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  slope = false,
  density = 1,
) {
  if (x1 - x0 < 0.6 || z1 - z0 < 0.6) return;
  b.box(x1 - x0, slope ? 0.12 : 0.06, z1 - z0, pal.mulch, (x0 + x1) / 2, -0.3, (z0 + z1) / 2);
  const top = -0.3 + (slope ? 0.12 : 0.06);
  const area = (x1 - x0) * (z1 - z0);
  const n = Math.min(520, Math.round(area * 1.15 * density));
  for (let i = 0; i < n; i++) {
    const x = x0 + 0.3 + rand() * (x1 - x0 - 0.6);
    const z = z0 + 0.3 + rand() * (z1 - z0 - 0.6);
    const r = rand();
    if (r < 0.2) agave(b, pal, rand, x, top, z, 0.7 + rand() * 0.6);
    else if (r < 0.58) tuft(b, pal, rand, x, top, z, 0.45 + rand() * 0.45);
    else if (r < 0.78) {
      const s = 0.25 + rand() * 0.45;
      b.blob(
        s * (1 + rand() * 0.5),
        s * 0.6,
        s,
        pal.rock[Math.floor(rand() * pal.rock.length)],
        x,
        top - s * 0.15,
        z,
        rand() * 3,
        [7, 5],
      );
      contact(shade, x, top, z, s * 0.9);
    } else if (r < 0.9) {
      const s = 0.3 + rand() * 0.25;
      b.blob(s, s * 0.8, s, pal.leaves[Math.floor(rand() * pal.leaves.length)], x, top, z, rand() * 3, [7, 5]);
    } else {
      // Succulent groundcover: a low cushion of small rosettes.
      const color = pick(rand, ['#8fa7a3', '#7f9a5a', '#a3ad72', '#9c8fa6']);
      for (let k = 0; k < 6; k++)
        b.blob(
          0.1 + rand() * 0.08,
          0.06 + rand() * 0.04,
          0.1 + rand() * 0.08,
          color,
          x + (rand() - 0.5) * 0.6,
          top,
          z + (rand() - 0.5) * 0.6,
          0,
          [6, 4],
        );
    }
  }
}

function agave(b: Batch, pal: Palette, rand: Rand, x: number, y: number, z: number, s: number) {
  const color = pal.agave[Math.floor(rand() * pal.agave.length)];
  const leaves = 11;
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + rand() * 0.3;
    const tilt = 0.55 + rand() * 0.5;
    b.cone(0.07 * s, 0.6 * s, color, x, y, z, 4, { rx: Math.sin(a) * tilt, rz: -Math.cos(a) * tilt });
  }
  b.cone(0.06 * s, 0.5 * s, color, x, y, z, 4);
}

function tuft(b: Batch, pal: Palette, rand: Rand, x: number, y: number, z: number, h: number) {
  const color = pal.grass[Math.floor(rand() * pal.grass.length)];
  for (let i = 0; i < 8; i++) {
    const a = rand() * Math.PI * 2;
    const tilt = 0.15 + rand() * 0.5;
    b.cone(0.025, h * (0.6 + rand() * 0.4), i % 3 ? color : pal.grass[0], x, y, z, 3, {
      rx: Math.sin(a) * tilt,
      rz: -Math.cos(a) * tilt,
    });
  }
}

/** A rounded shade tree (olive, coral or, in blossom, jacaranda). */
function roundTree(
  b: Batch,
  shade: Batch,
  pal: Palette,
  rand: Rand,
  x: number,
  z: number,
  s: number,
  blossom: boolean,
) {
  const y = -0.3;
  const leaves = blossom ? pal.blossom : pal.leaves;
  b.cylinder(0.1 * s, 0.15 * s, 2.0 * s, '#6e5a46', x, y, z, 7);
  b.cylinder(0.05 * s, 0.07 * s, 1.0 * s, '#6e5a46', x + 0.3 * s, y + 1.4 * s, z, 6, { rz: -0.5 });
  for (let i = 0; i < 6; i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * 0.8 * s;
    const r = (0.8 + rand() * 0.5) * s;
    b.blob(
      r,
      r * 0.75,
      r,
      leaves[Math.floor(rand() * leaves.length)],
      x + Math.cos(a) * d,
      y + (2.0 + rand() * 0.9) * s,
      z + Math.sin(a) * d,
      rand() * 3,
    );
  }
  contact(shade, x, y, z, 1.7 * s);
}

/** A Torrey-style pine: a tall, slightly leaning trunk under broad, irregular clumps of needles. */
function pine(b: Batch, shade: Batch, pal: Palette, rand: Rand, x: number, y: number, z: number, h: number) {
  const k = h / 12;
  const lean = (rand() - 0.5) * 0.12;
  b.cylinder(0.13 * k, 0.24 * k, h * 0.8, '#5d4a3a', x, y, z, 8, { rz: lean });
  const tx = x - Math.sin(lean) * h * 0.6;
  for (let i = 0; i < 9; i++) {
    const t = 0.38 + Math.pow(rand(), 0.7) * 0.6;
    const spread = (1.05 - t) * 3.2 * k;
    const a = rand() * Math.PI * 2;
    const r = (0.8 + (1 - t) * 1.6 + rand() * 0.5) * k;
    b.blob(
      r,
      r * 0.5,
      r * 0.85,
      pal.pine[Math.floor(rand() * pal.pine.length)],
      tx + Math.cos(a) * spread * rand(),
      y + h * t,
      z + Math.sin(a) * spread * rand(),
      rand() * 3,
      [9, 6],
    );
  }
  b.blob(1.0 * k, 0.6 * k, 0.9 * k, pal.pine[0], tx, y + h * 0.95, z, 0, [9, 6]);
  contact(shade, x, y, z, 2.6 * k);
}

/** A eucalyptus: a pale, leaning trunk that forks into airy grey-green crowns. */
function eucalyptus(b: Batch, shade: Batch, pal: Palette, rand: Rand, x: number, y: number, z: number, h: number) {
  const lean = (rand() - 0.5) * 0.2;
  b.cylinder(0.14, 0.24, h * 0.7, '#cfc4b0', x, y, z, 8, { rz: lean });
  const tx = x - Math.sin(lean) * h * 0.7;
  for (const side of [-1, 1]) b.cylinder(0.07, 0.11, h * 0.3, '#c4b8a2', tx, y + h * 0.62, z, 6, { rz: side * 0.35 });
  for (let i = 0; i < 7; i++) {
    const a = rand() * Math.PI * 2;
    const d = 0.6 + rand() * 1.8;
    const r = 1.1 + rand() * 1.1;
    b.blob(
      r,
      r * 0.6,
      r,
      pal.eucalyptus[Math.floor(rand() * pal.eucalyptus.length)],
      tx + Math.cos(a) * d,
      y + h * (0.68 + rand() * 0.28),
      z + Math.sin(a) * d,
      rand() * 3,
      [8, 6],
    );
  }
  contact(shade, x, y, z, 2.8);
}

type CampusStyle = 'stairs' | 'fins' | 'louvres' | 'pavilion';

/**
 * A mid-rise campus building: concrete slab edges and piers framing recessed glass, a rooftop
 * with plant, and one of: an open exterior stair, vertical fins, or horizontal sun louvres.
 * At dusk a share of the bays on the camera-facing sides is lit.
 */
function campus(
  b: Batch,
  glow: Batch,
  pal: Palette,
  rand: Rand,
  dusk: boolean,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  floors: number,
  style: CampusStyle,
) {
  const y0 = -0.3;
  const fh = style === 'pavilion' ? 4.2 : 3.7;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const bay = 3.6;
  const H = floors * fh;
  // The glazed volume, set back from the frame.
  b.box(w - 0.7, H, d - 0.7, pal.glass, cx, y0, cz);
  for (let f = 0; f <= floors; f++)
    b.box(w, 0.42, d, f === floors ? pal.concreteDark : pal.concrete, cx, y0 + f * fh - (f ? 0.42 : 0), cz);
  for (let x = x0; x <= x1 + 0.01; x += w / Math.max(1, Math.round(w / bay))) {
    b.box(0.4, H, 0.4, pal.concrete, x, y0, z0);
    b.box(0.4, H, 0.4, pal.concrete, x, y0, z1);
  }
  for (let z = z0; z <= z1 + 0.01; z += d / Math.max(1, Math.round(d / bay))) {
    b.box(0.4, H, 0.4, pal.concrete, x0, y0, z);
    b.box(0.4, H, 0.4, pal.concrete, x1, y0, z);
  }
  // Lit bays on the south and east faces at dusk; mullions on every face by day.
  const nx = Math.max(1, Math.round(w / bay));
  const nz = Math.max(1, Math.round(d / bay));
  for (let f = 0; f < floors; f++) {
    const yb = y0 + f * fh + 0.1;
    const hb = fh - 0.6;
    for (let i = 0; i < nx; i++) {
      const bx = x0 + ((i + 0.5) * w) / nx;
      if (dusk && rand() < 0.42)
        glow.box(w / nx - 0.6, hb, 0.05, pick(rand, ['#f6d79a', '#f2e3bd', '#ffd18a']), bx, yb, z1 - 0.33);
      else b.box(0.06, hb, 0.06, pal.concreteDark, bx, yb, z1 - 0.3);
    }
    for (let j = 0; j < nz; j++) {
      const bz = z0 + ((j + 0.5) * d) / nz;
      if (dusk && rand() < 0.42)
        glow.box(0.05, hb, d / nz - 0.6, pick(rand, ['#f6d79a', '#f2e3bd', '#ffd18a']), x1 - 0.33, yb, bz);
      else b.box(0.06, hb, 0.06, pal.concreteDark, x1 - 0.3, yb, bz);
    }
  }
  if (style === 'fins')
    for (let x = x0 + 0.5; x < x1; x += 0.9) {
      b.box(0.08, H - 0.4, 0.6, pal.concrete, x, y0 + 0.4, z1 + 0.25);
    }
  if (style === 'louvres')
    for (let f = 0; f < floors; f++)
      for (let k = 0; k < 5; k++) {
        const y = y0 + f * fh + 0.55 + k * 0.55;
        b.box(w, 0.05, 0.35, '#d9cdb2', cx, y, z1 + 0.3);
        b.box(0.35, 0.05, d, '#d9cdb2', x1 + 0.3, y, cz);
      }
  if (style === 'stairs') {
    // An open stair tower on the east face: piers, landings and flights.
    const sx = x1 + 1.6;
    const sz0 = z1 - 7;
    const sz1 = z1 - 1;
    for (const [px, pz] of [
      [sx - 1.4, sz0],
      [sx + 1.4, sz0],
      [sx - 1.4, sz1],
      [sx + 1.4, sz1],
    ])
      b.box(0.3, H, 0.3, pal.concrete, px, y0, pz);
    for (let f = 0; f < floors; f++) {
      const y = y0 + f * fh;
      b.box(3.0, 0.2, 1.4, pal.concrete, sx, y + fh - 0.2, sz1 - 0.7);
      const run = Math.hypot(sz1 - sz0 - 1.4, fh / 2);
      b.box(1.3, 0.16, run, pal.concreteDark, sx - 0.75, y + fh * 0.25, (sz0 + sz1) / 2 - 0.7, {
        rx: Math.atan2(fh / 2, sz1 - sz0 - 1.4),
      });
      b.box(1.3, 0.16, run, pal.concreteDark, sx + 0.75, y + fh * 0.75 - 0.4, (sz0 + sz1) / 2 - 0.7, {
        rx: -Math.atan2(fh / 2, sz1 - sz0 - 1.4),
      });
      b.box(0.04, 1.0, sz1 - sz0, '#6d7277', sx + 1.45, y + fh - 0.1, (sz0 + sz1) / 2);
    }
  }
  if (style === 'pavilion') {
    // A deep flat roof on round columns over a terrace.
    b.box(w + 3, 0.5, d + 3, pal.concrete, cx, y0 + fh - 0.1, cz);
    for (let x = x0 - 1.2; x <= x1 + 1.2; x += 4) b.cylinder(0.22, 0.22, fh - 0.1, pal.concrete, x, y0, z1 + 1.2, 12);
  }
  // Rooftop plant.
  const top = y0 + H;
  for (let k = 0; k < 3; k++)
    b.box(
      2 + rand() * 2,
      1.2 + rand(),
      1.6 + rand(),
      pal.concreteDark,
      x0 + 2 + rand() * (w - 4),
      top,
      z0 + 2 + rand() * (d - 4),
    );
  for (let k = 0; k < 2; k++)
    b.cylinder(0.6, 0.6, 1.1, '#9aa0a6', x0 + 3 + rand() * (w - 6), top, z0 + 2 + rand() * (d - 4), 12);
  b.box(w, 0.9, 0.2, pal.concrete, cx, top, z0);
  b.box(w, 0.9, 0.2, pal.concrete, cx, top, z1);
  b.box(0.2, 0.9, d, pal.concrete, x0, top, cz);
  b.box(0.2, 0.9, d, pal.concrete, x1, top, cz);
}

function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)];
}

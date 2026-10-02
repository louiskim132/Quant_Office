import * as THREE from 'three';
import { Batch, Kit, mulberry32 } from './kit';
import type { OfficeLayout } from './layout';

export type Theme = 'dark' | 'light';

interface Palette {
  grass: string;
  pave: string;
  paveEdge: string;
  road: string;
  roadLine: string;
  water: string;
  stone: string;
  deck: string;
  leaves: string[];
  blossom: string[];
  towers: { glass: string; band: string; lit: string }[];
  carBodies: string[];
}

const DAY: Palette = {
  grass: '#bfdcae',
  pave: '#ece9e2',
  paveEdge: '#d9d5cb',
  road: '#5b6068',
  roadLine: '#f1d44e',
  water: '#8ccdea',
  stone: '#cfcabc',
  deck: '#cba77a',
  leaves: ['#58a56b', '#6cb87c', '#4a9460', '#7cc08a'],
  blossom: ['#f5c2d4', '#efa9c3', '#f8d3df'],
  towers: [
    { glass: '#9bbdd6', band: '#e4ecf2', lit: '#9bbdd6' },
    { glass: '#a9b9c9', band: '#dfe5ea', lit: '#a9b9c9' },
    { glass: '#8fb0a8', band: '#e2ebe8', lit: '#8fb0a8' },
    { glass: '#c8c3b6', band: '#ece8dd', lit: '#c8c3b6' },
    { glass: '#87a6c4', band: '#dbe6f0', lit: '#87a6c4' },
  ],
  carBodies: ['#f4f4f2', '#cfd4da', '#2f343c', '#4a72b8', '#b64b3d', '#e4e4e0'],
};

const DUSK: Palette = {
  grass: '#4a6355',
  pave: '#5b6068',
  paveEdge: '#4d5259',
  road: '#2d3036',
  roadLine: '#d9b94a',
  water: '#40708c',
  stone: '#6c6f72',
  deck: '#8d7357',
  leaves: ['#3f7a55', '#4b8a62', '#366a4a', '#559a6c'],
  blossom: ['#c98fa5', '#bf819a', '#d4a1b3'],
  towers: [
    { glass: '#4d6682', band: '#6b7f96', lit: '#f0d28a' },
    { glass: '#566073', band: '#71798a', lit: '#eac37a' },
    { glass: '#46675f', band: '#617f77', lit: '#f0d28a' },
    { glass: '#6b6862', band: '#85827a', lit: '#e8c880' },
    { glass: '#42597a', band: '#5d7494', lit: '#f0d28a' },
  ],
  carBodies: ['#c9cdd2', '#9aa1ab', '#1f2329', '#3b5d96', '#92382e', '#bdbdb8'],
};

export const palette = (theme: Theme) => (theme === 'light' ? DAY : DUSK);

/**
 * The city around the office: a paved plaza and entry path, a road with traffic, street lamps,
 * trees (some in blossom), a canal with a bridge, and glass towers behind. All of it is baked
 * into one static mesh with fixed seeds so the same office always has the same neighbours, and
 * none of it casts or receives shadows.
 */
export function buildEnvironment(layout: OfficeLayout, kit: Kit, theme: Theme): THREE.Mesh {
  const pal = palette(theme);
  const rand = mulberry32(2026);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const { maxX: W, maxZ: D } = layout.bounds;
  const door = layout.entrance.x;
  const b = new Batch();
  const slabTop = -0.3;

  // Ground, plaza and plinth.
  b.box(1200, 0.3, 1200, pal.grass, W / 2, slabTop - 0.3, D / 2);
  b.box(W + 10, 0.02, D + 9.5, pal.pave, W / 2, slabTop, D / 2 + 0.25);
  b.box(W + 10, 0.021, 0.18, pal.paveEdge, W / 2, slabTop, -4.5);
  b.box(W + 10, 0.021, 0.18, pal.paveEdge, W / 2, slabTop, D + 5);
  b.box(0.18, 0.021, D + 9.5, pal.paveEdge, -5, slabTop, D / 2 + 0.25);
  b.box(0.18, 0.021, D + 9.5, pal.paveEdge, W + 5, slabTop, D / 2 + 0.25);
  // Paving bands, so the plaza reads as laid stone rather than a flat sheet.
  for (let x = -4; x < W + 5; x += 3) b.box(0.05, 0.022, D + 9.5, pal.paveEdge, x, slabTop, D / 2 + 0.25);

  // Entry path from the door to the street, flanked by planting.
  const streetWalk = D + 9;
  b.box(3.6, 0.03, streetWalk - D - 0.25, '#f4f2ec', door, slabTop, (D + 0.25 + streetWalk) / 2);
  for (const edge of [-1.9, 1.9])
    b.box(0.12, 0.034, streetWalk - D - 0.25, pal.paveEdge, door + edge, slabTop, (D + 0.25 + streetWalk) / 2);
  for (const side of [-1, 1]) b.box(5, 0.06, 4.6, pal.grass, door + side * 6.8, slabTop, D + 4.2);

  // The street: sidewalk, two lanes, markings, far sidewalk.
  const roadNear = D + 10;
  const roadFar = D + 17.4;
  b.box(1200, 0.03, 2.2, pal.pave, W / 2, slabTop, D + 8.9);
  b.box(1200, 0.03, roadFar - roadNear, pal.road, W / 2, slabTop, (roadNear + roadFar) / 2);
  b.box(1200, 0.031, 2.2, pal.pave, W / 2, slabTop, roadFar + 1.1);
  for (let x = -40; x < W + 80; x += 4.4) b.box(2.2, 0.034, 0.16, pal.roadLine, x, slabTop, (roadNear + roadFar) / 2);
  b.box(1200, 0.034, 0.12, '#f1f1ee', W / 2, slabTop, roadNear + 0.35);
  b.box(1200, 0.034, 0.12, '#f1f1ee', W / 2, slabTop, roadFar - 0.35);
  for (let x = door - 2.2; x <= door + 2.2; x += 0.7) b.box(0.4, 0.034, 3.0, '#f1f1ee', x, slabTop, roadNear - 1.1);

  // Traffic: cars and a bus, parked mid-street so a still frame feels alive.
  const car = (x: number, z: number, color: string, dir: 1 | -1) => {
    b.box(4.2, 0.62, 1.8, color, x, slabTop + 0.22, z);
    b.box(2.3, 0.6, 1.6, color, x - dir * 0.2, slabTop + 0.84, z);
    b.box(2.15, 0.5, 1.64, '#2a3340', x - dir * 0.2, slabTop + 0.9, z);
    b.box(4.3, 0.2, 1.84, '#1c2025', x, slabTop + 0.1, z);
  };
  const lane1 = roadNear + 1.9;
  const lane2 = roadFar - 1.9;
  const cars: [number, number, 1 | -1][] = [
    [-8, lane1, 1],
    [W * 0.3, lane1, 1],
    [W * 0.78, lane1, 1],
    [W * 0.12, lane2, -1],
    [W * 0.52, lane2, -1],
    [W + 14, lane2, -1],
  ];
  for (const [x, z, dir] of cars) car(x + (rand() - 0.5) * 3, z, pick(pal.carBodies), dir);
  b.box(10.2, 2.55, 2.5, theme === 'light' ? '#eef2f6' : '#c9d1d9', W * 0.64, slabTop + 0.3, lane1);
  b.box(10.25, 0.7, 2.54, '#2d3d52', W * 0.64, slabTop + 1.35, lane1);
  b.box(10.25, 0.16, 2.54, '#3f7fd1', W * 0.64, slabTop + 0.85, lane1);

  // Street lamps along the near sidewalk and the plaza edge.
  const lamp = (x: number, z: number) => {
    b.cylinder(0.06, 0.08, 5.2, '#59606a', x, slabTop, z, 8);
    b.box(1.1, 0.07, 0.07, '#59606a', x, slabTop + 5.1, z);
    b.box(0.5, 0.1, 0.22, theme === 'light' ? '#f2efe6' : '#ffe9b0', x + 0.5, slabTop + 5.02, z);
  };
  for (let x = -24; x <= W + 30; x += 9) lamp(x, D + 9.6);

  // Trees: a row along the entry, the plaza corners, and the street verge; blossom near the path.
  const tree = (x: number, z: number, scale: number, blossom: boolean) => {
    const leaves = blossom ? pick(pal.blossom) : pick(pal.leaves);
    b.cylinder(0.12 * scale, 0.17 * scale, 1.7 * scale, '#6b5238', x, slabTop, z, 7);
    b.sphere(1.25 * scale, leaves, x, slabTop + 1.3 * scale, z, 0.95);
    b.sphere(
      0.9 * scale,
      pick(blossom ? pal.blossom : pal.leaves),
      x + 0.7 * scale,
      slabTop + 2.2 * scale,
      z + 0.2 * scale,
      0.95,
    );
    b.sphere(0.8 * scale, leaves, x - 0.6 * scale, slabTop + 2.0 * scale, z - 0.3 * scale, 0.95);
  };
  for (let i = 0; i < 4; i++) {
    tree(door - 7 - (i % 2) * 1.8, D + 2.4 + i * 1.5, 0.95 + rand() * 0.2, true);
    tree(door + 7 + (i % 2) * 1.8, D + 2.4 + i * 1.5, 0.95 + rand() * 0.2, true);
  }
  for (let x = -3; x < W + 4; x += 6.5) tree(x + rand(), D + 7.2, 0.9 + rand() * 0.3, rand() < 0.4);
  for (let z = -3; z < D + 4; z += 6.5) tree(-3.4, z, 0.9 + rand() * 0.25, false);
  for (let x = -3; x < W; x += 6.5) tree(x + rand(), -3.2, 0.9 + rand() * 0.25, false);

  // Canal on the right, with stone banks, a timber boardwalk and a footbridge.
  const canalX0 = W + 8;
  const canalX1 = W + 13;
  const canalZ0 = -90;
  const canalZ1 = D + 8.2;
  b.box(
    canalX1 - canalX0,
    0.02,
    canalZ1 - canalZ0,
    pal.water,
    (canalX0 + canalX1) / 2,
    slabTop - 0.1,
    (canalZ0 + canalZ1) / 2,
  );
  for (const x of [canalX0 - 0.35, canalX1 + 0.35])
    b.box(0.7, 0.2, canalZ1 - canalZ0, pal.stone, x, slabTop - 0.02, (canalZ0 + canalZ1) / 2);
  b.box(2.4, 0.1, D * 0.7, pal.deck, canalX0 - 2.4, slabTop, D * 0.4);
  const bridgeZ = D * 0.5;
  b.box(canalX1 - canalX0 + 2.4, 0.16, 2.4, pal.deck, (canalX0 + canalX1) / 2, slabTop + 0.4, bridgeZ);
  for (const dz of [-1.1, 1.1])
    b.box(canalX1 - canalX0 + 2.4, 0.5, 0.06, '#f4f4f2', (canalX0 + canalX1) / 2, slabTop + 0.55, bridgeZ + dz);
  for (let z = -40; z < D + 6; z += 3.4) {
    if (Math.abs(z - bridgeZ) < 2.2) continue;
    tree(canalX0 - 0.2, z + rand(), 0.85, true);
    tree(canalX1 + 0.4, z + rand() + 1.6, 0.9, rand() < 0.6);
  }
  for (let x = canalX1 + 3; x < canalX1 + 36; x += 5)
    for (let z = -50; z < D + 6; z += 8) tree(x + rand() * 3, z + rand() * 3, 0.9 + rand() * 0.5, false);

  // Towers: glass office blocks behind and beside the lot.
  const tower = (cx: number, cz: number, w: number, d: number, floors: number, look: Palette['towers'][number]) => {
    const floorH = 3.4;
    b.box(w + 0.6, 0.5, d + 0.6, look.band, cx, slabTop, cz);
    for (let f = 0; f < floors; f++) {
      const y = slabTop + 0.5 + f * floorH;
      const lit = theme === 'dark' && rand() < 0.35;
      b.box(w, floorH * 0.78, d, lit ? look.lit : look.glass, cx, y, cz);
      b.box(w + 0.12, floorH * 0.22, d + 0.12, look.band, cx, y + floorH * 0.78, cz);
    }
    const top = slabTop + 0.5 + floors * floorH;
    b.box(w * 0.5, 1.4, d * 0.5, look.band, cx, top, cz);
    if (rand() < 0.5) b.cylinder(0.08, 0.1, 4, '#8b929b', cx + w * 0.2, top + 1.4, cz, 6);
  };
  for (let x = -34; x < W + 52; x += 15) {
    tower(
      x + rand() * 3,
      -24 - rand() * 5,
      10 + rand() * 3,
      10 + rand() * 2,
      3 + Math.floor(rand() * 4),
      pick(pal.towers),
    );
    tower(x + 7 + rand() * 3, -46 - rand() * 6, 12 + rand() * 3, 12, 8 + Math.floor(rand() * 8), pick(pal.towers));
  }
  for (let z = 0; z < D + 22; z += 15) {
    tower(
      -26 - rand() * 4,
      z + rand() * 3,
      11 + rand() * 3,
      10 + rand() * 2,
      3 + Math.floor(rand() * 4),
      pick(pal.towers),
    );
    tower(-50 - rand() * 4, z + 6, 12, 12, 7 + Math.floor(rand() * 8), pick(pal.towers));
  }
  // A low glass pavilion across the street, so the front is not empty sky.
  b.box(14, 3.4, 8, pal.towers[0].glass, door - 16, slabTop + 0.1, roadFar + 8);
  b.box(14.4, 0.3, 8.4, pal.towers[0].band, door - 16, slabTop + 3.5, roadFar + 8);

  const material = kit.own(new THREE.MeshLambertMaterial({ vertexColors: true }));
  return b.build(kit, material, { cast: false, receive: false });
}

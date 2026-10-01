import * as THREE from 'three';
import { Batch, Kit, mulberry32, textTexture } from './kit';
import type { OfficeLayout } from './layout';

export type MonitorState = 'off' | 'working' | 'stalled' | 'unknown' | 'away' | 'done' | 'failed';
export type Theme = 'dark' | 'light';

export interface BoardSummary {
  working: number;
  idle: number;
  attention: number;
  meeting: number;
  total: number;
}
export interface WallHandle {
  group: THREE.Group;
  /** Horizontal outward normal (x, z): the wall is "near" when the camera sits on this side. */
  outward: THREE.Vector2;
  details: THREE.Object3D;
  tall: number;
  short: number;
  /** Current eased height ratio, 1 = full height. */
  amount: number;
}
export interface World {
  group: THREE.Group;
  screens: THREE.Mesh[];
  walls: WallHandle[];
  setMonitor(deskIndex: number, state: MonitorState): void;
  setBoard(summary: BoardSummary): void;
  /** Disc under each meeting table, so a busy room can be lit. */
  tableDiscs: THREE.Mesh[];
  discMaterials: { idle: THREE.MeshStandardMaterial; busy: THREE.MeshStandardMaterial };
}

const FLOOR_PLANKS = ['#ead9b6', '#e4d0a8', '#eedfbf', '#dfc99d', '#e8d6b0'];
const CHAIR_COLORS = ['#6a6fb5', '#5a79b8', '#7b64a8', '#4f8a99', '#8a6aa8'];
const WOOD = '#b98d5f';
const WOOD_DARK = '#8f6a45';
const WALL_FACE = '#9aa0ab';
const WALL_CAP = '#d2d6dc';

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
        ctx.strokeStyle = 'rgba(120, 88, 48, 0.10)';
        ctx.lineWidth = 1;
        for (let g = 0; g < 3; g++) {
          const gy = row * plankW + 10 + rand() * (plankW - 20);
          ctx.beginPath();
          ctx.moveTo(x + rand() * 30, gy);
          ctx.lineTo(x + plankL - rand() * 30, gy + (rand() - 0.5) * 3);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(100, 72, 38, 0.34)';
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

export function buildWorld(layout: OfficeLayout, kit: Kit, theme: Theme): World {
  const root = new THREE.Group();
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;

  // Floor.
  const floorTex = parquet(kit);
  floorTex.repeat.set(width / 8, depth / 8);
  const floor = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(width, depth)),
    kit.own(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(minX + width / 2, 0, minZ + depth / 2);
  floor.receiveShadow = true;
  root.add(floor);

  const b = new Batch();

  // Meeting-wing rug and the director's rug define their zones without walls.
  const director = layout.desks.filter(d => d.zone === 'director');
  if (director.length) {
    const cx = (Math.min(...director.map(d => d.x)) + Math.max(...director.map(d => d.x))) / 2;
    const rw = Math.max(...director.map(d => d.x)) - Math.min(...director.map(d => d.x)) + 3.6;
    b.box(rw, 0.012, 3.5, '#55627a', cx, 0, director[0].z + 0.55);
    b.box(rw - 0.3, 0.016, 3.2, '#66748e', cx, 0, director[0].z + 0.55);
  }

  // Desks, monitors and chairs.
  const screenSpots: { x: number; y: number; z: number }[] = [];
  layout.desks.forEach((d, i) => {
    const wood = d.zone === 'director' ? '#a47647' : WOOD;
    b.box(1.6, 0.05, 0.8, wood, d.x, 0.7, d.z);
    b.box(0.05, 0.7, 0.74, WOOD_DARK, d.x - 0.76, 0, d.z);
    b.box(0.05, 0.7, 0.74, WOOD_DARK, d.x + 0.76, 0, d.z);
    b.box(1.5, 0.42, 0.03, WOOD_DARK, d.x, 0.28, d.z - 0.33);
    b.box(0.42, 0.56, 0.68, '#a47e57', d.x + 0.52, 0.02, d.z);
    // Monitor: foot, neck, frame. The lit screen is a separate plane so its state can change.
    b.box(0.22, 0.015, 0.16, '#2a3038', d.x, 0.75, d.z - 0.2);
    b.box(0.045, 0.2, 0.045, '#2a3038', d.x, 0.765, d.z - 0.2);
    b.box(0.6, 0.36, 0.04, '#1c2128', d.x, 0.96, d.z - 0.2);
    screenSpots.push({ x: d.x, y: 0.96 + 0.18, z: d.z - 0.2 + 0.0215 });
    b.box(0.38, 0.02, 0.13, '#cfd5da', d.x, 0.75, d.z + 0.12);
    b.box(0.06, 0.02, 0.09, '#cfd5da', d.x + 0.3, 0.75, d.z + 0.14);
    b.cylinder(0.04, 0.035, 0.09, i % 2 ? '#e8e2d4' : '#e9915b', d.x + 0.58, 0.75, d.z - 0.05, 10);
    // Chair.
    const cc = CHAIR_COLORS[(d.zone === 'director' ? 4 : i) % CHAIR_COLORS.length];
    const sx = d.seat.x;
    const sz = d.seat.z;
    b.box(0.5, 0.07, 0.48, cc, sx, 0.43, sz + 0.04);
    b.box(0.5, 0.4, 0.06, cc, sx, 0.52, sz + 0.24);
    b.cylinder(0.03, 0.03, 0.28, '#30363f', sx, 0.15, sz + 0.04, 8);
    b.box(0.52, 0.03, 0.07, '#30363f', sx, 0.04, sz + 0.04);
    b.box(0.07, 0.03, 0.52, '#30363f', sx, 0.04, sz + 0.04);
  });

  // Meeting tables with chairs and a carpet disc each.
  const tableDiscs: THREE.Mesh[] = [];
  const discMaterial = kit.own(new THREE.MeshStandardMaterial({ color: '#8798b8', roughness: 1 }));
  const discBusy = kit.own(
    new THREE.MeshStandardMaterial({ color: '#7fb2ee', roughness: 1, emissive: '#2a4f86', emissiveIntensity: 0.6 }),
  );
  for (const t of layout.tables) {
    const disc = new THREE.Mesh(
      kit.own(new THREE.CylinderGeometry(t.radius + 1.15, t.radius + 1.15, 0.014, 40)),
      discMaterial,
    );
    disc.position.set(t.x, 0.007, t.z);
    disc.receiveShadow = true;
    root.add(disc);
    tableDiscs.push(disc);
    b.cylinder(0.12, 0.2, 0.7, '#4a3b2c', t.x, 0, t.z, 12);
    b.cylinder(t.radius, t.radius, 0.06, '#c99c6a', t.x, 0.7, t.z, 36);
    b.cylinder(t.radius - 0.04, t.radius - 0.04, 0.012, '#d9b080', t.x, 0.762, t.z, 36);
    t.seats.forEach((s, i) => {
      const cc = CHAIR_COLORS[(i + t.index) % CHAIR_COLORS.length];
      b.box(0.46, 0.07, 0.46, cc, s.seat.x, 0.43, s.seat.z, s.yaw);
      // Backrest behind the sitter (away from the table centre).
      const bx = s.seat.x - Math.sin(s.yaw) * 0.22;
      const bz = s.seat.z - Math.cos(s.yaw) * 0.22;
      b.box(0.46, 0.36, 0.05, cc, bx, 0.5, bz, s.yaw);
      b.cylinder(0.03, 0.03, 0.28, '#30363f', s.seat.x, 0.15, s.seat.z, 8);
    });
  }

  // Wing: lounge, ping-pong, kitchenette, shelves, server closet.
  amenities(b, layout);
  plants(b, layout);

  const material = kit.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 }));
  root.add(b.build(kit, material));

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
  for (const sign of layout.signs) {
    const tex = textTexture(kit, 640, 96, (ctx, _w, h) => {
      ctx.font = '600 44px ui-monospace, Consolas, monospace';
      ctx.fillStyle = theme === 'dark' ? 'rgba(76, 54, 30, 0.62)' : 'rgba(80, 58, 32, 0.55)';
      ctx.textBaseline = 'middle';
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '7px';
      ctx.fillText(sign.text, 6, h / 2);
    });
    const plane = new THREE.Mesh(
      kit.own(new THREE.PlaneGeometry(6.4, 0.96)),
      kit.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(sign.x + 3.2, 0.02, sign.z);
    root.add(plane);
  }
  layout.tables.forEach((t, i) => {
    const name = i === 0 ? 'COLLABORATION' : i === 1 ? 'REVIEW' : `ROOM ${i + 1}`;
    const tex = textTexture(kit, 512, 80, (ctx, w, h) => {
      ctx.font = '600 38px ui-monospace, Consolas, monospace';
      ctx.fillStyle = 'rgba(54, 66, 96, 0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '6px';
      ctx.fillText(name, w / 2, h / 2);
    });
    const plane = new THREE.Mesh(
      kit.own(new THREE.PlaneGeometry(4.2, 0.66)),
      kit.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(t.x, 0.03, t.z + t.radius + 1.0);
    root.add(plane);
  });

  // Walls (cut away when the camera is outside them) and the live status board.
  const walls = buildWalls(kit, layout, root);
  const board = statusBoard(kit, layout, walls[0].details);

  return {
    group: root,
    screens,
    walls,
    tableDiscs,
    discMaterials: { idle: discMaterial, busy: discBusy },
    setMonitor(deskIndex, state) {
      const screen = screens[deskIndex];
      if (screen) screen.material = screenMaterials[state];
    },
    setBoard: board,
  };
}

function plants(b: Batch, layout: OfficeLayout) {
  const { maxX, maxZ } = layout.bounds;
  const spots: [number, number][] = [
    [0.7, 0.8],
    [layout.corridorX - 0.95, 0.8],
    [layout.corridorX - 0.95, maxZ - 1.0],
    [0.7, maxZ - 1.0],
    [maxX - 0.8, maxZ - 0.9],
    [layout.wing.x0 + 0.2, maxZ - 0.9],
  ];
  const lastRow = Math.max(...layout.desks.map(d => d.z));
  for (const d of layout.desks) if (d.z === lastRow && d.order % 3 === 2) spots.push([d.x + 1.25, d.z - 0.2]);
  for (const [x, z] of spots) {
    b.cylinder(0.2, 0.15, 0.34, '#a8613f', x, 0, z, 10);
    b.cylinder(0.025, 0.03, 0.4, '#5b4630', x, 0.34, z, 6);
    b.sphere(0.3, '#4d9b6b', x, 0.62, z, 1.15);
    b.sphere(0.2, '#63b07f', x + 0.12, 0.92, z - 0.05, 1.1);
    b.cone(0.16, 0.5, '#3f8a5d', x - 0.1, 0.8, z + 0.06);
  }
}

function amenities(b: Batch, layout: OfficeLayout) {
  const { maxX, maxZ } = layout.bounds;
  const x0 = layout.wing.x0;
  const lastTable = layout.tables.reduce((a, t) => Math.max(a, t.z + t.radius), 0);
  const front = Math.max(lastTable + 2.4, maxZ - 5.0);
  // Lounge rug.
  b.box(7.4, 0.012, 3.6, '#6d5d8f', x0 + 5.9, 0, front + 2.0);
  b.box(7.0, 0.016, 3.2, '#7b6aa0', x0 + 5.9, 0, front + 2.0);
  // Sofa (purple) against the front, one (blue) facing it, coffee table between.
  const sofa = (x: number, z: number, color: string, rot: number) => {
    b.box(2.2, 0.42, 0.9, color, x, 0.0, z, rot);
    b.box(2.2, 0.5, 0.24, color, x, 0.3, z + (rot ? 0 : 0.33), rot);
    b.box(0.22, 0.32, 0.9, color, x - 1.0, 0.3, z, rot);
    b.box(0.22, 0.32, 0.9, color, x + 1.0, 0.3, z, rot);
  };
  sofa(x0 + 5.9, front + 3.4, '#5f6aa8', 0);
  b.box(1.3, 0.04, 0.7, '#d7c4a6', x0 + 5.9, 0.33, front + 1.9);
  b.box(0.1, 0.33, 0.1, '#6a5a44', x0 + 5.35, 0, front + 1.9);
  b.box(0.1, 0.33, 0.1, '#6a5a44', x0 + 6.45, 0, front + 1.9);
  b.box(2.2, 0.42, 0.9, '#8368b8', x0 + 5.9, 0, front + 0.55);
  b.box(2.2, 0.5, 0.24, '#8368b8', x0 + 5.9, 0.3, front + 0.2);
  // Armchairs.
  const arm = (x: number, z: number, color: string) => {
    b.box(0.9, 0.4, 0.9, color, x, 0, z);
    b.box(0.9, 0.5, 0.2, color, x, 0.3, z + 0.35);
    b.box(0.18, 0.3, 0.9, color, x - 0.4, 0.3, z);
    b.box(0.18, 0.3, 0.9, color, x + 0.4, 0.3, z);
  };
  arm(x0 + 3.2, front + 1.2, '#e0663c');
  arm(x0 + 8.9, front + 1.6, '#3d6fd6');
  // Floor lamp.
  b.cylinder(0.03, 0.03, 1.5, '#8a7a5a', x0 + 2.5, 0, front + 2.6, 6);
  b.cylinder(0.2, 0.28, 0.3, '#f0dca6', x0 + 2.5, 1.45, front + 2.6, 12);
  // Ping-pong table.
  const px = x0 + 1.9;
  const pz = Math.max(lastTable + 0.4, front - 0.4);
  b.box(2.6, 0.06, 1.45, '#3d9a82', px, 0.72, pz);
  b.box(0.04, 0.18, 1.45, '#f2f2ee', px, 0.78, pz);
  b.box(2.5, 0.062, 0.03, '#f4f4f0', px, 0.72, pz);
  for (const [lx, lz] of [
    [-1.2, -0.62],
    [1.2, -0.62],
    [-1.2, 0.62],
    [1.2, 0.62],
  ])
    b.box(0.07, 0.72, 0.07, '#2c3a3a', px + lx, 0, pz + lz);
  // Kitchenette along the back wall of the wing.
  const kx = x0 + 0.4;
  b.box(3.0, 0.9, 0.7, '#d9d3c4', kx + 1.6, 0, 0.5);
  b.box(3.0, 0.05, 0.74, '#43484f', kx + 1.6, 0.9, 0.5);
  b.box(0.8, 1.85, 0.7, '#e7eaee', kx + 3.5, 0, 0.5);
  b.box(0.62, 1.7, 0.7, '#bf3b3b', kx + 4.5, 0, 0.5);
  b.box(0.5, 0.2, 0.3, '#2f3439', kx + 1.0, 0.95, 0.4);
  // Bookshelf.
  const sx = maxX - 4.0;
  b.box(1.6, 1.9, 0.4, '#7a5636', sx, 0, 0.3);
  for (let r = 0; r < 4; r++) {
    b.box(1.5, 0.04, 0.38, '#5d4128', sx, 0.35 + r * 0.45, 0.32);
    for (let i = 0; i < 6; i++) {
      const colors = ['#c0553d', '#4f78b5', '#d6b04a', '#4e9a78', '#8a62ac', '#e2e0d6'];
      b.box(
        0.17,
        0.3 + ((i * 7 + r * 3) % 4) * 0.025,
        0.28,
        colors[(i + r * 2) % colors.length],
        sx - 0.62 + i * 0.25,
        0.39 + r * 0.45,
        0.32,
      );
    }
  }
  // Server closet in the right back corner: three low partitions and two racks.
  const cx = maxX - 1.6;
  b.box(2.8, 1.3, 0.12, '#838995', cx, 0, 2.9);
  b.box(0.12, 1.3, 2.7, '#838995', cx - 1.4, 0, 1.6);
  for (const dx of [-0.55, 0.55]) {
    b.box(0.8, 1.9, 0.8, '#1c2130', cx + dx, 0, 1.5);
    for (let i = 0; i < 6; i++) b.box(0.62, 0.05, 0.02, '#38425a', cx + dx, 0.2 + i * 0.28, 1.91);
    for (let i = 0; i < 6; i++)
      b.box(0.05, 0.05, 0.02, i % 3 ? '#4cb98a' : '#d6a64a', cx + dx + 0.24, 0.24 + i * 0.28, 1.915);
  }
}

function buildWalls(kit: Kit, layout: OfficeLayout, root: THREE.Group): WallHandle[] {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const tall = 2.4;
  const short = 0.85;
  const thick = 0.32;
  const faceMat = kit.own(new THREE.MeshStandardMaterial({ color: WALL_FACE, roughness: 0.95 }));
  const capMat = kit.own(new THREE.MeshStandardMaterial({ color: WALL_CAP, roughness: 0.9 }));
  const wall = (cx: number, cz: number, w: number, d: number, outward: [number, number]): WallHandle => {
    const group = new THREE.Group();
    group.position.set(cx, 0, cz);
    const body = new THREE.Mesh(kit.own(new THREE.BoxGeometry(w, tall, d)), faceMat);
    body.position.y = tall / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    const cap = new THREE.Mesh(kit.own(new THREE.BoxGeometry(w + 0.01, 0.08, d + 0.01)), capMat);
    cap.position.y = tall - 0.04;
    group.add(body, cap);
    const details = new THREE.Group();
    group.add(details);
    root.add(group);
    return { group, outward: new THREE.Vector2(...outward), details, tall, short, amount: 1 };
  };
  const back = wall((minX + maxX) / 2, minZ - thick / 2, maxX - minX + thick * 2, thick, [0, -1]);
  const left = wall(minX - thick / 2, (minZ + maxZ) / 2, thick, maxZ - minZ, [-1, 0]);
  const right = wall(maxX + thick / 2, (minZ + maxZ) / 2, thick, maxZ - minZ, [1, 0]);
  const front = wall((minX + maxX) / 2, maxZ + thick / 2, maxX - minX + thick * 2, thick, [0, 1]);

  // Windows along the back wall (left of the wing) and the left wall; glass is unlit-bright.
  const glass = kit.own(new THREE.MeshBasicMaterial({ color: '#c8e2fa', toneMapped: false }));
  const frameMat = kit.own(new THREE.MeshStandardMaterial({ color: '#eceff2', roughness: 0.8 }));
  const windowAt = (parent: THREE.Object3D, x: number, y: number, z: number, rotY: number) => {
    const w = new THREE.Group();
    w.position.set(x, y, z);
    w.rotation.y = rotY;
    const pane = new THREE.Mesh(kit.own(new THREE.PlaneGeometry(1.5, 1.3)), glass);
    pane.position.z = thick / 2 + 0.045;
    const frame = new THREE.Mesh(kit.own(new THREE.BoxGeometry(1.64, 1.44, 0.06)), frameMat);
    frame.position.z = thick / 2 - 0.02;
    const bar = new THREE.Mesh(kit.own(new THREE.BoxGeometry(0.05, 1.3, 0.07)), frameMat);
    bar.position.z = thick / 2 + 0.05;
    w.add(frame, pane, bar);
    parent.add(w);
  };
  // Back wall group's local +z points into the office (the wall box is centred on minZ - thick/2).
  const backWindows = Math.max(3, Math.floor((layout.corridorX - 1.2) / 2.6));
  for (let i = 0; i < backWindows; i++) windowAt(back.details, -(maxX - minX) / 2 + 1.8 + i * 2.6, 1.55, 0, 0);
  const leftWindows = Math.max(2, Math.floor((maxZ - 2) / 3.2));
  for (let i = 0; i < leftWindows; i++)
    windowAt(left.details, 0, 1.55, -(maxZ - minZ) / 2 + 2.2 + i * 3.2, Math.PI / 2);
  void right;
  void front;
  return [back, left, right, front];
}

function statusBoard(kit: Kit, layout: OfficeLayout, parent: THREE.Object3D): (s: BoardSummary) => void {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 288;
  const ctx = canvas.getContext('2d')!;
  const texture = kit.own(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mat = kit.own(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  const frame = new THREE.Mesh(
    kit.own(new THREE.BoxGeometry(2.96, 1.14, 0.1)),
    kit.own(new THREE.MeshStandardMaterial({ color: '#2c3138' })),
  );
  const screen = new THREE.Mesh(kit.own(new THREE.PlaneGeometry(2.8, 1.03)), mat);
  const group = new THREE.Group();
  const { minX, maxX } = layout.bounds;
  group.position.set(layout.wing.x0 + 6.9 - (minX + maxX) / 2, 1.7, 0.18);
  frame.position.z = 0.03;
  screen.position.z = 0.09;
  group.add(frame, screen);
  parent.add(group);
  return summary => {
    ctx.fillStyle = '#121a1f';
    ctx.fillRect(0, 0, 768, 288);
    ctx.fillStyle = '#e4b97b';
    ctx.font = '600 30px ui-monospace, Consolas, monospace';
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '6px';
    ctx.fillText('QUANT / RESEARCH LAB', 36, 56);
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    const row = (label: string, value: number, color: string, x: number) => {
      ctx.fillStyle = color;
      ctx.font = '700 84px ui-monospace, Consolas, monospace';
      ctx.fillText(String(value), x, 170);
      ctx.fillStyle = '#93a3a1';
      ctx.font = '500 24px ui-monospace, Consolas, monospace';
      ctx.fillText(label, x, 214);
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

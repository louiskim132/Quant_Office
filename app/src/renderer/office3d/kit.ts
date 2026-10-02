import * as THREE from 'three';

/**
 * Owns every GPU resource the office creates so one call frees them all, and gives the world
 * builder a cheap way to draw thousands of shapes: each is baked into one vertex-coloured geometry,
 * so the whole static office is a single draw call (and a single shadow draw).
 */
export class Kit {
  private owned: { dispose(): void }[] = [];
  own<T extends { dispose(): void }>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }
  dispose() {
    for (const resource of this.owned.splice(0)) resource.dispose();
  }
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmp = new THREE.Color();

/** Rotation applied about the shape's own base point, in the order X, then Z, then Y (yaw last). */
export interface Turn {
  rx?: number;
  ry?: number;
  rz?: number;
}

/**
 * A unit shape kept as plain arrays: three.js builds it once, and every copy in a batch is a scaled,
 * turned and moved version of it written straight into the batch's arrays. Building the office used
 * to allocate a geometry per shape and merge thousands of them, which took most of a second.
 */
interface Template {
  p: Float32Array;
  n: Float32Array;
  uv: Float32Array | null;
  index: ArrayLike<number>;
  count: number;
}
const templates = new Map<string, Template>();
function template(key: string, make: () => THREE.BufferGeometry): Template {
  let t = templates.get(key);
  if (t) return t;
  const g = make();
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const index = g.index ? Array.from(g.index.array) : Array.from({ length: p.count }, (_, i) => i);
  t = {
    p: Float32Array.from(p.array as ArrayLike<number>),
    n: Float32Array.from(n.array as ArrayLike<number>),
    uv: uv ? Float32Array.from(uv.array as ArrayLike<number>) : null,
    index,
    count: p.count,
  };
  g.dispose();
  templates.set(key, t);
  return t;
}

/** A shape's vertex in its own frame, before the turn and the move. */
interface Local {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}
const local: Local = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
const normalize = (v: Local) => {
  const l = Math.hypot(v.nx, v.ny, v.nz) || 1;
  v.nx /= l;
  v.ny /= l;
  v.nz /= l;
};

/** Collects coloured primitives and bakes them into one mesh. Positions are the shape's bottom centre. */
export class Batch {
  private pos = new Float32Array(3 * 4096);
  private nrm = new Float32Array(3 * 4096);
  private col = new Float32Array(3 * 4096);
  private uvs: Float32Array | null;
  private idx = new Uint32Array(8192);
  private vertices = 0;
  private indices = 0;
  private shapes = 0;

  /** `uv`: keep texture coordinates, for batches drawn with a map (soft shadows, light pools). */
  constructor(options: { uv?: boolean } = {}) {
    this.uvs = options.uv ? new Float32Array(2 * 4096) : null;
  }

  get size() {
    return this.shapes;
  }

  private reserve(vertices: number, indices: number) {
    const needV = this.vertices + vertices;
    if (needV * 3 > this.pos.length) {
      let cap = this.pos.length / 3;
      while (cap < needV) cap *= 2;
      const grow = (a: Float32Array, k: number) => {
        const b = new Float32Array(cap * k);
        b.set(a);
        return b;
      };
      this.pos = grow(this.pos, 3);
      this.nrm = grow(this.nrm, 3);
      this.col = grow(this.col, 3);
      if (this.uvs) this.uvs = grow(this.uvs, 2);
    }
    const needI = this.indices + indices;
    if (needI > this.idx.length) {
      let cap = this.idx.length;
      while (cap < needI) cap *= 2;
      const b = new Uint32Array(cap);
      b.set(this.idx);
      this.idx = b;
    }
  }

  /**
   * Writes one copy of `t`: `shape` sets `local` for template vertex `j`, then the copy is turned
   * (X, Z, then Y, as three.js's rotateX/Z/Y would) and moved to (x, y, z).
   */
  private emit(
    t: Template,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    turn: Turn | number,
    shape: (j: number, v: Local) => void,
  ) {
    const r = typeof turn === 'number' ? { ry: turn } : turn;
    const ax = r.rx ?? 0,
      az = r.rz ?? 0,
      ay = r.ry ?? 0;
    // M = Ry · Rz · Rx, row-major.
    const cx = Math.cos(ax),
      sx = Math.sin(ax),
      cz = Math.cos(az),
      sz = Math.sin(az),
      cy = Math.cos(ay),
      sy = Math.sin(ay);
    const rz00 = cz,
      rz01 = -sz,
      rz10 = sz,
      rz11 = cz;
    // Rz·Rx
    const a00 = rz00,
      a01 = rz01 * cx,
      a02 = -rz01 * sx;
    const a10 = rz10,
      a11 = rz11 * cx,
      a12 = -rz11 * sx;
    const a20 = 0,
      a21 = sx,
      a22 = cx;
    // Ry·(Rz·Rx)
    const m00 = cy * a00 + sy * a20,
      m01 = cy * a01 + sy * a21,
      m02 = cy * a02 + sy * a22;
    const m10 = a10,
      m11 = a11,
      m12 = a12;
    const m20 = -sy * a00 + cy * a20,
      m21 = -sy * a01 + cy * a21,
      m22 = -sy * a02 + cy * a22;
    const turned = ax !== 0 || az !== 0 || ay !== 0;
    this.reserve(t.count, t.index.length);
    tmp.set(color);
    const base = this.vertices;
    const { pos, nrm, col, uvs } = this;
    for (let j = 0; j < t.count; j++) {
      shape(j, local);
      const o = (base + j) * 3;
      if (turned) {
        pos[o] = m00 * local.x + m01 * local.y + m02 * local.z + x;
        pos[o + 1] = m10 * local.x + m11 * local.y + m12 * local.z + y;
        pos[o + 2] = m20 * local.x + m21 * local.y + m22 * local.z + z;
        nrm[o] = m00 * local.nx + m01 * local.ny + m02 * local.nz;
        nrm[o + 1] = m10 * local.nx + m11 * local.ny + m12 * local.nz;
        nrm[o + 2] = m20 * local.nx + m21 * local.ny + m22 * local.nz;
      } else {
        pos[o] = local.x + x;
        pos[o + 1] = local.y + y;
        pos[o + 2] = local.z + z;
        nrm[o] = local.nx;
        nrm[o + 1] = local.ny;
        nrm[o + 2] = local.nz;
      }
      col[o] = tmp.r;
      col[o + 1] = tmp.g;
      col[o + 2] = tmp.b;
      if (uvs) {
        uvs[(base + j) * 2] = t.uv ? t.uv[j * 2] : 0;
        uvs[(base + j) * 2 + 1] = t.uv ? t.uv[j * 2 + 1] : 0;
      }
    }
    for (let k = 0; k < t.index.length; k++) this.idx[this.indices + k] = t.index[k] + base;
    this.vertices += t.count;
    this.indices += t.index.length;
    this.shapes++;
  }

  box(
    w: number,
    h: number,
    d: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    turn: Turn | number = 0,
  ) {
    const t = template('box', () => new THREE.BoxGeometry(1, 1, 1));
    this.emit(t, color, x, y, z, turn, (j, v) => {
      v.x = t.p[j * 3] * w;
      v.y = t.p[j * 3 + 1] * h + h / 2;
      v.z = t.p[j * 3 + 2] * d;
      v.nx = t.n[j * 3];
      v.ny = t.n[j * 3 + 1];
      v.nz = t.n[j * 3 + 2];
    });
  }
  /** A box with softened edges: cushions, counters, tabletops — anything that should not look cut from foam. */
  rbox(
    w: number,
    h: number,
    d: number,
    radius: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    turn: Turn | number = 0,
  ) {
    // The same construction as three.js's RoundedBoxGeometry with two segments: each vertex of a
    // finely divided unit box keeps its corner's sign and a normal from the box's inner core, so
    // any size is the template's signs times the core plus the normal times the radius.
    const t = template('rbox', () => {
      const g = new THREE.BoxGeometry(1, 1, 1, 5, 5, 5);
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      const half = 0.5 / 5;
      for (let i = 0; i < p.count; i++) {
        const sx = Math.sign(p.getX(i)),
          sy = Math.sign(p.getY(i)),
          sz = Math.sign(p.getZ(i));
        const v = new THREE.Vector3(p.getX(i) - sx * half, p.getY(i) - sy * half, p.getZ(i) - sz * half).normalize();
        p.setXYZ(i, sx, sy, sz);
        n.setXYZ(i, v.x, v.y, v.z);
      }
      return g;
    });
    const r = Math.min(radius, w / 2, h / 2, d / 2);
    const bx = w / 2 - r,
      by = h / 2 - r,
      bz = d / 2 - r;
    this.emit(t, color, x, y, z, turn, (j, v) => {
      v.nx = t.n[j * 3];
      v.ny = t.n[j * 3 + 1];
      v.nz = t.n[j * 3 + 2];
      v.x = bx * t.p[j * 3] + v.nx * r;
      v.y = by * t.p[j * 3 + 1] + v.ny * r + h / 2;
      v.z = bz * t.p[j * 3 + 2] + v.nz * r;
    });
  }
  cylinder(
    rTop: number,
    rBottom: number,
    h: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    segments = 14,
    turn: Turn | number = 0,
  ) {
    const t = template(`cyl:${segments}`, () => new THREE.CylinderGeometry(1, 1, 1, segments));
    // Side normals lean with the taper, as three.js computes them; caps point straight up or down.
    const slope = h > 0 ? (rBottom - rTop) / h : 0;
    this.emit(t, color, x, y, z, turn, (j, v) => {
      const py = t.p[j * 3 + 1];
      const r = py > 0 ? rTop : rBottom;
      v.x = t.p[j * 3] * r;
      v.y = (py + 0.5) * h;
      v.z = t.p[j * 3 + 2] * r;
      const ny = t.n[j * 3 + 1];
      if (ny !== 0) {
        v.nx = 0;
        v.ny = ny;
        v.nz = 0;
      } else {
        v.nx = t.n[j * 3];
        v.ny = slope;
        v.nz = t.n[j * 3 + 2];
        normalize(v);
      }
    });
  }
  capsule(
    r: number,
    length: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    turn: Turn | number = 0,
  ) {
    // Built with radius 1 and a middle of 2, every template vertex sits on a cap (|y| ≥ 1).
    const t = template('capsule', () => new THREE.CapsuleGeometry(1, 2, 3, 10));
    this.emit(t, color, x, y, z, turn, (j, v) => {
      const py = t.p[j * 3 + 1];
      const s = py >= 0 ? 1 : -1;
      v.x = t.p[j * 3] * r;
      v.y = (py - s) * r + (s * length) / 2 + length / 2 + r;
      v.z = t.p[j * 3 + 2] * r;
      v.nx = t.n[j * 3];
      v.ny = t.n[j * 3 + 1];
      v.nz = t.n[j * 3 + 2];
    });
  }
  sphere(
    r: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    squash = 1,
    detail: [number, number] = [10, 8],
    turn: Turn | number = 0,
  ) {
    this.blob(r, r * squash, r, color, x, y, z, turn, detail);
  }
  /** An ellipsoid: leaves, boulders, cushions seen from afar. */
  blob(
    rx: number,
    ry: number,
    rz: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    turn: Turn | number = 0,
    detail: [number, number] = [9, 7],
  ) {
    const t = template(`sphere:${detail[0]}:${detail[1]}`, () => new THREE.SphereGeometry(1, detail[0], detail[1]));
    // A stretched sphere's normals take the inverse stretch (three.js's normal matrix), then unit length.
    const round = rx === ry && ry === rz;
    this.emit(t, color, x, y, z, turn, (j, v) => {
      v.x = t.p[j * 3] * rx;
      v.y = t.p[j * 3 + 1] * ry + ry;
      v.z = t.p[j * 3 + 2] * rz;
      if (round) {
        v.nx = t.n[j * 3];
        v.ny = t.n[j * 3 + 1];
        v.nz = t.n[j * 3 + 2];
      } else {
        v.nx = t.n[j * 3] / rx;
        v.ny = t.n[j * 3 + 1] / ry;
        v.nz = t.n[j * 3 + 2] / rz;
        normalize(v);
      }
    });
  }
  cone(
    r: number,
    h: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    segments = 8,
    turn: Turn | number = 0,
  ) {
    const t = template(`cone:${segments}`, () => new THREE.ConeGeometry(1, 1, segments));
    const slope = r / h;
    this.emit(t, color, x, y, z, turn, (j, v) => {
      v.x = t.p[j * 3] * r;
      v.y = (t.p[j * 3 + 1] + 0.5) * h;
      v.z = t.p[j * 3 + 2] * r;
      const ny = t.n[j * 3 + 1];
      if (ny === -1) {
        v.nx = 0;
        v.ny = -1;
        v.nz = 0;
      } else {
        // The template's side normal is (sin, 1, cos) normalised; keep its direction round the axis.
        const l = Math.hypot(t.n[j * 3], t.n[j * 3 + 2]) || 1;
        v.nx = t.n[j * 3] / l;
        v.ny = slope;
        v.nz = t.n[j * 3 + 2] / l;
        normalize(v);
      }
    });
  }
  torus(
    r: number,
    tube: number,
    color: THREE.ColorRepresentation,
    x: number,
    y: number,
    z: number,
    turn: Turn | number = 0,
  ) {
    const t = template('torus', () => new THREE.TorusGeometry(1, 0.25, 6, 18));
    this.emit(t, color, x, y, z, turn, (j, v) => {
      v.nx = t.n[j * 3];
      v.ny = t.n[j * 3 + 1];
      v.nz = t.n[j * 3 + 2];
      // The ring's centre line under this vertex, then out along the normal by the tube radius.
      const px = t.p[j * 3] - v.nx * 0.25,
        py = t.p[j * 3 + 1] - v.ny * 0.25;
      v.x = px * r + v.nx * tube;
      v.y = py * r + v.ny * tube;
      v.z = v.nz * tube;
    });
  }
  /** A flat quad lying on the floor (y is its height): painted lines, rugs, light pools. */
  flat(w: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, yaw = 0) {
    const t = template('flat', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.emit(t, color, x, y, z, yaw, (j, v) => {
      v.x = t.p[j * 3] * w;
      v.y = 0;
      v.z = t.p[j * 3 + 2] * d;
      v.nx = 0;
      v.ny = 1;
      v.nz = 0;
    });
  }
  disc(r: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, segments = 24) {
    const t = template(`disc:${segments}`, () => new THREE.CircleGeometry(1, segments).rotateX(-Math.PI / 2));
    this.emit(t, color, x, y, z, 0, (j, v) => {
      v.x = t.p[j * 3] * r;
      v.y = 0;
      v.z = t.p[j * 3 + 2] * r;
      v.nx = 0;
      v.ny = 1;
      v.nz = 0;
    });
  }
  /** One mesh from everything collected. The caller owns the returned geometry through the Kit. */
  build(
    kit: Kit,
    material: THREE.Material,
    shadows: { cast: boolean; receive: boolean } = { cast: true, receive: true },
  ): THREE.Mesh {
    if (!this.vertices) throw new Error('office3d: nothing to merge');
    const g = kit.own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.vertices * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.vertices * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.vertices * 3), 3));
    if (this.uvs) g.setAttribute('uv', new THREE.BufferAttribute(this.uvs.slice(0, this.vertices * 2), 2));
    const index = this.idx.subarray(0, this.indices);
    g.setIndex(new THREE.BufferAttribute(this.vertices > 65535 ? index.slice() : Uint16Array.from(index), 1));
    this.vertices = this.indices = this.shapes = 0;
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = shadows.cast;
    mesh.receiveShadow = shadows.receive;
    return mesh;
  }
}

/** A pattern drawn once into a canvas texture (the planted wall, the canopy's folds, floors). */
export function textTexture(
  kit: Kit,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, width, height);
  const texture = kit.own(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Lettering that stays sharp at any zoom. It is drawn on a fixed logical page (`page` units wide)
 * and repainted, at the size the camera shows it, whenever a zoom leaves it too coarse or needlessly
 * large; a texture of fixed size blurs as soon as the view moves in. `draw` may be called again at
 * any time, so it must paint the whole page from its own state.
 */
export class TextSurface {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private pixels = 0;
  constructor(
    kit: Kit,
    /** Width of the surface in the world, in metres. */
    readonly meters: number,
    private page: { w: number; h: number },
    private paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    private limits = { min: 128, max: 4096 },
  ) {
    this.texture = kit.own(new THREE.CanvasTexture(this.canvas));
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 16;
  }
  /** Repaint at the size that `pixelsPerMeter` (device pixels per metre on screen) calls for. */
  fit(pixelsPerMeter: number): boolean {
    const want = Math.min(this.limits.max, Math.max(this.limits.min, this.meters * pixelsPerMeter * 1.15));
    // Repaint only when the page has become too coarse, or more than twice what is needed.
    if (this.pixels && want <= this.pixels && want * 2 >= this.pixels) return false;
    const width = Math.min(this.limits.max, Math.ceil(want / 64) * 64);
    this.resize(width);
    return true;
  }
  /** Paint again at the current size, after the state the page shows has changed. */
  redraw() {
    if (!this.pixels) this.resize(this.limits.min);
    else this.draw();
  }
  private resize(width: number) {
    const resized = width !== this.pixels;
    this.pixels = width;
    this.canvas.width = width;
    this.canvas.height = Math.max(1, Math.round((width * this.page.h) / this.page.w));
    // A texture's storage is fixed at its first upload; a new size needs new storage.
    if (resized) this.texture.dispose();
    this.draw();
  }
  private draw() {
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.canvas.width / this.page.w, 0, 0, this.canvas.height / this.page.h, 0, 0);
    this.paint(ctx, this.page.w, this.page.h);
    this.texture.needsUpdate = true;
  }
}

/** A soft round spot (white centre fading to clear), used for light pools and contact shadows. */
export function softSpot(kit: Kit): THREE.CanvasTexture {
  return textTexture(kit, 128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

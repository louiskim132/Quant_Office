import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

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

/** Collects coloured primitives and bakes them into one mesh. Positions are the shape's bottom centre. */
export class Batch {
  private parts: THREE.BufferGeometry[] = [];
  private paint(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
    tmp.set(color);
    const count = geometry.getAttribute('position').count;
    const data = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      data[i * 3] = tmp.r;
      data[i * 3 + 1] = tmp.g;
      data[i * 3 + 2] = tmp.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(data, 3));
    return geometry;
  }
  private place(geometry: THREE.BufferGeometry, x: number, y: number, z: number, turn: Turn | number = 0) {
    const t = typeof turn === 'number' ? { ry: turn } : turn;
    if (t.rx) geometry.rotateX(t.rx);
    if (t.rz) geometry.rotateZ(t.rz);
    if (t.ry) geometry.rotateY(t.ry);
    geometry.translate(x, y, z);
    this.parts.push(geometry);
  }
  get size() {
    return this.parts.length;
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
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    this.place(this.paint(g, color), x, y, z, turn);
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
    const rounded = new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2));
    // Merging needs every part indexed; the rounded box comes out flat, so weld it again.
    const g = mergeVertices(rounded);
    rounded.dispose();
    g.translate(0, h / 2, 0);
    this.place(this.paint(g, color), x, y, z, turn);
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
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    g.translate(0, h / 2, 0);
    this.place(this.paint(g, color), x, y, z, turn);
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
    const g = new THREE.CapsuleGeometry(r, length, 3, 10);
    g.translate(0, length / 2 + r, 0);
    this.place(this.paint(g, color), x, y, z, turn);
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
    const g = new THREE.SphereGeometry(r, detail[0], detail[1]);
    g.scale(1, squash, 1);
    g.translate(0, r * squash, 0);
    this.place(this.paint(g, color), x, y, z, turn);
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
    const g = new THREE.SphereGeometry(1, detail[0], detail[1]);
    g.scale(rx, ry, rz);
    g.translate(0, ry, 0);
    this.place(this.paint(g, color), x, y, z, turn);
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
    const g = new THREE.ConeGeometry(r, h, segments);
    g.translate(0, h / 2, 0);
    this.place(this.paint(g, color), x, y, z, turn);
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
    const g = new THREE.TorusGeometry(r, tube, 6, 18);
    this.place(this.paint(g, color), x, y, z, turn);
  }
  /** A flat quad lying on the floor (y is its height): painted lines, rugs, light pools. */
  flat(w: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, yaw = 0) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    this.place(this.paint(g, color), x, y, z, yaw);
  }
  disc(r: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, segments = 24) {
    const g = new THREE.CircleGeometry(r, segments);
    g.rotateX(-Math.PI / 2);
    this.place(this.paint(g, color), x, y, z, 0);
  }
  /** One mesh from everything collected. The caller owns the returned geometry through the Kit. */
  build(
    kit: Kit,
    material: THREE.Material,
    shadows: { cast: boolean; receive: boolean } = { cast: true, receive: true },
  ): THREE.Mesh {
    const merged = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    this.parts = [];
    if (!merged) throw new Error('office3d: nothing to merge');
    kit.own(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = shadows.cast;
    mesh.receiveShadow = shadows.receive;
    return mesh;
  }
}

/** Text or a pattern drawn into a canvas texture (signs, the status board, the planted wall). */
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

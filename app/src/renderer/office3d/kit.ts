import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Owns every GPU resource the office creates so one call frees them all, and gives the world
 * builder a cheap way to draw hundreds of boxes: each is baked into one vertex-coloured geometry,
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
  private place(geometry: THREE.BufferGeometry, x: number, y: number, z: number, rotY: number) {
    if (rotY) geometry.rotateY(rotY);
    geometry.translate(x, y, z);
    this.parts.push(geometry);
  }
  get size() {
    return this.parts.length;
  }
  box(w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, rotY = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    this.place(this.paint(g, color), x, y, z, rotY);
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
  ) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    g.translate(0, h / 2, 0);
    this.place(this.paint(g, color), x, y, z, 0);
  }
  sphere(r: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, squash = 1) {
    const g = new THREE.SphereGeometry(r, 10, 8);
    g.scale(1, squash, 1);
    this.place(this.paint(g, color), x, y + r * squash, z, 0);
  }
  cone(r: number, h: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, segments = 8) {
    const g = new THREE.ConeGeometry(r, h, segments);
    g.translate(0, h / 2, 0);
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

/** Text drawn into a canvas texture (floor signs, the wall board). */
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

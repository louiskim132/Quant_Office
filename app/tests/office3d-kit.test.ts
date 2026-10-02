import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Batch, Kit, type Turn } from '../src/renderer/office3d/kit';

/**
 * The batch writes each shape from a cached unit template instead of building a three.js geometry
 * per shape. These checks build the same shapes the old way (three.js geometry, then rotateX/Z/Y and
 * translate) and require the same vertices, normals and triangles.
 */
function reference(g: THREE.BufferGeometry, turn: Turn, x: number, y: number, z: number) {
  if (turn.rx) g.rotateX(turn.rx);
  if (turn.rz) g.rotateZ(turn.rz);
  if (turn.ry) g.rotateY(turn.ry);
  g.translate(x, y, z);
  return g;
}
function built(fill: (b: Batch) => void) {
  const b = new Batch();
  fill(b);
  const mesh = b.build(new Kit(), new THREE.MeshBasicMaterial());
  return mesh.geometry;
}
/** Vertex list as rounded "position|normal" keys, in order. */
function keys(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const r = (v: number) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
  return Array.from({ length: p.count }, (_, i) =>
    [p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)].map(r).join(','),
  );
}
function triangles(g: THREE.BufferGeometry) {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
function same(actual: THREE.BufferGeometry, expected: THREE.BufferGeometry, ordered = true) {
  const a = keys(actual);
  const e = keys(expected);
  if (ordered) assert.deepEqual(a, e);
  else assert.deepEqual([...new Set(a)].sort(), [...new Set(e)].sort());
  assert.equal(triangles(actual), triangles(expected));
}

const turns: Turn[] = [{}, { ry: 0.7 }, { rx: 0.3, rz: -0.4, ry: 1.9 }];

test('boxes, cylinders, cones, spheres and blobs match three.js geometry', () => {
  for (const t of turns) {
    same(
      built(b => b.box(1.3, 0.4, 0.7, '#fff', 2, 0.5, -1, t)),
      reference(new THREE.BoxGeometry(1.3, 0.4, 0.7).translate(0, 0.2, 0), t, 2, 0.5, -1),
    );
    same(
      built(b => b.cylinder(0.08, 0.14, 0.9, '#fff', -1, 0, 3, 12, t)),
      reference(new THREE.CylinderGeometry(0.08, 0.14, 0.9, 12).translate(0, 0.45, 0), t, -1, 0, 3),
    );
    same(
      built(b => b.cone(0.3, 1.1, '#fff', 0, 0.2, 0, 6, t)),
      reference(new THREE.ConeGeometry(0.3, 1.1, 6).translate(0, 0.55, 0), t, 0, 0.2, 0),
    );
    same(
      built(b => b.sphere(0.25, '#fff', 1, 0, 1, 0.6, [10, 8], t)),
      reference(new THREE.SphereGeometry(0.25, 10, 8).scale(1, 0.6, 1).translate(0, 0.15, 0), t, 1, 0, 1),
    );
    same(
      built(b => b.blob(0.4, 0.2, 0.3, '#fff', 0, 0, 0, t, [9, 7])),
      reference(new THREE.SphereGeometry(1, 9, 7).scale(0.4, 0.2, 0.3).translate(0, 0.2, 0), t, 0, 0, 0),
    );
  }
});

test('capsules, tori, flats and discs match three.js geometry', () => {
  for (const t of turns) {
    same(
      built(b => b.capsule(0.11, 0.5, '#fff', 0, 0.3, 0, t)),
      reference(new THREE.CapsuleGeometry(0.11, 0.5, 3, 10).translate(0, 0.25 + 0.11, 0), t, 0, 0.3, 0),
    );
    same(
      built(b => b.torus(0.3, 0.04, '#fff', 1, 1, 1, t)),
      reference(new THREE.TorusGeometry(0.3, 0.04, 6, 18), t, 1, 1, 1),
    );
  }
  same(
    built(b => b.flat(2, 3, '#fff', 1, 0.01, 2, 0.5)),
    reference(new THREE.PlaneGeometry(2, 3).rotateX(-Math.PI / 2), { ry: 0.5 }, 1, 0.01, 2),
  );
  same(
    built(b => b.disc(0.4, '#fff', 0, 0.02, 0, 12)),
    reference(new THREE.CircleGeometry(0.4, 12).rotateX(-Math.PI / 2), {}, 0, 0.02, 0),
  );
});

test('rounded boxes match three.js RoundedBoxGeometry, welded', () => {
  for (const t of turns)
    for (const [w, h, d, r] of [
      [1.6, 0.04, 0.8, 0.015],
      [0.5, 0.08, 0.48, 0.035],
      [0.3, 0.3, 0.3, 0.5],
    ]) {
      const rounded = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2));
      const expected = reference(mergeVertices(rounded).translate(0, h / 2, 0), t, 0.4, 0.7, -0.2);
      same(
        built(b => b.rbox(w, h, d, r, '#fff', 0.4, 0.7, -0.2, t)),
        expected,
        false,
      );
    }
});

test('a batch is one indexed mesh with a colour per vertex and texture coordinates only when asked', () => {
  const plain = built(b => {
    b.box(1, 1, 1, '#ff0000', 0, 0, 0);
    b.sphere(0.5, '#00ff00', 2, 0, 0);
  });
  assert.ok(plain.index);
  assert.equal(plain.getAttribute('uv'), undefined);
  const colors = plain.getAttribute('color');
  assert.equal(colors.count, plain.getAttribute('position').count);
  assert.equal(colors.getX(0), 1);
  const lit = new Batch({ uv: true });
  lit.flat(1, 1, '#ffffff', 0, 0, 0);
  const g = lit.build(new Kit(), new THREE.MeshBasicMaterial()).geometry;
  assert.deepEqual(
    Array.from(g.getAttribute('uv').array),
    Array.from(new THREE.PlaneGeometry(1, 1).getAttribute('uv').array),
  );
});

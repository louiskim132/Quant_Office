import test from 'node:test';
import assert from 'node:assert/strict';
import { BrainSim, brainLabels, brainRadius, fitBounds, DEFAULT_FORCES } from '../src/renderer/brain-sim';

type Data = { nodes: { id: string; degree: number }[]; links: { from: string; to: string }[] };

const ring = (n: number): Data => {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(4, '0')}`, degree: 2 }));
  const links = nodes.map((node, i) => ({ from: node.id, to: nodes[(i + 1) % n].id }));
  return { nodes, links };
};
/** A hub with spokes plus a few loose findings. */
const hubGraph = (spokes: number, loose: number): Data => {
  const nodes = [{ id: 'hub', degree: spokes }];
  const links: { from: string; to: string }[] = [];
  for (let i = 0; i < spokes; i++) {
    nodes.push({ id: `s${String(i).padStart(3, '0')}`, degree: 1 });
    links.push({ from: 'hub', to: `s${String(i).padStart(3, '0')}` });
  }
  for (let i = 0; i < loose; i++) nodes.push({ id: `l${i}`, degree: 0 });
  return { nodes, links };
};
const settled = (data: Data, pins = {}) => {
  const sim = new BrainSim();
  sim.setData(data.nodes, data.links, pins);
  sim.settle(400, 5000);
  return sim;
};

test('the same findings settle into the same picture, in any input order', () => {
  const data = hubGraph(30, 6);
  const a = settled(data);
  const b = settled({ nodes: [...data.nodes].reverse(), links: [...data.links].reverse() });
  const pos = (s: BrainSim) => Object.fromEntries(s.nodes.map(n => [n.id, [n.x, n.y]]));
  assert.deepEqual(pos(a), pos(b));
});

test('settled bodies do not overlap and every position is finite', () => {
  const sim = settled(hubGraph(60, 12));
  for (let i = 0; i < sim.nodes.length; i++) {
    assert.ok(Number.isFinite(sim.nodes[i].x) && Number.isFinite(sim.nodes[i].y));
    for (let j = i + 1; j < sim.nodes.length; j++) {
      const a = sim.nodes[i],
        b = sim.nodes[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > (a.r + b.r) * 0.82, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('hubs sit nearer the middle than their spokes, and the cloud is round', () => {
  const sim = settled(hubGraph(48, 0));
  const hub = sim.nodes[sim.indexOf('hub')];
  const spokes = sim.nodes.filter(n => n.id !== 'hub');
  const avg = spokes.reduce((s, n) => s + Math.hypot(n.x, n.y), 0) / spokes.length;
  assert.ok(Math.hypot(hub.x, hub.y) < avg, 'hub is inside the ring of spokes');
  const b = sim.bounds();
  const aspect = (b.x1 - b.x0) / (b.y1 - b.y0);
  assert.ok(aspect > 0.6 && aspect < 1.6, `aspect ${aspect}`);
});

test('pins stay exactly where they are put, and a refresh keeps known positions', () => {
  const data = ring(24);
  const sim = new BrainSim();
  sim.setData(data.nodes, data.links, { n0003: { x: 120, y: -80 } });
  sim.settle(300, 5000);
  const pinned = sim.nodes[sim.indexOf('n0003')];
  assert.deepEqual([pinned.x, pinned.y], [120, -80]);
  const before = Object.fromEntries(sim.nodes.map(n => [n.id, [n.x, n.y]]));
  sim.setData([...data.nodes, { id: 'new', degree: 1 }], [...data.links, { from: 'new', to: 'n0001' }], {
    n0003: { x: 120, y: -80 },
  });
  for (const n of sim.nodes) if (n.id !== 'new') assert.deepEqual([n.x, n.y], before[n.id], 'nothing jumps on refresh');
  const fresh = sim.nodes[sim.indexOf('new')];
  const anchor = sim.nodes[sim.indexOf('n0001')];
  assert.ok(Math.hypot(fresh.x - anchor.x, fresh.y - anchor.y) < 40, 'a new finding appears beside its neighbour');
});

test('unknown endpoints, self links and duplicate links are ignored without error', () => {
  const sim = new BrainSim();
  sim.setData(
    [
      { id: 'a', degree: 0 },
      { id: 'b', degree: 0 },
    ],
    [
      { from: 'a', to: 'ghost' },
      { from: 'a', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  );
  assert.equal(sim.links.length, 1);
  sim.settle(50, 1000);
  assert.ok(sim.nodes.every(n => Number.isFinite(n.x)));
});

test('an empty graph is a no-op and a single node settles at the centre', () => {
  const sim = new BrainSim();
  sim.setData([], []);
  sim.tick();
  assert.equal(sim.nodes.length, 0);
  sim.setData([{ id: 'only', degree: 0 }], []);
  sim.settle(300, 1000);
  assert.ok(Math.hypot(sim.nodes[0].x, sim.nodes[0].y) < 5);
});

test('two thousand findings stay finite and tick in bounded time', () => {
  const nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `f${String(i).padStart(5, '0')}`, degree: 0 }));
  const links: { from: string; to: string }[] = [];
  for (let i = 1; i < nodes.length; i++) {
    links.push({ from: nodes[i].id, to: nodes[Math.floor(Math.sqrt(i * 7)) % i].id });
    nodes[i].degree++;
  }
  const start = performance.now();
  const sim = new BrainSim();
  sim.setData(nodes, links);
  for (let i = 0; i < 120; i++) sim.tick();
  assert.ok(performance.now() - start < 20000);
  assert.ok(sim.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('radius grows with links but is bounded, and scales with the node-size setting', () => {
  assert.ok(brainRadius(0) < brainRadius(4));
  assert.ok(brainRadius(10_000) <= 3.4 + 14);
  assert.ok(Math.abs(brainRadius(4, 2) - 2 * brainRadius(4)) < 1e-9);
  assert.ok(DEFAULT_FORCES.center > 0);
});

test('fitBounds frames the box inside the viewport', () => {
  const box = { x0: -300, y0: -100, x1: 500, y1: 400 };
  const cam = fitBounds(box, 800, 600, 40);
  const left = box.x0 * cam.k + cam.x,
    right = box.x1 * cam.k + cam.x,
    top = box.y0 * cam.k + cam.y,
    bottom = box.y1 * cam.k + cam.y;
  assert.ok(left >= 39 && right <= 761 && top >= 39 && bottom <= 561);
});

test('names thin out: hubs win, collisions drop, priority names always show, zooming out fades them', () => {
  const view = { width: 800, height: 600 };
  const items = [
    { id: 'hub', x: 400, y: 300, r: 10, degree: 9, width: 60 },
    { id: 'near', x: 405, y: 302, r: 5, degree: 1, width: 60 },
    { id: 'far', x: 100, y: 100, r: 5, degree: 1, width: 60 },
  ];
  const zoomed = brainLabels(items, 1.5, 0.3, new Set(), view);
  assert.deepEqual([...zoomed.shown].sort(), ['far', 'hub']);
  assert.ok(zoomed.alpha > 0);
  const out = brainLabels(items, 0.1, 0.3, new Set(['near']), view);
  assert.deepEqual([...out.shown], ['near']);
  assert.equal(out.alpha, 0);
  const offscreen = brainLabels([{ id: 'gone', x: 5000, y: 5000, r: 5, degree: 1, width: 60 }], 2, 0, new Set(), view);
  assert.equal(offscreen.shown.size, 0);
});

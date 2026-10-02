import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import '../../src/renderer/tokens.css';
import '../../src/renderer/styles.css';
import { OfficeLive } from '../../src/renderer/office-stage';
import { OfficeEngine } from '../../src/renderer/office3d/engine';
import { buildEnvironment } from '../../src/renderer/office3d/environment';
import { buildLayout } from '../../src/renderer/office3d/layout';
import { Kit } from '../../src/renderer/office3d/kit';
import type { AppState, Agent } from '../../src/shared/types';
import type { OfficeActivity } from '../../src/shared/activity';

const fixture = window as unknown as Record<string, any>;
const original = OfficeEngine.prototype.setAgents;
OfficeEngine.prototype.setAgents = function (visuals) {
  fixture.__engine = this;
  original.call(this, visuals);
};
fixture.office = {
  onChanged: () => () => {},
  onPresence: () => () => {},
  livePresence: async () => [],
  officeChatPage: async () => ({ entries: [], nextCursor: null }),
};
const names = ['Test dir 1', 'Test PM A', 'Test PM B', 'Test PM C', 'Test PM D', 'Test worker 1', 'Test worker 2'];
const stamp = new Date().toISOString();
function App() {
  const [options, setOptions] = useState({
    phase: 'idle',
    remaining: null as number | null,
    count: 7,
    offset: 0,
    reduced: true,
    theme: 'light',
  });
  fixture.__fixture = (changes: Partial<typeof options>) => setOptions(old => ({ ...old, ...changes }));
  document.documentElement.dataset.theme = options.theme;
  document.documentElement.dataset.motion = options.reduced ? 'reduced' : 'full';
  const agents = Array.from({ length: options.count }, (_, i) => ({
    id: `a${i + options.offset}`,
    name: names[i + options.offset] ?? `Test worker ${i + options.offset - 4}`,
    role: i === 0 ? 'DIRECTOR' : i < 5 ? `PM_${'ABCD'[i - 1]}` : 'WORKER',
    team: 'Fixture',
    provider: 'devin',
    model: 'swe-2',
    effort: 'max',
    account: 'fixture@example.test',
    execution: 'LOCAL',
    localRoute: 'LOCAL_CLI_EXEC',
    instructions: '',
    revision: 1,
    createdAt: stamp,
  })) as Agent[];
  const state = {
    agents,
    settings: { theme: options.theme, reducedMotion: options.reduced },
    requests: [{ id: 'r1', name: 'Synthetic project', projectId: 'p1', status: 'READY', participantIds: ['a0', 'a1'] }],
    teams: [{ id: 't1', name: 'Fixture project team', projectId: 'p1', archived: false }],
    memberships: agents.slice(0, -1).map(a => ({ teamId: 't1', agentId: a.id })),
    connections:
      options.remaining === null
        ? []
        : [
            {
              id: 'c1',
              provider: 'devin',
              identity: 'fixture@example.test',
              state: 'SIGNED_IN',
              lastCheckedAt: stamp,
              allowance: [
                {
                  label: 'Window',
                  remainingPercent: options.remaining,
                  resetsAt: Math.floor(Date.now() / 1000) + 3600,
                },
              ],
            },
          ],
  } as unknown as AppState;
  const activity = agents.map((a, i) => ({
    agentId: a.id,
    kind: i === 0 && options.phase !== 'idle' ? (options.phase === 'meeting' ? 'MEETING' : 'WORKING') : 'IDLE',
    meetingId: options.phase === 'meeting' && i === 0 ? 'r1' : undefined,
    since: stamp,
    requestId: i === 0 && options.phase !== 'idle' ? 'r1' : '',
    jobId: '',
    detail: '',
    evidence: 'OFFICE_OBSERVED',
  })) as OfficeActivity[];
  return (
    <div style={{ padding: 16 }}>
      <OfficeLive state={state} activity={activity} now={Date.now()} selectedId={null} onAgent={() => {}} />
    </div>
  );
}

// Inspect the real batched geometry, independently of camera angle and lighting.
fixture.__roofCheck = (theme: 'light' | 'dark') => {
  const kit = new Kit();
  const layout = buildLayout({ director: 1, pm: 4, worker: 2, tables: 2, tableSeats: 6 });
  const objects = buildEnvironment(layout, kit, theme);
  const mesh = objects[0] as THREE.Mesh;
  mesh.updateMatrixWorld(true);
  const W = layout.bounds.maxX,
    D = layout.bounds.maxZ;
  const buildings = [
    [-34, -10, -49.5, -33.5, 18.2],
    [-2, W - 2, -47.5, -33.5, 18.2],
    [W + 6, W + 32, -43.5, -27.5, 14.5],
    [-46, -28, -10, D + 16, 14.5],
    [W + 29.5, W + 43.5, -12, D + 4, 10.8],
    [W + 21.5, W + 37.5, D + 10, D + 24, 4.3],
  ];
  const ray = new THREE.Raycaster();
  let samples = 0;
  const failures: string[] = [];
  for (const [x0, x1, z0, z1, top] of buildings) {
    for (const u of [0.15, 0.35, 0.65, 0.85])
      for (const v of [0.15, 0.35, 0.65, 0.85]) {
        ray.set(new THREE.Vector3(x0 + (x1 - x0) * u, 50, z0 + (z1 - z0) * v), new THREE.Vector3(0, -1, 0));
        const hits = ray.intersectObject(mesh).filter(h => Math.abs(h.point.y - top) < 0.003);
        if (!hits.length) failures.push('missing roof');
        for (const hit of hits) {
          const colors = mesh.geometry.getAttribute('color');
          const face = hit.face!;
          for (const index of [face.a, face.b, face.c])
            if (Math.min(colors.getX(index), colors.getY(index), colors.getZ(index)) < 0.999)
              failures.push('non-white roof face');
        }
        samples++;
      }
  }
  kit.dispose();
  return { samples, failures };
};
fixture.__roofView = () => {
  const engine = fixture.__engine;
  const offset = engine.camera.position.clone().sub(engine.controls.target);
  const { maxX: W, maxZ: D } = engine.layout.bounds;
  engine.controls.target.set(W + 36.5, 10.8, (D - 8) / 2);
  engine.camera.position.copy(engine.controls.target).add(offset);
  engine.camera.zoom = 20;
  engine.camera.updateProjectionMatrix();
  engine.controls.update();
  engine.draw();
};
createRoot(document.getElementById('root')!).render(<App />);

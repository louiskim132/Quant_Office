import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/tokens.css';
import '../../src/renderer/styles.css';
import { SettingsPage, type SettingsSection } from '../../src/renderer/settings';
import { PipelineReviews } from '../../src/renderer/review';
import { SubscriptionUsage } from '../../src/renderer/agents';
import { modelLabel } from '../../src/renderer/model-label';
import type { AppState } from '../../src/shared/types';

const fixture = window as any;
const stamp = new Date().toISOString();
const agents = ['Test worker 1', 'Test PM A', 'Test PM B', 'Test dir 1'].map((name, i) => ({
  id: `a${i}`,
  name,
  provider: 'devin',
  model: 'swe-2-max',
  effort: 'default',
}));
const assignments = [0, 1, 2, 1, 3].map((agent, i) => ({
  id: `h${i}`,
  projectId: 'p1',
  requestId: 'r1',
  agentId: `a${agent}`,
  pipelineKey: ['produce', 'critique-a', 'critique-b', 'response-a', 'director-decision'][i],
  dependsOn: i ? [`h${i - 1}`] : [],
}));
const state = {
  settings: { theme: 'light', reducedMotion: true },
  agents,
  connections: [],
  capabilities: [],
  requests: [{ id: 'r1', projectId: 'p1', name: 'Analyze ema3 results', pipeline: true, createdAt: stamp }],
  assignments: [...assignments].reverse(),
  jobs: assignments.map((a, i) => ({
    id: `j${i}`,
    assignmentId: a.id,
    projectId: 'p1',
    requestId: 'r1',
    state: 'COMPLETED',
    attempt: 1,
    createdAt: stamp,
    updatedAt: stamp,
    detail: `Recorded step ${i + 1}`,
    outputs: [{ path: 'report.md', stored: true, sha256: 'a'.repeat(64), bytes: 100 }],
  })),
} as unknown as AppState;
fixture.__checks = [];
fixture.__previews = [];
fixture.office = {
  agentIsolationStatus: async () => ({ configured: true }),
  agentIsolationVerify: async () => ({
    passed: true,
    checks: { rootAclDenies: true },
    evidencePath: 'fixture/evidence.json',
  }),
  agentIsolationLogin: async () => ({}),
  providerKeyState: async () => ({ saved: false }),
  connectionStatus: async (provider: string) => {
    fixture.__checks.push(provider);
    if (provider === 'openai') throw new Error('Synthetic unavailable provider');
    return { provider, connected: true, account: 'fixture@example.test', models: [], windows: [], checkedAt: stamp };
  },
  jobOutputPreview: async ({ jobId }: { jobId: string }) => {
    fixture.__previews.push(jobId);
    return {
      text: `# Review ${jobId}\nFull review content for ${jobId}.\n${'Evidence and findings. '.repeat(35)}`,
      truncated: false,
    };
  },
  localSessions: async ({ offset, limit }: { offset: number; limit: number }) => ({
    total: 30,
    entries: Array.from({ length: Math.min(limit, 30 - offset) }, (_, i) => ({
      id: `s${offset + i}`,
      provider: ['devin', 'openai', 'claude'][(offset + i) % 3],
      createdAt: stamp,
      lifecycle: 'READY',
      surface: 'CLI',
      layout: 'FLAT_PACKET',
      packetHash: null,
      providerSessionId: null,
    })),
  }),
};
document.documentElement.dataset.theme = 'light';
function App() {
  const [view, setView] = useState('settings');
  const [section, setSection] = useState<SettingsSection>('connections');
  fixture.__view = setView;
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 24 }}>
      {view === 'settings' ? (
        <SettingsPage
          state={state}
          info={null}
          busy={false}
          command={async () => state}
          files={async () => {}}
          onState={() => {}}
          onNotice={() => {}}
          notifications={{
            taskbar: false,
            popups: false,
            sound: false,
            setTaskbar: () => {},
            setPopups: () => {},
            setSound: () => {},
          }}
          section={section}
          onSection={setSection}
        />
      ) : view === 'reviews' ? (
        <PipelineReviews
          state={state}
          projectId="p1"
          busy={false}
          setPreview={() => {
            throw new Error('Unexpected modal');
          }}
          onError={() => {}}
        />
      ) : view === 'usage' ? (
        <SubscriptionUsage state={state} />
      ) : (
        <p>{modelLabel(agents[0] as any)}</p>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);

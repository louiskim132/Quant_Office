import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { AppState, Project, Request } from '../src/shared/types';
import type { AttentionItem } from '../src/shared/attention';
import type { OfficeActivity } from '../src/shared/activity';

// main.tsx and shell-widgets.tsx import their stylesheets for the bundler; Node can't load .css, so
// the import stubs them — the same trick request-form.test.ts uses for the shared module.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { paletteSections, projectLiveCounts } = await import('../src/renderer/main');
const { attentionGroups } = await import('../src/renderer/shell-widgets');

const project = (id: string, updatedAt: string, over: Partial<Project> = {}): Project => ({
  id,
  name: `Project ${id}`,
  mandate: 'mandate',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt,
  archived: false,
  budgetCents: 0,
  ...over,
});
const request = (id: string, projectId: string, updatedAt: string): Request => ({
  id,
  projectId,
  experimentId: null,
  name: `Request ${id}`,
  objective: 'objective',
  workType: 'PLANNING',
  mode: 'SINGLE',
  leadAgentId: null,
  participantIds: [],
  acceptanceCriteria: '',
  revision: 1,
  status: 'READY',
  blockers: [],
  delegation: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt,
});
const state = (projects: Project[], requests: Request[]): Pick<AppState, 'projects' | 'requests'> => ({
  projects,
  requests,
});

test('palette pages follow the sidebar grouping and order', () => {
  const sections = paletteSections(state([project('p1', '2026-01-02T00:00:00Z')], []), '');
  const pageGroups = sections.map(s => s.label).filter(l => ['WORKSPACE', 'RESEARCH', 'RECORDS', 'SYSTEM'].includes(l));
  assert.deepEqual(pageGroups, ['WORKSPACE', 'RESEARCH', 'RECORDS', 'SYSTEM']);
  assert.deepEqual(
    sections.find(s => s.label === 'WORKSPACE')?.items.map(i => i.label),
    ['Office', 'Agents', 'Projects'],
  );
  assert.deepEqual(
    sections.find(s => s.label === 'RESEARCH')?.items.map(i => i.label),
    ['Reviews', 'Artifacts', 'Memory'],
  );
});

test('the query filters every section by label', () => {
  const sections = paletteSections(state([project('p1', '2026-01-02T00:00:00Z')], []), 'memory');
  const items = sections.flatMap(s => s.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Memory');
  assert.equal(items[0].page, 'Memory');
});

test('New request is listed but inert until a project exists, with the reason on the row', () => {
  const none = paletteSections(state([], []), '')
    .find(s => s.label === 'Commands')
    ?.items.find(i => i.command === 'new-request');
  assert.equal(none?.disabledReason, 'Create a project first');
  const ready = paletteSections(state([project('p1', '2026-01-02T00:00:00Z')], []), '')
    .find(s => s.label === 'Commands')
    ?.items.find(i => i.command === 'new-request');
  assert.equal(ready?.disabledReason, undefined);
  // The other two commands always work.
  const commands =
    ready && paletteSections(state([project('p1', 'x')], []), '').find(s => s.label === 'Commands')?.items;
  assert.ok(commands?.some(i => i.command === 'add-agent'));
  assert.ok(commands?.some(i => i.command === 'needs-you'));
});

test('unfiltered project and request sections are recent-first and capped', () => {
  const projects = Array.from({ length: 7 }, (_, i) =>
    project(`p${i}`, `2026-01-0${i + 1}T00:00:00Z`, { name: `P${i}` }),
  );
  const requests = Array.from({ length: 6 }, (_, i) => request(`r${i}`, 'p0', `2026-02-0${i + 1}T00:00:00Z`));
  const sections = paletteSections(state(projects, requests), '');
  const projectItems = sections.find(s => s.label === 'Recent projects')?.items ?? [];
  const requestItems = sections.find(s => s.label === 'Recent requests')?.items ?? [];
  assert.equal(projectItems.length, 5);
  assert.equal(requestItems.length, 5);
  assert.equal(projectItems[0].label, 'P6');
  assert.equal(requestItems[0].requestId, 'r5');
  // Filtering keeps everything that matches (cap 10), still recent-first.
  const filtered = paletteSections(state(projects, requests), 'p').find(s => s.label === 'Projects');
  assert.equal(filtered?.items.length, 7);
});

test('attention groups split requests needing action from agents gone quiet', () => {
  const items: AttentionItem[] = [
    { id: 'request:r1', kind: 'request', status: 'needs', title: 'Plan review', detail: 'Step failed', targetId: 'r1' },
    { id: 'agent:a1', kind: 'agent', status: 'stalled', title: 'A quiet', detail: 'quiet 10 min', targetId: 'a1' },
    { id: 'request:r2', kind: 'request', status: 'needs', title: 'Ship decision', detail: 'Decision', targetId: 'r2' },
  ];
  const groups = attentionGroups(items);
  assert.deepEqual(
    groups.map(g => g.label),
    ['Requests needing action', 'Agents gone quiet'],
  );
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[1].items.length, 1);
  assert.deepEqual(attentionGroups([]), []);
  assert.equal(attentionGroups([items[1]]).length, 1);
});

test('project live counts derive only from recorded activity and attention', () => {
  const requests = [
    { id: 'r1', projectId: 'p1' },
    { id: 'r2', projectId: 'p2' },
  ];
  const activity: OfficeActivity[] = [
    { agentId: 'a1', kind: 'WORKING', since: 'x', requestId: 'r1', jobId: 'j1', detail: '' },
    { agentId: 'a2', kind: 'WORKING', since: 'x', requestId: 'r1', jobId: 'j2', detail: '', stalled: true },
    { agentId: 'a3', kind: 'IDLE', since: 'x', requestId: 'r2', jobId: '', detail: '' },
  ];
  const attention: AttentionItem[] = [
    { id: 'request:r1', kind: 'request', status: 'needs', title: 't', detail: 'd', targetId: 'r1' },
    // An agent-quiet item has no project to charge — it must not leak into project counts.
    { id: 'agent:a3', kind: 'agent', status: 'stalled', title: 't', detail: 'd', targetId: 'a3' },
  ];
  const counts = projectLiveCounts(requests, activity, attention);
  assert.deepEqual(counts.get('p1'), { working: 2, needsYou: 1 });
  assert.equal(counts.get('p2'), undefined);
});

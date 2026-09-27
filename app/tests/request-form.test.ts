import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// main.tsx imports its stylesheets for the bundler; Node can't load .css, so the unit-level
// import stubs them. The DOM bootstrap is guarded, so importing exercises the real helper, not
// a copy — with no app window opened.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { requestCreatePayload } = await import('../src/renderer/main');

/** FormData shaped like the New-request dialog submits it — a select submits its option's value. */
const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
  return data;
};
const base = {
  requestProjectId: 'proj-1',
  name: 'Analyze sma5 result',
  hypothesis: 'The rolling mean tracks price.',
  workType: 'RESULT_ANALYSIS',
  leadAgentId: '',
  acceptanceCriteria: '',
};

test('an untouched plan select emits no analysisOfRequestId', () => {
  // The explicit 'None — the director plans the analysis' option submits '' — it must not bind.
  const payload = requestCreatePayload(form({ ...base, analysisOfRequestId: '' }), 'SINGLE');
  assert.ok(payload.type === 'request.create');
  assert.equal('analysisOfRequestId' in payload, false, 'an empty selection must omit the field entirely');
});

test('a form without the field emits no analysisOfRequestId either — no silent bind path', () => {
  const payload = requestCreatePayload(form(base), 'SINGLE');
  assert.ok(payload.type === 'request.create');
  assert.equal('analysisOfRequestId' in payload, false);
  assert.equal('idempotencyKey' in payload, false, 'the command wrapper mints the key, not the helper');
});

test('an explicitly chosen plan id lands on the command verbatim', () => {
  const payload = requestCreatePayload(form({ ...base, analysisOfRequestId: 'req-96f3deed' }), 'SINGLE');
  assert.ok(payload.type === 'request.create');
  assert.equal(payload.analysisOfRequestId, 'req-96f3deed');
});

test('a stale plan value on a non-analysis request is refused by the workType gate', () => {
  // The field only renders for RESULT_ANALYSIS, but a stale or crafted form still can't bind it.
  const payload = requestCreatePayload(
    form({ ...base, workType: 'PLANNING', analysisOfRequestId: 'req-96f3deed' }),
    'SINGLE',
  );
  assert.ok(payload.type === 'request.create');
  assert.equal(payload.analysisOfRequestId, undefined);
});

test('mode follows the work type — OTHER keeps the grouping, the rest are SINGLE', () => {
  const grouped = requestCreatePayload(form({ ...base, workType: 'OTHER' }), 'TEAM');
  assert.ok(grouped.type === 'request.create');
  assert.equal(grouped.mode, 'TEAM');
  for (const workType of ['PLANNING', 'RESULT_ANALYSIS'] as const) {
    const payload = requestCreatePayload(form({ ...base, workType }), 'GROUP');
    assert.ok(payload.type === 'request.create');
    assert.equal(payload.mode, 'SINGLE', `${workType} never carries a grouping mode`);
  }
});

test('the remaining fields are the form values, trimmed where the handler trimmed', () => {
  const payload = requestCreatePayload(
    form({
      ...base,
      workType: 'OTHER',
      name: '  Padded name  ',
      leadAgentId: 'agent-1',
      participantIds: ['agent-1', 'agent-2'],
      acceptanceCriteria: 'sharpe > 0',
    }),
    'GROUP',
  );
  assert.ok(payload.type === 'request.create');
  assert.equal(payload.projectId, 'proj-1');
  assert.equal(payload.name, 'Padded name');
  assert.equal(payload.hypothesis, 'The rolling mean tracks price.');
  assert.equal(payload.workType, 'OTHER');
  assert.equal(payload.leadAgentId, 'agent-1');
  assert.deepEqual(payload.participantIds, ['agent-1', 'agent-2']);
  assert.equal(payload.acceptanceCriteria, 'sharpe > 0');
});

test('an empty leadAgentId lands as null — the Choose-later option', () => {
  const payload = requestCreatePayload(form(base), 'SINGLE');
  assert.ok(payload.type === 'request.create');
  assert.equal(payload.leadAgentId, null);
});

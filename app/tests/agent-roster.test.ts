import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { ActivityEvidence, ActivityKind } from '../src/shared/activity';

// office.tsx imports its stylesheet for the bundler; Node can't load .css, so the unit-level
// import stubs it. This tests the roster's real helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { rosterFreshness, rosterProvenance, agentCountLabel } = await import('../src/renderer/office');

const now = Date.parse('2026-09-30T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(now - m * 60000).toISOString();
const activity = (kind?: ActivityKind, evidence?: ActivityEvidence) =>
  kind ? ({ kind, evidence } as const) : undefined;

test('the header counts agents plainly until a filter is active', () => {
  assert.equal(agentCountLabel(8, false), '8 agents · no seat limit');
  assert.equal(agentCountLabel(1, false), '1 agent · no seat limit');
  assert.equal(agentCountLabel(0, false), '0 agents · no seat limit');
  assert.equal(agentCountLabel(3, true), '3 matching agents · no seat limit');
  assert.equal(agentCountLabel(1, true), '1 matching agent · no seat limit');
});

test('freshness stamps prefer the newest verification record', () => {
  assert.equal(
    rosterFreshness({ connectionVerifiedAt: minutesAgo(90), bindingVerifiedAt: minutesAgo(5) }, undefined, now),
    'Last verified 5 min ago',
  );
  assert.equal(
    rosterFreshness({ connectionVerifiedAt: minutesAgo(120) }, undefined, now),
    'Last verified 2 h ago',
    'the add-time account check on the agent record is itself a verification',
  );
});

test('a newer recorded observation outranks an older verification; nothing recorded says so', () => {
  assert.equal(
    rosterFreshness({ connectionVerifiedAt: minutesAgo(120) }, minutesAgo(3), now),
    'Checked 3 min ago',
    'a later account check is fresher evidence than the stale verification',
  );
  assert.equal(rosterFreshness({}, minutesAgo(45), now), 'Checked 45 min ago');
  assert.equal(rosterFreshness({}, undefined, now), 'Never checked');
  assert.equal(
    rosterFreshness({ connectionVerifiedAt: 'not-a-date', bindingVerifiedAt: '' }, 'also-not-a-date', now),
    'Never checked',
    'unparsable timestamps are skipped, never rendered',
  );
});

test('provenance chips pass the recorded evidence field through and never inflate it', () => {
  assert.equal(rosterProvenance(activity('WORKING', 'PROVIDER_REPORTED')), 'provider-reported');
  assert.equal(rosterProvenance(activity('WORKING', 'OFFICE_OBSERVED')), 'office-observed');
  assert.equal(
    rosterProvenance(activity('UNKNOWN', 'NONE')),
    'unverified',
    'an explicit no-evidence state is the unverified case',
  );
  assert.equal(
    rosterProvenance(activity('IDLE')),
    'office-observed',
    'a seat claim resting only on the office ledger is office-observed',
  );
  assert.equal(
    rosterProvenance(undefined),
    'office-observed',
    'archived/removed rows have no activity entry; the status shown is an office record',
  );
});

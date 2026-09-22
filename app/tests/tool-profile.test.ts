import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { toolProfileSchema } from '../src/shared/tool-profile';
import { localPacketV2Schema, localSessionRecordSchema } from '../src/shared/local-session';

const profile = {
  allowedTools: ['Read', 'Bash'],
  mcpServers: [{ id: 'serena', command: 'serena start-mcp-server', args: ['--project', '.'], readOnly: true }],
  filesystem: 'PACKET_ONLY' as const,
  canWrite: false,
};

function binding(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: randomUUID(), jobId: randomUUID(), assignmentId: randomUUID(), projectId: randomUUID(), attemptId: randomUUID(),
    revision: 0, provider: 'claude' as const, surface: 'CLAUDE_CLI' as const, layout: 'FLAT_PACKET' as const,
    packetVersion: 2 as const, packetHash: null, storageRelativePath: 'session-1', originalCwd: null,
    repoRelativePath: null, seedCommit: null, worktreeOwner: 'NONE' as const, providerSessionId: null,
    providerProjectId: null, bindingEvidence: 'UNBOUND' as const, groupingStatus: 'UNKNOWN' as const,
    requirement: 'SCOPED_DELIVERY' as const, confinementStatus: 'UNVERIFIED' as const,
    confinementEvidenceId: null, lifecycle: 'PREPARING' as const, archiveRelativePath: null,
    lastReceipt: null, cancelRequestId: null, stopStatus: 'NOT_REQUESTED' as const,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function packet(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'office-local-session@2' as const,
    jobId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID(), projectId: randomUUID(),
    createdAt: new Date().toISOString(), requestName: 'Q', objective: 'do the thing',
    requested: { model: 'claude-sonnet-5', effort: 'default' as const, delegation: false },
    payload: 'bounded work', snapshotManifestHash: 'a'.repeat(64),
    files: [], instructions: [], contract: 'CONTRACT.md' as const,
    ...overrides,
  };
}

test('toolProfileSchema accepts a full declared profile', () => {
  const parsed = toolProfileSchema.parse(profile);
  assert.equal(parsed.filesystem, 'PACKET_ONLY');
  assert.equal(parsed.mcpServers?.[0]?.id, 'serena');
  assert.equal(parsed.canWrite, false);
});

test('toolProfileSchema refuses unknown keys and malformed servers', () => {
  assert.throws(() => toolProfileSchema.parse({ ...profile, sandbox: 'strict' }), /unrecognized|Unrecognized/i);
  assert.throws(() => toolProfileSchema.parse({ mcpServers: [{ id: 'x', command: '' }] }));
});

test('a binding carries toolProfile, and bindings frozen before it still parse', () => {
  const withProfile = localSessionRecordSchema.parse(binding({ toolProfile: profile }));
  assert.deepEqual(withProfile.toolProfile?.allowedTools, ['Read', 'Bash']);
  const legacy = localSessionRecordSchema.parse(binding());
  assert.equal(legacy.toolProfile, undefined);
});

test('a v2 packet carries toolProfile, and packets without it still parse', () => {
  const withProfile = localPacketV2Schema.parse(packet({ toolProfile: profile }));
  assert.equal(withProfile.toolProfile?.mcpServers?.[0]?.readOnly, true);
  const legacy = localPacketV2Schema.parse(packet());
  assert.equal(legacy.toolProfile, undefined);
});

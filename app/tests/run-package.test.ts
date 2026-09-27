import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createRunPackageCodec } from '../src/main/run-package';
import {
  runPackageHash,
  runPackageId,
  runPackageManifestSchema,
  type RunPackageManifest,
} from '../src/shared/run-package';
import { SECTIONS, at, sha256 } from './fixtures/pipeline';
import type { AppState, InputSnapshot } from '../src/shared/types';
import type { BranchLink } from '../src/shared/pipeline';
import type { FrozenResearchSpec, ResearchBranch } from '../src/shared/research';

/**
 * The production zip codec behind the manual-run seams (section 1.6): the builder assembles the
 * frozen package archive and the inspector validates the bound return against it. The store and
 * pipeline admission contract around these seams is exercised in manual-run-contract.test.ts with a
 * JSON-envelope double; this suite tests the real archive bytes.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDirectory = path.join(here, '..', 'research-templates');
const T = at(0);
const EXPECTED_FILES = [
  'outputs/dataset-manifest.json',
  'outputs/diagnostics.json',
  'outputs/portfolio-periods.json',
  'outputs/economics.json',
];
const RETURN_GATES = [
  { gate: 'G-PORTFOLIO', stage: 'S5', outcome: 'PASS', detail: 'Portfolio books produced.', rationale: 'user run' },
  { gate: 'G-COST', stage: 'S6', outcome: 'PASS', detail: 'Costs priced.', rationale: 'user run' },
  { gate: 'G-ECON', stage: 'S6', outcome: 'PASS', detail: 'Economics computed.', rationale: 'user run' },
] as const;

const projectId = randomUUID(),
  branchId = randomUUID(),
  specId = randomUUID(),
  requestId = randomUUID();
const subjectHash = sha256('candidate-bytes');
const branch: ResearchBranch = {
  id: branchId,
  projectId,
  name: 'Lineage A',
  parentBranchId: null,
  lineageId: randomUUID(),
  stage: 'S3',
  outcome: 'IN_PROGRESS',
  specId,
  predictionId: randomUUID(),
  revision: 2,
  createdAt: T,
  updatedAt: T,
};
const link: BranchLink = {
  id: randomUUID(),
  projectId,
  branchId,
  createdAt: T,
  kind: 'LINK',
  requestId,
  subjectHash,
  requestRevision: 1,
  branchRevision: 2,
};
const spec: FrozenResearchSpec = {
  id: specId,
  branchId,
  sections: SECTIONS,
  thresholds: [],
  notApplicable: [],
  maxSelectionTrials: 4,
  frozen: true,
  contentHash: sha256('frozen spec content'),
  createdAt: T,
  frozenAt: T,
};

const inputBytes = strToU8('a,b\n1,2\n');
const generatedBytes = strToU8('{"snapshotManifest":true}');
const snapshot: InputSnapshot = {
  objectsStored: true,
  id: randomUUID(),
  projectId,
  requestId,
  locationRevision: 0,
  requestRevision: 1,
  route: 'SELECTED_FILES_GIT_SNAPSHOT',
  files: [{ path: 'input.csv', bytes: inputBytes.byteLength, sha256: sha256(inputBytes) }],
  generated: [{ path: '_office/manifest.json', bytes: generatedBytes.byteLength, sha256: sha256(generatedBytes) }],
  totalBytes: inputBytes.byteLength + generatedBytes.byteLength,
  manifestHash: sha256('snapshot manifest'),
  stagingCommit: '',
  stagingPath: 'unused-in-codec',
  warnings: [],
  provenance: 'OFFICE_STAGED',
  createdAt: T,
};
const state: AppState = {
  schemaVersion: 1,
  snapshots: [snapshot],
  projects: [],
  experiments: [],
  tasks: [],
  artifacts: [],
  reviews: [],
  events: [],
  agents: [],
  settings: { theme: 'dark', reducedMotion: false, globalBudgetCents: 0 },
  spend: { actualCents: 0, reservedCents: 0 },
};
const objects = new Map<string, Uint8Array>([
  [sha256(inputBytes), inputBytes],
  [sha256(generatedBytes), generatedBytes],
]);
const readObject = async (hash: string) => objects.get(hash) ?? null;
const codec = () => createRunPackageCodec({ templatesDir: templateDirectory, now: () => T });

const build = () => codec().build({ state, branch, link, spec, readObject });

/** A valid bound return for a built package; overrides alter the manifest or the member set. */
function returnBundle(
  pkg: RunPackageManifest,
  options: {
    artifacts?: { path: string; data: Uint8Array }[];
    manifestExtra?: Record<string, unknown>;
    extraMembers?: Record<string, Uint8Array>;
    omitMembers?: string[];
  } = {},
) {
  const outputs =
    options.artifacts ?? EXPECTED_FILES.map(file => ({ path: file, data: strToU8(`content of ${file}`) }));
  const manifest = {
    schemaVersion: 1,
    kind: 'RUN_RETURN',
    packageId: pkg.packageId,
    packageHash: pkg.packageHash,
    branchId: pkg.branchId,
    specId: pkg.specId,
    specHash: pkg.specHash,
    subjectHash: pkg.subjectHash,
    runId: 'user-run-1',
    startedAt: at(5),
    finishedAt: at(9),
    status: 'COMPLETED',
    artifacts: outputs.map(item => ({ path: item.path, sha256: sha256(item.data), bytes: item.data.byteLength })),
    gates: [...RETURN_GATES],
    failedRuns: [],
    detail: 'Synthetic user-run return.',
    ...(options.manifestExtra ?? {}),
  };
  const members: Record<string, Uint8Array> = { 'return-manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const item of outputs) members[item.path] = item.data;
  for (const [name, data] of Object.entries(options.extraMembers ?? {})) members[name] = data;
  for (const name of options.omitMembers ?? []) delete members[name];
  return { bytes: zipSync(members), manifest };
}

/**
 * Writes a minimal store-method zip by hand so hostile entry names, duplicate names and link modes
 * can be produced exactly — fflate's own writer cannot express them.
 */
function rawZip(entries: { name: string; data: Uint8Array; external?: number }[]): Uint8Array {
  const out: number[] = [],
    central: number[] = [];
  const u16 = (value: number) => [value & 255, (value >> 8) & 255];
  const u32 = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255];
  for (const entry of entries) {
    const name = strToU8(entry.name),
      offset = out.length,
      crc = crc32(entry.data) >>> 0;
    out.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
      ...entry.data,
    );
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(entry.external ?? 0),
      ...u32(offset),
      ...name,
    );
  }
  const directoryOffset = out.length;
  out.push(...central);
  out.push(
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(out.length - directoryOffset),
    ...u32(directoryOffset),
    ...u16(0),
  );
  return Uint8Array.from(out);
}

const expectOf = (pkg: RunPackageManifest) => ({ packageId: pkg.packageId, packageHash: pkg.packageHash });

test('build assembles a manifest-bound archive whose entries match its members byte-for-byte', async () => {
  const built = await build();
  const { manifest } = built;
  assert.equal(runPackageManifestSchema.parse(manifest).packageId, manifest.packageId);
  const { packageId, packageHash, exportedAt, ...base } = manifest;
  assert.equal(runPackageHash(base), packageHash, 'the package hash recomputes from its content');
  assert.equal(runPackageId(packageHash), packageId, 'the package id derives from the hash');
  assert.deepEqual(manifest.expectedReturn.files, [...EXPECTED_FILES]);
  assert.deepEqual(manifest.expectedReturn.requiredGates, ['G-PORTFOLIO', 'G-COST', 'G-ECON']);
  assert.equal(manifest.environment.runtime, 'COLAB_USER_RUN');

  const members = unzipSync(built.bytes);
  const declared = new Map(manifest.entries.map(entry => [entry.path, entry]));
  assert.deepEqual(
    Object.keys(members).sort(),
    [...declared.keys(), 'MANIFEST.json'].sort(),
    'every archive member except the manifest carrier itself is declared',
  );
  for (const [name, data] of Object.entries(members)) {
    if (name === 'MANIFEST.json') {
      assert.deepEqual(JSON.parse(strFromU8(data)), JSON.parse(JSON.stringify(manifest)));
      continue;
    }
    const entry = declared.get(name)!;
    assert.equal(data.byteLength, entry.bytes, name);
    assert.equal(sha256(data), entry.sha256, name);
  }
  assert.ok(
    members['templates/data.v1.py'] && members['templates/cost.v1.py'],
    'authored check templates ship in the package',
  );
  assert.ok(members['spec.json'], 'the frozen spec ships');
  assert.deepEqual(members[`inputs/${snapshot.id}/input.csv`], inputBytes, 'bound input objects ship by identity');
  assert.equal(strFromU8(members['INSTRUCTIONS.md']), manifest.instructions);
  assert.ok(manifest.instructions.trim().length <= 8000);
});

test('inspect verifies a bound return and reports the extracted objects', async () => {
  const { manifest } = await build();
  const returned = returnBundle(manifest);
  const inspection = codec().inspect({ bytes: returned.bytes, expect: expectOf(manifest) });
  assert.equal(inspection.manifest.packageId, manifest.packageId);
  assert.equal(inspection.manifest.status, 'COMPLETED');
  assert.equal(
    inspection.manifestHash,
    sha256(strToU8(JSON.stringify(returned.manifest))),
    'the manifest hash names the manifest member bytes',
  );
  assert.equal(inspection.objects.length, EXPECTED_FILES.length);
  for (const object of inspection.objects) assert.equal(sha256(object.bytes), object.sha256);
  assert.match(inspection.summary, /Bound return admitted/);
});

test('inspect refuses a bundle that names a different package', async () => {
  const { manifest } = await build();
  const returned = returnBundle(manifest);
  assert.throws(
    () =>
      codec().inspect({
        bytes: returned.bytes,
        expect: { packageId: randomUUID(), packageHash: manifest.packageHash },
      }),
    /different package/,
  );
  assert.throws(
    () =>
      codec().inspect({
        bytes: returned.bytes,
        expect: { packageId: manifest.packageId, packageHash: sha256('some other package') },
      }),
    /different package/,
  );
});

test('inspect refuses tampered declared hashes, altered member bytes, undeclared extras and missing declared files', async () => {
  const { manifest } = await build();
  const inspect = (bytes: Uint8Array) => codec().inspect({ bytes, expect: expectOf(manifest) });

  // A declared hash that does not match its member.
  const outputs = EXPECTED_FILES.map(file => ({ path: file, data: strToU8(`content of ${file}`) }));
  const tampered = returnBundle(manifest).manifest;
  tampered.artifacts[0] = { ...tampered.artifacts[0], sha256: sha256('not the member bytes') };
  const rehashed = zipSync({
    'return-manifest.json': strToU8(JSON.stringify(tampered)),
    ...Object.fromEntries(outputs.map(item => [item.path, item.data])),
  });
  assert.throws(() => inspect(rehashed), /does not match its declared identity/);

  // Member bytes altered while the manifest keeps the true declaration.
  const altered = zipSync({
    'return-manifest.json': strToU8(JSON.stringify(returnBundle(manifest).manifest)),
    ...Object.fromEntries(
      outputs.map((item, index) => [item.path, index === 0 ? strToU8('swapped content') : item.data]),
    ),
  });
  assert.throws(() => inspect(altered), /does not match its declared identity/);

  // A member the manifest never declared.
  const extra = returnBundle(manifest, { extraMembers: { 'outputs/smuggled.bin': strToU8('smuggled') } });
  assert.throws(() => inspect(extra.bytes), /does not declare/);

  // A declared artifact absent from the archive.
  const missing = returnBundle(manifest, { omitMembers: [EXPECTED_FILES[3]] });
  assert.throws(() => inspect(missing.bytes), /missing or does not match/);
});

test('inspect refuses traversal, absolute, drive-letter, backslash, duplicate and linked entries', async () => {
  const { manifest } = await build();
  const returned = returnBundle(manifest);
  const good = unzipSync(returned.bytes);
  const baseEntries = Object.entries(good).map(([name, data]) => ({ name, data }));
  const withMember = (entry: { name: string; data: Uint8Array; external?: number }) => rawZip([...baseEntries, entry]);
  const inspect = (bytes: Uint8Array) => codec().inspect({ bytes, expect: expectOf(manifest) });

  assert.throws(() => inspect(withMember({ name: '../escape.txt', data: strToU8('x') })), /unsafe or duplicate/);
  assert.throws(() => inspect(withMember({ name: '/absolute.txt', data: strToU8('x') })), /unsafe or duplicate/);
  assert.throws(() => inspect(withMember({ name: 'C:/drive.txt', data: strToU8('x') })), /unsafe or duplicate/);
  assert.throws(() => inspect(withMember({ name: 'back\\slash.txt', data: strToU8('x') })), /unsafe or duplicate/);
  assert.throws(
    () => inspect(withMember({ name: 'outputs/economics.json', data: strToU8('x') })),
    /unsafe or duplicate/,
    'a duplicate archive name is refused even when it repeats a declared path',
  );
  // A symlink entry in the central directory (Unix mode 0o120000).
  assert.throws(
    () => inspect(withMember({ name: 'linked.txt', data: strToU8('x'), external: 0xa1ff0000 })),
    /links, directories and special files/,
  );
});

test('inspect refuses archives over the declared entry and size caps', async () => {
  const { manifest } = await build();
  const inspect = (bytes: Uint8Array) => codec().inspect({ bytes, expect: expectOf(manifest) });

  // The archive itself beyond the 64 MiB bound.
  assert.throws(() => inspect(new Uint8Array(64 * 1024 * 1024 + 1)), /64 MiB/);

  // More entries than the declared cap: 513 members including the manifest.
  const many: Record<string, Uint8Array> = { 'return-manifest.json': strToU8('{}') };
  for (let index = 0; index < 512; index++) many[`f${index}.bin`] = strToU8('x');
  assert.throws(() => inspect(zipSync(many)), /oversized|too many entries/);

  // A small archive whose central directory claims a member expands past the per-file cap.
  const small = Buffer.from(zipSync({ 'return-manifest.json': strToU8('{}') }));
  const eocd = small.length - 22;
  assert.equal(small.readUInt32LE(eocd), 0x06054b50);
  const directoryOffset = small.readUInt32LE(eocd + 16);
  assert.equal(small.readUInt32LE(directoryOffset), 0x02014b50);
  small.writeUInt32LE(64 * 1024 * 1024 + 1, directoryOffset + 24);
  assert.throws(() => inspect(small), /expands beyond the permitted size/);
});

test('inspect enforces the strict manifest schema and requires the manifest member', async () => {
  const { manifest } = await build();
  const inspect = (bytes: Uint8Array) => codec().inspect({ bytes, expect: expectOf(manifest) });

  const unknownField = returnBundle(manifest, { manifestExtra: { smuggled: true } });
  assert.throws(() => inspect(unknownField.bytes), /Unrecognized key/);

  const noManifest = zipSync({ 'outputs/economics.json': strToU8('x') });
  assert.throws(() => inspect(noManifest), /return-manifest\.json/);

  const garbage = strToU8('this is not a zip');
  assert.throws(() => inspect(garbage), /Invalid ZIP/);
});

test('build fails loudly when a bound input object is missing or corrupt', async () => {
  const missing = codec().build({ state, branch, link, spec, readObject: async () => null });
  await assert.rejects(missing, /not in the object store/);
  const corrupt = codec().build({ state, branch, link, spec, readObject: async () => strToU8('different bytes') });
  await assert.rejects(corrupt, /no longer matches its recorded identity/);
});

test('re-export of unchanged content keeps the same package identity', async () => {
  const first = await build();
  const second = await codec().build({ state, branch, link, spec, readObject });
  assert.equal(first.manifest.packageId, second.manifest.packageId);
  assert.equal(first.manifest.packageHash, second.manifest.packageHash);
});

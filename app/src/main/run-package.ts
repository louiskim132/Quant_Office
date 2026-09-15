import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parseStrictJson } from '../core/strict-json.js';
import { authoredTemplates } from './research-templates.js';
import { MAX_FILE, MAX_TOTAL, safeEntry, validateZipHeaders } from './artifacts.js';
import {
  runPackageHash, runPackageId, runPackageManifestSchema, runReturnManifestSchema,
  type RunPackageBuilder, type RunPackageManifest, type RunPackageBuild,
  type RunReturnInspector, type RunReturnInspection,
} from '../shared/run-package.js';
import type { GateId, Stage } from '../shared/research.js';

/**
 * The real archive codec behind the manual-run contract (roadmap section 1.6, slice C8 area 1/3).
 *
 * `build` freezes the package the user carries to Colab: the authored check templates, the frozen
 * specification and every input object bound to the linked request, plus the return inventory the
 * bundle must answer. `inspect` is the bound-return side: it unzips a returned bundle under strict
 * limits, validates its RUN_RETURN manifest and verifies every declared artifact byte-for-byte
 * before the store admits anything as user-run evidence.
 *
 * Nothing here executes research code, connects to Colab or promotes returned bytes past their
 * USER_RUN provenance. The package manifest member cannot list itself, so MANIFEST.json is the one
 * archive member not inside manifest.entries; every other member is declared with its sha256.
 */

/** Fixed member names inside the two archive formats. */
const PACKAGE_MANIFEST = 'MANIFEST.json';
const PACKAGE_INSTRUCTIONS = 'INSTRUCTIONS.md';
const PACKAGE_SPEC = 'spec.json';
const RETURN_MANIFEST = 'RUN_RETURN.json';

/** Archive bounds, declared so both sides of the transfer enforce the same limits. */
const MAX_ENTRIES = 512;
const MAX_ARCHIVE = MAX_FILE;
const MAX_MEMBER = MAX_FILE;
const MAX_EXPANDED = MAX_TOTAL;
const MAX_RETURN_MANIFEST = 1024 * 1024;

/** The files a completed return must carry back, each produced by one shipped check template. */
const EXPECTED_RETURN_FILES = [
  'outputs/dataset-manifest.json',
  'outputs/diagnostics.json',
  'outputs/portfolio-periods.json',
  'outputs/economics.json',
] as const;

/**
 * The gates the shipped check code answers: portfolio.v1 produces the period books G-PORTFOLIO
 * validates, and cost.v1 prices them for G-COST and G-ECON. The store requires exactly these in
 * `expectedReturn.requiredGates`; G-ARTIFACT stays office work (the transfer check itself) and the
 * review-stage gates were already earned before export.
 */
const REQUIRED_RETURN_GATES: { gate: GateId; stage: Stage }[] = [
  { gate: 'G-PORTFOLIO', stage: 'S5' },
  { gate: 'G-COST', stage: 'S6' },
  { gate: 'G-ECON', stage: 'S6' },
];

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface RunPackageCodecOptions {
  /** Directory holding the authored check templates (the app's research-templates directory). */
  templatesDir: string;
  /** Clock for the manifest's exportedAt; injectable so tests and replays are deterministic. */
  now?: () => string;
}

/**
 * The manual Colab runbook, also copied into the manifest's instructions field. It says what the
 * user does, what the bundle must contain and what the office will check — it cannot name the
 * packageId, because that identity is derived from the instructions themselves.
 */
function packageInstructions(templates: { file: string }[]): string {
  return [
    '# Quant Research Office - manual run package',
    '',
    'This archive is a frozen run package. You execute it yourself in Google Colab. The office',
    'does not connect to, poll or control Colab, and no agent acts on the waiting experiment.',
    '',
    '## Contents',
    `- ${PACKAGE_MANIFEST} - the frozen package manifest. Its packageId and packageHash name this`,
    '  exact package; the returned bundle must carry the same identity.',
    `- ${PACKAGE_SPEC} - the frozen specification this run answers.`,
    '- templates/ - the authored check scripts:',
    ...templates.map(template => `  - ${template.file}`),
    '- inputs/ - the frozen input bytes this run is bound to, grouped by input snapshot id.',
    '',
    '## Steps',
    '1. Open a fresh Colab notebook and upload this archive.',
    '2. Unpack it and run the shipped templates against inputs/ under the frozen spec, in order:',
    `   ${templates.map(template => template.file).join(', ')}.`,
    '3. Record every attempt, including failures. A return that reports only its successful run is',
    '   a selected ledger and cannot be admitted.',
    `4. Write ${RETURN_MANIFEST} at the bundle root: schemaVersion 1, kind RUN_RETURN, this`,
    `   package's packageId and packageHash from ${PACKAGE_MANIFEST}, the branch/spec/subject`,
    '   identity, your run id, start and finish timestamps, the final status, the sha256 and byte',
    '   length of every returned artifact, the gate outcomes the checks produced and the',
    '   failed-run ledger.',
    `5. Zip ${RETURN_MANIFEST} together with exactly these output files and import the bundle`,
    '   back into the office:',
    ...EXPECTED_RETURN_FILES.map(file => `   - ${file}`),
    '',
    'The office checks the return byte-for-byte: wrong package identity, missing, extra or altered',
    'files are each rejected. User-run evidence keeps its own provenance label on admission.',
  ].join('\n');
}

/**
 * Creates the object the pipeline's package seams consume: the same codec is both the
 * RunPackageBuilder and the RunReturnInspector, so wiring is `{ build: codec, inspect: codec }`.
 */
export function createRunPackageCodec(options: RunPackageCodecOptions): RunPackageBuilder & RunReturnInspector {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async build(input): Promise<RunPackageBuild> {
      const { state, branch, link, spec, readObject } = input;
      const members = new Map<string, Uint8Array>();
      const add = (entryPath: string, bytes: Uint8Array) => {
        if (!safeEntry(entryPath)) throw new Error(`Refusing to pack an unsafe archive path: ${entryPath}`);
        if (members.has(entryPath)) throw new Error(`Refusing to pack a duplicate archive path: ${entryPath}`);
        members.set(entryPath, bytes);
      };

      // The authored check templates are the package's check code and ship verbatim.
      const templates = authoredTemplates(options.templatesDir);
      for (const template of templates) {
        const bytes = readFileSync(path.join(options.templatesDir, template.file));
        if (sha256(bytes) !== template.sha256)
          throw new Error(`Template ${template.file} changed while the package was being assembled.`);
        add(`templates/${template.file}`, bytes);
      }
      add(PACKAGE_SPEC, strToU8(JSON.stringify(spec, null, 2)));

      // Every input object frozen against the linked request revision is package-bound data. A
      // declared object the store cannot produce fails the export loudly rather than shipping a
      // package whose recorded contents are incomplete.
      const bound = new Map<string, { path: string; sha256: string; bytes: number }>();
      for (const snapshot of (state.snapshots ?? [])
        .filter(item => item.requestId === link.requestId && item.requestRevision === link.requestRevision))
        for (const file of [...snapshot.files, ...(snapshot.generated ?? [])])
          bound.set(`${snapshot.id}/${file.path}`, file);
      for (const [key, file] of [...bound.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const bytes = await readObject(file.sha256);
        if (!bytes)
          throw new Error(`The package's input object ${file.sha256} (${file.path}) is not in the object store.`);
        if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256)
          throw new Error(`The package's input object ${file.path} no longer matches its recorded identity.`);
        add(`inputs/${key}`, bytes);
      }

      const instructions = packageInstructions(templates);
      add(PACKAGE_INSTRUCTIONS, strToU8(instructions));

      const entries = [...members.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([entryPath, bytes]) => ({ path: entryPath, sha256: sha256(bytes), bytes: bytes.byteLength }));
      const base: Omit<RunPackageManifest, 'packageId' | 'packageHash' | 'exportedAt'> = {
        schemaVersion: 1, kind: 'RUN_PACKAGE', projectId: branch.projectId, branchId: branch.id,
        branchRevision: branch.revision, specId: spec.id, specHash: spec.contentHash,
        subjectHash: link.subjectHash, requestId: link.requestId, requestRevision: link.requestRevision,
        entries,
        environment: {
          runtime: 'COLAB_USER_RUN',
          detail: 'The user runs this package manually in Google Colab: upload the archive, run the shipped templates against the frozen inputs and return the declared bundle. The office exports and later validates; it never connects to, polls or controls the runtime.',
        },
        expectedReturn: {
          files: [...EXPECTED_RETURN_FILES],
          requiredGates: REQUIRED_RETURN_GATES.map(item => item.gate),
        },
        instructions,
      };
      const packageHash = runPackageHash(base);
      const manifest: RunPackageManifest = {
        ...base, packageId: runPackageId(packageHash), packageHash, exportedAt: now(),
      };
      // A manifest that fails its own schema must not leave the build.
      runPackageManifestSchema.parse(manifest);

      const contents: Record<string, Uint8Array> = {};
      for (const [entryPath, bytes] of [...members.entries()].sort((a, b) => a[0].localeCompare(b[0])))
        contents[entryPath] = bytes;
      contents[PACKAGE_MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
      const zipped = zipSync(contents, { level: 6 });
      validateZipHeaders(zipped);
      return { manifest, bytes: zipped };
    },

    inspect(input): RunReturnInspection {
      const { bytes, expect } = input;
      if (bytes.length > MAX_ARCHIVE) throw new Error('Archive exceeds the 64 MiB limit.');
      validateZipHeaders(bytes);
      const seen = new Set<string>(); let total = 0;
      const files = unzipSync(bytes, { filter: entry => {
        if (!safeEntry(entry.name) || seen.has(entry.name.toLowerCase()) || seen.size >= MAX_ENTRIES)
          throw new Error('Archive contains unsafe, duplicate, or too many entries.');
        seen.add(entry.name.toLowerCase()); total += entry.originalSize;
        if (entry.originalSize > MAX_MEMBER || total > MAX_EXPANDED)
          throw new Error('Archive expands beyond the permitted size.');
        return true;
      }});

      const data = files[RETURN_MANIFEST];
      if (!data || data.length > MAX_RETURN_MANIFEST)
        throw new Error(`A returned bundle needs a ${RETURN_MANIFEST} smaller than 1 MiB.`);
      const manifestHash = sha256(data);
      const manifest = runReturnManifestSchema.parse(parseStrictJson(strFromU8(data)));
      if (manifest.packageId !== expect.packageId || manifest.packageHash !== expect.packageHash)
        throw new Error('Returned bundle names a different package.');

      // The inventory is closed: the manifest member plus exactly the declared artifacts, each
      // verified byte-for-byte. Anything else in the archive is undeclared by definition.
      const declared = new Set<string>([RETURN_MANIFEST]);
      const objects: RunReturnInspection['objects'] = [];
      for (const artifact of manifest.artifacts) {
        if (!safeEntry(artifact.path) || declared.has(artifact.path))
          throw new Error('Invalid return artifact inventory.');
        declared.add(artifact.path);
        const file = files[artifact.path];
        if (!file || file.length !== artifact.bytes || sha256(file) !== artifact.sha256)
          throw new Error(`Returned artifact is missing or does not match its declared identity: ${artifact.path}`);
        objects.push({ path: artifact.path, sha256: artifact.sha256, bytes: file });
      }
      if (Object.keys(files).some(name => !declared.has(name)))
        throw new Error('Returned bundle carries files its manifest does not declare.');

      return {
        manifest, objects, manifestHash,
        summary: `Bound return admitted for package ${manifest.packageId}: ${manifest.status}, ${objects.length} declared artifact${objects.length === 1 ? '' : 's'} verified byte-for-byte, ${manifest.failedRuns.length} failed attempt${manifest.failedRuns.length === 1 ? '' : 's'} on the ledger. User-run provenance retained; no hosted or independent verification is implied.`,
      };
    },
  };
}

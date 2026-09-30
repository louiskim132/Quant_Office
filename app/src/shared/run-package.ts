import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GATES, type ResearchBranch, type FrozenResearchSpec, type Stage } from './research.js';
import type { AppState, InputSnapshot } from './types.js';
import type { BranchLink } from './pipeline.js';

/**
 * The manual-run contract (roadmap section 1.6, slice C8).
 *
 * The office authors a frozen run package; the user executes it in Colab, by hand; the office
 * validates the returned bytes against the package identity and admits them as user-run evidence.
 * Nothing here connects to, polls or controls the external runtime, and no returned byte is ever
 * relabelled as independently executed, hosted or custodial evidence.
 */

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime();
const text = (n: number) => z.string().trim().min(1).max(n);

/** How a gate receipt was produced. The label is the claim; nothing promotes a receipt past it. */
export const GATE_PROVENANCE = ['OFFICE', 'REVIEWER_ASSERTED', 'USER_RUN', 'SIGNED_HARNESS'] as const;
export type GateProvenance = (typeof GATE_PROVENANCE)[number];

/**
 * The frozen package manifest. `packageHash` covers every field that determines what the user runs;
 * `packageId` derives from it, so re-exporting unchanged content is idempotent and a changed package
 * is a different identity rather than an edit.
 */
export const runPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('RUN_PACKAGE'),
    packageId: id,
    packageHash: hash,
    projectId: id,
    branchId: id,
    branchRevision: z.number().int().nonnegative(),
    specId: id,
    specHash: hash,
    subjectHash: hash,
    requestId: id,
    requestRevision: z.number().int().nonnegative(),
    /** Package contents: fixed launcher, frozen code/config/data identities and check definitions. */
    entries: z
      .array(z.object({ path: text(240), sha256: hash, bytes: z.number().int().nonnegative() }).strict())
      .min(1)
      .max(512),
    environment: z.object({ runtime: z.literal('COLAB_USER_RUN'), detail: text(2000) }).strict(),
    expectedReturn: z
      .object({
        files: z.array(text(240)).min(1).max(256),
        /** Gates the package's shipped check code must answer for the return to be complete. */
        requiredGates: z.array(z.enum(GATES)).max(32),
      })
      .strict(),
    instructions: text(8000),
    exportedAt: at,
  })
  .strict();
export type RunPackageManifest = z.infer<typeof runPackageManifestSchema>;

/** The content identity a package is named by: everything except the export timestamp. */
export function runPackageHash(manifest: Omit<RunPackageManifest, 'packageId' | 'packageHash' | 'exportedAt'>): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
/** A deterministic packageId: the same content is the same package, so re-export is idempotent. */
export function runPackageId(packageHash: string): string {
  const h = packageHash.replace(/[^a-f0-9]/g, '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The returned bundle's manifest. It answers the package it names — a return naming any other
 * package, subject, spec or request revision is a wrong-package return, not a partial success.
 */
export const runReturnManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('RUN_RETURN'),
    packageId: id,
    packageHash: hash,
    branchId: id,
    specId: id,
    specHash: hash,
    subjectHash: hash,
    runId: text(120),
    startedAt: at,
    finishedAt: at,
    status: z.enum(['COMPLETED', 'EXECUTION_FAILED', 'INCONCLUSIVE']),
    /** Every returned artifact with its byte identity. Undeclared files make the return invalid. */
    artifacts: z
      .array(z.object({ path: text(240), sha256: hash, bytes: z.number().int().nonnegative() }).strict())
      .max(512),
    /** Outcomes the package's check code reports, each tagged with the stage it answers. */
    gates: z
      .array(
        z
          .object({
            gate: z.enum(GATES),
            stage: z.enum(['S3', 'S4', 'S5', 'S6', 'S8'] as const),
            outcome: z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE']),
            detail: z.string().max(4000),
            rationale: z.string().max(4000),
          })
          .strict(),
      )
      .max(64),
    /** Attempts the user ran that failed, so a selected ledger cannot be returned. */
    failedRuns: z.array(z.object({ reason: z.string().trim().min(1).max(1000), failedAt: at }).strict()).max(500),
    detail: z.string().max(4000),
  })
  .strict();
export type RunReturnManifest = z.infer<typeof runReturnManifestSchema>;

// ---- service seams ------------------------------------------------------------------------------
// The contracts are shared; the implementations live in main/ and are injected into the pipeline.

export interface RunPackageBuild {
  manifest: RunPackageManifest;
  /** Zip bytes of the package archive the user takes to Colab. */
  bytes: Uint8Array;
}

export interface RunPackageBuilder {
  build(input: {
    state: AppState;
    branch: ResearchBranch;
    link: BranchLink;
    spec: FrozenResearchSpec;
    readObject: (sha256: string) => Promise<Uint8Array | null>;
  }): Promise<RunPackageBuild>;
}

export interface RunReturnInspection {
  manifest: RunReturnManifest;
  /** Verified content-addressed objects extracted from the returned archive. */
  objects: { path: string; sha256: string; bytes: Uint8Array }[];
  manifestHash: string;
  summary: string;
}

export interface RunReturnInspector {
  /**
   * Parses and hashes a returned archive, failing fast when its manifest names any package other
   * than `expect`. Store admission re-checks the same binding; this is the early, useful reason.
   */
  inspect(input: { bytes: Uint8Array; expect: { packageId: string; packageHash: string } }): RunReturnInspection;
}

// ---- readiness split ----------------------------------------------------------------------------

/**
 * Section 5.3's required split: each capability is reported on its own evidence, never collapsed
 * into one optimistic "ready". A capability the build lacks says so rather than implying readiness.
 */
export interface ManualRunReadiness {
  /** Whether agents can be reached at all (connection/adapter route). */
  agentCommunication: { state: 'READY' | 'LIMITED' | 'BLOCKED'; detail: string };
  /** Whether an agent assignment can execute (hosted dispatch or the manual terminal handoff). */
  agentToolExecution: { state: 'READY' | 'HANDOFF_ONLY' | 'BLOCKED'; detail: string };
  /** The section-1.6 export/wait/import path — built in, so always reportable. */
  manualExperimentHandoff: { state: 'READY' | 'BLOCKED'; detail: string };
  /** Bound-return validation — built in alongside the handoff. */
  returnValidation: { state: 'READY' | 'BLOCKED'; detail: string };
  /** Optional stronger evidence: isolated evaluator, signed harness, custodian. */
  protectedEvaluation: { state: 'READY' | 'NOT_CONFIGURED'; detail: string };
}

/** How each stage's work is delivered under the corrected contract. */
export const STAGE_DELIVERY: Record<Stage, 'AGENT' | 'USER_RUN' | 'OFFICE'> = {
  S0: 'AGENT',
  S1: 'AGENT',
  S2: 'AGENT',
  S3: 'USER_RUN',
  S4: 'AGENT',
  S5: 'OFFICE',
  S6: 'OFFICE',
  S7: 'AGENT',
  S8: 'OFFICE',
  S9: 'OFFICE',
  S10: 'OFFICE',
};

/** Snapshot builders used by the separated-review path; one packet object per reviewer. */
export interface SeparatedReviewPacket {
  agentId: string;
  contextId: string;
  snapshot: InputSnapshot;
  evidenceHash: string;
  objectHashes: string[];
}

import { z } from 'zod';

/**
 * Per-assignment declared tool scope (inter-agent pipeline W1).
 *
 * A tool profile is a contract, not a sandbox. The office enforces it only where enforcement
 * is real: provider launch flags the CLI actually honors, office-spawned tool servers bound
 * to the session, and grant-checked query surfaces that refuse before bytes reach a model.
 * Anything a provider cannot express stays declared-only, and the launch record names that
 * residue instead of claiming a boundary that does not exist.
 */
export const toolProfileSchema = z.object({
  /**
   * Declared tool allowlist (provider tool ids, e.g. 'Bash', 'Read', 'Edit' for claude;
   * sandbox modes for codex). Absent means today's unrestricted local posture.
   */
  allowedTools: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
  /**
   * Office-spawned stdio tool servers bound to this session — serena, the evidence query
   * surface and the like. The office owns their lifecycle; the provider only sees the
   * session directory they are scoped to.
   */
  mcpServers: z.array(z.object({
    id: z.string().trim().min(1).max(60),
    command: z.string().trim().min(1).max(400),
    args: z.array(z.string().trim().max(400)).max(32).optional(),
    readOnly: z.boolean(),
  }).strict()).max(8).optional(),
  /** Declared filesystem posture; enforced only where the provider or the office can. */
  filesystem: z.enum(['PACKET_ONLY', 'READ_PROJECT']).optional(),
  /** Whether the session may write outside outputs/. Declared; enforced where expressible. */
  canWrite: z.boolean().optional(),
}).strict();

export type ToolProfile = z.infer<typeof toolProfileSchema>;

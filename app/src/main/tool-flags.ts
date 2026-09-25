import type { Effort, Provider } from '../shared/types.js';
import { EVIDENCE_SURFACE_ID, type ToolProfile } from '../shared/tool-profile.js';

/**
 * Profile-driven launch flags (inter-agent pipeline W1).
 *
 * mapToolFlags builds the full argv for one provider CLI launch from the binding's declared
 * ToolProfile. With no profile the output is byte-identical to the pre-profile builders — that
 * is a regression boundary, not an option. With a profile, every declared restriction either
 * becomes arguments verified against the installed CLI's --help on this machine or is named in
 * `unmapped` — a restriction the CLI cannot express is never silently dropped and never claimed.
 *
 * Verified flag surface (claude --help / codex exec --help / devin --help, this machine):
 *   claude 2.x:  --tools <tools...> restricts the available built-in tool set ("" disables all,
 *                "default" restores all); it is a real restriction even under
 *                --dangerously-skip-permissions — unlike --allowedTools/--disallowedTools, which
 *                exist but are permission-layer lists that bypass renders advisory. --mcp-config
 *                loads MCP servers from JSON files or strings. No flag confines filesystem
 *                reads or write scope, so filesystem/canWrite=false stay unmapped.
 *   codex exec:  -s/--sandbox read-only|workspace-write|danger-full-access is the only tool-
 *                surface gate documented; -c key=value config overrides exist but the
 *                mcp_servers keys they would need are not documented in exec --help, so
 *                allowedTools/mcpServers stay unmapped.
 *   devin 3000.x: --permission-mode auto|accept-edits|smart|dangerous and --respect-workspace-
 *                trust exist; --sandbox is documented for macOS seatbelt / Linux bwrap only —
 *                a no-op on Windows — so it maps filesystem only off win32. There is no
 *                per-tool allowlist and `devin mcp` is a management subcommand, not a
 *                per-invocation flag: everything else stays honestly unmapped.
 */

export interface ToolFlagInput {
  provider: Provider;
  model: string;
  effort: Effort;
  prompt: string;
  profile?: ToolProfile;
}

export interface ToolFlagResult {
  /** The full argv for the launch — baseline plus profile-derived flags. */
  args: string[];
  /** The exact trust/permission-bypass flags in the argv, verbatim. */
  bypassFlags: string[];
  /** The documented flag the requested effort was carried by, when the CLI documents one. */
  effortFlag: string | null;
  /** A requested effort the CLI has no documented flag for — recorded, never silently dropped. */
  unmappedEffort: Effort | null;
  /** Profile restrictions carried by a flag verified in the installed CLI's --help. */
  applied: string[];
  /**
   * Profile restrictions no verified flag expresses. Each entry names the restriction and
   * spells out 'declared, not enforced by <provider>' — the launch record surfaces them
   * verbatim instead of implying a boundary that does not exist.
   */
  unmapped: string[];
}

const CLAUDE_EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Splits declared mcpServers into the office-mounted evidence surface (packet drop-box — real
 * for every provider because it is plain files, and never a CLI-spawned command) and the
 * stdio servers a provider flag might attach. The surface must never reach --mcp-config:
 * its 'command' is a declaration label, not an executable.
 */
function partitionServers(profile: ToolProfile | undefined) {
  const servers = profile?.mcpServers ?? [];
  return {
    surface: servers.filter(server => server.id === EVIDENCE_SURFACE_ID),
    cli: servers.filter(server => server.id !== EVIDENCE_SURFACE_ID),
  };
}
const surfaceMounted = 'evidence-surface mounted via the packet queries/answers drop-box — the office serves it, no provider flag involved';

/**
 * Whether the provider has a verified flag that attaches declared MCP servers to the spawned
 * run. Only claude documents one (--mcp-config); codex and devin leave mcpServers unmapped, so
 * an office-side spawn of a declared server would gate on a binary the session could never
 * reach — the unmapped record is the honest state there, not a readiness probe.
 */
export const providerAttachesMcp = (provider: Provider): boolean => provider === 'claude';

export function mapToolFlags(input: ToolFlagInput, platform: NodeJS.Platform = process.platform): ToolFlagResult {
  switch (input.provider) {
    case 'claude': return claudeFlags(input);
    case 'openai': return codexFlags(input);
    case 'devin': return devinFlags(input, platform);
  }
}

function claudeFlags(input: ToolFlagInput): ToolFlagResult {
  const { model, effort, prompt, profile } = input;
  const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions', '--model', model];
  let effortFlag: string | null = null;
  let unmappedEffort: Effort | null = null;
  if (effort !== 'default') {
    if (CLAUDE_EFFORTS.has(effort)) {
      args.push('--effort', effort);
      effortFlag = `--effort ${effort}`;
    } else unmappedEffort = effort;
  }
  const applied: string[] = [];
  const unmapped: string[] = [];
  if (profile?.allowedTools?.length) {
    // --tools (not --allowedTools): it restricts the built-in tool set the session has at all,
    // so the boundary survives --dangerously-skip-permissions; --allowedTools is a permission-
    // layer allowlist that the bypass flag renders advisory.
    args.push('--tools', profile.allowedTools.join(','));
    applied.push(`allowedTools [${profile.allowedTools.join(', ')}] restricted via --tools (verified in claude --help: the available built-in tool set, enforced even under --dangerously-skip-permissions)`);
  }
  const servers = partitionServers(profile);
  if (servers.surface.length) applied.push(surfaceMounted);
  if (servers.cli.length) {
    // Claude launches each server without a shell, so a command carrying its sub-command
    // ("serena start-mcp-server") is split into the executable and leading arguments.
    const config = Object.fromEntries(servers.cli.map(server => {
      const [command, ...leading] = server.command.trim().split(/\s+/).filter(Boolean);
      const args = [...leading, ...(server.args ?? [])];
      return [server.id, args.length ? { command, args } : { command }];
    }));
    args.push('--mcp-config', JSON.stringify({ mcpServers: config }));
    applied.push(`mcpServers [${servers.cli.map(server => server.id).join(', ')}] attached via --mcp-config (verified in claude --help; each server's readOnly intent is packet-declared metadata, not a CLI flag)`);
  }
  if (profile?.filesystem)
    unmapped.push(`filesystem=${profile.filesystem}: declared, not enforced by claude — the installed CLI has no flag that confines filesystem reads (--add-dir only widens access)`);
  if (profile?.canWrite === false)
    unmapped.push('canWrite=false: declared, not enforced by claude — the installed CLI has no read-only sandbox flag and --dangerously-skip-permissions bypasses the permission layer');
  if (profile?.canWrite === true)
    applied.push('canWrite=true permitted by the baseline launch posture (--dangerously-skip-permissions)');
  return { args, bypassFlags: ['--dangerously-skip-permissions'], effortFlag, unmappedEffort, applied, unmapped };
}

function codexFlags(input: ToolFlagInput): ToolFlagResult {
  const { model, effort, prompt, profile } = input;
  const args = ['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-m', model, prompt];
  const applied: string[] = [];
  const unmapped: string[] = [];
  if (profile?.canWrite === false) {
    // Verified mode in codex exec --help: read-only removes the write capability entirely.
    args[2] = 'read-only';
    applied.push('canWrite=false enforced via -s read-only (a verified sandbox mode in codex exec --help — model-generated commands cannot write)');
  } else if (profile?.canWrite === true) {
    applied.push('canWrite=true permitted by the baseline -s workspace-write sandbox (writes stay confined to the packet directory)');
  }
  if (profile?.filesystem === 'PACKET_ONLY')
    applied.push(`filesystem=PACKET_ONLY carried by -s ${args[2]} — command writes are confined to the packet directory (the spawn cwd); reads are not confined`);
  else if (profile?.filesystem === 'READ_PROJECT')
    applied.push(`filesystem=READ_PROJECT satisfied by -s ${args[2]} — reads are already unrestricted (the project included); command writes stay confined to the packet directory`);
  if (profile?.allowedTools?.length)
    unmapped.push(`allowedTools [${profile.allowedTools.join(', ')}]: declared, not enforced by codex — codex exec --help documents no per-tool allowlist; the tool surface follows the sandbox mode`);
  const servers = partitionServers(profile);
  if (servers.surface.length) applied.push(surfaceMounted);
  if (servers.cli.length)
    unmapped.push(`mcpServers [${servers.cli.map(server => server.id).join(', ')}]: declared, not enforced by codex — exec --help documents -c config overrides but not the mcp_servers keys a per-invocation attach would need`);
  return {
    args,
    bypassFlags: ['-s', args[2], '--skip-git-repo-check'],
    effortFlag: null,
    unmappedEffort: effort === 'default' ? null : effort,
    applied, unmapped,
  };
}

function devinFlags(input: ToolFlagInput, platform: NodeJS.Platform): ToolFlagResult {
  const { model, effort, prompt, profile } = input;
  const args = ['-p', prompt, '--model', model, '--respect-workspace-trust', 'false', '--permission-mode', 'dangerous'];
  const applied: string[] = [];
  const unmapped: string[] = [];
  if (profile?.filesystem) {
    // --sandbox is verified in devin --help but documented macOS seatbelt / Linux bwrap+seccomp
    // only — on Windows passing it would claim a boundary that does not exist.
    if (platform === 'win32')
      unmapped.push(`filesystem=${profile.filesystem}: declared, not enforced by devin — --sandbox is documented for macOS seatbelt / Linux bwrap only and is a no-op on this Windows machine`);
    else {
      args.push('--sandbox');
      applied.push(`filesystem=${profile.filesystem} partially carried by --sandbox (verified in devin --help: exec-tool commands write only within the workspace; the agent's other file tools are not covered and reads are not confined)`);
    }
  }
  if (profile?.allowedTools?.length)
    unmapped.push(`allowedTools [${profile.allowedTools.join(', ')}]: declared, not enforced by devin — devin --help documents no per-tool allowlist flag`);
  const servers = partitionServers(profile);
  if (servers.surface.length) applied.push(surfaceMounted);
  if (servers.cli.length)
    unmapped.push(`mcpServers [${servers.cli.map(server => server.id).join(', ')}]: declared, not enforced by devin — 'devin mcp' manages server configuration, but no per-invocation flag attaches servers to a -p run`);
  if (profile?.canWrite === false)
    unmapped.push('canWrite=false: declared, not enforced by devin — --permission-mode auto auto-approves only read-only tools, but the help does not document that writes are denied non-interactively; the launch still records --permission-mode dangerous verbatim');
  if (profile?.canWrite === true)
    applied.push('canWrite=true permitted by the baseline --permission-mode dangerous posture');
  return {
    args,
    bypassFlags: ['--respect-workspace-trust', 'false', '--permission-mode', 'dangerous'],
    effortFlag: null,
    unmappedEffort: effort === 'default' ? null : effort,
    applied, unmapped,
  };
}

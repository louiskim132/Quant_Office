import type { Effort, Provider } from './types.js';
export const efforts: Effort[] = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** No inferred capability: aliases and missing catalogs remain unresolved. */
// Claude Code publishes a session effort axis on the CLI itself — `--effort` rejects invalid
// values with this exact enum (verified 2026-09-18 on claude.exe 2.1.273). It is session-level,
// not per-model: which models honor it stays provider-side, exactly like a declared preference.
export const CLAUDE_EFFORT_LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
// Devin encodes effort in the model variant (e.g. swe-2-max is the max-effort variant), so a
// separate effort axis cannot be honored there — 'default' is the honest answer until a catalog
// entry declares real levels. OpenAI entries carry levels from the signed-in catalog.
export function suggestedEfforts(provider: Provider, _model: string): Effort[] {
  return provider === 'claude' ? ['default', ...CLAUDE_EFFORT_LEVELS] : ['default'];
}
/** Whether the provider exposes effort as a control separate from the model choice. Devin encodes
 * effort in the model variant itself, so its effort field is Provider default by construction. */
export function effortIsIndependentAxis(provider: Provider): boolean {
  return provider !== 'devin';
}
/**
 * Curated model suggestions shown before (Claude) or alongside (OpenAI) a signed-in catalog.
 * Suggestions only — the model input is free-text and provider-side validation stays authoritative.
 * Claude entries are Claude Code aliases plus pinned IDs for the current generation; OpenAI entries
 * are Codex catalog names that the live `model/list` response replaces after sign-in.
 * Reviewed 2026-10-01 against the official Codex pricing list and the signed-in catalog.
 * GPT-6.1 Sol was exercised by the B5 local acceptance. Suggestions do not establish account
 * availability or effort support; the live catalog stays authoritative. Re-check at the next cycle.
 */
export const PROVIDER_MODEL_SUGGESTIONS: Record<Provider, { id: string; name: string }[]> = {
  openai: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.5', name: 'GPT-5.5 (retires from Codex 2026-10-14)' },
  ],
  claude: [
    { id: 'best', name: 'Best alias (latest Fable or Opus)' },
    { id: 'fable', name: 'Fable alias (latest Fable)' },
    { id: 'opus', name: 'Opus alias (latest Opus)' },
    { id: 'sonnet', name: 'Sonnet alias (latest Sonnet)' },
    { id: 'haiku', name: 'Haiku alias (latest Haiku)' },
    { id: 'opus[1m]', name: 'Opus alias · 1M context' },
    { id: 'sonnet[1m]', name: 'Sonnet alias · 1M context' },
    { id: 'opusplan', name: 'Opus plan → Sonnet execution' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 (pinned)' },
    { id: 'claude-fable-5', name: 'Claude Fable 5 (pinned)' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (pinned)' },
    { id: 'claude-opus-5', name: 'Claude Opus 5 (pinned)' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (pinned)' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (pinned)' },
  ],
  /**
   * Devin's real catalog comes from `devin models list --format json` after `devin auth login`;
   * there is no documented provisional list, so nothing is suggested before that sign-in.
   */
  devin: [],
};

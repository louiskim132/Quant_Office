import type { Agent } from '../shared/types';

/** Devin's variant suffix is the requested effort, not a second independent flag. */
export function modelLabel(agent: Pick<Agent, 'provider' | 'model' | 'effort'>): string {
  const variant =
    agent.provider === 'devin'
      ? /^(swe-\d+(?:\.\d+)?)-(none|minimal|low|medium|high|xhigh|max|ultra)$/i.exec(agent.model)
      : null;
  return `${agent.provider} · ${variant?.[1] ?? agent.model} · ${variant?.[2]?.toLowerCase() ?? agent.effort ?? 'default'} effort`;
}

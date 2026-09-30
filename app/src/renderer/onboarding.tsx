import React from 'react';
import type { AppState } from '../shared/types';
export function Onboarding({
  state,
  onAgents,
  onProjects,
  onRequest,
}: {
  state: AppState;
  onAgents: () => void;
  onProjects: () => void;
  onRequest: () => void;
}) {
  const active = state.agents.filter(a => !a.removedAt);
  const steps = [
    { name: 'Add a Director', done: active.some(a => a.role === 'DIRECTOR'), action: onAgents },
    { name: 'Add a project manager', done: active.some(a => a.role.startsWith('PM')), action: onAgents },
    { name: 'Add a worker', done: active.some(a => a.role === 'WORKER'), action: onAgents },
    { name: 'Create a project', done: state.projects.some(p => !p.archived && !p.removedAt), action: onProjects },
    { name: 'Create a first request', done: !!state.requests?.length, action: onRequest },
  ];
  if (steps.every(s => s.done)) return null;
  return (
    <details className="onboarding" open={!active.length && !state.projects.length}>
      <summary>
        Set up your office · {steps.filter(s => s.done).length} / {steps.length}
      </summary>
      <p className="muted">
        Build the team your question needs. Requests can use a single agent; a full roster is optional.
      </p>
      <div className="button-row">
        {steps.map(step => (
          <button key={step.name} className="secondary" disabled={step.done} onClick={step.action}>
            {step.done ? '✓ ' : '○ '}
            {step.name}
          </button>
        ))}
      </div>
    </details>
  );
}

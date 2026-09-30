import { useEffect, useState } from 'react';
import type { Agent, AppState, Role } from '../shared/types';
import type { OfficeActivity } from '../shared/activity';
import { agentBinding, currentConnection, providerReadiness } from '../shared/readiness';
import './office.css';
import { Users } from 'lucide-react';
import { Empty, Avatar, StatusPill } from './components';
import { useOfficeActivity } from './use-activity';
import { seatView } from './seat-view';
import { formatDateTime } from './format';
import { timeAgo } from './status';

const parseTime = (value: string | undefined): number => {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NaN;
};

/**
 * One freshness claim per roster row, from recorded timestamps alone: the newest verification
 * reads 'Last verified …', otherwise the newest recorded account observation reads 'Checked …',
 * and a row with neither admits 'Never checked'. A missing or unparsable timestamp is skipped,
 * never invented.
 */
export function rosterFreshness(
  agent: { connectionVerifiedAt?: string; bindingVerifiedAt?: string },
  lastObservedAt: string | undefined,
  now: number,
): string {
  const stamps = (...values: Array<string | undefined>) => values.map(parseTime).filter(Number.isFinite);
  const verifiedAt = Math.max(-Infinity, ...stamps(agent.bindingVerifiedAt, agent.connectionVerifiedAt));
  const checkedAt = Math.max(-Infinity, ...stamps(lastObservedAt));
  const latest = Math.max(verifiedAt, checkedAt);
  if (!Number.isFinite(latest)) return 'Never checked';
  return `${latest === verifiedAt ? 'Last verified' : 'Checked'} ${timeAgo(latest, now)}`;
}

export type RosterProvenance = 'office-observed' | 'provider-reported' | 'unverified';

/**
 * Who backs the status a roster row shows. 'provider-reported' and 'office-observed' come straight
 * from the recorded evidence field; a live claim with no evidence is 'unverified'; a row whose
 * status is only the office's own ledger (idle, a recorded recent outcome, archived) is backed by
 * office records, so it is office-observed.
 */
export function rosterProvenance(activity: Pick<OfficeActivity, 'kind' | 'evidence'> | undefined): RosterProvenance {
  if (activity?.evidence === 'PROVIDER_REPORTED') return 'provider-reported';
  if (activity?.kind === 'UNKNOWN' || activity?.evidence === 'NONE') return 'unverified';
  return 'office-observed';
}

export const rosterProvenanceTitle: Record<RosterProvenance, string> = {
  'office-observed': "Backed by the office's own records or a process it watches.",
  'provider-reported': 'Reported by the provider — the office records it but does not attest it.',
  unverified: 'No provider report or office record backs the current state.',
};

/** Header count copy: 'N agents' unfiltered, 'N matching agents' only while a filter is active. */
export function agentCountLabel(count: number, filtered: boolean): string {
  const word = count === 1 ? 'agent' : 'agents';
  return `${count} ${filtered ? 'matching ' : ''}${word} · no seat limit`;
}

export function AgentRoster({
  state,
  busy,
  onAgent,
  onAdd,
  onRemove,
  onDelete,
}: {
  state: AppState;
  busy: boolean;
  onAgent: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string, removed: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { activity, now } = useOfficeActivity(state);
  const [lifecycle, setLifecycle] = useState('active'),
    [search, setSearch] = useState(''),
    [team, setTeam] = useState(''),
    [role, setRole] = useState(''),
    [provider, setProvider] = useState(''),
    [page, setPage] = useState(0);
  useEffect(() => setPage(0), [lifecycle, search, team, role, provider]);
  const agents = state.agents.filter(
    a =>
      (lifecycle === 'removed'
        ? !!a.deletedAt
        : lifecycle === 'all'
          ? !a.deletedAt
          : lifecycle === 'archived'
            ? !!a.removedAt && !a.deletedAt
            : !a.removedAt) &&
      (!team || a.team === team) &&
      (!role || a.role === role) &&
      (!provider || a.provider === provider) &&
      [a.name, a.team, a.model].join(' ').toLowerCase().includes(search.toLowerCase()),
  );
  const lastPage = Math.max(0, Math.ceil(agents.length / 24) - 1),
    currentPage = Math.min(page, lastPage);
  const filtered = lifecycle !== 'active' || search.trim() !== '' || team !== '' || role !== '' || provider !== '';
  return (
    <>
      <div className="section-toolbar">
        <span>{agentCountLabel(agents.length, filtered)}</span>
        <button className="primary" onClick={onAdd}>
          Add agent
        </button>
      </div>
      <div className="log-filters">
        <label className="field">
          Membership
          <select value={lifecycle} onChange={e => setLifecycle(e.target.value)}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
            <option value="removed">Removed</option>
          </select>
        </label>
        <label className="field">
          Search agents
          <input value={search} onChange={e => setSearch(e.target.value)} />
        </label>
        <label className="field">
          Team
          <select value={team} onChange={e => setTeam(e.target.value)}>
            <option value="">All teams</option>
            {[...new Set(state.agents.map(a => a.team))].map(t => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Role
          <select value={role} onChange={e => setRole(e.target.value)}>
            <option value="">All roles</option>
            {['DIRECTOR', 'PM_A', 'PM_B', 'PM_C', 'PM_D', 'WORKER'].map(r => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Provider
          <select value={provider} onChange={e => setProvider(e.target.value)}>
            <option value="">All providers</option>
            <option value="openai">OpenAI</option>
            <option value="claude">Claude</option>
            <option value="devin">Devin</option>
          </select>
        </label>
      </div>
      {!agents.length &&
        (filtered || state.agents.some(a => !a.removedAt) ? (
          <Empty
            icon={Users}
            title="No agents match these filters"
            description="Adjust the membership, search, team, role or provider filters to widen the list."
          />
        ) : (
          <Empty
            icon={Users}
            title="No agents yet"
            description="Seat the first member of the team — add verifies the account with the provider's own sign-in first."
            action={
              <button className="primary" onClick={onAdd}>
                Add agent
              </button>
            }
          />
        ))}
      {!!agents.length && (
        <div className="agent-rows">
          <div className="agent-row agent-head">
            <span>Name</span>
            <span>Team · role</span>
            <span>Provider · model · effort</span>
            <span>Account</span>
            <span>Status</span>
            <span />
          </div>
          {agents.slice(currentPage * 24, (currentPage + 1) * 24).map(a => {
            const agentActivity = activity.find(x => x.agentId === a.id),
              view = seatView(a, agentActivity, state.requests, now),
              provenance = rosterProvenance(agentActivity),
              freshness = rosterFreshness(a, currentConnection(state, a.provider)?.lastCheckedAt, now);
            return (
              <article className="project-card agent-row" key={a.id}>
                <span className="agent-cell agent-name">
                  <Avatar id={a.id} name={a.name} status={view.status} />
                  <strong>{a.name}</strong>
                </span>
                <span className="agent-cell">
                  {a.team} · {a.role.replaceAll('_', ' ')}
                </span>
                <span className="agent-cell">
                  {a.provider} · {a.model} · {a.effort ?? 'default'} effort
                </span>
                <span className="agent-cell">
                  <details>
                    <summary>{a.execution === 'LOCAL' ? 'Local CLI' : 'Hosted setup'}</summary>
                    <small>{a.account}</small>
                  </details>
                  <small className="roster-stamp">{freshness}</small>
                </span>
                <span className="agent-cell">
                  <StatusPill
                    status={view.status}
                    label={a.deletedAt ? 'Removed' : a.removedAt ? 'Archived' : undefined}
                  />
                  <small className="prov-chip" data-evidence={provenance} title={rosterProvenanceTitle[provenance]}>
                    {provenance}
                  </small>
                  <small title={view.requestName || undefined} aria-label={view.requestName || undefined}>
                    {view.requestName}
                  </small>
                </span>
                <div className="button-row agent-actions">
                  <button className="secondary" onClick={() => onAgent(a.id)}>
                    Profile &amp; logs
                  </button>
                  {a.deletedAt ? (
                    <button
                      className="cancel-request"
                      disabled={busy}
                      title="Brings this agent back into the archived list; restore again there to make it active."
                      onClick={() => onRemove(a.id, false)}
                    >
                      Restore
                    </button>
                  ) : a.removedAt ? (
                    <>
                      <button
                        className="cancel-request"
                        disabled={busy}
                        title="Hides this archived agent from pickers and lists. Its profile, assignments and history are retained."
                        onClick={() => onDelete(a.id)}
                      >
                        Remove from list
                      </button>
                      <button className="cancel-request" disabled={busy} onClick={() => onRemove(a.id, false)}>
                        Restore agent
                      </button>
                    </>
                  ) : (
                    <button className="text-button" disabled={busy} onClick={() => onRemove(a.id, true)}>
                      Archive agent
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {lastPage > 0 && (
        <div className="button-row">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            Previous
          </button>
          <span>
            Page {currentPage + 1} of {lastPage + 1}
          </span>
          <button disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}
const profileDrafts = new Map<
  string,
  { name: string; team: string; role: Role; instructions: string; revision: number }
>();
/**
 * Bound account, current context, last verification and cloud readiness are separate facts.
 * Verify keeps the profile's own account; Change is an explicit move and says both identities.
 */
export function ConnectionBinding({
  agent,
  state,
  onState,
}: {
  agent: Agent;
  state: AppState;
  onState: (s: AppState) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirming, setConfirming] = useState(false);
  const binding = agentBinding(state, agent);
  const readiness = providerReadiness(state, agent.provider, { model: agent.model, execution: agent.execution });
  async function run(intent: 'VERIFY' | 'CHANGE') {
    setBusy(true);
    setError('');
    try {
      onState(
        await window.office.bindAgentConnection({ agentId: agent.id, expectedRevision: agent.revision ?? 0, intent }),
      );
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="binding-card">
      <h3>Account connection</h3>
      <dl className="binding-facts">
        <div>
          <dt>Bound account</dt>
          <dd>{binding.boundIdentity || 'Unverified'}</dd>
        </div>
        <div>
          <dt>Profile was created for</dt>
          <dd>{binding.setupIdentity}</dd>
        </div>
        <div>
          <dt>Currently signed in</dt>
          <dd>{binding.currentIdentity || 'No recorded account check'}</dd>
        </div>
        <div>
          <dt>Last verified</dt>
          <dd>{binding.lastVerifiedAt ? formatDateTime(binding.lastVerifiedAt) : 'Never'}</dd>
        </div>
        <div>
          <dt>Dispatch readiness</dt>
          <dd>
            {readiness.dispatchChecked
              ? agent.execution === 'LOCAL'
                ? 'Verified local transport'
                : 'Verified transport'
              : agent.execution === 'LOCAL'
                ? 'Local execution transport unverified'
                : 'Execution transport unverified'}
          </dd>
        </div>
      </dl>
      {binding.blockers.map(blocker => (
        <p className="muted" key={blocker}>
          {blocker}
        </p>
      ))}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!agent.removedAt && (
        <div className="button-row">
          <button type="button" className="secondary" disabled={busy} onClick={() => void run('VERIFY')}>
            {busy ? 'Checking…' : 'Verify connection'}
          </button>
          {confirming ? (
            <>
              <button type="button" className="secondary" disabled={busy} onClick={() => void run('CHANGE')}>
                Move this profile to the signed-in account
              </button>
              <button type="button" className="text-button" disabled={busy} onClick={() => setConfirming(false)}>
                Keep current binding
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setError('');
                setConfirming(true);
              }}
            >
              Change connection…
            </button>
          )}
        </div>
      )}
      {confirming && (
        <p className="muted">
          This moves {agent.name} from {binding.boundIdentity || binding.setupIdentity} to{' '}
          {binding.currentIdentity || 'the signed-in account'}. Existing assignments keep the account they were created
          under.
        </p>
      )}
    </section>
  );
}

export function ProfileEditor({ agent, onState }: { agent: Agent; onState: (s: AppState) => void }) {
  const fromAgent = () => ({
    name: agent.name,
    team: agent.team,
    role: agent.role,
    instructions: agent.instructions,
    revision: agent.revision ?? 0,
  });
  const [draft, setDraft] = useState(() => profileDrafts.get(agent.id) ?? fromAgent()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const dirty = ['name', 'team', 'role', 'instructions'].some(
    key => draft[key as keyof typeof draft] !== agent[key as keyof Agent],
  );
  const conflict = draft.revision !== (agent.revision ?? 0);
  useEffect(() => {
    if (dirty) profileDrafts.set(agent.id, draft);
    else profileDrafts.delete(agent.id);
  }, [draft, dirty, agent.id]);
  function edit(patch: Partial<typeof draft>) {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  }
  return (
    <form
      onSubmit={async e => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const { revision, ...fields } = draft;
          const state = await window.office.command({
            type: 'agent.update',
            idempotencyKey: crypto.randomUUID(),
            agentId: agent.id,
            expectedRevision: revision,
            ...fields,
          });
          onState(state);
          setDraft({ ...draft, revision: state.agents.find(a => a.id === agent.id)?.revision ?? 0 });
          setSaved(true);
          profileDrafts.delete(agent.id);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy || !!agent.removedAt}>
        <div className="profile-fields">
          <label className="field">
            Name
            <input value={draft.name} onChange={e => edit({ name: e.target.value })} required maxLength={160} />
          </label>
          <label className="field">
            Team
            <input value={draft.team} onChange={e => edit({ team: e.target.value })} required maxLength={160} />
          </label>
          <label className="field">
            Role
            <select value={draft.role} onChange={e => edit({ role: e.target.value as Role })}>
              {['DIRECTOR', 'PM_A', 'PM_B', 'PM_C', 'PM_D', 'WORKER'].map(r => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Instructions
          <textarea
            value={draft.instructions}
            onChange={e => edit({ instructions: e.target.value })}
            maxLength={12000}
          />
        </label>
        <button className="secondary" disabled={!dirty || conflict}>
          Save profile
        </button>
      </fieldset>
      <p role="status">
        {agent.removedAt
          ? 'Archived profile is read-only.'
          : conflict
            ? 'Profile changed in another view. Reload before saving.'
            : dirty
              ? 'Unsaved changes retained while this app is open.'
              : saved
                ? 'Profile saved.'
                : 'Profile is up to date.'}
      </p>
      {(conflict || dirty) && (
        <button
          type="button"
          onClick={() => {
            profileDrafts.delete(agent.id);
            setDraft(fromAgent());
            setError('');
          }}
        >
          Discard draft and reload
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

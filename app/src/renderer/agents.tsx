import { useEffect, useRef, useState } from 'react';
import { modelLabel } from './model-label';
import type {
  AgentDraft,
  AgentTicket,
  AppState,
  Connection,
  ExecutionEnvironment,
  Provider,
  Role,
  Effort,
  ToolProfile,
} from '../shared/types';
import type { LocalSessionRecord } from '../shared/local-session';
import { suggestedEfforts, PROVIDER_MODEL_SUGGESTIONS, effortIsIndependentAxis } from '../shared/effort';
import { LocalConsumption } from './activity';
import './agents.css';
import { formatDateTime, formatNumber, plural } from './format';
import { Checkbox, Empty, label } from './components';
import { History, RefreshCw } from 'lucide-react';
const roleNames: Record<Role, string> = {
  DIRECTOR: 'Director',
  PM_A: 'PM · Implementation',
  PM_B: 'PM · Verification',
  PM_C: 'PM · Findings',
  PM_D: 'PM · Falsification',
  WORKER: 'Worker',
};
const executionNames: Record<ExecutionEnvironment, string> = {
  HOSTED_SETUP_REQUIRED: 'Hosted (setup required)',
  LOCAL: 'Local (this machine)',
};
const toolProfileNames: Record<ToolProfile, string> = { STANDARD: 'Standard', CODE_NAV: 'Code navigation' };
const localRouteNames: Record<NonNullable<AgentDraft['localRoute']>, string> = {
  LOCAL_MAILBOX: 'Manual packet — you launch the session',
  LOCAL_CLI_EXEC: 'Office-spawned CLI — unattended run',
  LOCAL_ACP: 'Devin ACP — unattended run',
};
let setupDraft: AgentDraft | undefined;
export function AgentSetup({ onAdded }: { onAdded: (state: AppState, execution?: ExecutionEnvironment) => void }) {
  // Claude is the primary provider for new work. Existing profiles keep the provider they were created with.
  const [draft, setDraft] = useState<AgentDraft>(
    setupDraft ?? {
      name: '',
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      effort: 'default',
      execution: 'LOCAL',
      localRoute: 'LOCAL_CLI_EXEC',
      toolProfile: 'STANDARD',
    },
  );
  const [ticket, setTicket] = useState<AgentTicket | null>(null),
    [connection, setConnection] = useState<Connection | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const spawnsLocally =
    (draft.provider === 'devin' ? 'LOCAL' : draft.execution) === 'LOCAL' &&
    (draft.localRoute ?? 'LOCAL_CLI_EXEC') !== 'LOCAL_MAILBOX';
  const operation = useRef(0);
  useEffect(
    () => () => {
      operation.current++;
      void window.office.cancelAgent();
    },
    [],
  );
  function edit(patch: Partial<AgentDraft>) {
    setTicket(null);
    setupDraft = { ...draft, ...patch };
    setDraft(setupDraft);
  }
  async function add() {
    const turn = ++operation.current;
    setBusy(true);
    setError('');
    try {
      const result = await window.office.connectAgent(draft);
      if (turn === operation.current) {
        setTicket(result);
        setConnection(result.connection);
      }
    } catch (e) {
      if (turn === operation.current) setError(String((e as Error).message));
    } finally {
      if (turn === operation.current) setBusy(false);
    }
  }
  async function cancel() {
    operation.current++;
    setBusy(false);
    setTicket(null);
    await window.office.cancelAgent();
  }
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      if (ticket) {
        const execution = ticket.draft.execution;
        const state = await window.office.confirmAgent(ticket.id);
        setupDraft = undefined;
        onAdded(state, execution);
      }
    } catch (e) {
      setError((e as Error).message);
      setTicket(null);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setConnection(await window.office.connectionStatus(draft.provider));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // The provider change below discards the current turn, so a slow check for a previous provider can never overwrite a newer one.
  async function hydrate(provider: Provider) {
    const turn = ++operation.current;
    setError('');
    try {
      const value = await window.office.connectionStatus(provider);
      if (turn === operation.current) setConnection(value);
    } catch (e) {
      if (turn === operation.current) setError((e as Error).message);
    }
  }
  const modelOptions = connection?.models.length ? connection.models : PROVIDER_MODEL_SUGGESTIONS[draft.provider];
  const independentEffort = effortIsIndependentAxis(draft.provider),
    selectedModel = connection?.models.find(m => m.id === draft.model),
    catalogEfforts = selectedModel?.efforts;
  // Claude's effort axis is session-level and published by the installed CLI itself — the
  // signed-in catalog only carries per-model levels for OpenAI, so it never supplies claude's.
  const effortLevels =
    draft.provider === 'claude'
      ? suggestedEfforts(draft.provider, draft.model)
      : (catalogEfforts ?? suggestedEfforts(draft.provider, draft.model));
  // Devin splits the picker into family (model) and variant (effort) axes when the catalog carries family data.
  const devinCatalog = draft.provider === 'devin' && connection?.models.some(m => m.family) ? connection.models : [];
  const devinFamilies = devinCatalog
    .filter(m => !m.family)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const devinFamilyId = devinCatalog.length
    ? (devinCatalog.find(m => m.id === draft.model)?.family ?? draft.model)
    : '';
  const devinFamily = devinCatalog.find(m => m.id === devinFamilyId);
  const devinVariants = devinFamilyId ? devinCatalog.filter(m => m.family === devinFamilyId) : [];
  // A variant's qualifier: its name minus the family name, else its uid suffix after the family id, else its name.
  const variantLabel = (variant: Connection['models'][number]): string => {
    if (devinFamily && variant.name.startsWith(devinFamily.name + ' '))
      return variant.name.slice(devinFamily.name.length + 1);
    if (devinFamily && variant.id.startsWith(devinFamily.id + '-'))
      return variant.id
        .slice(devinFamily.id.length + 1)
        .split('-')
        .map(word => (word ? word[0].toUpperCase() + word.slice(1) : word))
        .join(' ');
    return variant.name;
  };
  return (
    <section className="settings-card agent-setup">
      <div className="section-title">
        <div>
          <h2>A new member of your team</h2>
          <p>
            Subscription sign-in stays with the official provider tool. Add verifies the account; Confirm creates the
            agent.
          </p>
        </div>
      </div>
      <ol className="setup-stepper" aria-label="Add agent steps">
        <li aria-current={!ticket && !busy ? 'step' : undefined}>1 · Profile &amp; permissions</li>
        <li aria-current={busy ? 'step' : undefined}>2 · Verify account</li>
        <li aria-current={ticket ? 'step' : undefined}>3 · Review &amp; confirm</li>
      </ol>
      <form
        onSubmit={e => {
          e.preventDefault();
          void (ticket ? confirm() : add());
        }}
      >
        <fieldset disabled={busy || !!ticket} className="agent-fields">
          <label className="field">
            Agent name
            <input required maxLength={160} value={draft.name} onChange={e => edit({ name: e.target.value })} />
          </label>
          <label className="field">
            Provider
            <select
              aria-label="Provider"
              value={draft.provider}
              onChange={e => {
                const provider = e.target.value as Provider;
                setConnection(null);
                edit({
                  provider,
                  localRoute:
                    provider !== 'devin' && draft.localRoute === 'LOCAL_ACP' ? 'LOCAL_CLI_EXEC' : draft.localRoute,
                  model:
                    provider === 'openai'
                      ? PROVIDER_MODEL_SUGGESTIONS.openai[0].id
                      : provider === 'claude'
                        ? 'opus'
                        : '',
                  execution: provider === 'devin' ? 'LOCAL' : (draft.execution ?? 'LOCAL'),
                });
                void hydrate(provider);
              }}
            >
              <option value="claude">Anthropic · Claude subscription</option>
              <option value="openai">OpenAI · ChatGPT subscription</option>
              <option value="devin">Devin · local CLI sign-in</option>
            </select>
          </label>
          <label className="field">
            Execution environment
            <select
              aria-label="Execution environment"
              disabled={draft.provider === 'devin'}
              value={draft.provider === 'devin' ? 'LOCAL' : (draft.execution ?? 'LOCAL')}
              onChange={e => edit({ execution: e.target.value as ExecutionEnvironment })}
            >
              {draft.provider !== 'devin' && (
                <option value="HOSTED_SETUP_REQUIRED">Provider-hosted (setup required)</option>
              )}
              <option value="LOCAL">This machine (local CLI)</option>
            </select>
            <small>
              {(draft.provider === 'devin' ? 'LOCAL' : draft.execution) === 'LOCAL'
                ? 'Sessions run on this machine through the official provider CLI. Local execution is not provider-hosted, isolated or independently attested.'
                : 'Provider-hosted execution still requires transport setup; nothing hosted is verified yet.'}
            </small>
          </label>
          {(draft.provider === 'devin' ? 'LOCAL' : draft.execution) === 'LOCAL' && (
            <label className="field">
              Local transport
              <select
                aria-label="Local transport"
                value={draft.localRoute ?? 'LOCAL_CLI_EXEC'}
                onChange={e => edit({ localRoute: e.target.value as AgentDraft['localRoute'] })}
              >
                <option value="LOCAL_MAILBOX">Manual packet — you launch the session</option>
                <option value="LOCAL_CLI_EXEC">Office-spawned CLI — unattended run</option>
                {draft.provider === 'devin' && <option value="LOCAL_ACP">Devin ACP — unattended run</option>}
              </select>
              <small>
                {(draft.localRoute ?? 'LOCAL_CLI_EXEC') !== 'LOCAL_MAILBOX'
                  ? 'The office spawns the provider CLI on this machine and owns the process (cancel kills it); not provider-hosted, isolated or independently attested.'
                  : 'The office writes the packet; you run the session yourself in the official tool. Not provider-hosted, isolated or independently attested.'}
              </small>
            </label>
          )}
          {spawnsLocally && (
            <div className="field consent">
              <Checkbox checked={riskAccepted} onChange={setRiskAccepted}>
                I understand that this agent runs unattended on this computer with my Windows account's permissions. It
                can read, change and delete files my account can reach, and run programs. Files it reads are not a
                security boundary.
              </Checkbox>
            </div>
          )}
          <label className="field">
            Model
            <select
              aria-label="Model"
              disabled={!(devinCatalog.length ? devinFamilies.length : modelOptions.length)}
              value={devinCatalog.length ? devinFamilyId : draft.model}
              onChange={e => edit({ model: e.target.value })}
            >
              {(devinCatalog.length ? devinFamilies : modelOptions).map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              {(() => {
                const shown = devinCatalog.length ? devinFamilyId : draft.model;
                return (
                  shown &&
                  !(devinCatalog.length ? devinFamilies : modelOptions).some(m => m.id === shown) && (
                    <option value={shown}>{shown}</option>
                  )
                );
              })()}
            </select>
            <small>
              {draft.provider === 'devin'
                ? modelOptions.length
                  ? 'Catalog read from the installed Devin CLI. Model entitlement is not verified.'
                  : connection?.connected
                    ? 'The signed-in Devin CLI returned no models — catalog unavailable. Refresh models & account to retry.'
                    : 'Sign in to the Devin CLI to load the model catalog.'
                : draft.provider === 'openai'
                  ? connection?.models.length
                    ? 'Options read from the signed-in Codex model catalog.'
                    : connection?.connected
                      ? 'The signed-in account returned no model catalog — the provisional list is shown instead.'
                      : 'Provisional until checked against your signed-in model catalog.'
                  : 'Claude Code aliases or pinned model IDs. Account login does not verify model entitlement.'}
            </small>
          </label>
          <label className="field">
            Tool profile
            <select
              aria-label="Tool profile"
              value={draft.toolProfile ?? 'STANDARD'}
              onChange={e => edit({ toolProfile: e.target.value as ToolProfile })}
            >
              <option value="STANDARD">Standard</option>
              <option value="CODE_NAV">Code navigation</option>
            </select>
            <small>
              The tool surface this profile is configured for. It declares intent only; capability comes from recorded
              evidence.
            </small>
          </label>
          <label className="field">
            Section / team
            <input required maxLength={160} value={draft.team} onChange={e => edit({ team: e.target.value })} />
          </label>
          <label className="field">
            Role
            <select aria-label="Role" value={draft.role} onChange={e => edit({ role: e.target.value as Role })}>
              {Object.entries(roleNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Effort level
            <select
              aria-label="Initial effort level"
              value={devinCatalog.length ? draft.model : (draft.effort ?? 'default')}
              onChange={e => {
                if (draft.provider === 'devin' && devinCatalog.length) {
                  edit({ model: e.target.value, effort: 'default' });
                } else edit({ effort: e.target.value as Effort });
              }}
            >
              {devinCatalog.length ? (
                <>
                  <option value={devinFamilyId}>Provider default</option>
                  {devinVariants.map(variant => (
                    <option key={variant.id} value={variant.id}>
                      {variantLabel(variant)}
                    </option>
                  ))}
                  {draft.model !== devinFamilyId && !devinVariants.some(variant => variant.id === draft.model) && (
                    <option value={draft.model}>{draft.model}</option>
                  )}
                </>
              ) : (
                [...new Set([draft.effort ?? 'default', ...(independentEffort ? effortLevels : [])])].map(level => (
                  <option value={level} key={level}>
                    {level === 'default' ? 'Provider default' : level}
                  </option>
                ))
              )}
            </select>
            <small>
              {draft.provider === 'devin'
                ? devinCatalog.length
                  ? 'Devin encodes effort in the model variant: the model picks the family and this pick stages the matching variant. The office does not verify which variant a session applied unless the session result.json reports appliedModel/appliedEffort.'
                  : 'Devin encodes effort in the model variant; the catalog carries no family data, so only Provider default is offered.'
                : draft.provider === 'claude'
                  ? 'Session-level effort levels published by the installed Claude Code CLI — whether the selected model honors a level is not verified; the session result reports what applied. The saved preference is revalidated before confirmation.'
                  : catalogEfforts
                    ? 'Effort options read from the signed-in model catalog; the saved preference is revalidated before confirmation.'
                    : 'No effort levels are published for this provider and model, so only Provider default is offered rather than an invented scale. Saved preference is revalidated before confirmation.'}
            </small>
          </label>
          <label className="field">
            Instructions
            <textarea
              rows={3}
              maxLength={12000}
              value={draft.instructions}
              onChange={e => edit({ instructions: e.target.value })}
            />
          </label>
        </fieldset>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {connection && connection.note && (!connection.connected || !connection.account) && (
          <p className="muted" role="status">
            {connection.note}
          </p>
        )}
        {busy && (
          <p role="status">
            Checking the subscription connection… Complete sign-in in the provider window if it opens.
          </p>
        )}
        {ticket && (
          <div className="connection-confirm" role="status">
            <h3>Account connected · ready to confirm</h3>
            <p>
              {ticket.connection.account} · {modelLabel(ticket.draft)}
            </p>
            <p>
              {ticket.draft.team} / {roleNames[ticket.draft.role]}
            </p>
            <p>
              {executionNames[ticket.draft.execution ?? 'HOSTED_SETUP_REQUIRED']}
              {ticket.draft.execution === 'LOCAL'
                ? ` · ${localRouteNames[ticket.draft.localRoute ?? 'LOCAL_MAILBOX']}`
                : ''}{' '}
              · tool profile {toolProfileNames[ticket.draft.toolProfile ?? 'STANDARD']}
            </p>
            <p>{ticket.connection.note}</p>
            <small>
              {ticket.draft.execution === 'LOCAL'
                ? 'Runs on this machine through the signed-in official CLI. Launch remains subject to the recorded capability checks; local execution is not independently attested.'
                : 'Provider-hosted research execution still requires setup. This agent will be added with research dispatch blocked.'}
            </small>
          </div>
        )}
        <div className="button-row setup-actions">
          {(busy || ticket) && (
            <button type="button" className="secondary" onClick={() => void cancel()}>
              {busy ? 'Cancel sign-in' : 'Edit details'}
            </button>
          )}
          <button type="button" className="secondary" disabled={busy || !!ticket} onClick={() => void refresh()}>
            Refresh models &amp; account
          </button>
          <button
            className="primary"
            disabled={busy || (!ticket && !draft.model.trim()) || (!ticket && spawnsLocally && !riskAccepted)}
          >
            {ticket ? 'Confirm' : 'Add'}
          </button>
        </div>
      </form>
      <div className="inline-note">
        No limit on the number of agents or members of a role. Agents using the same account share its allowance.
      </div>
      <div className="button-row">
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void window.office.selectProviderTool(draft.provider).catch(e => setError(e.message))}
        >
          Locate sign-in tool
        </button>
      </div>
      <p className="muted">
        Requires the official provider CLI — codex.exe, claude.exe or devin.exe — installed on this device.
        Authentication and usage checks run locally; research code does not.
      </p>
    </section>
  );
}
export function SubscriptionUsage({ state }: { state: AppState }) {
  const providers: Provider[] = ['openai', 'claude', 'devin'];
  const [connections, setConnections] = useState<Partial<Record<Provider, Connection>>>({}),
    [errors, setErrors] = useState<Partial<Record<Provider, string>>>({}),
    [busy, setBusy] = useState<Partial<Record<Provider, boolean>>>({});
  async function refresh(provider: Provider) {
    setBusy(b => ({ ...b, [provider]: true }));
    setErrors(e => ({ ...e, [provider]: '' }));
    try {
      const value = await window.office.connectionStatus(provider);
      setConnections(c => ({ ...c, [provider]: value }));
    } catch (e) {
      setErrors(old => ({ ...old, [provider]: (e as Error).message }));
      setConnections(c => ({ ...c, [provider]: undefined }));
    } finally {
      setBusy(b => ({ ...b, [provider]: false }));
    }
  }
  const anyChecking = providers.some(provider => busy[provider]);
  return (
    <>
      <div className="inline-note">
        Subscription allowances belong to accounts, not individual agents. No API billing or automatic paid fallback.
        Usage is refreshed only when requested.
      </div>
      <div className="section-toolbar">
        <span className="muted">Run the same per-card check for every provider.</span>
        <button className="secondary" disabled={anyChecking} onClick={() => void Promise.all(providers.map(refresh))}>
          {anyChecking ? 'Checking…' : 'Refresh all'}
        </button>
      </div>
      {providers.map(provider => {
        const c = connections[provider];
        const matching = state.agents.filter(
          a => !a.removedAt && a.provider === provider && (!c?.connected || a.account === c.account),
        ).length;
        return (
          <section className="settings-card usage-card" key={provider}>
            <div className="section-toolbar">
              <h2>{provider === 'openai' ? 'ChatGPT / Codex' : provider === 'devin' ? 'Devin' : 'Claude'}</h2>
              <button className="secondary" disabled={busy[provider]} onClick={() => void refresh(provider)}>
                {busy[provider] ? 'Checking…' : 'Refresh usage'}
              </button>
            </div>
            <p>
              {c?.connected ? c.account || 'Signed in — account unidentified' : 'Account not checked'} · {matching}{' '}
              active profile{matching === 1 ? '' : 's'}
              {c?.connected ? ' with matching setup account' : ''}
            </p>
            {c?.connected &&
              c.account &&
              state.agents.some(a => !a.removedAt && a.provider === provider && a.account !== c.account) && (
                <p className="blocker">
                  Some profiles were verified under a different account. Their connection is not current.
                </p>
              )}
            {c?.connected && !c.account && (
              <p className="blocker">
                The official tool reported sign-in but did not name the account. Profiles cannot be verified against an
                unidentified session — re-check, or sign in through the tool.
              </p>
            )}
            {c?.windows.length ? (
              <div className="metric-grid">
                {c.windows.map((w, i) => (
                  <div className="metric" key={i}>
                    <span>{w.label}</span>
                    <strong>{w.remainingPercent.toFixed(0)}% remaining</strong>
                    <progress max="100" value={w.remainingPercent} />
                    <small>
                      Resets {formatDateTime(w.resetsAt * 1000)} ·{' '}
                      {Math.max(0, Math.ceil((w.resetsAt * 1000 - Date.now()) / 3600000))}h remaining
                    </small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="usage-unavailable">
                <span className="muted">{c ? 'Usage windows unavailable from this tool' : 'Not checked yet'}</span>
              </div>
            )}
            <p>
              {errors[provider] ||
                c?.note ||
                'Refresh to check the official provider tool. Missing values are never estimated.'}
            </p>
            {c && <small>Checked {formatDateTime(c.checkedAt)}</small>}
            {provider !== 'devin' && (
              <div>
                <button
                  className="text-button"
                  onClick={() =>
                    void window.office
                      .openProviderUsage(provider)
                      .catch(e => setErrors(old => ({ ...old, [provider]: e.message })))
                  }
                >
                  Open official usage page
                </button>
              </div>
            )}
            {provider === 'devin' && (
              <p className="muted">
                The Devin CLI reports no usage windows to this application; local-session limits are outside this check.
              </p>
            )}
          </section>
        );
      })}
      <LocalConsumption />
      <SessionHistory />
    </>
  );
}

const SESSION_HISTORY_PAGE = 25;
/** The provenance line every session-history row carries — these are the office's own ledger records. */
const SESSION_PROVENANCE_TITLE = "Office-recorded — a row from the office's own session ledger, not a provider report.";

/**
 * Sessions newest-first by the record's creation time; the id breaks ties so pagination stays
 * stable. The store returns collection order — sorting here is a view concern, never a rewrite.
 */
export function sessionHistoryRows(entries: LocalSessionRecord[]): LocalSessionRecord[] {
  return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** The displayed packet-hash chip: the first eight hex characters, or '—' when none is recorded. */
export function shortPacketHash(hash: string | null): string {
  return hash ? hash.slice(0, 8) : '—';
}

/** Recorded lifecycle words ('reconcile required'), matching the app's lowercase status voice. */
export function sessionLifecycleLabel(lifecycle: LocalSessionRecord['lifecycle']): string {
  return lifecycle.replaceAll('_', ' ').toLowerCase();
}

export interface SessionHistoryCells {
  recorded: string;
  provider: string;
  lifecycle: string;
  surface: string;
  layout: string;
  packetHash: string;
  providerSessionId: string;
  provenance: 'office-observed';
}
/**
 * The table cells for one recorded session. Every value comes straight from the record — no token
 * totals (LocalSessionRecord carries none) and no provider-usage claims; '—' marks absent fields.
 */
export function sessionRowCells(record: LocalSessionRecord): SessionHistoryCells {
  return {
    recorded: formatDateTime(record.createdAt),
    provider: record.provider,
    lifecycle: sessionLifecycleLabel(record.lifecycle),
    surface: label(record.surface),
    layout: label(record.layout),
    packetHash: shortPacketHash(record.packetHash),
    providerSessionId: record.providerSessionId ?? '—',
    provenance: 'office-observed',
  };
}

/**
 * Office-recorded local sessions, paged through office:local-sessions. These rows are the office's
 * own ledger — they say nothing about provider-side usage, tokens, or remaining allowance.
 */
function SessionHistory() {
  const request = useRef(0);
  const [entries, setEntries] = useState<LocalSessionRecord[]>([]),
    [total, setTotal] = useState(0),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load(offset: number) {
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      const page = await window.office.localSessions({ limit: SESSION_HISTORY_PAGE, offset });
      if (ticket !== request.current) return;
      setEntries(prev =>
        offset === 0 ? page.entries : [...new Map([...prev, ...page.entries].map(row => [row.id, row])).values()],
      );
      setTotal(page.total);
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    } finally {
      if (ticket === request.current) {
        setBusy(false);
        setLoaded(true);
      }
    }
  }
  useEffect(() => {
    void load(0);
    return () => {
      request.current++;
    };
  }, []);
  const rows = sessionHistoryRows(entries);
  return (
    <section className="settings-card session-history">
      <div className="section-title">
        <div>
          <h2>Session history</h2>
          <p>Recorded office sessions — provider-reported usage is shown separately above.</p>
        </div>
        <button
          className="icon-button"
          title="Refresh session history"
          aria-label="Refresh session history"
          disabled={busy}
          onClick={() => void load(0)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!loaded && !error ? (
        <p className="muted">Reading recorded sessions…</p>
      ) : rows.length === 0 && !error ? (
        <Empty
          icon={History}
          title="No sessions recorded yet"
          description="The office writes a record here each time it prepares a local session packet; none exist on this machine."
        />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recorded</th>
                  <th>Provider</th>
                  <th>Lifecycle</th>
                  <th>Surface</th>
                  <th>Layout</th>
                  <th>Packet hash</th>
                  <th>Provider session</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(record => {
                  const cells = sessionRowCells(record);
                  return (
                    <tr key={record.id}>
                      <td>
                        <time dateTime={record.createdAt}>{cells.recorded}</time>
                      </td>
                      <td>{cells.provider}</td>
                      <td>
                        {cells.lifecycle}{' '}
                        <small className="prov-chip" data-evidence={cells.provenance} title={SESSION_PROVENANCE_TITLE}>
                          {cells.provenance}
                        </small>
                      </td>
                      <td>{cells.surface}</td>
                      <td>{cells.layout}</td>
                      <td>
                        {record.packetHash ? (
                          <code className="session-hash" title={record.packetHash}>
                            {cells.packetHash}
                          </code>
                        ) : (
                          <span className="muted" title="No packet hash recorded">
                            —
                          </span>
                        )}
                      </td>
                      <td>
                        {record.providerSessionId ? (
                          <code title={record.providerSessionId}>{cells.providerSessionId}</code>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="section-toolbar">
            <span className="muted">
              {formatNumber(rows.length)} of {plural(total, 'session')} recorded
            </span>
            {entries.length < total && (
              <button className="secondary" disabled={busy} onClick={() => void load(entries.length)}>
                {busy ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

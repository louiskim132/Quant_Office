import { useEffect, useRef, useState } from 'react';
import type {
  AgentDraft,
  AgentTicket,
  AppState,
  Connection,
  ExecutionEnvironment,
  Provider,
  ReadinessActions,
  Role,
  Effort,
  ToolProfile,
} from '../shared/types';
import { suggestedEfforts, PROVIDER_MODEL_SUGGESTIONS, effortIsIndependentAxis } from '../shared/effort';
import { providerReadiness, currentConnection } from '../shared/readiness';
import { LocalConsumption } from './activity';
import { TRANSPORT_PROBE_CONTAINMENT } from '../shared/transport';
import './agents.css';
import { formatDateTime } from './format';
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
    (draft.localRoute ?? 'LOCAL_CLI_EXEC') === 'LOCAL_CLI_EXEC';
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
              value={draft.provider}
              onChange={e => {
                const provider = e.target.value as Provider;
                setConnection(null);
                edit({
                  provider,
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
              </select>
              <small>
                {(draft.localRoute ?? 'LOCAL_CLI_EXEC') === 'LOCAL_CLI_EXEC'
                  ? 'The office spawns the provider CLI on this machine and owns the process (cancel kills it); not provider-hosted, isolated or independently attested.'
                  : 'The office writes the packet; you run the session yourself in the official tool. Not provider-hosted, isolated or independently attested.'}
              </small>
            </label>
          )}
          {spawnsLocally && (
            <label className="field consent">
              <span>
                <input type="checkbox" checked={riskAccepted} onChange={e => setRiskAccepted(e.target.checked)} /> I
                understand that this agent runs unattended on this computer with my Windows account's permissions. It
                can read, change and delete files my account can reach, and run programs. Files it reads are not a
                security boundary.
              </span>
            </label>
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
              {ticket.connection.account} · {ticket.draft.model} · effort {ticket.draft.effort ?? 'default'}
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
                ? 'Runs on this machine through the official CLI. Not provider-hosted, isolated or independently attested; no local transport has been exercised, so dispatch stays blocked.'
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
  return (
    <>
      <div className="inline-note">
        Subscription allowances belong to accounts, not individual agents. No API billing or automatic paid fallback.
        Usage is refreshed only when requested.
      </div>
      {(['openai', 'claude', 'devin'] as Provider[]).map(provider => {
        const c = connections[provider];
        return (
          <section className="settings-card usage-card" key={provider}>
            <div className="section-toolbar">
              <h2>{provider === 'openai' ? 'ChatGPT / Codex' : provider === 'devin' ? 'Devin' : 'Claude'}</h2>
              <button className="secondary" disabled={busy[provider]} onClick={() => void refresh(provider)}>
                {busy[provider] ? 'Checking…' : 'Refresh usage'}
              </button>
            </div>
            <p>
              {c?.connected ? c.account || 'Signed in — account unidentified' : 'Account not checked'} ·{' '}
              {
                state.agents.filter(
                  a => !a.removedAt && a.provider === provider && (!c?.connected || a.account === c.account),
                ).length
              }{' '}
              active profiles{c?.connected ? ' with matching setup account' : ' (account not checked)'}
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
                    <small>Resets {formatDateTime(w.resetsAt * 1000)}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="usage-unavailable">
                <strong>5 hour: Unavailable</strong>
                <strong>Weekly: Unavailable</strong>
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
    </>
  );
}

const providerNames: Record<Provider, string> = {
  claude: 'Anthropic · Claude subscription',
  openai: 'OpenAI · ChatGPT subscription',
  devin: 'Devin · local CLI sign-in',
};
const actionNames: [keyof ReadinessActions, string][] = [
  ['prepare', 'Prepare request'],
  ['handoff', 'Official terminal handoff'],
  ['automaticStart', 'Automatic start'],
  ['observe', 'Observe job'],
  ['requestCancellation', 'Request cancellation'],
  ['duplicate', 'Duplicate'],
  ['viewTerminalHistory', 'View handoff history'],
];
/**
 * Readiness comes only from persisted observations. A live check that could not be recorded is shown
 * as exactly that, and never changes what the office is allowed to do.
 */
export function ProviderConnections({ state }: { state: AppState }) {
  const [busy, setBusy] = useState<Partial<Record<Provider, 'check' | 'signin'>>>({}),
    [errors, setErrors] = useState<Partial<Record<Provider, string>>>({}),
    [live, setLive] = useState<Partial<Record<Provider, Connection>>>({}),
    // The auth mode a key save/remove established in this session — it outranks a stale recorded
    // observation until the next provider check records the new context.
    [authMode, setAuthMode] = useState<Partial<Record<Provider, 'subscription' | 'api-key'>>>({});
  const applyConnection = (provider: Provider, connection: Connection) => {
    setLive(l => ({ ...l, [provider]: connection }));
    if (connection.authMode) setAuthMode(a => ({ ...a, [provider]: connection.authMode }));
  };
  // A silent re-check for a recorded api-key provider: the check spawns nothing in api-key mode and
  // returns keySavedAt, and it corrects the card if the key file was removed outside the app.
  async function refresh(provider: Provider) {
    try {
      applyConnection(provider, await window.office.connectionStatus(provider));
    } catch {
      /* a failed refresh leaves the recorded state standing — it never masks as verified */
    }
  }
  // Saved-key presence is the auth mode — it is probed once per provider per mount so a key saved
  // just before a shutdown (before any observation could record its context) still renders api-key
  // state on the next launch. A stale resolve can never re-enable a mode this session reverted.
  const probed = useRef<Provider[]>([]);
  useEffect(() => {
    for (const provider of ['claude', 'openai', 'devin'] as Provider[]) {
      if (!probed.current.includes(provider)) {
        probed.current.push(provider);
        void window.office
          .providerKeyState(provider)
          .then(saved => {
            if (!saved.saved) return;
            setAuthMode(a => (a[provider] ? a : { ...a, [provider]: 'api-key' }));
            void refresh(provider);
          })
          .catch(() => {});
      }
      if (!live[provider] && currentConnection(state, provider)?.credentialContext === 'api-key-local')
        void refresh(provider);
    }
  });
  async function check(provider: Provider) {
    setBusy(b => ({ ...b, [provider]: 'check' }));
    setErrors(e => ({ ...e, [provider]: '' }));
    try {
      applyConnection(provider, await window.office.connectionStatus(provider));
    } catch (e) {
      setErrors(old => ({ ...old, [provider]: (e as Error).message }));
    } finally {
      setBusy(b => ({ ...b, [provider]: undefined }));
    }
  }
  // Sign-in runs the provider's own login (browser flow or official terminal) in the main process and
  // is re-observed and recorded there; the card reflects the returned connection like a check does.
  async function signIn(provider: Provider) {
    setBusy(b => ({ ...b, [provider]: 'signin' }));
    setErrors(e => ({ ...e, [provider]: '' }));
    try {
      applyConnection(provider, await window.office.loginProvider(provider));
    } catch (e) {
      setErrors(old => ({ ...old, [provider]: (e as Error).message }));
    } finally {
      setBusy(b => ({ ...b, [provider]: undefined }));
    }
  }
  async function removeKey(provider: Provider) {
    setErrors(e => ({ ...e, [provider]: '' }));
    try {
      await window.office.removeProviderApiKey(provider);
      // The key is gone — subscription mode again. Re-checking the account runs the real CLI probe.
      setAuthMode(a => ({ ...a, [provider]: 'subscription' }));
      await check(provider);
    } catch (e) {
      setErrors(old => ({ ...old, [provider]: (e as Error).message }));
    }
  }
  return (
    <div className="settings-card">
      <h2>Connections</h2>
      <p className="muted">
        Every check is recorded with the exact official tool version that produced it. Only an operation the office
        actually exercised counts as verified; documentation and sign-in never make work runnable.
      </p>
      {(['claude', 'openai', 'devin'] as Provider[]).map(provider => {
        const readiness = providerReadiness(state, provider, { execution: 'LOCAL' });
        const snapshot = state.capabilities?.filter(c => c.provider === provider).at(-1);
        const checked = live[provider]?.checkedAt;
        const recorded = currentConnection(state, provider);
        // Presence of a saved key is the mode (LR-15): the live check's authMode wins, then this
        // session's save/remove, then the last recorded observation's credential context.
        const apiKeyMode =
          (authMode[provider] ??
            live[provider]?.authMode ??
            (recorded?.credentialContext === 'api-key-local' ? 'api-key' : 'subscription')) === 'api-key';
        return (
          <div className="setting-row connection-row" key={provider}>
            <div>
              <strong>
                {providerNames[provider]}
                {provider === 'claude' && <span className="quiet-badge"> Primary</span>}
              </strong>
              <p>
                {readiness.identity
                  ? `${readiness.identity} · last recorded observation ${formatDateTime(readiness.lastObservedAt)}`
                  : readiness.lastObservedAt
                    ? `Checked ${formatDateTime(readiness.lastObservedAt)} — ${snapshot?.operations.find(item => item.operation === 'ACCOUNT_STATUS')?.detail ?? 'no signed-in subscription was reported.'}`
                    : 'No account check recorded yet.'}
              </p>
              {checked && checked !== readiness.lastObservedAt && (
                <p className="muted">
                  Last live check {formatDateTime(checked)} was not persisted as a new observation. It cannot authorize
                  anything.
                </p>
              )}
              <p className="provider-summary">
                {apiKeyMode ? (
                  <>
                    <b>API key saved</b> — the provider was not contacted. <b>Provider-hosted:</b> not available in this
                    version.
                  </>
                ) : (
                  <>
                    <b>This computer (local CLI):</b>{' '}
                    {readiness.signedIn
                      ? readiness.ready
                        ? 'ready.'
                        : `signed in; ${readiness.blockers[0] ?? 'not yet verified by a run.'}`
                      : 'not signed in — sign in with the provider CLI, then Refresh.'}{' '}
                    <b>Provider-hosted:</b> not available in this version.
                  </>
                )}
              </p>
              <details>
                <summary>Technical details</summary>
                {apiKeyMode && (
                  <>
                    <p className="muted">
                      {live[provider]?.keySavedAt ? `Saved ${formatDateTime(live[provider].keySavedAt!)} · ` : ''}stored
                      encrypted with Windows DPAPI · the provider was not contacted.
                    </p>
                    <p>
                      <button
                        className="secondary"
                        disabled={busy[provider] === 'check'}
                        onClick={() => void removeKey(provider)}
                      >
                        Remove key
                      </button>
                    </p>
                  </>
                )}
                <div className="badge-groups">
                  <div className="badge-group">
                    <span className="mini-label">Account</span>
                    <ul className="readiness-list">
                      {(
                        [
                          ['Signed in', readiness.signedIn],
                          ['Account fresh', readiness.accountFresh],
                          ['Model checked', readiness.modelChecked],
                          ['Dispatch checked', readiness.dispatchChecked],
                          ['Ready', readiness.ready],
                        ] as [string, boolean][]
                      ).map(([label, value]) => (
                        <li key={label} data-state={value ? 'yes' : 'no'}>
                          {label}: {value ? 'Yes' : 'No'}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="badge-group">
                    <span className="mini-label">Operations</span>
                    <ul className="readiness-list">
                      {actionNames.map(([action, label]) => (
                        <li key={action} data-state={readiness.actions[action] ? 'yes' : 'no'}>
                          {label}: {readiness.actions[action] ? 'Allowed' : 'Blocked'}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                {snapshot && (
                  <p className="muted">
                    Tool {snapshot.toolVersion} · transport {snapshot.transport.toLowerCase().replaceAll('_', ' ')} ·{' '}
                    {snapshot.models.length} model{snapshot.models.length === 1 ? '' : 's'} · source: {snapshot.source}
                  </p>
                )}
                {readiness.evidence.filter(item => item.level !== 'ACCOUNT_VERIFIED' || item.expired).length > 0 && (
                  <details>
                    <summary>Capability evidence</summary>
                    <ul className="evidence-list">
                      {readiness.evidence.map(item => (
                        <li key={item.operation}>
                          <b>{item.operation.toLowerCase().replaceAll('_', ' ')}</b>:{' '}
                          {item.level.toLowerCase().replaceAll('_', ' ')} · {item.evidence.toLowerCase()}
                          {item.model ? ` · model ${item.model}` : ''}
                          {item.expired ? ' · expired' : ''} — {item.detail} <i>({item.source})</i>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {readiness.blockers.map(blocker => (
                  <p className="muted" key={blocker}>
                    {blocker}
                  </p>
                ))}
              </details>
              {errors[provider] && (
                <p className="notice error" role="alert">
                  {errors[provider]}
                </p>
              )}
              {provider === 'claude' && TRANSPORT_PROBE_CONTAINMENT.contained && (
                <p className="muted">{TRANSPORT_PROBE_CONTAINMENT.status}</p>
              )}
            </div>
            <div className="connection-actions">
              <div className="button-row">
                <button className="secondary" disabled={!!busy[provider]} onClick={() => void check(provider)}>
                  {busy[provider] === 'check' ? 'Checking…' : 'Check account'}
                </button>
                {!readiness.signedIn && busy[provider] !== 'signin' && (
                  <button className="secondary" disabled={!!busy[provider]} onClick={() => void signIn(provider)}>
                    Sign in
                  </button>
                )}
                {busy[provider] === 'signin' && (
                  <button className="secondary" onClick={() => void window.office.cancelAgent()}>
                    Cancel sign-in
                  </button>
                )}
                {provider === 'claude' && (
                  <button className="text-button" disabled title={TRANSPORT_PROBE_CONTAINMENT.status}>
                    Verify cloud transport…
                  </button>
                )}
              </div>
              {!apiKeyMode && (
                <ApiKeyEntry
                  provider={provider}
                  onSaved={() => {
                    setAuthMode(a => ({ ...a, [provider]: 'api-key' }));
                    void refresh(provider);
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The subscription-mode entry to api-key mode (LR-15): a collapsed disclosure with the billing
 * sentence, a password input and Save/Cancel. The key leaves React state the instant Save fires —
 * it is sent over the office bridge to the encrypted store and never rendered, logged or kept.
 */
function ApiKeyEntry({ provider, onSaved }: { provider: Provider; onSaved: () => void }) {
  const [open, setOpen] = useState(false),
    [key, setKey] = useState(''),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  async function save() {
    const value = key.trim();
    setKey('');
    setSaving(true);
    setError('');
    try {
      await window.office.setProviderApiKey(provider, value);
      setOpen(false);
      onSaved();
    } catch (e) {
      // The IPC error message is the validation or save failure — it never contains key material.
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <details
      className="api-key-entry"
      open={open}
      onToggle={event => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>Use my own API key</summary>
      <p className="muted">Enter your own provider API key. Calls are billed to your account by the provider.</p>
      <input
        type="password"
        aria-label={`API key for ${providerNames[provider]}`}
        autoComplete="off"
        value={key}
        onChange={event => setKey(event.target.value)}
      />
      <div className="button-row">
        <button className="secondary" disabled={saving || !key.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
        <button className="text-button" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

/**
 * The LR-16 agent isolation card on the provider-settings surface. Configured state comes only
 * from the main process (the saved credential's presence — never its content). Setup runs the
 * consented elevated step; removal stops isolated launches but deliberately leaves the Windows
 * account itself in place.
 */
export function AgentIsolation() {
  const [configured, setConfigured] = useState<boolean | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let stale = false;
    void window.office
      .agentIsolationStatus()
      .then(status => {
        if (!stale) setConfigured(status.configured);
      })
      .catch(() => {
        if (!stale) setConfigured(false);
      });
    return () => {
      stale = true;
    };
  }, []);
  async function setup() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.office.agentIsolationSetup();
      setConfigured(true);
      setNotice('Agent isolation is set up. New agent launches now run as the QRO-Agent account.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.office.agentIsolationVerify();
      const failed = Object.entries(result.checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      if (result.passed)
        setNotice(
          `Isolation check passed: all ${Object.keys(result.checks).length} checks. Evidence saved to ${result.evidencePath}`,
        );
      else setError(`Isolation check failed: ${failed.join(', ')}. Evidence saved to ${result.evidencePath}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.office.agentIsolationRemove();
      setConfigured(false);
      setNotice('Agent isolation removed. New agent launches run as your Windows account again.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-card">
      <h2>Agent isolation</h2>
      {configured === null && <p className="muted">Checking isolation status…</p>}
      {configured === false && (
        <div className="setting-row">
          <div>
            <strong>Separate Windows account</strong>
            <p>
              Agents currently run as your Windows account. Set up a separate low-privilege account so agents can only
              reach their own session folders.
            </p>
            <p className="muted">
              While isolation is on, agents authenticate with your saved API keys — subscription sign-ins stay in your
              profile.
            </p>
          </div>
          <button
            className="secondary"
            disabled={busy}
            aria-label="Set up agent isolation"
            aria-busy={busy}
            onClick={() => void setup()}
          >
            {busy ? 'Setting up…' : 'Set up agent isolation'}
          </button>
        </div>
      )}
      {configured === true && (
        <div className="setting-row">
          <div>
            <strong>Separate Windows account</strong>
            <p>Agents run as Windows user QRO-Agent with access limited to agent session folders.</p>
            <p className="muted">
              While isolation is on, agents authenticate with your saved API keys — subscription sign-ins stay in your
              profile.
            </p>
          </div>
          <div>
            <button
              className="secondary"
              disabled={busy}
              aria-label="Check agent isolation"
              aria-busy={busy}
              onClick={() => void verify()}
            >
              {busy ? 'Working…' : 'Check isolation'}
            </button>
            <button
              className="secondary"
              disabled={busy}
              aria-label="Remove agent isolation"
              aria-busy={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Removing…' : 'Remove isolation'}
            </button>
            <p className="muted">
              This stops launching agents as QRO-Agent. The Windows account itself is left in place; remove it in
              Windows settings if you want it gone.
            </p>
          </div>
        </div>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

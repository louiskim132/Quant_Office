import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  Check,
  Database,
  Info,
  Minus,
  Palette,
  Plug,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { AppInfo, AppState, Command, Connection, Provider } from '../shared/types';
import { providerReadiness, currentConnection } from '../shared/readiness';
import { TRANSPORT_PROBE_CONTAINMENT } from '../shared/transport';
import { Dot, Segmented, Switch, type Tone } from './components';
import { formatDateTime } from './format';
import { usePref } from './prefs';
import './settings.css';

type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'idempotencyKey'> : never) : never;
export type SettingsSection = 'connections' | 'isolation' | 'notifications' | 'appearance' | 'data' | 'about';

const PROVIDERS: Provider[] = ['claude', 'openai', 'devin'];
const providerCopy: Record<Provider, { name: string; plan: string; glyph: string }> = {
  claude: { name: 'Claude', plan: 'Anthropic subscription', glyph: 'C' },
  openai: { name: 'ChatGPT', plan: 'OpenAI subscription', glyph: 'G' },
  devin: { name: 'Devin', plan: 'Devin local CLI sign-in', glyph: 'D' },
};

/** The one word and tone a provider card leads with, from recorded readiness alone. */
export function connectionTone(r: { signedIn: boolean; ready: boolean; lastObservedAt: string }): {
  tone: Tone;
  word: string;
} {
  if (r.ready) return { tone: 'ok', word: 'Ready' };
  if (r.signedIn) return { tone: 'warn', word: 'Signed in · not verified' };
  if (r.lastObservedAt) return { tone: 'bad', word: 'Not signed in' };
  return { tone: 'off', word: 'Not checked' };
}

/** "rootAclDenies" → "Root acl denies": a check key, readable. */
export const humanCheck = (key: string) => {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

// ---- isolation status, shared by the rail dot and the card -----------------------------------
interface IsolationCheck {
  at: string;
  passed: boolean;
  checks: Record<string, boolean>;
  evidencePath: string;
}
function useIsolation() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [lastRaw, setLast] = usePref('isolation-last-check', '');
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
  let last: IsolationCheck | null = null;
  try {
    last = lastRaw ? (JSON.parse(lastRaw) as IsolationCheck) : null;
  } catch {
    last = null;
  }
  return {
    configured,
    setConfigured,
    last,
    saveLast: (value: IsolationCheck | null) => setLast(value ? JSON.stringify(value) : ''),
  };
}

export function SettingsPage({
  state,
  info,
  busy,
  command,
  files,
  onState,
  onNotice,
  notifications,
  section,
  onSection,
}: {
  state: AppState;
  info: AppInfo | null;
  busy: boolean;
  command: (input: CommandInput, success?: string) => Promise<AppState | null>;
  files: (action: () => ReturnType<typeof window.office.backupWorkspace>) => Promise<void>;
  onState: (state: AppState) => void;
  onNotice: (text: string) => void;
  notifications: {
    taskbar: boolean;
    popups: boolean;
    sound: boolean;
    setTaskbar: (on: boolean) => void;
    setPopups: (on: boolean) => void;
    setSound: (on: boolean) => void;
  };
  section: SettingsSection;
  onSection: (next: SettingsSection) => void;
}) {
  const isolation = useIsolation();
  const [view, setView] = usePref('office-view', '3d');
  const readiness = PROVIDERS.map(provider => providerReadiness(state, provider, { execution: 'LOCAL' }));
  const connections: { tone: Tone; word: string } = readiness.every(r => r.ready)
    ? { tone: 'ok', word: 'All ready' }
    : readiness.some(r => r.signedIn)
      ? { tone: 'warn', word: `${readiness.filter(r => r.ready).length} of ${PROVIDERS.length} ready` }
      : { tone: 'off', word: 'Not signed in' };
  const isoTone: { tone: Tone; word: string } =
    isolation.configured === null
      ? { tone: 'busy', word: 'Checking' }
      : isolation.configured
        ? { tone: 'ok', word: 'Active' }
        : { tone: 'off', word: 'Off' };
  const rail: { id: SettingsSection; label: string; icon: typeof Plug; status?: { tone: Tone; word: string } }[] = [
    { id: 'connections', label: 'Connections', icon: Plug, status: connections },
    { id: 'isolation', label: 'Agent isolation', icon: ShieldCheck, status: isoTone },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'data', label: 'Data & recovery', icon: Database },
    { id: 'about', label: 'About', icon: Info },
  ];
  return (
    <div className="settings-shell">
      <nav className="settings-rail" aria-label="Settings sections">
        {rail.map(({ id, label, icon: Icon, status }) => (
          <button
            key={id}
            type="button"
            className={`rail-item${section === id ? ' on' : ''}`}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => onSection(id)}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="rail-label">{label}</span>
            {status && (
              <span className="rail-status" title={status.word}>
                <Dot tone={status.tone} />
                <span className="sr-only">{status.word}</span>
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="settings-pane">
        {section === 'connections' && <ProviderConnections state={state} />}
        {section === 'isolation' && <AgentIsolation isolation={isolation} />}
        {section === 'notifications' && (
          <Pane title="Notifications" lead="How the office gets your attention when it needs you.">
            <div className="settings-group">
              <Row
                title="Taskbar badge"
                hint="Show a count on the taskbar icon and flash it when something needs you."
                control={
                  <Switch
                    label="Taskbar badge and attention flash"
                    on={notifications.taskbar}
                    onChange={notifications.setTaskbar}
                  />
                }
              />
              <Row
                title="Desktop popups"
                hint="A system notification when the count grows while the window is in the background. Carries a count only."
                control={<Switch label="Desktop popups" on={notifications.popups} onChange={notifications.setPopups} />}
              />
              <Row
                title="Sound"
                hint="A short, quiet cue on the same event."
                control={
                  <Switch label="Notification sound" on={notifications.sound} onChange={notifications.setSound} />
                }
              />
            </div>
            <details className="settings-more">
              <summary>How this works</summary>
              <p>
                No request content leaves the app, and clicking a popup focuses the window. The in-app inbox stays
                available either way. The taskbar progress bar shows recorded work on the current project (terminal jobs
                ÷ recorded jobs) and clears when no jobs are recorded or all are terminal.
              </p>
            </details>
          </Pane>
        )}
        {section === 'appearance' && (
          <Pane title="Appearance" lead="How the workspace looks and moves.">
            <div className="settings-group">
              <Row
                title="Theme"
                control={
                  <Segmented
                    label="Theme"
                    value={state.settings.theme}
                    disabled={busy}
                    options={[
                      { value: 'dark', label: 'Warm dark' },
                      { value: 'light', label: 'Light' },
                    ]}
                    onChange={theme =>
                      void command({ type: 'settings.update', settings: { ...state.settings, theme } })
                    }
                  />
                }
              />
              <Row
                title="Office view"
                hint="The 3D floor needs WebGL. Classic is the flat floor, lighter on older graphics."
                control={
                  <Segmented
                    label="Office view"
                    value={view === '2d' ? '2d' : '3d'}
                    options={[
                      { value: '3d', label: '3D floor' },
                      { value: '2d', label: 'Classic' },
                    ]}
                    onChange={setView}
                  />
                }
              />
              <Row
                title="Reduce motion"
                hint="Keep transitions, walking and graph physics to a minimum."
                control={
                  <Switch
                    label="Reduce motion"
                    on={state.settings.reducedMotion}
                    disabled={busy}
                    onChange={reducedMotion =>
                      void command({ type: 'settings.update', settings: { ...state.settings, reducedMotion } })
                    }
                  />
                }
              />
            </div>
          </Pane>
        )}
        {section === 'data' && (
          <Pane title="Data & recovery" lead="Your records live on this computer.">
            <div className="settings-group">
              <Row
                title="Back up workspace"
                hint="A portable copy of the local record and stored artifacts."
                control={
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void files(() => window.office.backupWorkspace())}
                  >
                    <ArrowUpFromLine size={14} />
                    Create backup
                  </button>
                }
              />
              <Row
                title="Restore a backup"
                hint="Your current workspace is kept as a recovery copy first."
                control={
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void files(() => window.office.restoreWorkspace())}
                  >
                    <ArrowDownToLine size={14} />
                    Restore backup
                  </button>
                }
              />
              <Row
                title="Legacy records"
                hint="Give old task records a native request. Copied first and verified by replay; old outcomes stay marked as never observed."
                control={
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void window.office
                        .migrateLegacyRecords()
                        .then(result => {
                          onState(result.state);
                          onNotice(
                            result.migrated
                              ? `Migrated ${result.migrated} legacy record${result.migrated === 1 ? '' : 's'} as drafts carrying an explicit ambiguity blocker.`
                              : 'No legacy records needed migrating.',
                          );
                        })
                        .catch(error => onNotice(error.message));
                    }}
                  >
                    Migrate legacy records
                  </button>
                }
              />
              <Row
                title="Data location"
                hint={undefined}
                control={<code className="path-text">{info?.dataDirectory || 'Unavailable'}</code>}
                stacked
              />
            </div>
          </Pane>
        )}
        {section === 'about' && (
          <Pane title="About" lead={`Quant Research Office · desktop ${info?.version ?? ''}`.trim()}>
            <div className="boundary-grid">
              <div>
                <span className="boundary-number">01</span>
                <strong>This desktop</strong>
                <p>Prompts, task routing, local records and explicit file transfers.</p>
              </div>
              <div>
                <span className="boundary-number">02</span>
                <strong>Provider tools</strong>
                <p>Agent sessions use the configured official client on this machine.</p>
              </div>
              <div>
                <span className="boundary-number">03</span>
                <strong>Your Colab session</strong>
                <p>Run manually by you. No agent access or integration.</p>
              </div>
            </div>
          </Pane>
        )}
      </div>
    </div>
  );
}

function Pane({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={`settings-${title.replaceAll(/\W+/g, '-')}`}>
      <header>
        <h2 id={`settings-${title.replaceAll(/\W+/g, '-')}`}>{title}</h2>
        <p>{lead}</p>
      </header>
      {children}
    </section>
  );
}

function Row({
  title,
  hint,
  control,
  stacked,
}: {
  title: string;
  hint?: string;
  control: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={`settings-row${stacked ? ' stacked' : ''}`}>
      <div className="settings-row-text">
        <strong>{title}</strong>
        {hint && <p>{hint}</p>}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

// ---- connections ------------------------------------------------------------------------------

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
    for (const provider of PROVIDERS) {
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
    <Pane
      title="Connections"
      lead="Sign in to each provider's official CLI. Only checks the office actually ran count as verified."
    >
      <div className="conn-list">
        {PROVIDERS.map(provider => {
          const copy = providerCopy[provider];
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
          const status = apiKeyMode ? { tone: 'warn' as Tone, word: 'API key saved' } : connectionTone(readiness);
          const identityLine = readiness.identity
            ? `${readiness.identity} · checked ${formatDateTime(readiness.lastObservedAt)}`
            : readiness.lastObservedAt
              ? `Checked ${formatDateTime(readiness.lastObservedAt)} — ${snapshot?.operations.find(item => item.operation === 'ACCOUNT_STATUS')?.detail ?? 'no signed-in subscription was reported.'}`
              : 'No account check recorded yet.';
          const steps: [string, boolean][] = [
            ['Signed in', readiness.signedIn],
            ['Model', readiness.modelChecked],
            ['Dispatch', readiness.dispatchChecked],
            ['Ready', readiness.ready],
          ];
          const firstBlocker = apiKeyMode ? '' : (readiness.blockers[0] ?? '');
          return (
            <article className="conn-card" key={provider} data-provider={provider}>
              <header>
                <span className="conn-glyph" aria-hidden="true">
                  {copy.glyph}
                </span>
                <div className="conn-title">
                  <h3>
                    {copy.name}
                    {provider === 'claude' && <span className="quiet-badge small"> Primary</span>}
                  </h3>
                  <span>{copy.plan}</span>
                </div>
                <span className="conn-status" data-tone={status.tone}>
                  <Dot tone={status.tone} />
                  {status.word}
                </span>
              </header>
              <p className="conn-identity">{identityLine}</p>
              {apiKeyMode ? (
                <p className="conn-note">
                  The provider was not contacted. Provider-hosted runs are not available in this version.
                </p>
              ) : (
                <ul className="conn-steps" aria-label={`${copy.name} readiness`}>
                  {steps.map(([name, ok]) => (
                    <li key={name} data-state={ok ? 'yes' : 'no'}>
                      {ok ? <Check size={12} aria-hidden="true" /> : <Minus size={12} aria-hidden="true" />}
                      {name}
                      <span className="sr-only">: {ok ? 'Yes' : 'No'}</span>
                    </li>
                  ))}
                </ul>
              )}
              {firstBlocker && <p className="conn-note">{firstBlocker}</p>}
              {checked && checked !== readiness.lastObservedAt && (
                <p className="conn-note">
                  Last live check {formatDateTime(checked)} was not recorded as a new observation, so it cannot
                  authorize anything.
                </p>
              )}
              {errors[provider] && (
                <p className="notice error" role="alert">
                  {errors[provider]}
                </p>
              )}
              <div className="conn-actions">
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
                  <button
                    className="text-button"
                    disabled
                    title={TRANSPORT_PROBE_CONTAINMENT.status}
                    aria-label={`Verify cloud transport — unavailable. ${TRANSPORT_PROBE_CONTAINMENT.status}`}
                  >
                    Verify cloud transport…
                  </button>
                )}
              </div>
              {provider === 'claude' && TRANSPORT_PROBE_CONTAINMENT.contained && (
                <p className="conn-note">{TRANSPORT_PROBE_CONTAINMENT.status}</p>
              )}
              <details className="settings-more">
                <summary>Technical details</summary>
                {apiKeyMode && (
                  <div className="conn-key">
                    <p>
                      {live[provider]?.keySavedAt ? `Saved ${formatDateTime(live[provider].keySavedAt!)} · ` : ''}
                      Stored encrypted with Windows DPAPI. The provider was not contacted.
                    </p>
                    <button
                      className="secondary"
                      disabled={busy[provider] === 'check'}
                      onClick={() => void removeKey(provider)}
                    >
                      Remove key
                    </button>
                  </div>
                )}
                <ul className="readiness-list">
                  {(
                    [
                      ['Account fresh', readiness.accountFresh],
                      ['Model checked', readiness.modelChecked],
                      ['Dispatch checked', readiness.dispatchChecked],
                    ] as [string, boolean][]
                  ).map(([name, value]) => (
                    <li key={name} data-state={value ? 'yes' : 'no'}>
                      {name}: {value ? 'Yes' : 'No'}
                    </li>
                  ))}
                </ul>
                <ul className="readiness-list">
                  {(
                    [
                      ['prepare', 'Prepare request'],
                      ['handoff', 'Official terminal handoff'],
                      ['automaticStart', 'Automatic start'],
                      ['observe', 'Observe job'],
                      ['requestCancellation', 'Request cancellation'],
                      ['duplicate', 'Duplicate'],
                      ['viewTerminalHistory', 'View handoff history'],
                    ] as const
                  ).map(([action, name]) => (
                    <li key={action} data-state={readiness.actions[action] ? 'yes' : 'no'}>
                      {name}: {readiness.actions[action] ? 'Allowed' : 'Blocked'}
                    </li>
                  ))}
                </ul>
                {snapshot && (
                  <p className="conn-note">
                    Tool {snapshot.toolVersion} · transport {snapshot.transport.toLowerCase().replaceAll('_', ' ')} ·{' '}
                    {snapshot.models.length} model{snapshot.models.length === 1 ? '' : 's'} · source: {snapshot.source}
                  </p>
                )}
                {readiness.evidence.filter(item => item.level !== 'ACCOUNT_VERIFIED' || item.expired).length > 0 && (
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
                )}
                {readiness.blockers.slice(apiKeyMode ? 0 : 1).map(blocker => (
                  <p className="conn-note" key={blocker}>
                    {blocker}
                  </p>
                ))}
              </details>
              {!apiKeyMode && (
                <ApiKeyEntry
                  provider={provider}
                  onSaved={() => {
                    setAuthMode(a => ({ ...a, [provider]: 'api-key' }));
                    void refresh(provider);
                  }}
                />
              )}
            </article>
          );
        })}
      </div>
    </Pane>
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
      className="api-key-entry settings-more"
      open={open}
      onToggle={event => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>Advanced · Use my own API key</summary>
      <p>API calls are billed separately from your subscription. Enter a key only if you explicitly want that.</p>
      <input
        type="password"
        aria-label={`API key for ${providerCopy[provider].name}`}
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

// ---- agent isolation --------------------------------------------------------------------------

type StepState = 'done' | 'todo' | 'blocked' | 'unknown';
const SIGNIN_PROVIDERS = PROVIDERS;
const STEP_ICON: Record<StepState, typeof Check> = { done: Check, todo: Minus, blocked: X, unknown: Minus };

/**
 * The LR-16 agent isolation card, status first: one headline state, then each step with its own
 * status, then the one action that fits the state. Configured state comes only from the main
 * process (the saved credential's presence — never its content). Setup runs the consented elevated
 * step; removal stops isolated launches but deliberately leaves the Windows account in place.
 */
export function AgentIsolation({ isolation }: { isolation: ReturnType<typeof useIsolation> }) {
  const { configured, setConfigured, last, saveLast } = isolation;
  const [busy, setBusy] = useState<'' | 'setup' | 'verify' | 'remove'>(''),
    [confirming, setConfirming] = useState<'' | 'setup' | 'remove'>(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [signins, setSignins] = useState<Partial<Record<Provider, { account?: string; at: string }>>>({});
  /** Official sign-in as QRO-Agent (opens its own window), or a fresh check through the isolated host. */
  async function agentSubscription(provider: Provider, login: boolean) {
    setBusy('verify');
    setError('');
    setNotice('');
    try {
      if (login) {
        await window.office.agentIsolationLogin(provider);
        setNotice(`Finish the ${providerCopy[provider].name} sign-in in the QRO-Agent window, then check it here.`);
      } else {
        const connection = await window.office.connectionStatus(provider);
        const at = new Date().toISOString();
        setSignins(prev => ({
          ...prev,
          [provider]: { account: connection.connected ? connection.account : undefined, at },
        }));
        if (connection.connected && connection.account)
          setNotice(
            `${providerCopy[provider].name} verified for QRO-Agent as ${connection.account}. Prepare new work to use it.`,
          );
        else setError(connection.note || `${providerCopy[provider].name} is not signed in for QRO-Agent.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function setup() {
    setBusy('setup');
    setConfirming('');
    setError('');
    setNotice('');
    try {
      await window.office.agentIsolationSetup();
      setConfigured(true);
      setNotice('Agent isolation is set up. New agent launches now run as the QRO-Agent account.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function verify() {
    setBusy('verify');
    setError('');
    setNotice('');
    try {
      const result = await window.office.agentIsolationVerify();
      saveLast({ at: new Date().toISOString(), ...result });
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
      setBusy('');
    }
  }
  async function remove() {
    setBusy('remove');
    setConfirming('');
    setError('');
    setNotice('');
    try {
      await window.office.agentIsolationRemove();
      setConfigured(false);
      setNotice('Agent isolation removed. New agent launches run as your Windows account again.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const head: { tone: Tone; word: string; line: string } =
    configured === null
      ? { tone: 'busy', word: 'Checking…', line: 'Reading the isolation status.' }
      : configured
        ? { tone: 'ok', word: 'Active', line: 'New agent launches run as the QRO-Agent Windows account.' }
        : { tone: 'off', word: 'Not set up', line: 'Agents currently run as your own Windows account.' };
  const checks = last ? Object.entries(last.checks) : [];
  const steps: { name: string; state: StepState; detail: string }[] = [
    {
      name: 'Separate Windows account',
      state: configured === null ? 'unknown' : configured ? 'done' : 'todo',
      detail: configured ? 'QRO-Agent, a low-privilege user' : 'QRO-Agent has not been created',
    },
    {
      name: 'Access limited to agent folders',
      state: configured === null ? 'unknown' : configured ? 'done' : 'todo',
      detail: configured ? 'Only the agent session folders are reachable' : 'Agents can reach your whole profile',
    },
    (() => {
      // Derived from checks run through the isolated host in this view — never assumed.
      const verified = SIGNIN_PROVIDERS.filter(p => signins[p]?.account);
      return {
        name: 'Subscription sign-in for this account',
        state: (!configured ? 'todo' : verified.length === SIGNIN_PROVIDERS.length ? 'done' : 'todo') as StepState,
        detail: !configured
          ? 'Needs the QRO-Agent account first'
          : verified.length
            ? `Verified: ${verified.map(p => `${providerCopy[p].name} (${signins[p]!.account})`).join(' · ')}`
            : 'Sign in each provider as QRO-Agent, then check it',
      };
    })(),
    {
      name: 'Isolation check',
      state: last ? (last.passed ? 'done' : 'blocked') : 'todo',
      detail: last
        ? `${last.passed ? 'Passed' : 'Failed'} ${formatDateTime(last.at)} · ${checks.filter(([, ok]) => ok).length} of ${checks.length} checks`
        : 'Not run yet',
    },
  ];
  return (
    <Pane title="Agent isolation" lead="Run agent sessions as a separate low-privilege Windows account.">
      <article className="iso-card" data-state={configured === null ? 'checking' : configured ? 'active' : 'off'}>
        <header className="iso-head">
          <Dot tone={head.tone} />
          <div>
            <strong>{head.word}</strong>
            <span>{head.line}</span>
          </div>
        </header>
        <ol className="iso-steps">
          {steps.map(step => {
            const Icon = STEP_ICON[step.state];
            return (
              <li key={step.name} data-state={step.state}>
                <span className="iso-mark" aria-hidden="true">
                  <Icon size={12} strokeWidth={3} />
                </span>
                <div>
                  <b>{step.name}</b>
                  <span>{step.detail}</span>
                </div>
              </li>
            );
          })}
        </ol>
        {last && !last.passed && (
          <ul className="iso-failures" aria-label="Failed checks">
            {checks
              .filter(([, ok]) => !ok)
              .map(([name]) => (
                <li key={name}>{humanCheck(name)}</li>
              ))}
          </ul>
        )}
        <footer className="iso-actions">
          {configured === false && !confirming && (
            <button
              className="secondary"
              disabled={!!busy}
              aria-label="Set up agent isolation"
              aria-busy={busy === 'setup'}
              onClick={() => setConfirming('setup')}
            >
              {busy === 'setup' ? 'Setting up…' : 'Set up isolation'}
            </button>
          )}
          {configured === false && confirming === 'setup' && (
            <div className="iso-confirm" role="alertdialog" aria-label="Confirm agent isolation setup">
              <p>
                Setup needs administrator approval. Afterwards, sign in each provider separately as QRO-Agent; your own
                sign-ins are not shared with it.
              </p>
              <div className="button-row">
                <button className="primary" disabled={!!busy} onClick={() => void setup()}>
                  Set up
                </button>
                <button className="text-button" onClick={() => setConfirming('')}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {configured === true && (
            <>
              <button
                className="primary"
                disabled={!!busy}
                aria-label="Check agent isolation"
                aria-busy={busy === 'verify'}
                onClick={() => void verify()}
              >
                {busy === 'verify' ? 'Checking…' : 'Check isolation'}
              </button>
              {SIGNIN_PROVIDERS.map(provider => (
                <span key={provider} className="button-row">
                  <button
                    className="secondary"
                    disabled={!!busy}
                    aria-label={`Sign in ${provider} for agent account`}
                    onClick={() => void agentSubscription(provider, true)}
                  >
                    Sign in {providerCopy[provider].name}
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    aria-label={`Check ${provider} agent subscription`}
                    onClick={() => void agentSubscription(provider, false)}
                  >
                    Check
                  </button>
                </span>
              ))}
              {confirming !== 'remove' ? (
                <button
                  className="text-button danger"
                  disabled={!!busy}
                  aria-label="Remove agent isolation"
                  onClick={() => setConfirming('remove')}
                >
                  Remove isolation
                </button>
              ) : (
                <div className="iso-confirm" role="alertdialog" aria-label="Confirm removing agent isolation">
                  <p>
                    New launches go back to your own Windows account. The QRO-Agent account stays; remove it in Windows
                    settings if you want it gone.
                  </p>
                  <div className="button-row">
                    <button className="secondary" disabled={!!busy} onClick={() => void remove()}>
                      {busy === 'remove' ? 'Removing…' : 'Remove isolation'}
                    </button>
                    <button className="text-button" onClick={() => setConfirming('')}>
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </footer>
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
      </article>
    </Pane>
  );
}

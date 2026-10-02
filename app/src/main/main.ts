import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell } from 'electron';
import { attentionBadgePng } from './attention-badge.js';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OfficeStore, effortSchema } from '../core/store.js';
import { ArtifactService, MAX_TOTAL } from './artifacts.js';
import { createRunPackageCodec } from './run-package.js';
import { EvidenceService } from './evidence.js';
import { handleEvidenceFrame } from './evidence-tool.js';
import { promotable, scheduleStage, STAGE_FUNCTIONS_REQUIRED } from './research-controller.js';
import { STAGE_DELIVERY } from '../shared/run-package.js';
import { migrateRolesToFunctions, resolveFunctions } from './context-policy.js';
import { stat, readFile } from 'node:fs/promises';
import { reconstructUsage } from './local-usage.js';
import { loadWindowWithRetry } from './boot-load.js';
import { parseWorkLogs } from './work-logs.js';
import {
  workspaceDirectory,
  recoverInterruptedRestore,
  prepareRestore,
  discardCandidate,
  commitRestore,
} from './recovery.js';
import { resolveSelection, prepareInputSnapshot, reconstructSnapshot, verifySnapshotForTransfer } from './locations.js';
import { AssignmentController } from './controller.js';
import {
  mintPipelineBrief,
  mintPipelineRefine,
  mintPipelineRound,
  pipelineConfirmGate,
  type PipelineMintContext,
} from './pipeline-runner.js';
import { latestJobFor } from '../core/jobs.js';
import { PipelineService } from './pipeline.js';
import { HoldoutCustody } from './holdout.js';
import { OutputService } from './outputs.js';
import { TerminalHandoffAdapter } from './handoff.js';
import { LocalCliExecAdapter, type LocalCliExecOptions } from './local-cli-exec.js';
import { LocalAcpAdapter } from './local-acp.js';
import { LocalMailboxAdapter } from './local-session.js';
import { LocalWorktreeMailboxAdapter } from './local-worktree-session.js';
import { WORKTREES_DIR } from './local-worktree-repo.js';
import { LocalSessionRouter } from './local-session-router.js';
import { createLocalProviderLifecycle } from './local-provider-lifecycle.js';
import { localArchiveResultSchema, type LocalSessionRecord } from '../shared/local-session.js';
import { PtyCloudAdapter, transportModuleStatus } from './pty.js';
import { probeCloudTransport } from './probe.js';
import { assertTransportProbeAllowed } from '../shared/transport.js';
import { realpathSync, existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { calibration, compareMethods, lineageAncestry } from '../core/monitoring';
/** One place decides what a usable project root is, so dialogs and saved allowlists agree. */
function resolveSelectionRoot(root: string): string {
  if (!path.isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory())
    throw new Error('Choose the project folder first.');
  return realpathSync(root);
}

import { Subscriptions, providerSchema, subscriptionEnvironment } from './subscriptions.js';
import { Secrets, agentEnvironment } from './secrets.js';
import { AGENT_USERNAME, qroAgentSpawn, setupAgentIsolation, type QroAgentSpawn } from './agent-isolation.js';
import { runAgentIsolationAcceptance } from './agent-isolation-acceptance.js';
import { launchIsolatedLogin } from './agent-isolation-login.js';
import type { Connection, Provider } from '../shared/types.js';
import { describeError, writeLog } from './diagnostics.js';
let subscriptions: Subscriptions;
/** The local secrets store — userData root, outside the workspace, so restores never touch it. */
let secrets: Secrets;
let win: BrowserWindow | null = null;
let store: OfficeStore;
let artifacts: ArtifactService;
let evidence: EvidenceService;
let transferBusy = false;
/** Bumped every time the workspace database is replaced. Results from an older epoch are discarded. */
let storeEpoch = 0;
/** Request actions currently in flight. A workspace replacement may not begin while any are open. */
let openRequestActions = 0;
/** Includes async account/metadata handlers that can commit after awaiting an official tool. */
let activeWorkspaceCalls = 0;
/** Set for the whole restore lifecycle, from candidate preparation to commit. */
let workspaceLocked = false;
let controller: AssignmentController;
let exec: LocalCliExecAdapter | undefined;
let acp: LocalAcpAdapter | undefined;
/** The QRO-Agent host's spawn surface and shutdown handle — set only while isolation is live. */
let agentHost: QroAgentSpawn | undefined;
let pipeline: PipelineService;
let custody: HoldoutCustody;
let dispatchBusy = false;
let html = path.join(__dirname, '../renderer/index.html');
const loadingHtml = (theme: Theme) =>
  path.join(__dirname, theme === 'light' ? '../renderer/loading-light.html' : '../renderer/loading.html');
let expectedURL = pathToFileURL(html).href;
type Theme = 'dark' | 'light';
/** The page background of each theme, so the window never shows a colour the page does not use. */
const WINDOW_BACKGROUND: Record<Theme, string> = { dark: '#171614', light: '#f1f0e9' };
/**
 * The workspace's last theme, remembered outside the workspace so the window and its loading page
 * open in it before the store is read. A new workspace starts light, as the store does.
 */
const themeFile = () => path.join(app.getPath('userData'), 'window-theme');
let windowTheme: Theme = 'light';
/** What the theme file holds, or null when it has none yet (the first launch of this build). */
let storedTheme: Theme | null = null;
function readWindowTheme(): Theme | null {
  try {
    const value = readFileSync(themeFile(), 'utf8').trim();
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}
function rememberTheme(theme: Theme) {
  if (theme !== windowTheme) {
    windowTheme = theme;
    win?.setBackgroundColor(WINDOW_BACKGROUND[theme]);
  }
  if (theme === storedTheme) return;
  storedTheme = theme;
  void writeFile(themeFile(), theme).catch(() => undefined);
}
const id = z.string().uuid();
const importSchema = z
  .object({ projectId: id, experimentId: id.nullable(), kind: z.enum(['REFERENCE', 'RESULT']) })
  .strict();
const selectedRoot = process.env.QRO_USER_DATA_DIR;
if (selectedRoot) {
  app.setPath('userData', path.resolve(selectedRoot));
}
// One stable application identity so the taskbar groups dev and packaged windows under the
// same icon rather than falling back to the Electron binary's generic one.
app.setAppUserModelId('Quant Research Office');
const logDir = () => path.join(app.getPath('userData'), 'logs');
let crashDialogShown = false;
const reportCrash = (kind: string, error: unknown) => {
  writeLog(logDir(), 'ERROR', `${kind} ${describeError(error)}`);
  if (crashDialogShown || !app.isReady()) return;
  crashDialogShown = true;
  dialog.showErrorBox(
    'Quant Research Office hit an unexpected error',
    'Your workspace is saved. The error was written to the log folder (Help → Open logs folder). If the office misbehaves, restart it.',
  );
};
process.on('uncaughtException', error => reportCrash('uncaughtException', error));
process.on('unhandledRejection', reason => reportCrash('unhandledRejection', reason));
app.on('child-process-gone', (_event, details) =>
  writeLog(
    logDir(),
    'WARN',
    `child-process-gone type=${details.type} reason=${details.reason} exit=${details.exitCode}`,
  ),
);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch(error => {
      writeLog(logDir(), 'ERROR', `startup ${describeError(error)}`);
      // A schema-replay failure almost always means this build is older than the one that wrote the
      // workspace — the strict event schemas fail closed on values they do not know. Say that plainly
      // instead of dumping the raw validation issues.
      const detail =
        error instanceof z.ZodError
          ? 'The stored workspace does not match this build’s record schema — most often because it was written by a newer version of Quant Research Office. Open it with the newer build, or restore a verified backup.\n\nYour files have not been reset.'
          : `${error instanceof Error ? error.message : 'Unknown startup error'}\n\nYour files have not been reset. Keep the data folder and use a compatible build or a verified backup.`;
      dialog.showErrorBox('Workspace could not be opened', detail);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    agentHost?.shutdown();
    exec?.disposeAll();
    acp?.disposeAll();
    subscriptions?.close();
    if (store) store.close();
  });
}
async function start() {
  writeLog(logDir(), 'INFO', `start version=${app.getVersion()} packaged=${app.isPackaged}`);
  // Startup timings land in the log, so a slow open can be traced to the step that took the time.
  const began = performance.now();
  let previous = began;
  const marks: string[] = [];
  const mark = (step: string) => {
    const now = performance.now();
    marks.push(`${step}=${Math.round(now - previous)}ms`);
    previous = now;
  };
  // The .ico keeps window and taskbar pinned to the same artwork the packager embeds in the exe;
  // the .png remains for platforms without multi-size ico support.
  const appIcon = path.join(__dirname, process.platform === 'win32' ? '../assets/icon.ico' : '../assets/icon.png');
  storedTheme = readWindowTheme();
  const guess = storedTheme;
  windowTheme = guess ?? 'light';
  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 1050,
    minHeight: 720,
    title: 'Quant Research Office',
    backgroundColor: WINDOW_BACKGROUND[windowTheme],
    // With a remembered theme the window shows at once. Without one it waits for the workspace's,
    // so it never opens in the wrong colours.
    show: guess !== null,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  // The themed loading page loads while the workspace opens.
  let loading = guess ? win.loadFile(loadingHtml(windowTheme)).catch(() => undefined) : undefined;
  let shown = guess ? 0 : -1;
  mark('window');
  const root = app.getPath('userData');
  await mkdir(root, { recursive: true });
  await recoverInterruptedRestore(root);
  const workspace = workspaceDirectory(root);
  await mkdir(workspace, { recursive: true });
  mark('recovery');
  store = new OfficeStore(path.join(workspace, 'workspace.sqlite'), {
    includeHistoryInResults: false,
    // The full-history check runs once the window is up; the open itself replays only the tail.
    backgroundVerifyDelayMs: 4000,
    onBackgroundVerifyError: error => {
      writeLog(logDir(), 'ERROR', `integrity ${describeError(error)}`);
      dialog.showErrorBox(
        'Quant Research Office integrity check failed',
        'The workspace history check running in the background found a problem. Do not trust this session — quit and restore from a backup. Details are in the log folder (Help → Open logs folder).',
      );
    },
  });
  mark('store');
  rememberTheme(store.snapshot({ history: false }).settings.theme);
  // The page is built in the workspace's theme, so its first paint matches before the page has a
  // theme of its own stored.
  html = path.join(__dirname, windowTheme === 'dark' ? '../renderer/index-dark.html' : '../renderer/index.html');
  expectedURL = pathToFileURL(html).href;
  // No remembered theme, or a wrong one: the loading page follows the workspace. Services and
  // reconciliation run while it loads.
  if (windowTheme !== guess) loading = win.loadFile(loadingHtml(windowTheme)).catch(() => undefined);
  // The first launch shows the window once that page has loaded. ('ready-to-show' is no use here:
  // it fires for the window's blank first document, before the workspace's theme is known.)
  if (!guess)
    loading = loading?.then(() => {
      shown = Math.round(performance.now() - began);
      win?.show();
    });
  artifacts = new ArtifactService(store, workspace);
  evidence = new EvidenceService(store, workspace);
  // secrets.dat lives at the userData root — a sibling of workspace/, never inside it.
  secrets = new Secrets(root, undefined, line => writeLog(logDir(), 'WARN', line));
  subscriptions = new Subscriptions(
    path.join(root, 'connections'),
    url => shell.openExternal(url),
    // The most recent recorded observation that named an account for this provider — the
    // still-fresh fallback a connected-but-unidentified live check resolves through.
    provider =>
      [...(store.snapshot({ history: false }).connections ?? [])]
        .reverse()
        .find(c => c.provider === provider && c.state === 'SIGNED_IN' && c.identity),
    secrets,
  );
  // The interim transport is the labeled handoff. Automatic dispatch stays gated on verified evidence.
  controller = buildController();
  // Custody lives outside the workspace tree so no backup or restore can reach it. This build has no
  // isolated evaluator, which the capability states honestly and which keeps S8 reservations refused.
  custody = buildCustody(root, workspace);
  pipeline = buildPipeline();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    // No renderer network or live content. Future provider transport belongs in guarded main-process adapters.
    callback({
      cancel:
        !details.url.startsWith('file:') && !details.url.startsWith('devtools:') && !details.url.startsWith('data:'),
    });
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Office', submenu: [{ label: 'Quit', role: 'quit' }] },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Open logs folder',
            click: () => {
              void shell.openPath(logDir());
            },
          },
        ],
      },
    ]),
  );
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('close', event => {
    if (transferBusy) {
      event.preventDefault();
      void dialog.showMessageBox(win!, {
        type: 'info',
        message: 'A file transfer is still being finalized.',
        detail: 'Please wait for the transfer to finish before closing the office.',
      });
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    writeLog(logDir(), 'ERROR', `render-process-gone reason=${details.reason} exit=${details.exitCode}`);
    if (details.reason === 'clean-exit' || !win) return;
    void dialog
      .showMessageBox(win, {
        type: 'error',
        message: 'The office window stopped unexpectedly.',
        detail: 'Your workspace is saved. Reload to continue. Details are in the log folder (Help → Open logs folder).',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) win?.reload();
        else app.quit();
      });
  });
  // Interrupted work is reconciled while the window is already visible but before the renderer
  // loads; a crash never resubmits or invents an outcome, and no page exists to serve IPC yet.
  // A failed pass never blocks the window; it is logged, and the next trigger retries.
  mark('services');
  try {
    await controller.reconcile();
  } catch (error) {
    writeLog(logDir(), 'WARN', `startup reconcile failed ${describeError(error)}`);
  }
  // Work that finished while the office was closed may now unlock dependents — the same guarded
  // chain-advance runs once here, so a completed predecessor never leaves its chain parked.
  try {
    await controller.reconcileLocalChain();
  } catch (error) {
    writeLog(logDir(), 'WARN', `startup chain reconcile failed ${describeError(error)}`);
  }
  mark('reconcile');
  register();
  await loading;
  await loadWindowWithRetry(win, html);
  mark('page');
  if (!win.isVisible()) win.show();
  // Each step's own time, then the total since start() and since the process began.
  writeLog(
    logDir(),
    'INFO',
    `startup ${marks.join(' ')} total=${Math.round(performance.now() - began)}ms process=${Math.round(process.uptime() * 1000)}ms theme=${windowTheme} shown=${shown < 0 ? 'page' : `${shown}ms`}`,
  );
  // The office opens on re-observed accounts, not on however stale the recorded check is.
  // Each provider is re-observed once, off the load path; a failed observation leaves the
  // last recorded state standing with its real timestamp — never a refreshed-looking lie.
  for (const provider of ['openai', 'claude', 'devin'] as const)
    void subscriptions
      .observe(provider)
      .then(({ observation }) => {
        store.recordAccountObservation(observation);
        win?.webContents.send('office:changed');
      })
      // The last recorded state stays standing with its real timestamp; the failure is logged.
      .catch(error => writeLog(logDir(), 'WARN', `startup ${provider} observation failed ${describeError(error)}`));
}
function register() {
  const handle = (channel: string, fn: (value: unknown) => unknown | Promise<unknown>) =>
    ipcMain.handle(channel, async (event, value) => {
      let admitted = false;
      try {
        if (
          !win ||
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame ||
          event.senderFrame.url !== expectedURL
        )
          throw new Error('Request is not from the trusted desktop window.');
        if (workspaceLocked) throw new Error('The workspace is being restored. Wait for restoration to finish.');
        // Restore itself owns the lock. Every other handler, including account observations and reads,
        // holds admission until its asynchronous continuation has finished using this workspace.
        if (channel !== 'office:restore') {
          activeWorkspaceCalls++;
          admitted = true;
        }
        const result = await fn(value);
        // A state on its way to the page carries the current theme, and the window follows it.
        type Themed = { settings?: { theme?: unknown }; state?: { settings?: { theme?: unknown } } } | null;
        const theme = ((result as Themed)?.settings ?? (result as Themed)?.state?.settings)?.theme;
        if (theme === 'dark' || theme === 'light') rememberTheme(theme);
        const publicResult =
          result && typeof result === 'object' && 'schemaVersion' in result && 'projects' in result
            ? OfficeStore.publicState(result as import('../shared/types').AppState)
            : result &&
                typeof result === 'object' &&
                'state' in result &&
                result.state &&
                typeof result.state === 'object' &&
                'schemaVersion' in result.state &&
                'projects' in result.state
              ? {
                  ...result,
                  state: OfficeStore.publicState((result as { state: import('../shared/types').AppState }).state),
                }
              : result;
        return { ok: true, value: publicResult };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof z.ZodError
              ? 'Invalid desktop request. Check the selected project and values.'
              : error instanceof Error
                ? error.message
                : 'The request failed.',
        };
      } finally {
        if (admitted) activeWorkspaceCalls--;
      }
    });
  const changed = () => win?.webContents.send('office:changed');
  /**
   * Launches a minted hop that is still at INTENT. A failed automatic launch never loses the work:
   * the reason is recorded on the job as an office-local status line and the hop stays prepared
   * for a manual launch. `what` names the hop in that line; `label` prefixes its external id.
   */
  const launchPreparedHop = async (assignmentId: string, label: string, what: string): Promise<void> => {
    const job = latestJobFor(store.snapshot({ history: false }).jobs, assignmentId);
    if (job?.state !== 'INTENT') return;
    try {
      await controller.handoff(assignmentId);
    } catch (error) {
      const at = new Date().toISOString();
      store.recordJobEvents(job.id, [
        {
          externalId: `${label}:${randomUUID()}`,
          cursor: '',
          kind: 'STATUS',
          text: `${what} could not run: ${error instanceof Error ? error.message : 'unknown error'} The work stays prepared; launch it manually when the blocker clears.`,
          occurredAt: at,
          receivedAt: at,
          evidence: 'OFFICE_LOCAL',
        },
      ]);
    }
  };
  /** Where one local session record's packet directory lives (flat sessions or a project worktree). */
  const localRecordDir = (record: LocalSessionRecord): string =>
    path.join(
      workspaceDirectory(app.getPath('userData')),
      record.layout === 'PROJECT_WORKTREE'
        ? path.join('local-repos', record.projectId, WORKTREES_DIR)
        : 'local-sessions',
      record.archiveRelativePath ?? record.storageRelativePath,
    );
  handle('office:claude-local-usage', async value => {
    const chooseFolder = z.boolean().parse(value);
    return transfer(async () => {
      let folder = path.join(process.env.USERPROFILE || app.getPath('home'), '.claude', 'projects');
      if (chooseFolder) {
        const result = await dialog.showOpenDialog(win!, {
          title: 'Select Claude transcript folder for local token counting',
          properties: ['openDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        folder = result.filePaths[0];
      }
      return reconstructUsage(folder);
    });
  });
  handle('office:agent-effort', async value => {
    const input = z.object({ agentId: id, effort: effortSchema, expectedEffort: effortSchema }).strict().parse(value);
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const agent = store.snapshot({ history: false }).agents.find(a => a.id === input.agentId);
    if (!agent) throw new Error('Agent not found.');
    if (agent.removedAt) throw new Error('Restore this agent before editing');
    const connection =
      agent.provider === 'openai' && input.effort !== 'default' ? await subscriptions.status('openai') : undefined;
    if (connection && (!connection.connected || connection.account !== agent.account))
      throw new Error('Sign in to this agent’s subscription account before validating a non-default effort.');
    subscriptions.validateEffort(agent.provider, agent.model, input.effort, connection);
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const state = store.setAgentEffort(agent.id, input.effort, input.expectedEffort);
    win?.webContents.send('office:changed');
    return state;
  });
  handle('office:agent-model', async value => {
    const input = z
      .object({
        agentId: id,
        model: z.string().trim().min(1).max(160),
        expectedModel: z.string().trim().min(1).max(160),
      })
      .strict()
      .parse(value);
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const agent = store.snapshot({ history: false }).agents.find(a => a.id === input.agentId);
    if (!agent) throw new Error('Agent not found.');
    if (agent.removedAt) throw new Error('Restore this agent before editing');
    if (agent.provider === 'openai') {
      const connection = await subscriptions.status('openai');
      if (!connection.connected || connection.account !== agent.account)
        throw new Error('Sign in to this agent’s subscription account before changing its model.');
      if (!connection.models.some(m => m.id === input.model))
        throw new Error('The selected model is not in your available Codex catalog. Refresh models and select again.');
    }
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const state = store.setAgentModel(agent.id, input.model, input.expectedModel);
    win?.webContents.send('office:changed');
    return state;
  });
  handle('office:work-logs', value => {
    if (value !== undefined) throw new Error('Unexpected data');
    return store.workLogs();
  });
  handle('office:work-log-import', async value => {
    const agentId = id.parse(value);
    return transfer(async () => {
      if (!store.snapshot({ history: false }).agents.some(a => a.id === agentId)) throw new Error('Agent not found.');
      const selection = await dialog.showOpenDialog(win!, {
        title: 'Import visible conversation or work logs for this agent',
        properties: ['openFile'],
        filters: [{ name: 'JSON Lines transcripts', extensions: ['jsonl'] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return { count: 0, skipped: 0, message: 'Import canceled.' };
      const file = selection.filePaths[0];
      if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('Import a log no larger than 16 MiB.');
      const parsed = parseWorkLogs(
        await readFile(file),
        agentId,
        new Set(store.snapshot({ history: false }).agents.map(a => a.id)),
      );
      const count = store.importWorkLogs(parsed.entries);
      win?.webContents.send('office:changed');
      return {
        count,
        skipped: parsed.skipped,
        message: `Imported ${count} entries; ${parsed.skipped} non-message records skipped. Source is user-imported, not verified execution.`,
      };
    });
  });
  handle('office:agent-connect', async value => {
    const ticket = await subscriptions.connect(value);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return ticket;
  });
  handle('office:agent-bind', async value => {
    const input = z
      .object({ agentId: id, expectedRevision: z.number().int().nonnegative(), intent: z.enum(['VERIFY', 'CHANGE']) })
      .strict()
      .parse(value);
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const agent = store.snapshot({ history: false }).agents.find(a => a.id === input.agentId);
    if (!agent) throw new Error('Agent not found.');
    // The renderer names only the profile it is acting on; the observation always comes from the official tool here.
    const observation = await subscriptions.observeFor(agent.provider);
    const state = store.bindAgentConnection({ ...input, observation });
    changed();
    return state;
  });
  handle('office:agent-confirm', async value => {
    if (transferBusy) throw new Error('Wait for the file transfer to finish.');
    await subscriptions.confirm(id.parse(value), (agent, observation) => {
      if (transferBusy) throw new Error('Wait for the file transfer to finish.');
      store.confirmAgentBinding({ observation, agent });
    });
    win?.webContents.send('office:changed');
    return store.snapshot({ history: false });
  });
  handle('office:agent-cancel', value => {
    if (value !== undefined) throw new Error('Unexpected data');
    subscriptions.cancel();
  });
  /** The auth-mode fields IPC adds to a returned Connection — never persisted, never the key. */
  const withAuthMode = (provider: Provider, connection: Connection): Connection => {
    const key = secrets.providerKeyState(provider);
    connection.authMode = key.saved ? 'api-key' : 'subscription';
    if (key.savedAt) connection.keySavedAt = key.savedAt;
    return connection;
  };
  handle('office:provider-api-key-set', async value => {
    const input = z.object({ provider: providerSchema, key: z.string() }).strict().parse(value);
    const key = input.key.trim();
    if (!key || key.length > 512 || /\s/.test(key))
      throw new Error('Enter a single-line API key no longer than 512 characters.');
    try {
      secrets.saveProviderKey(input.provider, key);
    } catch (error) {
      // The saved store's own messages carry no key material; the guard keeps it that way even if
      // a lower layer ever echoed its input back.
      const message = (error instanceof Error ? error.message : 'unknown error').replaceAll(key, '…');
      throw new Error(`The key could not be saved: ${message}`);
    }
    changed();
    return { ok: true };
  });
  handle('office:provider-api-key-remove', async value => {
    const provider = providerSchema.parse(value);
    secrets.removeProviderKey(provider);
    changed();
    return { ok: true };
  });
  handle('office:provider-key-state', async value => secrets.providerKeyState(providerSchema.parse(value)));
  // LR-16 agent isolation: status is the credential's presence only — the renderer never sees the
  // password, and the account itself is created/left behind by the consented elevated script.
  handle('office:agent-isolation-status', async value => {
    noInput(value);
    return { configured: secrets.hasAgentCredential() };
  });
  handle('office:agent-isolation-login', async value => {
    const provider = providerSchema.parse(value);
    const credential = secrets.agentCredential();
    if (!credential || !agentHost) throw new Error('Set up agent isolation first.');
    await launchIsolatedLogin({
      credential,
      provider,
      executable: subscriptions.toolPath(provider),
      agentsRoot: path.join(workspaceDirectory(app.getPath('userData')), 'local-sessions'),
    });
    return { ok: true };
  });
  handle('office:agent-isolation-setup', async value => {
    noInput(value);
    await setupAgentIsolation({
      userData: app.getPath('userData'),
      secrets,
      toolPath: provider => subscriptions.toolPath(provider),
      log: line => writeLog(logDir(), 'WARN', line),
    });
    // The credential just landed — rebuild so the exec adapter picks up the isolated spawn surface.
    controller = buildController();
    changed();
    return { ok: true };
  });
  handle('office:agent-isolation-remove', async value => {
    noInput(value);
    secrets.removeAgentUser();
    // Rebuild drops the isolated spawn surface; the Windows account itself is left in place by
    // design (removing it is the user's Windows admin action, never a silent office effect).
    controller = buildController();
    changed();
    return { ok: true };
  });
  // LR-16 acceptance: probes run as QRO-Agent through the office's own host, so the saved
  // credential is used unchanged. Evidence lands in <userData>cceptance; it never includes the
  // password, only the probes' output and the fail-closed verdict.
  handle('office:agent-isolation-verify', async value => {
    noInput(value);
    if (!agentHost) throw new Error('Agent isolation is not active. Set it up first.');
    const workspaceDir = workspaceDirectory(app.getPath('userData'));
    const sessionDir = path.join(workspaceDir, 'local-sessions', `acceptance-${Date.now()}`);
    mkdirSync(sessionDir, { recursive: true });
    const report = await runAgentIsolationAcceptance({
      spawnAs: agentHost,
      username: AGENT_USERNAME,
      sessionDir,
      // The DPAPI secrets file always exists once isolation is configured (it holds the credential).
      protectedFile: path.join(app.getPath('userData'), 'secrets.dat'),
    });
    const evidenceDir = path.join(app.getPath('userData'), 'acceptance');
    mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, `lr16-${new Date().toISOString().replaceAll(':', '-')}.json`);
    writeFileSync(
      evidencePath,
      JSON.stringify({ at: new Date().toISOString(), version: app.getVersion(), ...report }, null, 2),
      'utf8',
    );
    return { passed: report.passed, checks: report.checks, evidencePath };
  });
  handle('office:connection-status', async value => {
    const provider = providerSchema.parse(value);
    const { connection, observation } = await subscriptions.observe(provider);
    // Provider evidence is persisted here, in the main process. The renderer never supplies observations.
    try {
      store.recordAccountObservation(observation);
      changed();
    } catch (error) {
      connection.note =
        `${connection.note} Durable record not saved: ${error instanceof Error ? error.message : 'unknown error'}`.trim();
    }
    return withAuthMode(provider, connection);
  });
  handle('office:provider-login', async value => {
    const provider = providerSchema.parse(value);
    await subscriptions.signIn(provider);
    // A completed sign-in is immediately re-observed and recorded like any account check.
    const { connection, observation } = await subscriptions.observe(provider);
    try {
      store.recordAccountObservation(observation);
      changed();
    } catch (error) {
      connection.note =
        `${connection.note} Durable record not saved: ${error instanceof Error ? error.message : 'unknown error'}`.trim();
    }
    return withAuthMode(provider, connection);
  });
  handle('office:provider-tool', async value => {
    const provider = providerSchema.parse(value);
    const result = await dialog.showOpenDialog(win!, {
      title: 'Locate the official ' + (provider === 'openai' ? 'codex.exe' : 'claude.exe'),
      properties: ['openFile'],
      filters: [{ name: 'Provider executable', extensions: ['exe'] }],
    });
    if (!result.canceled && result.filePaths[0]) subscriptions.select(provider, result.filePaths[0]);
  });
  handle('office:provider-usage', value =>
    shell.openExternal(
      providerSchema.parse(value) === 'claude'
        ? 'https://claude.ai/settings/usage'
        : 'https://chatgpt.com/codex/settings/usage',
    ),
  );

  const noInput = (value: unknown) => {
    if (value !== undefined) throw new Error('Unexpected request data.');
  };
  handle('office:project-folder', async value => {
    noInput(value);
    const result = await dialog.showOpenDialog(win!, {
      title: 'Project folder on this device',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle('office:project-open-folder', async value => {
    const project = store.snapshot({ history: false }).projects.find(p => p.id === id.parse(value));
    if (!project?.localFolder) throw new Error('Folder not selected. Edit the project to choose one.');
    if (!(await stat(project.localFolder)).isDirectory())
      throw new Error('Project folder is missing. Relink it in project settings.');
    const error = await shell.openPath(project.localFolder);
    if (error) throw new Error(error);
  });
  handle('office:choose-input-files', async value => {
    const root = z.string().min(1).max(32000).parse(value);
    const real = resolveSelectionRoot(root);
    return transfer(async () => {
      const result = await dialog.showOpenDialog(win!, {
        title: 'Choose files to share with this request',
        defaultPath: real,
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return [];
      if (result.filePaths.length > 200) throw new Error('Select up to 200 files at a time.');
      // The selection is validated here, in the main process, before it can become a saved allowlist.
      return resolveSelection(
        real,
        result.filePaths.map(file => path.relative(real, file)),
      ).map(file => file.relative);
    });
  });
  const assignmentInput = z.object({ assignmentId: id }).strict();
  /**
   * Admission for one request action.
   *
   * Two things have to hold. A workspace replacement must not be in progress, because the database
   * this action is about to use is the one being replaced; checking a flag once at the end of the
   * restore was not enough, since an action could be admitted while the restore was still awaiting.
   * And the epoch is captured before the work and compared after, so a result computed against a
   * database that has since been swapped is discarded instead of being written back or returned.
   */
  const dispatch = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    if (workspaceLocked)
      throw new Error('The workspace is being restored. Wait for it to finish before starting a request action.');
    if (dispatchBusy) throw new Error('Another request action is already running.');
    const epoch = storeEpoch;
    dispatchBusy = true;
    openRequestActions++;
    try {
      const result = await fn();
      if (epoch !== storeEpoch)
        throw new Error(
          'The workspace was replaced while this action was running. Its result was discarded; reload and try again.',
        );
      return result;
    } finally {
      dispatchBusy = false;
      openRequestActions--;
    }
  };
  handle('office:request-prepare', async value => {
    const input = z
      .object({
        requestId: id,
        expectedRequestRevision: z.number().int().nonnegative(),
        agentId: id,
        expectedAgentRevision: z.number().int().nonnegative(),
        dependsOn: z.array(id).max(64).optional(),
      })
      .strict()
      .parse(value);
    return dispatch(async () => {
      const state = store.snapshot({ history: false });
      const request = state.requests?.find(item => item.id === input.requestId);
      if (!request) throw new Error('Request not found.');
      // The frozen bytes go into the workspace object store, so a backup carries them and a restore can
      // rebuild the staging directory without ever reading the user's source folder again.
      const snapshot = await prepareInputSnapshot({
        store,
        stagingRoot: path.join(workspaceDirectory(app.getPath('userData')), 'snapshots'),
        objectRoot: workspaceDirectory(app.getPath('userData')),
        projectId: request.projectId,
        requestId: request.id,
        requestRevision: request.revision,
        objective: request.objective,
      });
      const result = controller.prepare({
        requestId: input.requestId,
        agentId: input.agentId,
        snapshotId: snapshot.id,
        expectedRequestRevision: input.expectedRequestRevision,
        expectedAgentRevision: input.expectedAgentRevision,
        dependsOn: input.dependsOn,
      });
      changed();
      return { state: result.state, assignmentId: result.assignment.id, snapshot };
    });
  });
  handle('office:request-plan', value => {
    const input = assignmentInput.parse(value);
    return controller.handoffPlan(input.assignmentId);
  });
  handle('office:request-handoff', async value => {
    const input = assignmentInput.parse(value);
    return dispatch(async () => {
      const state = await controller.handoff(input.assignmentId);
      changed();
      return state;
    });
  });
  handle('office:request-observe', async value => {
    const input = assignmentInput.parse(value);
    return dispatch(async () => {
      // A completed observation may unlock dependent work — the same guarded chain-advance the
      // automatic path uses runs here, so manual and automatic observation settle identically.
      await controller.observe(input.assignmentId);
      const state = await controller.advanceLocalChain(input.assignmentId);
      changed();
      return state;
    });
  });
  handle('office:request-cancel-job', async value => {
    const input = assignmentInput.parse(value);
    return dispatch(async () => {
      const state = await controller.cancel(input.assignmentId);
      changed();
      return state;
    });
  });
  // Re-arm one failed or verified-unresolved pipeline hop: the command mints the next attempt on
  // the same assignment, then the normal launch path dispatches it — same guards, same evidence.
  handle('office:pipeline-retry-hop', async value => {
    const input = z
      .object({
        requestId: id,
        pipelineKey: z.string().trim().min(1).max(80),
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(value);
    return dispatch(async () => {
      store.execute({
        type: 'request.pipeline.retryHop',
        idempotencyKey: randomUUID(),
        requestId: input.requestId,
        pipelineKey: input.pipelineKey,
        expectedRevision: input.expectedRevision,
      });
      const assignment = (store.snapshot({ history: false }).assignments ?? []).find(
        item => item.requestId === input.requestId && item.pipelineKey === input.pipelineKey,
      );
      if (assignment)
        await launchPreparedHop(assignment.id, 'pipeline-retry-launch', 'The hop was re-armed but its launch');
      changed();
      return store.snapshot({ history: false });
    });
  });
  // A bounded, read-only preview of one recorded job output — the brief/report text a decision
  // binds to, fetched through the content-addressed object store and re-hashed before serving.
  handle('office:job-output-preview', async value => {
    const input = z
      .object({ jobId: id, path: z.string().min(1).max(1000) })
      .strict()
      .parse(value);
    const job = (store.snapshot({ history: false }).jobs ?? []).find(item => item.id === input.jobId);
    if (!job) throw new Error('Job not found.');
    const output = job.outputs.find(item => item.path === input.path);
    if (!output) throw new Error('That output is not recorded on this job.');
    if (!output.stored)
      throw new Error('The output was reported but its bytes were never durably stored — nothing to preview.');
    const workspace = workspaceDirectory(app.getPath('userData'));
    const bytes = await readFile(path.join(workspace, 'objects', output.sha256.slice(0, 2), output.sha256));
    if (createHash('sha256').update(bytes).digest('hex') !== output.sha256)
      throw new Error('Stored output object integrity failure — the bytes do not match the recorded identity.');
    const PREVIEW_BYTES = 64 * 1024;
    return {
      path: output.path,
      sha256: output.sha256,
      bytes: output.bytes,
      text: bytes.subarray(0, PREVIEW_BYTES).toString('utf8'),
      truncated: bytes.byteLength > PREVIEW_BYTES,
      verified: true as const,
    };
  });
  handle('office:request-discard-preparation', async value => {
    const input = assignmentInput.parse(value);
    return dispatch(async () => {
      const state = controller.discardPreparation(input.assignmentId);
      changed();
      return state;
    });
  });
  handle('office:request-link', value => {
    const input = z
      .object({
        assignmentId: id,
        externalId: z.string().trim().min(1).max(200),
        externalUrl: z.string().trim().max(2000),
      })
      .strict()
      .parse(value);
    const state = controller.link(input.assignmentId, input.externalId, input.externalUrl);
    changed();
    return state;
  });
  handle('office:verify-transport', async value => {
    const input = z.object({ provider: providerSchema }).strict().parse(value);
    // R1 containment: refuse before observing the account or spawning a terminal, so no path here can
    // create a session while the probe's intent, snapshot and duplicate handling remain unrepaired.
    assertTransportProbeAllowed();
    const transport = transportModuleStatus();
    if (!transport.available) throw new Error(transport.detail);
    if (input.provider !== 'claude') throw new Error('Only the Claude cloud transport can be verified.');
    return dispatch(async () => {
      const { observation } = await subscriptions.observe(input.provider);
      const model =
        store.snapshot({ history: false }).agents.find(agent => agent.provider === input.provider && !agent.removedAt)
          ?.model ??
        observation.models[0]?.id ??
        'opus';
      // One real session, on the user's own subscription, carrying only a generated fixture.
      const adapter = new PtyCloudAdapter({
        executable: () => subscriptions.toolPath('claude'),
        environment: () => subscriptionEnvironment(),
      });
      const result = await probeCloudTransport({
        store,
        adapter,
        stagingRoot: path.join(workspaceDirectory(app.getPath('userData')), 'probes'),
        model,
        observation,
      });
      changed();
      return { ...result, state: store.snapshot({ history: false }) };
    });
  });
  const pageLimit = z.number().int().min(1).max(500).optional();
  handle('office:chat-page', value =>
    store.officeChatPage(
      z
        .object({
          projectId: id.optional(),
          requestId: id.optional(),
          agentId: id.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().max(1000).optional(),
        })
        .strict()
        .parse(value),
    ),
  );
  handle('office:history-page', value =>
    store.historyPage(
      z
        .object({
          projectId: id.nullable().optional(),
          limit: pageLimit,
          cursor: z.number().int().positive().optional(),
        })
        .strict()
        .parse(value),
    ),
  );
  handle('office:log-page', value =>
    store.logPage(
      z
        .object({
          agentId: id.optional(),
          conversationId: z.string().max(200).optional(),
          limit: pageLimit,
          cursor: z.string().max(300).optional(),
        })
        .strict()
        .parse(value),
    ),
  );
  handle('office:job-events', value => {
    const input = z
      .object({ jobId: id, limit: pageLimit, cursor: z.string().max(300).optional() })
      .strict()
      .parse(value);
    return store.jobEventPage(input.jobId, input);
  });
  // The structured applied-report query: publicState strips jobEvents, so the applied-report UI
  // must query them rather than read the pushed snapshot (QO-LOCAL-REV F05/F06).
  handle('office:applied-reports', value => {
    const input = z.object({ jobId: id, limit: pageLimit }).strict().parse(value);
    return { entries: store.appliedReports(input.jobId, input.limit ?? 50) };
  });
  handle('office:local-session-summary', value => store.localSessionSummary(id.parse(value), localRecordDir));
  // The launch plan for one bound packet — where it lives, its proven hash, and the manual steps.
  handle('office:local-launch-plan', value => store.localLaunchPlan(id.parse(value), localRecordDir));
  // Retire one settled local session: packet dir moves under archive/ (bytes retained), then a
  // provider-side archive is attempted only through a supported exact-id verb. The result is
  // schema-validated at the boundary with a fresh summary of the post-retire record.
  handle('office:local-session-archive', value => {
    const assignmentId = id.parse(value);
    return dispatch(async () => {
      const { state, archive } = await controller.retireLocal(assignmentId);
      changed();
      const job = latestJobFor(state.jobs, assignmentId);
      const summary = job ? store.localSessionSummary(job.id, localRecordDir) : null;
      return { state, archive: localArchiveResultSchema.parse({ ...archive, summary }) };
    });
  });
  handle('office:migrate-legacy', value => {
    noInput(value);
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const result = store.migrateLegacyRequests();
    changed();
    return { ...result, state: store.snapshot({ history: false }) };
  });
  handle('office:state', value => {
    noInput(value);
    const state = store.snapshot({ history: false });
    return { ...state, capabilities: OfficeStore.capabilitiesForWindow(state) };
  });
  handle('office:message-page', value =>
    store.messagePage(
      z
        .object({
          agentId: id.optional(),
          requestId: id.optional(),
          limit: pageLimit,
          cursor: z.string().max(300).optional(),
        })
        .strict()
        .parse(value),
    ),
  );
  handle('office:research-page', value =>
    store.researchPage(
      z
        .object({
          projectId: id,
          branchId: id.optional(),
          kind: z.enum(['pipeline', 'trials']),
          limit: pageLimit,
          cursor: z.string().max(300).optional(),
          query: z.string().max(200).optional(),
        })
        .strict()
        .parse(value),
    ),
  );
  handle('office:research-insights', value => {
    const input = z.object({ projectId: id, branchId: id }).strict().parse(value),
      state = store.snapshot({ history: false });
    if (!state.branches?.some(b => b.id === input.branchId && b.projectId === input.projectId))
      throw new Error('Research branch is outside this project.');
    const branches = state.branches.filter(b => b.projectId === input.projectId),
      ids = new Set(branches.map(b => b.id));
    const records = { ...state, branches, trials: state.trials?.filter(t => ids.has(t.branchId)) },
      predictions = (state.predictions ?? []).filter(p => ids.has(p.branchId));
    const realised = Object.fromEntries(
      (state.pipeline ?? [])
        .filter(r => r.kind === 'FORECAST_OUTCOME' && ids.has(r.branchId))
        .map(r => (r.kind === 'FORECAST_OUTCOME' ? [r.predictionId, r.value] : [])),
    );
    return {
      calibration: calibration(predictions, realised),
      methods: compareMethods(
        records,
        branches.filter(b => b.parentBranchId === null).map(b => ({ name: b.name, lineageIds: [b.lineageId] })),
      ),
      ancestry: lineageAncestry(records, input.branchId),
    };
  });
  handle('office:research-export', async value => {
    const input = z.object({ branchId: id }).strict().parse(value),
      branch = store.snapshot({ history: false }).branches?.find(b => b.id === input.branchId);
    if (!branch) throw new Error('Research branch not found.');
    return transfer(async () => {
      const selected = await dialog.showSaveDialog({
        title: 'Export exact research evidence',
        defaultPath: 'research-evidence.zip',
      });
      if (selected.canceled || !selected.filePath)
        return { canceled: true, count: 0, message: '', state: store.snapshot({ history: false }) };
      rejectInternalDestination(selected.filePath);
      await artifacts.exportResearch(branch.id, selected.filePath);
      changed();
      return {
        canceled: false,
        count: 1,
        message: 'Research evidence exported with exact scope and verification limits.',
        state: store.snapshot({ history: false }),
      };
    });
  });
  handle('office:info', value => {
    noInput(value);
    const transport = transportModuleStatus();
    return {
      version: app.getVersion(),
      dataDirectory: workspaceDirectory(app.getPath('userData')),
      platform: process.platform,
      packaged: app.isPackaged,
      transportModule: transport.available,
      transportDetail: transport.detail,
    };
  });
  handle('office:command', async value => {
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    // Pipeline commands carry office-side minting after the durable command lands: the brief hop on
    // start, a refine hop per note, the remaining spec on confirm. They run inside the dispatch
    // serializer like every other request action; every other command keeps the plain sync path.
    const type = (value as { type?: string } | null | undefined)?.type;
    const requestId = (value as { requestId?: string } | null | undefined)?.requestId;
    const hasPipeline =
      !!requestId && !!store.snapshot({ history: false }).requests?.find(r => r.id === requestId)?.pipeline;
    const isPipeline =
      type === 'request.pipeline.note' ||
      type === 'request.pipeline.confirm' ||
      type === 'request.pipeline.decide' ||
      type === 'request.pipeline.retryHop' ||
      (type === 'request.start' && hasPipeline) ||
      // A pipeline cancel cascades to every open hop before the request row flips.
      (type === 'request.cancel' && hasPipeline);
    if (!isPipeline) {
      const state = store.execute(value);
      changed();
      return state;
    }
    return dispatch(async () => {
      if (type === 'request.pipeline.confirm') {
        // The whole spec must resolve before the phase flips — a refusal leaves the request briefing.
        // The recorded spec hash is always the office's own mint of the confirmed shape.
        const shape = (value as { shape?: 'FULL' | 'QUICK' }).shape;
        const gate = pipelineConfirmGate(store, requestId!, shape);
        if (!gate.ok) throw new Error(gate.detail);
        value = { ...(value as object), specHash: gate.specHash };
      }
      let state = store.execute(value);
      const request = state.requests?.find(r => r.id === requestId);
      if (request?.pipeline) {
        const workspace = workspaceDirectory(app.getPath('userData'));
        const ctx: PipelineMintContext = {
          store,
          snapshotFor: req =>
            prepareInputSnapshot({
              store,
              stagingRoot: path.join(workspace, 'snapshots'),
              objectRoot: workspace,
              projectId: req.projectId,
              requestId: req.id,
              requestRevision: req.revision,
              objective: req.objective,
            }),
          prepare: input => controller.prepare(input),
        };
        if (type === 'request.cancel') {
          // The durable cancel is already recorded; now every open hop gets its own recorded outcome —
          // cooperative sentinel and office-side kill where the office owns the process.
          await controller.cancelPipelineJobs(requestId!);
        } else if (type === 'request.start' && request.status === 'READY' && !request.blockers.length) {
          const minted = await mintPipelineBrief(ctx, request);
          if (!minted.minted)
            throw new Error(`The request is ready but its director brief could not be minted: ${minted.detail}`);
          // A re-start with the hop already launched is a no-op — only an INTENT job can hand off.
          await launchPreparedHop(
            minted.assignment!.id,
            'pipeline-brief-launch',
            'The director brief hop was minted but its automatic launch',
          );
        } else if (type === 'request.pipeline.note') {
          const minted = await mintPipelineRefine(ctx, request, String((value as { text?: string }).text ?? ''));
          if (!minted.minted)
            throw new Error(`The note is recorded but its refine hop could not be minted: ${minted.detail}`);
          await controller.reconcileLocalChain();
        } else if (type === 'request.pipeline.confirm') {
          await mintPipelineRound(ctx, request);
          await controller.reconcileLocalChain();
        } else if (type === 'request.pipeline.retryHop') {
          // The command minted the next attempt on the same assignment; launch it like any INTENT hop.
          const retried = (state.assignments ?? []).find(
            item =>
              item.requestId === request.id && item.pipelineKey === (value as { pipelineKey?: string }).pipelineKey,
          );
          if (retried)
            await launchPreparedHop(retried.id, 'pipeline-retry-launch', 'The hop was re-armed but its launch');
        } else if (type === 'request.pipeline.decide' && (value as { decision?: string }).decision === 'REVISE') {
          // The decision transaction minted the linked revision request; starting it runs the same
          // brief-mint path a user-initiated start would, so a REVISE always ends in a live round.
          const revision = (state.requests ?? [])
            .filter(r => r.revisionOf?.requestId === request.id)
            .sort((a, b) => (b.revisionOf?.round ?? 0) - (a.revisionOf?.round ?? 0))[0];
          if (revision && revision.status === 'DRAFT') {
            const started = store.execute({
              type: 'request.start',
              idempotencyKey: randomUUID(),
              requestId: revision.id,
              expectedRevision: revision.revision,
            });
            const fresh = started.requests?.find(r => r.id === revision.id);
            if (fresh?.status === 'READY' && !fresh.blockers.length) {
              const minted = await mintPipelineBrief(ctx, fresh);
              if (!minted.minted)
                throw new Error(
                  `The revision request was recorded but its director brief could not be minted: ${minted.detail}`,
                );
              await launchPreparedHop(
                minted.assignment!.id,
                'pipeline-brief-launch',
                "The revision's director brief hop was minted but its automatic launch",
              );
            }
          }
        }
        state = store.snapshot({ history: false });
      }
      changed();
      return state;
    });
  });
  // Evidence access is deliberately read-only and grant-checked inside the service, which is the only
  // place that resolves an object hash to bytes. The renderer never receives an object path.
  // Read-only research status, and the one write that gives a stage its people. Assignment is
  // append-only and never edits a profile, so a change of function is a dated decision on the record.
  handle('office:research-assign-function', value => {
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const input = z
      .object({
        projectId: id,
        stage: z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']),
        function: z.enum(['PRINCIPAL', 'CORRECTNESS_REVIEWER', 'ADVOCATE', 'SKEPTIC', 'CUSTODIAN', 'DIRECTOR']),
        agentId: id,
        expectedAgentRevision: z.number().int().nonnegative(),
        note: z.string().max(2000),
      })
      .strict()
      .parse(value);
    const state = store.appendFunctionAssignment({
      id: randomUUID(),
      projectId: input.projectId,
      stage: input.stage,
      function: input.function,
      agentId: input.agentId,
      agentRevision: input.expectedAgentRevision,
      appendedAt: new Date().toISOString(),
      supersededById: null,
      origin: 'EXPLICIT',
      note: input.note,
    });
    changed();
    return state;
  });
  handle('office:research-migrate-functions', value => {
    if (transferBusy) throw new Error('Wait for the file operation to finish.');
    const input = z
      .object({ projectId: id, stage: z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']) })
      .strict()
      .parse(value);
    const snapshot = store.snapshot({ history: false });
    const appended = migrateRolesToFunctions(snapshot, {
      projectId: input.projectId,
      stage: input.stage,
      now: new Date().toISOString(),
      existing: (snapshot.functions ?? []).filter(item => !item.supersededById),
      id: randomUUID,
    });
    let state = snapshot;
    for (const assignment of appended) state = store.appendFunctionAssignment(assignment);
    if (appended.length) changed();
    return { appended: appended.length, state };
  });
  handle('office:research-status', value => {
    const input = z
      .object({
        branchId: id,
        subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.enum(['SINGLE', 'GROUP', 'TEAM']),
      })
      .strict()
      .parse(value);
    const state = store.snapshot({ history: false });
    const branch = (state.branches ?? []).find(item => item.id === input.branchId);
    if (!branch) throw new Error('Research branch not found.');
    const functions = STAGE_FUNCTIONS_REQUIRED[branch.stage];
    const assignments = (state.functions ?? []).filter(item => !item.supersededById);
    const schedule = scheduleStage({
      state,
      records: state,
      assignments,
      branch,
      subjectHash: input.subjectHash,
      mode: input.mode,
      outputSchema: 'research-stage-report@1',
    });
    const integration = store.researchStageBlocker(branch.stage),
      promotion = promotable(state, branch, input.subjectHash, integration);
    const delivery = STAGE_DELIVERY[branch.stage];
    const pkg = (state.pipeline ?? [])
      .filter(r => r.kind === 'RUN_PACKAGE' && r.branchId === branch.id && r.branchRevision === branch.revision)
      .at(-1);
    const awaiting = pkg?.kind === 'RUN_PACKAGE' && pkg.state === 'AWAITING_RETURN' ? pkg : null;
    const caps = pipeline.capabilities();
    return {
      stage: branch.stage,
      outcome: branch.outcome,
      requiredFunctions: functions,
      functions: resolveFunctions(state, assignments, { projectId: branch.projectId, stage: branch.stage, functions }),
      tasks: schedule.tasks,
      scheduleBlockers: schedule.blockers
        .filter(b => !b.includes('execution and advancement are blocked'))
        .concat(integration ? [integration] : []),
      canPrepare:
        !integration &&
        branch.outcome === 'IN_PROGRESS' &&
        !state.projects.find(p => p.id === branch.projectId)?.archived &&
        (schedule.tasks.length > 0 || delivery !== 'AGENT'),
      canPromote: promotion.allowed,
      promotionBlockers: promotion.reasons,
      stageDelivery: delivery,
      manual: {
        canExport: branch.stage === 'S3' && branch.outcome === 'IN_PROGRESS' && !awaiting && !pkg,
        awaitingPackageId: awaiting ? awaiting.packageId : null,
        exportedAt: pkg?.kind === 'RUN_PACKAGE' ? pkg.exportedAt : null,
        canImport: !!awaiting,
        canValidate: delivery === 'OFFICE' && branch.outcome === 'IN_PROGRESS',
      },
      capabilities: {
        agentCommunication: {
          state: 'READY',
          detail:
            'Office-spawned local agents are launched and observed programmatically; the labeled terminal handoff remains available.',
        },
        agentToolExecution: {
          state: 'READY',
          detail:
            'Agent work runs on local CLI agents or through the terminal handoff; hosted dispatch requires the separately scoped provider route.',
        },
        manualExperimentHandoff: {
          state: caps.packageExport ? 'READY' : 'BLOCKED',
          detail: caps.packageExport
            ? 'Run-package export is configured.'
            : 'This build has no run-package author configured.',
        },
        returnValidation: {
          state: caps.returnValidation ? 'READY' : 'BLOCKED',
          detail: caps.returnValidation
            ? 'Bound-return validation is configured.'
            : 'This build has no return inspector configured.',
        },
        protectedEvaluation: {
          state: caps.independentRuntime ? 'READY' : 'NOT_CONFIGURED',
          detail: caps.independentRuntime
            ? 'Independent runtime is configured.'
            : 'No independent runtime or custodian is configured; stronger evidence is separately scoped.',
        },
      },
    };
  });
  // One stage action per call, run inside the dispatch admission so a restore cannot swap the
  // database mid-action. The renderer names the action; the service and the store re-check it.
  handle('office:pipeline', async value =>
    dispatch(async () => {
      const result = await pipeline.run(value);
      // The renderer refreshes after every stage action; a no-op action costs one extra state read.
      changed();
      return result;
    }),
  );
  handle('office:evidence-describe', value => evidence.describe(value));
  handle('office:evidence-read', value => evidence.read(value));
  handle('office:evidence-query', value => evidence.query(value));
  handle('office:evidence-packet', value => evidence.stagePacket(value));
  // Read-only memory surfaces: bounded search over the project's finding ledger and the
  // derived graph. Mutations go through office:command (memory.finding.note) or receipt ingest.
  handle('office:memory-search', value => {
    const input = z
      .object({
        projectId: id,
        text: z.string().trim().min(1).max(400),
        limit: z.number().int().min(1).max(25).optional(),
      })
      .strict()
      .parse(value);
    return { findings: store.searchMemoryFindings(input.projectId, input.text, input.limit) };
  });
  handle('office:memory-graph', value => store.memoryGraph(id.parse(value)));
  // The taskbar badge for items waiting on the user. A count only: no content leaves the window.
  // Desktop notifications ride the same channel: the renderer reports the count and a user-held
  // preference; the main process fires an OS notification only when the count grows while the
  // window is unfocused — a local signal, never provider-reported.
  let lastAttention = 0;
  let desktopNotifications = false;
  handle('office:desktop-notifications', value => {
    desktopNotifications = z.boolean().parse(value);
  });
  handle('office:attention', value => {
    const count = z.number().int().min(0).max(999).parse(value);
    if (!win || win.isDestroyed()) return;
    if (count > 0)
      win.setOverlayIcon(
        nativeImage.createFromBuffer(attentionBadgePng()),
        `${count} need${count === 1 ? 's' : ''} you`,
      );
    else win.setOverlayIcon(null, '');
    if (count === 0) win.flashFrame(false);
    else if (count > lastAttention && !win.isFocused()) {
      win.flashFrame(true);
      if (desktopNotifications && Notification.isSupported()) {
        const note = new Notification({
          title: 'Quant Research Office',
          body: `${count} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`,
          silent: true,
        });
        note.on('click', () => {
          if (!win || win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          win.focus();
        });
        note.show();
      }
    }
    lastAttention = count;
  });
  // Live presence of the children this office spawned: in memory, read-only, never an event-chain record.
  handle('office:presence', value => {
    noInput(value);
    return [...(exec?.presence() ?? []), ...(acp?.presence() ?? [])];
  });
  handle('office:preview', value => artifacts.preview(id.parse(value)));
  // Bounded content search over one project's stored text artifacts; the result carries the
  // scanned/skipped/truncated counts so the window can state exactly what was searched.
  handle('office:artifact-search', async value => {
    const input = z
      .object({ projectId: id, query: z.string().min(1).max(200) })
      .strict()
      .parse(value);
    return artifacts.searchContent(input.projectId, input.query);
  });
  // The taskbar progress the renderer reports from recorded job counts: -1 clears the bar,
  // [0,1] shows a fraction, >1 is indeterminate. A display signal only — never a stored record.
  handle('office:progress', value => {
    const progress = z.number().min(-1).max(2).parse(value);
    if (!win || win.isDestroyed()) return;
    win.setProgressBar(progress);
  });
  // One page of recorded local sessions for the usage history surface — office records only.
  handle('office:local-sessions', value => {
    const input = z
      .object({ projectId: id.optional(), limit: pageLimit, offset: z.number().int().min(0).max(100000).optional() })
      .strict()
      .parse(value);
    return store.localSessionFeed(input);
  });
  handle('office:import', async value => {
    const input = importSchema.parse(value);
    const state = store.snapshot({ history: false });
    if (
      !state.projects.some(p => p.id === input.projectId && !p.archived) ||
      (input.experimentId !== null &&
        !state.experiments.some(e => e.id === input.experimentId && e.projectId === input.projectId))
    )
      throw new Error('Select an active project and a matching experiment.');
    return transfer(async () => {
      const result = await dialog.showOpenDialog(win!, {
        title: input.kind === 'RESULT' ? 'Import your result files' : 'Attach research references',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return { canceled: true, count: 0, message: '', state: store.snapshot({ history: false }) };
      if (result.filePaths.length > 32) throw new Error('Import up to 32 files at a time.');
      let total = 0;
      for (const file of result.filePaths) {
        total += (await stat(file)).size;
        if (total > MAX_TOTAL) throw new Error('Selection exceeds 256 MiB.');
      }
      let count = 0;
      const failures: string[] = [];
      for (const file of result.filePaths) {
        try {
          await artifacts.importFile(file, input.projectId, input.experimentId, input.kind);
          count++;
        } catch (error) {
          failures.push(`${path.basename(file)}: ${error instanceof Error ? error.message : 'Import failed'}`);
        }
      }
      changed();
      return {
        canceled: false,
        count,
        message: `${count} file${count === 1 ? '' : 's'} stored. ${input.kind === 'RESULT' ? 'Results stay quarantined pending an approved run and hosted verification.' : 'References remain unclassified until agents are configured.'}${failures.length ? ' Failed: ' + failures.join('; ') : ''}`,
        state: store.snapshot({ history: false }),
      };
    });
  });
  handle('office:export', async value => {
    const projectId = id.parse(value);
    const p = store.snapshot({ history: false }).projects.find(p => p.id === projectId);
    if (!p) throw new Error('Project not found.');
    return transfer(async () => {
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export project planning archive',
        defaultPath: `${p.name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}.qro.zip`,
        filters: [{ name: 'Office planning archive', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath)
        return { canceled: true, count: 0, message: '', state: store.snapshot({ history: false }) };
      rejectInternalDestination(result.filePath);
      await artifacts.exportProject(projectId, result.filePath);
      changed();
      return {
        canceled: false,
        count: 1,
        message: 'Project planning archive exported. This is not an approved run package.',
        state: store.snapshot({ history: false }),
      };
    });
  });
  handle('office:backup', async value => {
    noInput(value);
    return transfer(async () => {
      const result = await dialog.showSaveDialog(win!, {
        title: 'Back up office workspace',
        defaultPath: `quant-office-backup-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: 'Workspace backup', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath)
        return { canceled: true, count: 0, message: '', state: store.snapshot({ history: false }) };
      rejectInternalDestination(result.filePath);
      await artifacts.backup(result.filePath);
      changed();
      return {
        canceled: false,
        count: 1,
        message: 'Workspace backup saved with database and artifact byte identities.',
        state: store.snapshot({ history: false }),
      };
    });
  });
  handle('office:restore', async value => {
    noInput(value);
    return transfer(async () => {
      const selection = await dialog.showOpenDialog(win!, {
        title: 'Restore a workspace backup',
        properties: ['openFile'],
        filters: [{ name: 'Office workspace backup', extensions: ['zip'] }],
      });
      if (selection.canceled || !selection.filePaths[0])
        return { canceled: true, count: 0, message: '', state: store.snapshot({ history: false }) };
      // A request action in flight holds the database that is about to be replaced. This is checked
      // before any candidate is prepared, and the lock then covers the whole preparation and commit, so
      // no action can be admitted during the awaits that follow.
      if (openRequestActions > 0 || activeWorkspaceCalls > 0)
        throw new Error('A workspace action is still running. Wait for it to finish before restoring a workspace.');
      const root = app.getPath('userData');
      workspaceLocked = true;
      let prepared;
      try {
        prepared = await prepareRestore(selection.filePaths[0], root);
      } catch (error) {
        workspaceLocked = false;
        throw error;
      }
      try {
        const decision = await dialog.showMessageBox(win!, {
          type: 'question',
          buttons: ['Cancel', 'Restore workspace'],
          defaultId: 0,
          cancelId: 0,
          title: 'Restore workspace',
          message: 'Replace the current workspace with this verified backup?',
          detail: `${prepared.summary}\n\nYour current workspace will be retained as a recovery copy. The office will reload after restoration.`,
        });
        if (decision.response !== 1) {
          // Refusing has to clean up the candidate it prepared, or a declined restore leaves bytes behind.
          await discardCandidate(prepared.candidate, root);
          return { canceled: true, count: 0, message: '', state: store.snapshot({ history: false }) };
        }
        subscriptions.cancel();
        store.close();
        try {
          await commitRestore(root, prepared.transactionId);
        } catch (error) {
          // The commit failed after the store was closed. Reopen whatever is there and clean the candidate
          // rather than leaving both a closed database and an orphaned candidate behind.
          try {
            await discardCandidate(prepared.candidate, root);
          } catch {
            /* the candidate may already be gone */
          }
          throw error;
        } finally {
          // Every service that held the old database is rebuilt against the new one. The controller was
          // previously left pointing at the closed store, so the next dispatch used a database that was gone.
          store = new OfficeStore(path.join(workspaceDirectory(root), 'workspace.sqlite'), {
            includeHistoryInResults: false,
          });
          artifacts = new ArtifactService(store, workspaceDirectory(root));
          evidence = new EvidenceService(store, workspaceDirectory(root));
          controller = buildController();
          // The journal survived the restore by living outside it; reconcile its view of spent allowances
          // against the reservations the restored workspace actually knows before anything new reserves.
          custody = buildCustody(root, workspaceDirectory(root));
          custody.reconcileAfterRestore(
            (store.snapshot({ history: false }).pipeline ?? [])
              .filter(r => r.kind === 'RESERVATION')
              .map(r => (r.kind === 'RESERVATION' ? r.reservation.id : '')),
          );
          pipeline = buildPipeline();
          storeEpoch++;
        }
        const state = store.snapshot({ history: false });
        setTimeout(() => win?.webContents.reload(), 100);
        return {
          canceled: false,
          count: 1,
          message: 'Workspace restored. Previous workspace retained in recovery.',
          state,
        };
      } finally {
        workspaceLocked = false;
      }
    });
  });
}
function rejectInternalDestination(destination: string) {
  const relative = path.relative(app.getPath('userData'), path.resolve(destination));
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Save exports outside the live workspace data folder.');
}
/** One place that wires the controller, so start-up and post-restore rebuild stay identical. */
function buildController(): AssignmentController {
  const workspace = () => workspaceDirectory(app.getPath('userData'));
  exec?.disposeAll();
  acp?.disposeAll();
  // A rebuilt controller drops the previous host channel — ask the old QRO-Agent host to kill its
  // children and exit before its requests dir is orphaned. The host also self-exits if the office
  // pid dies, so a missed shutdown costs it at most one watchdog tick.
  agentHost?.shutdown();
  agentHost = undefined;
  // LR-16: when the agent account credential exists, agent CLIs spawn through the QRO-Agent host
  // instead of under the office account. `QRO_AGENT_ISOLATION=off` is the documented dev/test/CI
  // escape hatch; with no credential the adapter self-spawns and records runAs 'self' either way.
  if (secrets.hasAgentCredential() && process.env.QRO_AGENT_ISOLATION !== 'off')
    agentHost = qroAgentSpawn({
      secrets,
      agentsRoot: path.join(workspace(), 'local-sessions'),
      log: line => writeLog(logDir(), 'WARN', line),
    });
  subscriptions.setIsolation(agentHost, path.join(workspace(), 'local-sessions', '.account-checks'));
  const outputs = new OutputService(store, workspace());
  const handoff = new TerminalHandoffAdapter({ executable: () => subscriptions.toolPath('claude') });
  const flat = new LocalMailboxAdapter(() => path.join(workspace(), 'local-sessions'));
  const tree = new LocalWorktreeMailboxAdapter(() => path.join(workspace(), 'local-repos'));
  // LOCAL_MAILBOX resolves through the persisted binding router: the layout each job's record
  // declares decides which adapter owns it, and pre-binding jobs take the named legacy rule —
  // never registration-order luck (QO-LOCAL-REV §5.3).
  const mailbox = new LocalSessionRouter(jobId => store.localSessionForJob(jobId), {
    FLAT_PACKET: flat,
    PROJECT_WORKTREE: tree,
  });
  // LOCAL_CLI_EXEC resolves through the same persisted binding, to the office-spawned adapter.
  // Both layout slots hold the exec adapter: a record misbound to the worktree layout lands on it
  // anyway and fails closed on its own flat-packet check instead of silently changing transport.
  // The child's environment is built per provider: the subscriptionEnvironment() scrub that
  // removes ACP_* and billing overrides, plus the one provider key variable when the user saved
  // their own key locally (LR-15). The secrets store is injected — the adapter never imports it.
  const localOptions: LocalCliExecOptions = {
    sessionsRoot: () => path.join(workspace(), 'local-sessions'),
    executable: provider => subscriptions.toolPath(provider),
    environment: provider => (agentHost ? subscriptionEnvironment() : agentEnvironment(provider, secrets)),
    providerFor: agentId => store.snapshot({ history: false }).agents.find(a => a.id === agentId)?.provider,
    // A spawned child's exit or a receipt write fires this — the office observes the job through the
    // same validated reader a manual Observe uses, then advances any dependent the completion
    // unlocked. It runs outside the request-action mutex; a refused or racing pass leaves the job
    // for the next trigger or startup reconciliation, never a silently claimed outcome.
    onLocalEvent: jobId => {
      void (async () => {
        if (workspaceLocked) return;
        try {
          const job = store.snapshot({ history: false }).jobs?.find(item => item.id === jobId);
          if (!job) return;
          await controller.observe(job.assignmentId);
          await controller.advanceLocalChain(job.assignmentId);
          win?.webContents.send('office:changed');
        } catch (error) {
          writeLog(logDir(), 'WARN', `automatic local observation failed job=${jobId} ${describeError(error)}`);
        }
      })();
    },
    // The evidence drop-box edge: caller identity is bound from the assignment record inside the
    // adapter — an agent's query file can never choose whose grants are checked.
    evidenceFrames: (caller, line) => handleEvidenceFrame(evidence, caller, line),
    // The launch record states which credential context the spawn used — metadata only, never a key.
    authMode: provider => (!agentHost && secrets.providerKeyState(provider).saved ? 'api-key' : 'subscription'),
    // LR-16: the isolated spawn surface, present only when a QRO-Agent credential is saved and the
    // escape hatch is not set. When it is, dispatches without a saved API key are refused — the
    // office profile's subscription sign-ins do not exist in the agent account's profile.
    spawnAs: agentHost,
    isolatedAccountVerified: context => subscriptions.isolatedAccountVerified(context),
  };
  exec = new LocalCliExecAdapter(localOptions);
  acp = new LocalAcpAdapter({
    ...localOptions,
    recoveryVerified: async job => {
      const frozen = store.snapshot({ history: false }).assignments?.find(item => item.id === job.assignmentId)?.frozen;
      if (!frozen) return false;
      const { observation } = await subscriptions.observe('devin');
      store.recordAccountObservation(observation);
      return (
        observation.state === 'SIGNED_IN' &&
        observation.identity === frozen.accountIdentity &&
        observation.credentialContext === frozen.credentialContext
      );
    },
  });
  // Children start, speak and end far faster than the window needs to hear about it: one push per second.
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  exec.onPresence = acp.onPresence = () => {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      win?.webContents.send('office:presence', [...(exec?.presence() ?? []), ...(acp?.presence() ?? [])]);
    }, 1000);
    presenceTimer.unref?.();
  };
  const execRoute = new LocalSessionRouter(
    jobId => store.localSessionForJob(jobId),
    { FLAT_PACKET: exec, PROJECT_WORKTREE: exec },
    'LOCAL_CLI_EXEC',
  );
  const acpRoute = new LocalSessionRouter(
    jobId => store.localSessionForJob(jobId),
    { FLAT_PACKET: acp, PROJECT_WORKTREE: acp },
    'LOCAL_ACP',
  );
  return new AssignmentController(
    store,
    handoff,
    undefined,
    // Verification is scoped to the staging root this office owns, so a snapshot pointing anywhere
    // else is refused rather than verified in place.
    snapshot => verifySnapshotForTransfer(snapshot, 'git', path.join(workspace(), 'snapshots')),
    // The fresh account check lives inside the controller, so every launch path runs it and no future
    // caller can reach one that skipped it. Committing it here makes it a durable fact, not a reading.
    async provider => {
      const { observation } = await subscriptions.observe(provider);
      store.recordAccountObservation(observation);
    },
    // Staging is disposable and a restore does not carry it. Rebuilding from the workspace's own
    // stored bytes is what makes prepared work survive a restore; the source folder is never reread.
    async snapshot => {
      const rebuilt = await reconstructSnapshot({
        snapshot,
        objectRoot: workspace(),
        stagingRoot: path.join(workspace(), 'snapshots'),
      });
      if (rebuilt.problems.length)
        throw new Error(`The prepared inputs could not be rebuilt: ${rebuilt.problems[0]} Prepare the request again.`);
      return rebuilt.stagingPath;
    },
    undefined,
    outputs.storeBytes,
    outputs.prepare,
    // Hosted work uses the labeled terminal handoff; local work uses the mailbox transport. Routes
    // and agents resolve only to the adapter that actually owns them — a miss fails closed, never a
    // silent fallback across environments.
    ref => {
      if (ref.route)
        return ref.route === handoff.route
          ? handoff
          : ref.route === mailbox.route
            ? mailbox
            : ref.route === execRoute.route
              ? execRoute
              : ref.route === acpRoute.route
                ? acpRoute
                : undefined;
      if (ref.agent)
        return ref.agent.execution === 'HOSTED_SETUP_REQUIRED'
          ? handoff
          : ref.agent.execution === 'LOCAL'
            ? ref.agent.localRoute === 'LOCAL_CLI_EXEC'
              ? execRoute
              : ref.agent.localRoute === 'LOCAL_ACP'
                ? acpRoute
                : mailbox
            : undefined;
      return undefined;
    },
    // Provider-side archive for retired packets — exact record identity, bounded output, and an
    // honest UNSUPPORTED where the provider ships no archive verb (claude/codex keep their history).
    createLocalProviderLifecycle(),
    // Dependent packets inherit predecessor outputs only as hash-verified bytes read back from the
    // content-addressed store — never a filename or a claim.
    outputs.readBytes,
  );
}
async function transfer<T>(fn: () => Promise<T>): Promise<T> {
  if (transferBusy) throw new Error('Another file dialog or transfer is already active.');
  transferBusy = true;
  try {
    return await fn();
  } finally {
    transferBusy = false;
  }
}
/**
 * Custody outside the workspace tree, with a capability that says only what this build can do.
 *
 * Sealed storage is a real directory the separation check verifies is unreachable from the
 * workspace, its backups and its evidence index. There is no isolated evaluator in this build, and
 * claiming otherwise would turn every S8 answer into a claim about software that does not exist.
 */
function buildCustody(root: string, workspace: string): HoldoutCustody {
  const paths = {
    sealedRoot: path.join(root, 'custody', 'sealed'),
    journalFile: path.join(root, 'custody', 'exposure-journal.jsonl'),
  };
  const separation = HoldoutCustody.separationBlocker(paths, workspace);
  return new HoldoutCustody(
    paths,
    {
      sealedStorageSupported: !separation,
      isolatedEvaluatorSupported: false,
      detail: separation ?? 'No isolated evaluator is configured in this build.',
    },
    null,
  );
}
/** The research pipeline acts on the live store, controller and evidence layer — rebuilt together after a restore. */
function buildPipeline(): PipelineService {
  const workspace = workspaceDirectory(app.getPath('userData'));
  return new PipelineService(
    store,
    controller,
    custody,
    input =>
      prepareInputSnapshot({
        store,
        stagingRoot: path.join(workspace, 'snapshots'),
        objectRoot: workspace,
        projectId: input.projectId,
        requestId: input.requestId,
        requestRevision: input.requestRevision,
        objective: input.objective,
      }),
    hash => evidence.bytes(hash),
    () => new Date().toISOString(),
    null,
    {
      selectHoldout: async () => {
        const selected = await dialog.showOpenDialog({
          title: 'Register holdout in separate custody',
          properties: ['openFile'],
        });
        if (selected.canceled) return null;
        const file = selected.filePaths[0],
          metadata = await stat(file);
        if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024)
          throw new Error('Holdout import must be a file no larger than 64 MiB.');
        return readFile(file);
      },
      exportHoldout: async bytes => {
        const selected = await dialog.showSaveDialog({
          title: 'Export exposed holdout — user custody',
          defaultPath: 'holdout-user-custody.bin',
        });
        if (selected.canceled || !selected.filePath) return;
        rejectInternalDestination(selected.filePath);
        await writeFile(selected.filePath, bytes, { flag: 'wx', flush: true });
      },
      writeObject: async bytes => {
        const sha256 = createHash('sha256').update(bytes).digest('hex'),
          file = path.join(workspace, 'objects', sha256.slice(0, 2), sha256);
        await mkdir(path.dirname(file), { recursive: true });
        if (!existsSync(file)) {
          const temporary = file + '.' + randomUUID() + '.pending';
          await writeFile(temporary, bytes, { flag: 'wx', flush: true });
          await rename(temporary, file);
        } else if (
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex') !== sha256
        )
          throw new Error('Stored report object integrity failure.');
        return { sha256, bytes: bytes.length };
      },
      // The user takes the exported package to Colab by hand; this only writes it somewhere they can.
      exportPackage: async (bytes, packageId) => {
        const selected = await dialog.showSaveDialog({
          title: 'Export run package for your manual Colab run',
          defaultPath: `run-package-${packageId.slice(0, 8)}.zip`,
        });
        if (selected.canceled || !selected.filePath) return null;
        rejectInternalDestination(selected.filePath);
        await writeFile(selected.filePath, bytes, { flag: 'wx', flush: true });
        return selected.filePath;
      },
    },
    (() => {
      const codec = createRunPackageCodec({ templatesDir: path.join(app.getAppPath(), 'research-templates') });
      return { build: codec, inspect: codec };
    })(),
  );
}

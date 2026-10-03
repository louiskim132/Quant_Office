/** Helpers for the existing user-assisted UI harness. Importing this module never dispatches. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { OfficeAPI, Provider, ProviderJob } from '../src/shared/types.js';

export const ACCEPTANCE_MARKER = '.qro-isolation-acceptance.json';
export const PROJECT_NAME = 'LR-16b synthetic isolation acceptance';
export const ROSTER_NAMES = [
  'Test dir 1',
  'Test PM A',
  'Test PM B',
  'Test PM C',
  'Test PM D',
  'Test worker 1',
  'Test worker 2',
];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

export function scratchPath(root: string, file: string): string {
  const relative = path.relative(realpathSync(root), realpathSync(file));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Acceptance files must stay inside the marked scratch root.');
  return file;
}
export function requireScratch(root: string): void {
  const marker = JSON.parse(readFileSync(path.join(root, ACCEPTANCE_MARKER), 'utf8'));
  if (marker.version !== 1 || marker.purpose !== 'SYNTHETIC_ISOLATION_ACCEPTANCE')
    throw new Error('Dispatch needs an explicitly marked synthetic scratch root.');
}
export function verifyProbe(text: string, nonce: string): boolean {
  const probe = JSON.parse(text.replace(/^\uFEFF/, ''));
  return probe.nonce === nonce && /(^|\\)qro-agent$/i.test(probe.whoami) && probe.officePathDenied === true;
}
export function sameJobs(before: ProviderJob[], after: ProviderJob[]): boolean {
  return (
    JSON.stringify(before.map(j => [j.id, j.assignmentId, j.externalId]).sort()) ===
    JSON.stringify(after.map(j => [j.id, j.assignmentId, j.externalId]).sort())
  );
}
function running(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) throw new Error('Synthetic probe supplied an invalid PID.');
  return (
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'RUNNING' } else { 'STOPPED' }`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ).trim() === 'RUNNING'
  );
}

export async function dispatchAcceptance(options: {
  root: string;
  provider: Provider;
  agentName?: string;
  api: () => OfficeAPI;
  restart: () => Promise<void>;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const { root, provider } = options;
  requireScratch(root);
  const report: Record<string, unknown> = {
    schema: 'qro-isolation-dispatch-acceptance@1',
    accepted: false,
    provider,
    startedAt: new Date().toISOString(),
    scope: 'SYNTHETIC_SUBSCRIPTION_ISOLATION',
    dispatch: 'NOT_RUN',
    identityAndDenial: 'NOT_RUN',
    durableOutput: 'NOT_RUN',
    wholeTreeCancel: 'NOT_RUN',
    restartNonduplication: 'NOT_RUN',
  };
  const save = () => writeFileSync(path.join(root, `dispatch-${provider}.json`), JSON.stringify(report, null, 2));
  let active: string | undefined;
  try {
    const info = await options.api().getInfo();
    const data = path.join(root, 'userData');
    if (realpathSync(info.dataDirectory) !== realpathSync(path.join(data, 'workspace')))
      throw new Error('App data directory is not this scratch profile.');
    scratchPath(root, data);
    const state = await options.api().getState();
    if (state.projects.some(p => p.name !== PROJECT_NAME))
      throw new Error('Scratch profile contains unrelated projects.');
    if (
      !(await options
        .api()
        .agentIsolationStatus()
        .then(s => s.configured))
    )
      throw new Error('Isolation is not configured.');
    const isolation = await options.api().agentIsolationVerify();
    report.isolation = isolation;
    if (!isolation.passed) throw new Error('Independent isolation checks did not pass.');
    const agent = state.agents.find(
      a =>
        a.provider === provider &&
        ROSTER_NAMES.includes(a.name) &&
        (!options.agentName || a.name === options.agentName) &&
        !a.removedAt &&
        !a.deletedAt &&
        a.execution === 'LOCAL' &&
        a.localRoute === 'LOCAL_CLI_EXEC',
    );
    if (!agent)
      throw new Error(
        'Create a standard scratch roster profile through the official UI first. No sign-in is initiated by dispatch.',
      );
    report.agent = { id: agent.id, name: agent.name, model: agent.model, effort: agent.effort };
    const checked = await options.api().connectionStatus(provider);
    if (!checked.connected || checked.account !== agent.account)
      throw new Error('Scratch provider identity does not match the chosen profile.');
    await options
      .api()
      .bindAgentConnection({ agentId: agent.id, expectedRevision: agent.revision ?? 0, intent: 'VERIFY' });
    const nonce = randomUUID();
    const source = path.join(root, 'synthetic-source', nonce);
    mkdirSync(source, { recursive: true });
    const denied = path.join(data, 'office-denial-canary.txt');
    writeFileSync(denied, 'Synthetic office-only canary. Never return its contents.');
    const probeScript = [
      '$ErrorActionPreference = "Stop"',
      '$denied = $false',
      `try { [void][IO.File]::ReadAllText(${quote(denied)}) } catch { $denied = $_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException] }`,
      `$result = @{ nonce = ${quote(nonce)}; whoami = (& whoami); officePathDenied = $denied }`,
      '[void][IO.Directory]::CreateDirectory("outputs")',
      '[IO.File]::WriteAllText((Join-Path (Get-Location) "outputs/isolation-probe.json"), ($result | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))',
    ].join('\n');
    writeFileSync(path.join(source, 'probe.ps1'), probeScript);
    const childScript = `while ($true) { [IO.File]::AppendAllText((Join-Path (Get-Location) 'cancel-heartbeat.txt'), ${quote(nonce)} + [Environment]::NewLine); Start-Sleep -Milliseconds 200 }`;
    const encoded = Buffer.from(childScript, 'utf16le').toString('base64');
    writeFileSync(
      path.join(source, 'cancel.ps1'),
      [
        `$child = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-EncodedCommand', ${quote(encoded)} -PassThru -WindowStyle Hidden -WorkingDirectory (Get-Location).Path`,
        `[IO.File]::WriteAllText((Join-Path (Get-Location) 'cancel-pids.json'), (@{ nonce = ${quote(nonce)}; parent = $PID; child = $child.Id } | ConvertTo-Json))`,
        'Wait-Process -Id $child.Id',
      ].join('\n'),
    );
    report.syntheticInputs = ['probe.ps1', 'cancel.ps1'].map(file => ({
      file,
      sha256: hash(readFileSync(path.join(source, file))),
    }));
    const projectState = state.projects.length
      ? state
      : await options.api().command({
          type: 'project.create',
          idempotencyKey: randomUUID(),
          name: PROJECT_NAME,
          mandate: 'Synthetic isolation acceptance only. No research or real user inputs.',
          budgetCents: 0,
        });
    const project = projectState.projects.find(p => p.name === PROJECT_NAME)!;
    const location = projectState.locations?.find(l => l.projectId === project.id);
    await options.api().command({
      type: 'location.save',
      idempotencyKey: randomUUID(),
      projectId: project.id,
      expectedRevision: location?.revision ?? 0,
      localFolder: source,
      inputPaths: ['probe.ps1', 'cancel.ps1'],
      outputFolder: '',
    });
    const launch = async (suffix: string, objective: string) => {
      const fresh = await options.api().getState();
      const profile = fresh.agents.find(a => a.id === agent.id)!;
      const requestState = await options.api().command({
        type: 'request.create',
        idempotencyKey: randomUUID(),
        projectId: project.id,
        name: `Isolation ${provider} ${nonce} ${suffix}`,
        hypothesis: objective,
        workType: 'OTHER',
        mode: 'SINGLE',
        leadAgentId: agent.id,
        participantIds: [],
      });
      const request = requestState.requests!.find(r => r.name === `Isolation ${provider} ${nonce} ${suffix}`)!;
      const prepared = await options.api().prepareRequest({
        requestId: request.id,
        expectedRequestRevision: request.revision,
        agentId: agent.id,
        expectedAgentRevision: profile.revision ?? 0,
      });
      active = prepared.assignmentId;
      await options.api().openHandoffTerminal({ assignmentId: active });
      return active;
    };
    const deadline = () => Date.now() + Math.min(options.timeoutMs ?? 180000, 600000);
    const waitJob = async (assignmentId: string, wanted: ProviderJob['state'][]) => {
      const until = deadline();
      while (Date.now() < until) {
        const current = await options.api().observeJob({ assignmentId });
        const job = current.jobs!.find(j => j.assignmentId === assignmentId)!;
        if (wanted.includes(job.state)) return job;
        if (['FAILED', 'CANCEL_ACKNOWLEDGED', 'COMPLETED'].includes(job.state))
          throw new Error(`Expected ${wanted}, got ${job.state}: ${job.detail}`);
        await pause(1000);
      }
      throw new Error(`Timed out waiting for ${wanted}`);
    };
    const assignment = await launch(
      'output',
      'Synthetic acceptance only. No research, network or delegation. Read packet.json and CONTRACT.md. Run selected input probe.ps1 with powershell.exe -NoProfile -File from the packet working directory. Do not edit it. Produce outputs/isolation-probe.json and a valid byte/hash-correct result.json per CONTRACT.md. Do not access any other office file. Finish promptly.',
    );
    report.dispatch = 'STARTED';
    save();
    const completed = await waitJob(assignment, ['COMPLETED']);
    active = undefined;
    report.job = completed;
    const output = completed.outputs.find(o => o.path === 'outputs/isolation-probe.json');
    if (!output?.stored) throw new Error('Probe output was not durably stored.');
    const preview = await options.api().jobOutputPreview({ jobId: completed.id, path: output.path });
    report.durableOutput =
      preview.verified && preview.sha256 === output.sha256 && preview.bytes === output.bytes ? 'PASS' : 'FAIL';
    report.probeOutput = preview;
    report.identityAndDenial = verifyProbe(preview.text, nonce) ? 'PASS_PROVIDER_REPORTED' : 'FAIL';
    const cancelAssignment = await launch(
      'cancel',
      'Synthetic cancellation acceptance only. No research, network or delegation. Read packet.json and CONTRACT.md. Run selected input cancel.ps1 unchanged with powershell.exe -NoProfile -File in the packet directory. It starts a synthetic child and heartbeat. Wait for it; do not finish or write result.json. The office will cancel this run.',
    );
    const until = deadline();
    let pids: { nonce: string; parent: number; child: number } | undefined;
    let heartbeat = '';
    while (Date.now() < until) {
      const current = await options.api().getState();
      const summary = await options
        .api()
        .localSessionSummary(current.jobs!.find(j => j.assignmentId === cancelAssignment)!.id);
      if (summary) {
        const cwd = scratchPath(root, summary.cwdDisplay);
        const pidFile = path.join(cwd, 'cancel-pids.json');
        heartbeat = path.join(cwd, 'cancel-heartbeat.txt');
        if (existsSync(pidFile) && existsSync(heartbeat)) {
          pids = JSON.parse(readFileSync(scratchPath(root, pidFile), 'utf8'));
          break;
        }
      }
      await pause(1000);
    }
    if (!pids || pids.nonce !== nonce || !running(pids.parent) || !running(pids.child))
      throw new Error('No live synthetic parent/child cancellation probe was observed.');
    const beforeHeartbeat = readFileSync(scratchPath(root, heartbeat));
    await pause(1000);
    if (hash(beforeHeartbeat) === hash(readFileSync(heartbeat)))
      throw new Error('Synthetic child heartbeat did not advance before cancellation.');
    await options.api().cancelJob({ assignmentId: cancelAssignment });
    // An office process-tree kill settles as FAILED, accurately distinct from provider ACK.
    const canceled = await waitJob(cancelAssignment, ['FAILED', 'CANCEL_ACKNOWLEDGED']);
    active = undefined;
    await pause(1000);
    const stoppedHeartbeat = readFileSync(heartbeat);
    await pause(3000);
    report.wholeTreeCancel =
      !running(pids.parent) && !running(pids.child) && hash(stoppedHeartbeat) === hash(readFileSync(heartbeat))
        ? 'PASS_OFFICE_LOCAL'
        : 'FAIL';
    report.cancel = { pids, job: canceled, heartbeatSha256: hash(stoppedHeartbeat) };
    const before = (await options.api().getState()).jobs ?? [];
    save();
    await options.restart();
    await pause(3000);
    const after = (await options.api().getState()).jobs ?? [];
    const restoredOutput = await options.api().jobOutputPreview({ jobId: completed.id, path: output.path });
    report.restartOutput = {
      sha256: restoredOutput.sha256,
      bytes: restoredOutput.bytes,
      verified: restoredOutput.verified,
    };
    report.restartNonduplication =
      sameJobs(before, after) &&
      restoredOutput.verified &&
      restoredOutput.sha256 === output.sha256 &&
      restoredOutput.bytes === output.bytes
        ? 'PASS_OFFICE_LOCAL'
        : 'FAIL';
    report.restartObservationWindowMs = 3000;
    report.restartJobs = after.map(j => ({
      id: j.id,
      assignmentId: j.assignmentId,
      externalId: j.externalId,
      state: j.state,
    }));
    report.dispatch = 'COMPLETED';
    report.accepted =
      report.identityAndDenial === 'PASS_PROVIDER_REPORTED' &&
      report.durableOutput === 'PASS' &&
      report.wholeTreeCancel === 'PASS_OFFICE_LOCAL' &&
      report.restartNonduplication === 'PASS_OFFICE_LOCAL';
  } catch (error) {
    report.error = String(error);
  } finally {
    if (active) {
      try {
        await options.api().cancelJob({ assignmentId: active });
        report.cleanup = 'CANCEL_REQUESTED';
      } catch (error) {
        report.cleanup = String(error);
      }
    }
    report.finishedAt = new Date().toISOString();
    save();
  }
  return report;
}

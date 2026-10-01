import path from 'node:path';
import { AcpClient, AcpPacketChild } from './acp-client.js';
import { LocalCliExecAdapter, spawnTreeKillable, type LocalCliExecOptions, type CliSpawn } from './local-cli-exec.js';
import type { ObserveResult, SubmitContext } from './controller.js';
import type { ProviderJob } from '../shared/types.js';
import type { LocalSessionRecord } from '../shared/local-session.js';

/** ACP carries prompts and tool updates; the existing bound packet contract still admits outputs. */
export class LocalAcpAdapter extends LocalCliExecAdapter {
  private readonly children: Map<string, AcpPacketChild>;
  private readonly native: CliSpawn;
  private readonly recovered = new Set<string>();
  private readonly recoveryAfter = new Map<string, number>();
  constructor(
    private readonly config: LocalCliExecOptions & {
      recoveryVerified?: (job: ProviderJob) => Promise<boolean>;
    },
  ) {
    const children = new Map<string, AcpPacketChild>();
    const native = config.spawnAs ?? config.spawnChild ?? spawnTreeKillable;
    const wrapper: CliSpawn = (executable, args, options) => {
      const child = new AcpPacketChild(native, executable, args, options);
      children.set(options.cwd, child);
      return child;
    };
    super({ ...config, route: 'LOCAL_ACP', spawnChild: wrapper, spawnAs: config.spawnAs ? wrapper : undefined });
    this.native = native;
    this.children = children;
  }
  private directory(local: LocalSessionRecord): string {
    return path.resolve(this.config.sessionsRoot(), local.storageRelativePath);
  }
  override async submit(context: SubmitContext) {
    if (context.payload.delegation)
      throw new Error(
        'ACP does not expose a verified delegation control; disable delegation before preparing this work.',
      );
    return super.submit(context);
  }
  override async observe(
    job: ProviderJob,
    local?: LocalSessionRecord | null,
    replay?: { receiptHash: string },
  ): Promise<ObserveResult> {
    const { providerGrouping: _fileGrouping, ...result } = await super.observe(job, local, replay);
    if (!local || local.layout !== 'FLAT_PACKET' || local.packetVersion !== 2) return result;
    const child = this.children.get(this.directory(local));
    if (
      child &&
      result.state === 'UNKNOWN' &&
      child.exited &&
      (child.stopReason === 'cancelled' || child.providerError)
    )
      return {
        ...result,
        state: 'FAILED',
        detail: child.providerError ?? 'ACP session/prompt returned stopReason=cancelled.',
        provenance: 'PROVIDER_REPORTED',
        ...(child.sessionId ? { providerGrouping: { key: child.sessionId, kind: 'ACP session/new reply' } } : {}),
      };
    if (child?.sessionId)
      return { ...result, providerGrouping: { key: child.sessionId, kind: 'ACP session/new reply' } };
    // A restart never submits another prompt. Only an identity already observed and committed by
    // the controller may be loaded, after a fresh matching account check. Packet files are not authority.
    if (
      result.state === 'UNKNOWN' &&
      !this.recovered.has(job.id) &&
      Date.now() >= (this.recoveryAfter.get(job.id) ?? 0) &&
      local.groupingStatus === 'OBSERVED' &&
      local.providerSessionId &&
      this.config.recoveryVerified &&
      (await this.config.recoveryVerified(job))
    ) {
      this.recoveryAfter.set(job.id, Date.now() + 30_000);
      let client: AcpClient | undefined;
      try {
        client = new AcpClient(
          this.native,
          this.config.executable?.('devin') ?? 'devin',
          ['acp'],
          {
            cwd: this.directory(local),
            env: this.config.environment?.('devin') ?? {},
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
          () => {},
          local.toolProfile,
        );
        const initialized = await client.initialize();
        if (!initialized.agentCapabilities?.loadSession) throw new Error('Provider does not support session/load.');
        await client.load(local.providerSessionId);
        this.recovered.add(job.id);
        return {
          ...result,
          detail:
            result.detail +
            ' ACP loaded the recorded session without another prompt; a valid bound receipt is still required.',
          providerGrouping: { key: local.providerSessionId, kind: 'ACP session/load reply' },
        };
      } catch (error) {
        return { ...result, detail: result.detail + ' ACP reconciliation failed: ' + String(error).slice(0, 800) };
      } finally {
        client?.stop();
      }
    }
    return result;
  }
  override async cancel(job: ProviderJob, local?: LocalSessionRecord | null) {
    const child = local && this.children.get(this.directory(local));
    const acknowledged = child ? await child.cancelTurn() : false;
    const result = await super.cancel(job, local);
    return {
      ...result,
      detail:
        result.detail +
        (acknowledged
          ? ' ACP session/prompt returned stopReason=cancelled.'
          : ' No ACP cancellation acknowledgement was observed.'),
    };
  }
  override settled(job: ProviderJob): void {
    super.settled(job);
    if (['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'].includes(job.state)) {
      for (const [key, child] of this.children) if (child.exited) this.children.delete(key);
      this.recovered.delete(job.id);
      this.recoveryAfter.delete(job.id);
    }
  }
  override disposeAll(): void {
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    super.disposeAll();
  }
}

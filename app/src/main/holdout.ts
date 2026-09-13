import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,openSync,closeSync,unlinkSync,renameSync } from 'node:fs';
import path from 'node:path';
import { canonicalHash } from '../core/canonical.js';
import { parseStrictJson } from '../core/strict-json.js';
import {
  custodyBlocker, holdoutSchema,journalEntrySchema, quarterOf, reservationSchema, unsealBlockers, ZERO_HASH,
  type CustodyCapability, type EvaluatorResult, type ExposureJournalEntry, type Holdout,
  type HoldoutReservation, type IsolatedEvaluator,
} from '../shared/holdout.js';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export interface CustodyPaths {
  /** Sealed bytes, deliberately outside the workspace the evidence layer and backups can reach. */
  sealedRoot: string;
  /** The exposure journal, deliberately outside anything a restore replaces. */
  journalFile: string;
}

export interface ReserveRequest {
  holdout: Holdout; lineageId: string; branchId: string; candidateHash: string; refitHash: string;
  queryHash?:string;
  gates: { gate: string; outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'BLOCKED' }[];
  adjudication: 'UPHELD' | 'REVISION_REQUIRED' | 'FOLLOW_UP_GRANTED' | 'LINEAGE_SUSPENDED' | null;
}

/**
 * Custody of the final holdouts: the allowance, the journal and the one-way door.
 *
 * Two rules make the rest of this readable. The journal is written before the data moves, so the
 * office's worst case is believing a holdout was spent when it was not — which costs an allowance
 * and protects the result. And the journal, not the database, is the authority on what has been
 * spent, so restoring an older workspace cannot return an allowance that was already used.
 */
export class HoldoutCustody {
  get status(){return {available:!custodyBlocker(this.capability),verification:this.capability.verification??'USER_IMPORTED' as const,detail:custodyBlocker(this.capability)??this.capability.detail};}
  private locked<T>(operation:()=>T):T {
    mkdirSync(path.dirname(this.paths.journalFile),{recursive:true});
    const lock=this.paths.journalFile+'.lock';
    let fd:number;
    try{fd=openSync(lock,'wx');}catch{
      let dead=false;
      try{const owner=JSON.parse(readFileSync(lock,'utf8')) as {pid:number};if(Number.isSafeInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){dead=(e as NodeJS.ErrnoException).code==='ESRCH';}}}catch{}
      if(!dead)throw new Error('Custody journal is busy or interrupted. Reconcile the existing operation before retrying.');
      unlinkSync(lock);fd=openSync(lock,'wx');
    }
    writeFileSync(fd,JSON.stringify({pid:process.pid}));
    try{return operation();}finally{closeSync(fd);unlinkSync(lock);}
  }
  private assertReservation(reservation:HoldoutReservation,holdout?:Holdout):void {
    const last=this.journal().filter(e=>e.reservationId===reservation.id).at(-1);
    if(!last||last.kind!=='RESERVED'||last.holdoutId!==reservation.holdoutId||last.lineageId!==reservation.lineageId
      ||last.candidateHash!==reservation.candidateHash||last.period!==reservation.period
      ||(last.refitHash!==undefined&&last.refitHash!==reservation.refitHash)||(last.queryHash!==undefined&&last.queryHash!==reservation.queryHash)
      ||(holdout&&(holdout.id!==reservation.holdoutId||holdout.projectId!==reservation.projectId)))throw new Error('Reservation differs from authoritative custody or has already been spent.');
  }
  constructor(
    private readonly paths: CustodyPaths,
    private readonly capability: CustodyCapability,
    private readonly evaluator: IsolatedEvaluator | null,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  // ---- journal ---------------------------------------------------------------------------------
  register(input:{projectId:string;name:string;timezoneOffsetMinutes:number;allowancePerPeriod:number;bytes:Uint8Array}):Holdout{
    return this.locked(()=>{
      const file=this.paths.journalFile+'.registrations.json';
      const records:Holdout[]=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).map((r:unknown)=>holdoutSchema.parse(r)):[];
      const sealedHash=sha256(input.bytes),prior=records.find(r=>r.sealedHash===sealedHash);
      if(prior){
        if(prior.projectId!==input.projectId||prior.timezoneOffsetMinutes!==input.timezoneOffsetMinutes||prior.allowancePerPeriod!==input.allowancePerPeriod)throw new Error('These sealed bytes already have an immutable custody scope and allowance policy.');
        return prior;
      }
      const sealed=this.seal(input.bytes),record=holdoutSchema.parse({id:randomUUID(),projectId:input.projectId,name:input.name,...sealed,periodPolicy:'CALENDAR_QUARTER',timezoneOffsetMinutes:input.timezoneOffsetMinutes,allowancePerPeriod:input.allowancePerPeriod,createdAt:this.now()});
      writeFileSync(file+'.pending',JSON.stringify([...records,record]),{encoding:'utf8',flush:true});renameSync(file+'.pending',file);return record;
    });
  }

  /**
   * The whole journal, with its chain verified.
   *
   * A break in the chain is not repaired or skipped. An exposure record that can be edited is not an
   * exposure record, so a broken journal makes every holdout it covers unusable until a person
   * decides what happened.
   */
  journal(): ExposureJournalEntry[] {
    const checkpoint=this.paths.journalFile+'.head';
    if (!existsSync(this.paths.journalFile)){
      if(existsSync(checkpoint))throw new Error('The exposure journal is missing after a durable checkpoint. Exposure cannot be reset.');
      return [];
    }
    const lines = readFileSync(this.paths.journalFile, 'utf8').split(/\r?\n/).filter(line => line.trim().length > 0);
    const entries: ExposureJournalEntry[] = [];
    let previousHash = ZERO_HASH;
    for (const [index, line] of lines.entries()) {
      const entry = journalEntrySchema.parse(parseStrictJson(line));
      if (entry.sequence !== index + 1) throw new Error(`The exposure journal is out of order at line ${index + 1}. It cannot be used to decide what has been spent.`);
      if (entry.previousHash !== previousHash) throw new Error(`The exposure journal's chain breaks at entry ${entry.sequence}. Treat every holdout it covers as possibly exposed.`);
      const { hash, ...body } = entry;
      if (canonicalHash(body) !== hash) throw new Error(`Exposure journal entry ${entry.sequence} does not match its own hash.`);
      entries.push(entry);
      previousHash = hash;
    }
    if(existsSync(checkpoint)){
      const head=parseStrictJson(readFileSync(checkpoint,'utf8')) as {sequence:number;hash:string};
      if(!Number.isSafeInteger(head.sequence)||head.sequence<1||entries[head.sequence-1]?.hash!==head.hash)throw new Error('The exposure journal was truncated or differs from its non-restorable checkpoint.');
    }
    return entries;
  }

  private write(body: Omit<ExposureJournalEntry, 'sequence' | 'previousHash' | 'hash'>): ExposureJournalEntry {
    const existing = this.journal();
    const previous = existing.at(-1);
    const withChain = { ...body, sequence: (previous?.sequence ?? 0) + 1, previousHash: previous?.hash ?? ZERO_HASH };
    const entry = journalEntrySchema.parse({ ...withChain, hash: canonicalHash(withChain) });
    mkdirSync(path.dirname(this.paths.journalFile), { recursive: true });
    // Appended and flushed before the caller is told anything succeeded. If the process dies on the
    // next line, the record of a possible exposure is already durable.
    appendFileSync(this.paths.journalFile, JSON.stringify(entry) + '\n',{encoding:'utf8',flush:true});
    const temporary=this.paths.journalFile+'.head.pending';
    writeFileSync(temporary,JSON.stringify({sequence:entry.sequence,hash:entry.hash}),{encoding:'utf8',flush:true});
    renameSync(temporary,this.paths.journalFile+'.head');
    return entry;
  }

  /** How much of one period's allowance the journal says is gone, for one holdout. */
  spent(holdoutId: string, period: string): { used: number; unknown: number; reservationIds: string[] } {
    const relevant = this.journal().filter(entry => entry.holdoutId === holdoutId && entry.period === period);
    const byReservation = new Map<string, ExposureJournalEntry[]>();
    for (const entry of relevant) byReservation.set(entry.reservationId, [...(byReservation.get(entry.reservationId) ?? []), entry]);
    let used = 0, unknown = 0;
    const ids: string[] = [];
    for (const [reservationId, entries] of byReservation) {
      const last = entries.at(-1)!;
      if (last.kind === 'RELEASED') continue;
      if (last.kind === 'UNKNOWN_AFTER_RESTORE') unknown++;
      used++;
      ids.push(reservationId);
    }
    return { used, unknown, reservationIds: ids };
  }

  // ---- reservation -----------------------------------------------------------------------------

  /**
   * Claims one look at a holdout, or explains why it cannot be claimed.
   *
   * The allowance check and the journal write are one step, and the journal is re-read immediately
   * before writing, so two admissions racing for the last slot cannot both find it free: the second
   * one's own chain read includes the first one's entry.
   */
  reserve(request: ReserveRequest): { reservation: HoldoutReservation; entry: ExposureJournalEntry } {
    return this.locked(()=>this.reserveLocked(request));
  }
  private reserveLocked(request:ReserveRequest):{reservation:HoldoutReservation;entry:ExposureJournalEntry}{
    const blocked = custodyBlocker(this.capability);
    if (blocked) throw new Error(blocked);
    const gateBlockers = unsealBlockers({ gates: request.gates, adjudication: request.adjudication });
    if (gateBlockers.length)
      throw new Error(`This candidate may not be evaluated against a final holdout: ${gateBlockers.slice(0, 3).join(' ')}${gateBlockers.length > 3 ? ` (${gateBlockers.length - 3} more)` : ''}`);

    const at = this.now();
    const period = quarterOf(at, request.holdout.timezoneOffsetMinutes);
    const before = this.spent(request.holdout.id, period);
    if (before.unknown)
      throw new Error(`${before.unknown} reservation${before.unknown === 1 ? '' : 's'} on this holdout are of unknown exposure after a restore. Reuse is blocked until a person settles them.`);
    if (before.used >= request.holdout.allowancePerPeriod)
      throw new Error(`This holdout's ${period} allowance of ${request.holdout.allowancePerPeriod} is already spent. Allowance renews on the calendar quarter boundary in the holdout's own zone, not on request.`);

    const reservation: HoldoutReservation = reservationSchema.parse({
      id: randomUUID(), holdoutId: request.holdout.id, projectId: request.holdout.projectId,
      lineageId: request.lineageId, branchId: request.branchId,
      candidateHash: request.candidateHash, refitHash: request.refitHash, period,
      ...(request.queryHash?{queryHash:request.queryHash}:{}),
      state: 'RESERVED', reservedAt: at, settledAt: null, reportHash: null,
      detail: 'Reserved before any bytes moved. This already costs the allowance.',
    });
    const entry = this.write({ holdoutId: reservation.holdoutId, reservationId: reservation.id, lineageId: reservation.lineageId,
      period, kind: 'RESERVED', candidateHash: reservation.candidateHash,refitHash:reservation.refitHash,...(reservation.queryHash?{queryHash:reservation.queryHash}:{}), at, detail: reservation.detail });

    // Re-read after writing: if a concurrent admission took the last slot first, this reservation is
    // withdrawn immediately rather than being allowed to double-spend.
    const after = this.spent(reservation.holdoutId, period);
    if (after.used > request.holdout.allowancePerPeriod) {
      this.write({ holdoutId: reservation.holdoutId, reservationId: reservation.id, lineageId: reservation.lineageId,
        period, kind: 'RELEASED', candidateHash: reservation.candidateHash, at: this.now(),
        detail: 'Withdrawn: another admission claimed the last slot of this period first. No bytes were exported.' });
      throw new Error(`This holdout's ${period} allowance was claimed by another admission first. Nothing was exported.`);
    }
    return { reservation, entry };
  }

  // ---- export and evaluation --------------------------------------------------------------------

  /**
   * Records exposure and then hands over the sealed bytes, in that order.
   *
   * A manual export is exposure whatever comes back: once the package leaves, nobody can prove the
   * data was not read. Writing the journal entry afterwards would leave a window in which a crash
   * loses the fact that a person is holding the holdout.
   */
  exportPackage(reservation: HoldoutReservation, holdout: Holdout): { reservation: HoldoutReservation; bytes: Uint8Array; classification: string } {
    return this.locked(()=>this.exportLocked(reservation,holdout));
  }
  private exportLocked(reservation:HoldoutReservation,holdout:Holdout):{reservation:HoldoutReservation;bytes:Uint8Array;classification:string}{
    if (reservation.state !== 'RESERVED') throw new Error(`This reservation is ${reservation.state.toLowerCase()} and cannot be exported again.`);
    this.assertReservation(reservation,holdout);
    const file = this.sealedPath(holdout.sealedHash);
    if (!existsSync(file)) throw new Error('The sealed holdout bytes are not present in this custody store. Nothing was exported.');
    const bytes = readFileSync(file);
    if (sha256(bytes) !== holdout.sealedHash) throw new Error('The sealed holdout bytes do not match their recorded identity. Nothing was exported.');
    const at = this.now();
    this.write({ holdoutId: holdout.id, reservationId: reservation.id, lineageId: reservation.lineageId, period: reservation.period,
      kind: 'EXPORTED', candidateHash: reservation.candidateHash, at,
      detail: 'Sealed bytes handed to a person. Recorded as exposure before the handover, because a returned report cannot prove the data was unread.' });
    return { reservation: { ...reservation, state: 'EXPORTED', detail: 'Exported to a person; counted as exposure.' }, bytes,
      classification: 'USER_CUSTODY: evidence returned against this export is user-attested. It is not an isolated evaluation and must not be labelled as one.' };
  }

  /**
   * Evaluates a candidate through the isolated evaluator, which sees only the sealed bytes.
   *
   * The evaluator is handed no store, no root and no query interface. That is the whole isolation
   * claim, and it is a property of what is passed in rather than of a promise made about it.
   */
  async evaluate(reservation: HoldoutReservation, holdout: Holdout, predictions: { rowId: string; prediction: number }[]): Promise<{ reservation: HoldoutReservation; result: EvaluatorResult }> {
    const blocked = custodyBlocker(this.capability);
    if (blocked) throw new Error(blocked);
    if (!this.evaluator) throw new Error('No isolated evaluator is configured. S8 stays blocked rather than evaluating in this process.');
    if(reservation.queryHash&&reservation.queryHash!==canonicalHash(predictions))throw new Error('Changed holdout query requires a new exposure.');
    const receiptFile=this.paths.journalFile+'.result-'+reservationSchema.parse(reservation).id+'.json';
    if(existsSync(receiptFile)){
      const receipt=JSON.parse(readFileSync(receiptFile,'utf8')) as {reservation:HoldoutReservation;result:EvaluatorResult;queryHash:string};
      const last=this.journal().filter(e=>e.reservationId===reservation.id).at(-1);
      if(last?.kind!=='EXPOSED'||receipt.queryHash!==canonicalHash(predictions)||receipt.reservation.candidateHash!==reservation.candidateHash
        ||receipt.reservation.refitHash!==reservation.refitHash||receipt.reservation.holdoutId!==holdout.id||receipt.reservation.id!==reservation.id)throw new Error('Recovered custody receipt does not match this exact query and exposure.');
      return {reservation:reservationSchema.parse(receipt.reservation),result:receipt.result};
    }
    if (reservation.state !== 'RESERVED') throw new Error(`This reservation is ${reservation.state.toLowerCase()} and cannot be evaluated again.`);
    const file = this.sealedPath(holdout.sealedHash);
    if (!existsSync(file)) throw new Error('The sealed holdout bytes are not present in this custody store.');
    const sealedBytes = readFileSync(file);
    if (sha256(sealedBytes) !== holdout.sealedHash) throw new Error('The sealed holdout bytes do not match their recorded identity.');

    // Exposure is journalled before the evaluator runs. If it crashes mid-run, the office has
    // already recorded that the data may have been read.
    this.locked(()=>{this.assertReservation(reservation,holdout);this.write({ holdoutId: holdout.id, reservationId: reservation.id, lineageId: reservation.lineageId, period: reservation.period,
      kind: 'EXPOSED', candidateHash: reservation.candidateHash, at: this.now(),
      detail: 'The isolated evaluator was given the sealed bytes. Recorded before the run, so a crash counts as possible exposure.' });});
    const result = await this.evaluator.evaluate({ sealedHash: holdout.sealedHash, sealedBytes, candidateHash: reservation.candidateHash, predictions });
    const completed={reservation:reservationSchema.parse({...reservation,state:'EXPOSED',settledAt:this.now(),reportHash:result.reportHash,detail:'Evaluated once by the isolated evaluator.'}),result};
    writeFileSync(receiptFile+'.pending',JSON.stringify({...completed,queryHash:canonicalHash(predictions)}),{encoding:'utf8',flush:true});renameSync(receiptFile+'.pending',receiptFile);
    return completed;
  }

  /**
   * Fetches the report for an already-evaluated reservation.
   *
   * Idempotent for the same report and refused for anything else. Re-reading the report of a look
   * already taken is free; asking the same reservation about a changed candidate is a second look
   * wearing the first one's receipt.
   */
  fetchReport(reservation: HoldoutReservation, request: { reportHash: string; candidateHash: string }): { reservation: HoldoutReservation; replay: true } {
    if (reservation.state !== 'EXPOSED' || !reservation.reportHash)
      throw new Error('There is no completed holdout evaluation on this reservation to fetch.');
    if (request.candidateHash !== reservation.candidateHash)
      throw new Error('This reservation was spent on a different candidate. A changed candidate needs its own reservation and its own allowance.');
    if (request.reportHash !== reservation.reportHash)
      throw new Error('That is not the report this reservation produced. A new query against the holdout is a new look, not a re-fetch.');
    return { reservation, replay: true };
  }

  /**
   * Releases a reservation, and only on verified non-exposure.
   *
   * "The run failed" is not verified non-exposure; nor is "no report came back". The allowance is
   * returned only when there is positive evidence that the bytes never left custody, which in
   * practice means the reservation was withdrawn before any export or evaluation.
   */
  release(reservation: HoldoutReservation, evidence: { verifiedNonExposure: boolean; detail: string }): HoldoutReservation {
    return this.locked(()=>this.releaseLocked(reservation,evidence));
  }
  private releaseLocked(reservation:HoldoutReservation,evidence:{verifiedNonExposure:boolean;detail:string}):HoldoutReservation{
    if (!evidence.verifiedNonExposure)
      throw new Error('A reservation is released only on verified non-exposure. An unfinished run, a lost receipt or a partial delivery all count as possible exposure.');
    if (reservation.state !== 'RESERVED')
      throw new Error(`This reservation is ${reservation.state.toLowerCase()}; the bytes have already moved and the allowance is spent.`);
    this.assertReservation(reservation);
    const at = this.now();
    this.write({ holdoutId: reservation.holdoutId, reservationId: reservation.id, lineageId: reservation.lineageId,
      period: reservation.period, kind: 'RELEASED', candidateHash: reservation.candidateHash, at, detail: evidence.detail });
    return { ...reservation, state: 'RELEASED', settledAt: at, detail: evidence.detail };
  }

  /**
   * Reconciles the journal against a restored workspace.
   *
   * The journal is the authority. Any reservation it knows about that the restored database has
   * never heard of is marked unknown and blocks reuse, because the alternative is silently handing
   * back an allowance that a run has already spent.
   */
  reconcileAfterRestore(knownReservationIds: string[]): { unknown: string[]; entries: ExposureJournalEntry[] } {
    return this.locked(()=>this.reconcileLocked(knownReservationIds));
  }
  private reconcileLocked(knownReservationIds:string[]):{unknown:string[];entries:ExposureJournalEntry[]}{
    const known = new Set(knownReservationIds);
    const live = new Map<string, ExposureJournalEntry>();
    for (const entry of this.journal()) live.set(entry.reservationId, entry);
    if(knownReservationIds.some(id=>!live.has(id)))throw new Error('Restored custody records have no authoritative exposure journal. Reuse is blocked.');
    const entries: ExposureJournalEntry[] = [];
    const unknown: string[] = [];
    for (const [reservationId, last] of live) {
      if (known.has(reservationId) || last.kind === 'RELEASED' || last.kind === 'UNKNOWN_AFTER_RESTORE') continue;
      unknown.push(reservationId);
      entries.push(this.write({ holdoutId: last.holdoutId, reservationId, lineageId: last.lineageId, period: last.period,
        kind: 'UNKNOWN_AFTER_RESTORE', candidateHash: last.candidateHash, at: this.now(),
        detail: 'A restored workspace has no record of this reservation, but the journal does. Treated as spent and of unknown exposure; reuse is blocked until a person settles it.' }));
    }
    return { unknown, entries };
  }

  // ---- sealed storage ---------------------------------------------------------------------------

  private sealedPath(sealedHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(sealedHash)) throw new Error('A sealed holdout is addressed by its SHA-256 and nothing else.');
    return path.join(this.paths.sealedRoot, sealedHash.slice(0, 2), sealedHash);
  }

  /** Stores sealed bytes in custody, outside the workspace tree that backups and search cover. */
  seal(bytes: Uint8Array): { sealedHash: string; sealedBytes: number } {
    // Only the storage half is required to put something into custody. Whether an isolated evaluator
    // exists decides whether it can ever be looked at, which is a separate question asked later.
    if (!this.capability.sealedStorageSupported)
      throw new Error(`Sealed holdout storage is not available in this build (${this.capability.detail}). Nothing was sealed.`);
    const sealedHash = sha256(bytes);
    const file = this.sealedPath(sealedHash);
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)){
      const temporary=file+'.'+randomUUID()+'.pending';
      writeFileSync(temporary,bytes,{flag:'wx',flush:true});renameSync(temporary,file);
    }else if(sha256(readFileSync(file))!==sealedHash)throw new Error('Existing custody bytes do not match their content identity.');
    return { sealedHash, sealedBytes: bytes.length };
  }

  /**
   * Whether custody is genuinely separate from the agent-visible workspace.
   *
   * Checked as a path relationship rather than trusted from configuration: a sealed root inside the
   * workspace would be swept into every backup and reachable by the evidence layer, and no flag
   * anywhere would make that untrue.
   */
  static separationBlocker(paths: CustodyPaths, workspaceRoot: string): string | null {
    const inside = (child: string) => {
      const relative = path.relative(path.resolve(workspaceRoot), path.resolve(child));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    if (inside(paths.sealedRoot)) return 'The sealed holdout store is inside the agent-visible workspace, so backups and the evidence index would reach it. Custody is not separate.';
    if (inside(paths.journalFile)) return 'The exposure journal is inside the restorable workspace, so restoring a backup would forget what has been spent.';
    return null;
  }
}

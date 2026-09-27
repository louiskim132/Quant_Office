import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { LocalFileIO } from './local-session-files.js';
import type { EvidenceCaller } from './evidence-tool.js';

/**
 * The packet-dir transport for the office evidence surface (inter-agent pipeline W4).
 *
 * A session whose tool profile declares the `evidence-surface` mcp entry gets two directories
 * in its packet: `queries/`, where the agent writes `<name>.jsonl` files — one
 * `{id, op, args}` frame per line — and `answers/`, where the office writes the matching
 * `<name>.jsonl` of `{id, result}` / `{id, refused}` lines. It is a file channel, so every
 * provider reaches it without a CLI flag; nothing in the wire can choose the caller — the
 * office binds {agentId, projectId, requestId} from the assignment record itself.
 */
export const QUERIES_DIR = 'queries';
export const ANSWERS_DIR = 'answers';
/** One query file is a bounded batch — larger submissions are simply unread. */
export const MAX_QUERY_BYTES = 64 * 1024;
/** A just-seen query file gets a beat to finish flushing before the office reads it. */
export const QUERY_SETTLE_MS = 150;

export type EvidenceFrameHandler = (caller: EvidenceCaller, line: string) => Promise<string>;

/** Whether a watcher-reported name is a query file directly inside queries/. */
export const isQueryFile = (name: string | null | undefined): name is string =>
  typeof name === 'string' && /^[^\\/]+\.jsonl$/.test(name);

/**
 * Creates the drop-box inside a prepared packet directory. A failure to create either
 * directory throws — a declared surface that cannot be mounted must fail the launch, not
 * sit silently deaf.
 */
export function prepareEvidenceDropbox(dir: string, io: LocalFileIO): { queries: string; answers: string } {
  const queries = path.join(dir, QUERIES_DIR);
  const answers = path.join(dir, ANSWERS_DIR);
  mkdirSync(queries, { recursive: true });
  mkdirSync(answers, { recursive: true });
  io.inspectRoot(queries);
  io.inspectRoot(answers);
  return { queries, answers };
}

const failedFrame = (detail: string): string =>
  `${JSON.stringify({ id: null, refused: { reason: 'FAILED', detail, denialReceiptId: null } })}\n`;

/** One in-flight serve per query file — a double-fired watcher event joins, never re-runs. */
const inflight = new Map<string, Promise<void>>();

/**
 * Serves one queries/<name>.jsonl: each non-empty line goes through the frame handler under
 * the office-bound caller, and the responses land in answers/<name>.jsonl. Dedup is layered —
 * an existing answer file returns early (durable across restarts), a concurrent serve joins
 * the in-flight one, and writeNew's refusal is the atomic backstop — so a watcher firing
 * rename+change for one write can never run the frames twice or rewrite an answer. A query
 * file the office cannot read gets a single FAILED frame instead of silence.
 */
export function serveEvidenceQuery(args: {
  dir: string;
  io: LocalFileIO;
  name: string;
  caller: EvidenceCaller;
  frames: EvidenceFrameHandler;
}): Promise<void> {
  if (existsSync(path.join(args.dir, ANSWERS_DIR, args.name))) return Promise.resolve();
  const key = `${args.dir}\0${args.name}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = serveQueryFile(args).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, work);
  return work;
}

async function serveQueryFile(args: {
  dir: string;
  io: LocalFileIO;
  name: string;
  caller: EvidenceCaller;
  frames: EvidenceFrameHandler;
}): Promise<void> {
  const answerPath = `${ANSWERS_DIR}/${args.name}`;
  let queryBytes: Uint8Array;
  try {
    queryBytes = args.io.read(args.dir, `${QUERIES_DIR}/${args.name}`, MAX_QUERY_BYTES).bytes;
  } catch {
    try {
      args.io.writeNew(
        args.dir,
        answerPath,
        Buffer.from(
          failedFrame('The office could not read this query file — over the size bound or already gone.'),
          'utf8',
        ),
      );
    } catch {
      /* an answer already exists or the packet is gone — nothing more to do */
    }
    return;
  }
  const out: string[] = [];
  for (const line of Buffer.from(queryBytes).toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(await args.frames(args.caller, line));
    } catch {
      out.push(failedFrame('The office could not complete this frame.').trimEnd());
    }
  }
  try {
    args.io.writeNew(args.dir, answerPath, Buffer.from(`${out.join('\n')}\n`, 'utf8'));
  } catch {
    /* an answer already exists — a repeated watcher event is a no-op, never a rewrite */
  }
}

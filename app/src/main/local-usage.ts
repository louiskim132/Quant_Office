import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LocalUsage, TokenTotals } from '../shared/types.js';
export const emptyTotals = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, messages: 0 });
const fields = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;
const add = (to: TokenTotals, value: TokenTotals) => {
  for (const k of [...fields, 'messages'] as const) {
    if (!Number.isSafeInteger(to[k] + value[k])) throw new Error('Recorded token totals exceed safe numeric range.');
    to[k] += value[k];
  }
};
/** Bounded line reader: incomplete final lines are ignored while a provider may be writing. */
export async function* jsonLines(file: string, size: number, onSkip: () => void): AsyncGenerator<string> {
  if (size === 0) return;
  const stream = createReadStream(file, { start: 0, end: size - 1, encoding: 'utf8', highWaterMark: 65536 });
  let buffer = '',
    discard = false;
  for await (const chunk of stream) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (discard) {
        discard = false;
        continue;
      }
      if (line.length > 2 * 1024 * 1024) {
        onSkip();
        continue;
      }
      if (line.trim()) yield line;
    }
    if (buffer.length > 2 * 1024 * 1024) {
      buffer = '';
      discard = true;
      onSkip();
    }
  }
  if (buffer.trim() && !discard) {
    try {
      JSON.parse(buffer);
      yield buffer;
    } catch {
      onSkip();
    }
  }
}
interface Observation {
  key: string;
  session: string;
  model: string;
  time: number;
  totals: TokenTotals;
}
export function usageObservation(raw: any, now: number): Observation | null {
  if (raw?.type !== 'assistant' || !raw.message?.usage) return null;
  const time = Date.parse(raw.timestamp),
    message = raw.message;
  if (!Number.isFinite(time) || time > now) return null;
  const messageId = typeof message.id === 'string' ? message.id : typeof raw.uuid === 'string' ? raw.uuid : null;
  if (!messageId || typeof raw.sessionId !== 'string') return null;
  const u = message.usage,
    values = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
  if (values.some(v => !Number.isSafeInteger(v) || v < 0)) return null;
  return {
    key: messageId,
    session: raw.sessionId,
    model: typeof message.model === 'string' ? message.model : 'Unknown',
    time,
    totals: { input: values[0], output: values[1], cacheRead: values[2], cacheCreation: values[3], messages: 1 },
  };
}
export async function reconstructUsage(selectedRoot: string, now = Date.now()): Promise<LocalUsage> {
  const result: LocalUsage = {
    root: path.resolve(selectedRoot),
    scannedAt: new Date(now).toISOString(),
    files: 0,
    skipped: 0,
    malformed: 0,
    duplicates: 0,
    partial: false,
    sessions: 0,
    last5Hours: emptyTotals(),
    last7Days: emptyTotals(),
    daily: [],
    models: [],
    note: 'Local transcript consumption only. These rolling periods are not provider reset windows. Other devices and web sessions are absent; files may cover multiple accounts or billing modes. No remaining quota is inferred.',
  };
  let root: string;
  try {
    if ((await lstat(result.root)).isSymbolicLink())
      throw new Error('Choose the actual transcript folder, not a link.');
    root = await realpath(result.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      result.note =
        'No local transcript folder was found. Local consumption is unavailable; this does not mean account usage is zero.';
      return result;
    }
    throw error;
  }
  if (!(await stat(root)).isDirectory()) throw new Error('Select a transcript directory.');
  const observations = new Map<string, Observation>();
  let bytes = 0,
    entries = 0;
  const queue = [{ folder: root, depth: 0 }];
  while (queue.length) {
    const { folder, depth } = queue.shift()!;
    let items;
    try {
      items = await readdir(folder, { withFileTypes: true });
    } catch {
      result.skipped++;
      continue;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (++entries > 20000) {
        result.partial = true;
        queue.length = 0;
        break;
      }
      const file = path.join(folder, item.name);
      if (item.isSymbolicLink()) {
        result.skipped++;
        continue;
      }
      if (item.isDirectory()) {
        if (depth < 8) queue.push({ folder: file, depth: depth + 1 });
        else result.skipped++;
        continue;
      }
      if (!item.isFile() || !item.name.toLowerCase().endsWith('.jsonl')) continue;
      if (result.files >= 5000) {
        result.partial = true;
        queue.length = 0;
        break;
      }
      try {
        const actual = await realpath(file),
          relative = path.relative(root, actual);
        if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
          result.skipped++;
          continue;
        }
        const metadata = await lstat(file);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          result.skipped++;
          continue;
        }
        if (bytes + metadata.size > 512 * 1024 * 1024) {
          result.skipped++;
          result.partial = true;
          continue;
        }
        bytes += metadata.size;
        result.files++;
        for await (const line of jsonLines(actual, metadata.size, () => result.malformed++)) {
          let raw: any;
          try {
            raw = JSON.parse(line);
          } catch {
            result.malformed++;
            continue;
          }
          const value = usageObservation(raw, now);
          if (!value) {
            if (raw?.type === 'assistant' && raw.message?.usage) result.malformed++;
            continue;
          }
          // The same response may occur in streamed updates, resumed histories or copied transcripts.
          const previous = observations.get(value.key);
          if (previous) {
            result.duplicates++;
            for (const key of fields) previous.totals[key] = Math.max(previous.totals[key], value.totals[key]);
            previous.time = Math.min(previous.time, value.time);
          } else if (observations.size < 100000) observations.set(value.key, value);
          else {
            result.partial = true;
            result.skipped++;
          }
        }
      } catch {
        result.skipped++;
      }
    }
  }
  const sessions = new Set<string>(),
    daily = new Map<string, TokenTotals>(),
    models = new Map<string, TokenTotals>();
  for (const o of observations.values()) {
    sessions.add(o.session);
    if (o.time >= now - 5 * 60 * 60 * 1000) add(result.last5Hours, o.totals);
    if (o.time < now - 7 * 24 * 60 * 60 * 1000) continue;
    add(result.last7Days, o.totals);
    const day = new Date(o.time).toISOString().slice(0, 10);
    if (!daily.has(day)) daily.set(day, emptyTotals());
    add(daily.get(day)!, o.totals);
    if (!models.has(o.model)) models.set(o.model, emptyTotals());
    add(models.get(o.model)!, o.totals);
  }
  result.sessions = sessions.size;
  result.daily = [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, totals]) => ({ day, totals }));
  result.models = [...models].map(([model, totals]) => ({ model, totals }));
  result.partial ||= result.skipped > 0 || result.malformed > 0;
  if (!observations.size)
    result.note =
      'No usable assistant usage records were found. Zero recorded tokens does not mean zero subscription usage. ' +
      result.note;
  return result;
}

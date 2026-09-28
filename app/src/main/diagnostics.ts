import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export const LOG_FILE = 'main.log';
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** main.log plus main.1.log and main.2.log. */
export const KEEP_LOGS = 3;

/**
 * Appends one line to <dir>/main.log. When the file has reached maxBytes it rotates
 * main.log → main.1.log → main.2.log first, dropping the oldest. Never throws: logging must not
 * take the app down.
 */
export function writeLog(
  dir: string,
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  maxBytes = MAX_LOG_BYTES,
  now = new Date(),
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_FILE);
    if (existsSync(file) && statSync(file).size >= maxBytes) {
      const oldest = path.join(dir, `main.${KEEP_LOGS - 1}.log`);
      if (existsSync(oldest)) rmSync(oldest);
      for (let i = KEEP_LOGS - 2; i >= 1; i--) {
        const from = path.join(dir, `main.${i}.log`);
        if (existsSync(from)) renameSync(from, path.join(dir, `main.${i + 1}.log`));
      }
      renameSync(file, path.join(dir, 'main.1.log'));
    }
    appendFileSync(file, `${now.toISOString()} ${level} ${message.replace(/\r?\n/g, ' | ')}\n`, 'utf8');
  } catch {
    /* never throw from logging */
  }
}

/** Name, message and the first three stack frames of an error, on one line. */
export const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.name}: ${error.message}${
        error.stack
          ? ` | ${error.stack
              .split('\n')
              .slice(1, 4)
              .map(line => line.trim())
              .join(' | ')}`
          : ''
      }`
    : String(error);

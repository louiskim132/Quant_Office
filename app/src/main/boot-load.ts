/**
 * Loads the renderer bundle into a BrowserWindow with one bounded retry.
 *
 * Electron's loadFile() rejects on did-fail-load, so a failed navigation and a failed renderer
 * load surface through the same promise — retrying this promise covers both failure surfaces;
 * there is no second channel to subscribe.
 *
 * The window is a structural type, not an Electron import, so the module stays unit-testable
 * under plain tsx. When attempts are exhausted the FIRST error is rethrown: the original failure
 * is the one that prompted the retry, and reporting the retry's error would describe a different
 * boot than the one that failed.
 */
export interface LoadableWindow {
  loadFile(path: string): Promise<unknown>;
}
export interface BootLoadOptions {
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function loadWindowWithRetry(
  win: LoadableWindow,
  file: string,
  opts: BootLoadOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let firstError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await win.loadFile(file);
      return;
    } catch (error) {
      firstError ??= error;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw firstError;
}

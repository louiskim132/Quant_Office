import { useSyncExternalStore } from 'react';

/**
 * Per-viewer display preferences (view mode, label toggles, panel state). They live in this
 * browser's storage only; an embedder that forbids storage keeps the session value in memory, and
 * a read never throws. Every setter notifies subscribers so two components stay in step.
 */
const listeners = new Set<() => void>();
const session = new Map<string, string>();
const key = (name: string) => `qro.pref.${name}`;

export function readPref(name: string, fallback: string): string {
  try {
    const stored = window.localStorage.getItem(key(name));
    if (stored !== null) return stored;
  } catch {
    /* storage unavailable */
  }
  return session.get(name) ?? fallback;
}

export function writePref(name: string, value: string) {
  session.set(name, value);
  try {
    window.localStorage.setItem(key(name), value);
  } catch {
    /* kept for this session only */
  }
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
};

export function usePref(name: string, fallback: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readPref(name, fallback),
    () => fallback,
  );
  return [value, (next: string) => writePref(name, next)];
}

export function useBoolPref(name: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, set] = usePref(name, fallback ? 'on' : 'off');
  return [value === 'on', (next: boolean) => set(next ? 'on' : 'off')];
}

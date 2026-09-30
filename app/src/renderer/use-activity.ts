import { useEffect, useMemo, useState } from 'react';
import { officeActivity, type LivePresence, type OfficeActivity } from '../shared/activity';
import type { AppState } from '../shared/types';

/**
 * Presence alone — the office watching the processes it spawned — for surfaces that only need to know
 * which jobs have a live process (step status, Retry). `presence` is null until the first answer, so
 * "nothing watched" is never assumed before the office has said so.
 */
export function useLivePresence(): { presence: LivePresence[] | null; heardAt: number } {
  const [presence, setPresence] = useState<LivePresence[] | null>(null);
  const [heardAt, setHeardAt] = useState(() => Date.now());
  useEffect(() => {
    if (!window.office?.livePresence) return;
    let live = true;
    void window.office
      .livePresence()
      .then(items => {
        if (live) setPresence(items);
      })
      .catch(() => {});
    const off = window.office.onPresence(items => {
      setPresence(items);
      setHeardAt(Date.now());
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return { presence, heardAt };
}

/** Jobs the office holds a process record for; undefined until presence has been heard once. */
export const watchedJobs = (presence: LivePresence[] | null): ReadonlySet<string> | undefined =>
  presence ? new Set(presence.map(item => item.jobId)) : undefined;

/**
 * The office's derived activity plus the clock it was derived against, shared by every surface that
 * shows who is doing what (scene, roster strip, drawer, inbox) so they can never disagree.
 *
 * Presence arrives over its own channel; the clock runs once a second only while some process is
 * alive, and lazily otherwise.
 */
export function useOfficeActivity(state: AppState | null): {
  activity: OfficeActivity[];
  presence: LivePresence[];
  /** Jobs the office holds a process record for; undefined until presence has been heard once. */
  watchedJobIds: ReadonlySet<string> | undefined;
  now: number;
} {
  const { presence, heardAt } = useLivePresence();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [heardAt]);
  const ticking = !!presence?.some(item => item.alive);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : 20000);
    return () => clearInterval(timer);
  }, [ticking]);
  const activity = useMemo(
    () => (state ? officeActivity(state, { now, presence: presence ?? [] }) : []),
    [state, now, presence],
  );
  const watchedJobIds = useMemo(() => watchedJobs(presence), [presence]);
  return { activity, presence: presence ?? [], watchedJobIds, now };
}

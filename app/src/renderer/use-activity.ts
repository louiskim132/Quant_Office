import { useEffect, useMemo, useState } from 'react';
import { officeActivity, type LivePresence, type OfficeActivity } from '../shared/activity';
import type { AppState } from '../shared/types';

/**
 * The office's derived activity plus the clock it was derived against, shared by every surface that
 * shows who is doing what (scene, roster strip, drawer, inbox) so they can never disagree.
 *
 * Presence — the office watching a process it spawned — arrives over its own channel; the clock runs
 * once a second only while some process is alive, and lazily otherwise.
 */
export function useOfficeActivity(state: AppState | null): {
  activity: OfficeActivity[];
  presence: LivePresence[];
  now: number;
} {
  const [presence, setPresence] = useState<LivePresence[]>([]);
  const [now, setNow] = useState(() => Date.now());
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
      setNow(Date.now());
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const ticking = presence.some(item => item.alive);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : 20000);
    return () => clearInterval(timer);
  }, [ticking]);
  const activity = useMemo(() => (state ? officeActivity(state, { now, presence }) : []), [state, now, presence]);
  return { activity, presence, now };
}

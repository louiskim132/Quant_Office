import React, { useLayoutEffect, useRef, useState } from 'react';
import type { Agent, AppState } from '../shared/types';
import type { OfficeActivity } from '../shared/activity';
import './office.css';
import './office-scene.css';
import { avatarLook } from './avatar';
import { seatView, type SeatView } from './seat-view';
import { STATUS } from './status';
import { Avatar, StatusPill } from './components';

interface ScenePos {
  x: number;
  y: number;
  loc: string;
}

/** Loose floor zones by role. Order inside each zone follows join order; empty seats stay put. */
export interface SeatZones {
  directors: Agent[];
  pms: Agent[];
  workers: Agent[];
}
export function seatZones(seats: (Agent | null)[]): SeatZones {
  return {
    directors: seats.filter((a): a is Agent => a?.role === 'DIRECTOR'),
    pms: seats.filter((a): a is Agent => !!a && a.role.startsWith('PM')),
    workers: seats.filter((a): a is Agent => a?.role === 'WORKER'),
  };
}
const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
  document.documentElement.dataset.motion === 'reduced';

/**
 * The office floor. Everything an avatar does here is derived from recorded evidence (see
 * shared/activity.ts); this component only draws it.
 *
 * Movement rule: a person walks only when their location changed (desk ↔ meeting room). Positions are
 * measured relative to the scene, never the viewport, so scrolling, a banner appearing or a resize
 * cannot make anyone fly across the page. The first paint, a return to the page and a new hire do not
 * walk; a hire simply appears in their seat.
 */
export function OfficeScene({
  agents,
  activity,
  now,
  requests,
  onAgent,
}: {
  agents: Agent[];
  activity: OfficeActivity[];
  now: number;
  requests: AppState['requests'];
  onAgent: (id: string) => void;
}) {
  const team = agents.filter(a => !a.removedAt);
  const slots = useRef<string[]>([]),
    rooms = useRef<string[]>([]),
    scene = useRef<HTMLElement | null>(null),
    positions = useRef(new Map<string, ScenePos>()),
    painted = useRef(false);
  for (const agent of team) if (!slots.current.includes(agent.id)) slots.current.push(agent.id);
  const seats = slots.current.map(id => team.find(a => a.id === id) ?? null);
  const views = new Map<string, SeatView>(
    team.map(a => [
      a.id,
      seatView(
        a,
        activity.find(x => x.agentId === a.id),
        requests,
        now,
      ),
    ]),
  );
  const activeMeetings = [
    ...new Set(
      activity
        .filter(a => a.kind === 'MEETING' && team.some(t => t.id === a.agentId))
        .map(a => a.meetingId ?? 'meeting'),
    ),
  ].sort();
  for (const id of activeMeetings)
    if (!rooms.current.includes(id)) {
      const empty = rooms.current.findIndex(r => !activeMeetings.includes(r));
      if (empty < 0) rooms.current.push(id);
      else rooms.current[empty] = id;
    }
  const meetings = rooms.current.map(id => (activeMeetings.includes(id) ? id : null));
  const locationOf = (agent: Agent) => {
    const a = activity.find(x => x.agentId === agent.id);
    return a?.kind === 'MEETING' ? `room:${a.meetingId ?? 'meeting'}` : 'seat';
  };

  useLayoutEffect(() => {
    const root = scene.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const reduced = reducedMotion();
    const next = new Map<string, ScenePos>();
    for (const node of root.querySelectorAll<HTMLElement>('[data-office-agent]')) {
      const id = node.dataset.officeAgent!,
        loc = node.dataset.location ?? 'seat',
        rect = node.getBoundingClientRect(),
        pos = { x: rect.x - base.x, y: rect.y - base.y, loc },
        before = positions.current.get(id);
      next.set(id, pos);
      if (!painted.current || document.visibilityState !== 'visible') continue;
      if (!before) {
        // A new hire appears in their seat; nothing flies in from anywhere.
        if (!reduced) node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
        continue;
      }
      if (before.loc === loc) continue;
      if (reduced) {
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
        continue;
      }
      const dx = before.x - pos.x,
        dy = before.y - pos.y,
        distance = Math.abs(dx) + Math.abs(dy);
      // Walk in an L: along the aisle to the destination's row, then across to it.
      const walk = node.animate(
        [
          { transform: `translate(${dx}px,${dy}px)` },
          { transform: `translate(${dx}px,0px)`, offset: Math.abs(dy) / Math.max(1, distance) },
          { transform: 'translate(0,0)' },
        ],
        { duration: Math.min(1700, Math.max(700, distance * 2.6)), easing: 'linear' },
      );
      node.classList.add('walking');
      const done = () => node.classList.remove('walking');
      walk.onfinish = done;
      walk.oncancel = done;
    }
    positions.current = next;
    painted.current = true;
  });

  const person = (agent: Agent, meeting = false) => {
    const look = avatarLook(agent.id, agent.name),
      view = views.get(agent.id)!;
    return (
      <button
        type="button"
        data-office-agent={agent.id}
        data-location={locationOf(agent)}
        className={`office-person ${meeting ? 'talking' : ''}`}
        style={{ '--shirt': look.shirt, '--hair': look.hair, '--skin': look.skin } as React.CSSProperties}
        onClick={() => onAgent(agent.id)}
        aria-label={`${agent.name} — ${STATUS[view.status].label}. Open details`}
      >
        <span className="person-hair" />
        <span className="person-head" />
        <span className="person-body" />
        <span className="person-arms" />
        <span className="person-legs" />
        {view.bubble && (
          <span className="bubble" data-status={view.status} aria-hidden="true">
            {view.bubble}
          </span>
        )}
      </button>
    );
  };

  const station = (agent: Agent | null, i: number) => {
    const view = agent ? views.get(agent.id)! : undefined;
    const activityOf = agent ? activity.find(a => a.agentId === agent.id) : undefined;
    return (
      <div className="workstation" key={agent?.id ?? `seat-${i}`} data-status={view?.status}>
        <div
          className="office-monitor"
          data-state={view?.monitor ?? 'off'}
          aria-label={view ? `Computer: ${STATUS[view.status].label.toLowerCase()}` : 'Computer off'}
        >
          <i />
        </div>
        <div className="office-desk">
          <i className="keyboard" />
          <i className="coffee" />
        </div>
        <div className="office-chair" />
        {agent && view?.status !== 'meeting' && person(agent)}
        <div className="station-label">
          {agent && <strong className="person-name">{agent.name}</strong>}
          <span>{agent ? view!.line : 'Available seat'}</span>
        </div>
        {agent && view && (
          <div className="hover-card" aria-hidden="true">
            <strong>{agent.name}</strong>
            <span className="hover-role">
              {agent.role.replaceAll('_', ' ')} · {agent.provider} {agent.model}
              {agent.effort && agent.effort !== 'default' ? ` · ${agent.effort}` : ''}
            </span>
            <StatusPill status={view.status} />
            {view.requestName && <span>{view.requestName}</span>}
            {view.elapsed && <span>Elapsed {view.elapsed}</span>}
            <span className="hover-evidence">{view.evidence}</span>
            {activityOf?.kind === 'UNKNOWN' && <span className="hover-evidence">{activityOf.detail}</span>}
          </div>
        )}
      </div>
    );
  };

  // Seating mirrors the org on one open floor: loose role zones marked on the floor, never
  // walled in. Groups keep the join-ordered seat list so people don't shuffle.
  const zones = seatZones(seats);
  const roomName = (id: string | null) =>
    id ? ((requests ?? []).find(r => r.id === id)?.name ?? 'Conversation in progress') : 'No active meeting';
  const busyRooms = meetings.map((id, i) => ({ id, i })).filter(r => r.id);
  const freeRooms = Math.max(2, meetings.length) - busyRooms.length;
  const lit = team.filter(a => views.get(a.id)?.status === 'working' || views.get(a.id)?.status === 'stalled').length;

  return (
    <section ref={scene} className="sky-office">
      <div className="sky-wall">
        <span>QUANT / RESEARCH LAB</span>
        <span className="wall-summary" aria-live="polite">
          {lit ? `${lit} working now` : 'Nobody working right now'}
        </span>
        <div className="sky-windows" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="sky-floor">
        <div className="office-main">
          <section className="floor-zone" data-zone="director">
            <h3 className="zone-tag">DIRECTOR</h3>
            <i className="prop-rug" aria-hidden="true" />
            <div className="workstations">
              {zones.directors.length ? (
                zones.directors.map(a => station(a, seats.indexOf(a)))
              ) : (
                <span className="vacant-seat">No director seated</span>
              )}
            </div>
          </section>
          <section className="floor-zone" data-zone="pm">
            <h3 className="zone-tag">PROJECT MANAGERS</h3>
            <div className="workstations">
              {zones.pms.length ? (
                zones.pms.map(a => station(a, seats.indexOf(a)))
              ) : (
                <span className="vacant-seat">No project managers seated</span>
              )}
            </div>
          </section>
          <section className="floor-zone" data-zone="workers">
            <h3 className="zone-tag">WORKERS</h3>
            <div className="workstations">
              {zones.workers.length ? (
                zones.workers.map(a => station(a, seats.indexOf(a)))
              ) : team.length ? (
                <span className="vacant-seat">No workers seated</span>
              ) : (
                ([null, null, null, null] as (Agent | null)[]).map((a, i) => station(a, i))
              )}
            </div>
          </section>
          {/* Ambient furniture along the front edge — set dressing only, never interactive. */}
          <div className="floor-props" aria-hidden="true">
            <i className="prop-rack" />
            <i className="prop-board" />
            <i className="prop-plant" />
            <i className="prop-lamp" />
          </div>
        </div>
        <aside className={`meeting-wing${busyRooms.length ? '' : ' quiet'}`}>
          {busyRooms.map(({ id, i }) => (
            <section className="meeting-room" key={id!} data-room={id!}>
              <h3>{i === 0 ? 'COLLABORATION' : 'REVIEW'} ROOM</h3>
              <div className="meeting-table" />
              <div className="meeting-people">
                {team
                  .filter(a =>
                    activity.some(
                      s => s.agentId === a.id && s.kind === 'MEETING' && (s.meetingId ?? 'meeting') === meetings[i],
                    ),
                  )
                  .map(a => (
                    <div className="meeting-member" key={a.id}>
                      {person(a, true)}
                      <strong>{a.name}</strong>
                    </div>
                  ))}
              </div>
              <span>{roomName(id)}</span>
            </section>
          ))}
          {/* Empty rooms are one quiet line, not two large boxes. */}
          <div className="rooms-free">
            {freeRooms} meeting room{freeRooms === 1 ? '' : 's'} free
          </div>
        </aside>
      </div>
      <NowPanel team={team} views={views} onAgent={onAgent} />
      <div className="sky-caption">
        <span>{team.length} agents · click a person for details</span>
        <span>Activity follows recorded evidence; stale work is unknown</span>
      </div>
    </section>
  );
}

/** The textual twin of the floor: one line per agent, most urgent first. */
function NowPanel({
  team,
  views,
  onAgent,
}: {
  team: Agent[];
  views: Map<string, SeatView>;
  onAgent: (id: string) => void;
}) {
  const [byName, setByName] = useState(false);
  if (!team.length) return null;
  const rows = [...team].sort((a, b) =>
    byName
      ? a.name.localeCompare(b.name)
      : STATUS[views.get(a.id)!.status].rank - STATUS[views.get(b.id)!.status].rank || a.name.localeCompare(b.name),
  );
  return (
    <section className="now-panel" aria-label="Who is doing what">
      <div className="now-head">
        <h3>NOW</h3>
        <button type="button" className="text-button" onClick={() => setByName(v => !v)}>
          Sorted by {byName ? 'name' : 'attention'}
        </button>
      </div>
      <ul>
        {rows.map(a => {
          const v = views.get(a.id)!;
          return (
            <li key={a.id}>
              <button type="button" className="now-row" onClick={() => onAgent(a.id)}>
                <Avatar id={a.id} name={a.name} size={22} status={v.status} />
                <span className="now-name">{a.name}</span>
                <StatusPill status={v.status} />
                <span className="now-line">{v.line}</span>
                {v.elapsed && v.status !== 'idle' && <span className="now-elapsed">{v.elapsed}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

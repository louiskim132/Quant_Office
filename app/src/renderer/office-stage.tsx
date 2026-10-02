import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, LocateFixed, Search, Tag, Users, ZoomIn, ZoomOut } from 'lucide-react';
import type { AccountConnection, Agent, AppState } from '../shared/types';
import type { OfficeActivity } from '../shared/activity';
import './office3d.css';
import { avatarLook } from './avatar';
import { seatView, type SeatView } from './seat-view';
import { STATUS } from './status';
import { StatusPill } from './components';
import { OfficeScene, NowPanel, seatZones } from './office-scene';
import { OfficeChat } from './office-chat';
import { useBoolPref, usePref } from './prefs';
import { OfficeEngine, type AgentVisual } from './office3d/engine';
import { buildLayout, tableSeatDemand } from './office3d/layout';
import {
  assignDesks,
  assignRooms,
  locate,
  projectDeskAgents,
  remainingAllowance,
  shouldRest,
  stageLine,
  stageSummary,
  STATUS_VAR,
  typesWhile,
} from './office3d/visuals';

const rootTheme = (): 'dark' | 'light' => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const rootReduced = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
  document.documentElement.dataset.motion === 'reduced';

/**
 * The Office page's live area: the 3D stage (or the classic flat floor when the viewer prefers it
 * or WebGL is unavailable), the textual "Now" list and the office chat the stage's CHAT button
 * opens. Everything shown comes from the same derived activity as before.
 */
export function OfficeLive({
  state,
  activity,
  now,
  onAgent,
  selectedId,
}: {
  state: AppState;
  activity: OfficeActivity[];
  now: number;
  onAgent: (id: string) => void;
  selectedId: string | null;
}) {
  const [view] = usePref('office-view', '3d');
  const [broken, setBroken] = useState(false);
  const [chatOpen, setChatOpen] = useBoolPref('office-chat', false);
  // A GPU that refuses WebGL makes the engine throw, and onFail hands the page to the classic floor.
  // (A separate probe context cost a tenth of a second on every open.)
  const flat = view === '2d' || broken;
  if (flat)
    return (
      <div className="office-live-layout">
        <OfficeScene agents={state.agents} activity={activity} now={now} requests={state.requests} onAgent={onAgent} />
        <OfficeChat state={state} />
      </div>
    );
  return (
    <div className="office-live3d">
      <Office3D
        agents={state.agents}
        activity={activity}
        now={now}
        requests={state.requests}
        connections={state.connections}
        deskAgents={projectDeskAgents(state, activity)}
        onAgent={onAgent}
        selectedId={selectedId}
        theme={state.settings.theme === 'light' ? 'light' : 'dark'}
        reducedMotion={!!state.settings.reducedMotion}
        chatOpen={chatOpen}
        chat={chatOpen ? <OfficeChat state={state} /> : null}
        onToggleChat={() => setChatOpen(!chatOpen)}
        onFail={() => setBroken(true)}
      />
      <OfficeNow agents={state.agents} activity={activity} now={now} requests={state.requests} onAgent={onAgent} />
    </div>
  );
}

export function Office3D({
  agents,
  activity,
  now,
  requests,
  connections,
  deskAgents,
  onAgent,
  selectedId,
  theme,
  reducedMotion,
  chatOpen,
  chat,
  onToggleChat,
  onFail,
}: {
  agents: Agent[];
  activity: OfficeActivity[];
  now: number;
  requests: AppState['requests'];
  /** Recorded sign-in observations; an agent nearly out of allowance rests in the lounge. */
  connections?: AccountConnection[];
  deskAgents?: ReadonlySet<string>;
  onAgent: (id: string) => void;
  selectedId: string | null;
  /** From the saved settings, so the first build already uses the right palette. */
  theme: 'dark' | 'light';
  reducedMotion: boolean;
  chatOpen: boolean;
  /** The office chat, shown over the lower right of the floor while the CHAT button is on. */
  chat: React.ReactNode;
  onToggleChat: () => void;
  onFail: () => void;
}) {
  const team = agents.filter(a => !a.removedAt);
  const stage = useRef<HTMLElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const engine = useRef<OfficeEngine | null>(null);
  const labels = useRef(new Map<string, HTMLElement>());
  const tags = useRef(new Map<number, HTMLElement>());
  const slots = useRef<string[]>([]);
  const rooms = useRef<(string | null)[]>([]);
  const lounge = useRef<(string | null)[]>([]);
  const pickRef = useRef(onAgent);
  pickRef.current = onAgent;
  const [names, setNames] = useBoolPref('office-names', true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [ready, setReady] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);

  // Stable join order: a person keeps their desk while others come and go.
  for (const agent of team) if (!slots.current.includes(agent.id)) slots.current.push(agent.id);
  const ordered = slots.current.map(id => team.find(a => a.id === id)).filter((a): a is Agent => !!a);
  const zones = seatZones(ordered);
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
  const meetingsActive = [
    ...new Set(
      activity
        .filter(a => a.kind === 'MEETING' && team.some(t => t.id === a.agentId))
        .map(a => a.meetingId ?? 'meeting'),
    ),
  ].sort();
  rooms.current = assignRooms(rooms.current, meetingsActive);
  const roomSlots = rooms.current;
  const meetingPeople = new Map<string, string[]>();
  for (const a of ordered) {
    const act = activity.find(x => x.agentId === a.id);
    if (act?.kind !== 'MEETING') continue;
    const id = act.meetingId ?? 'meeting';
    meetingPeople.set(id, [...(meetingPeople.get(id) ?? []), a.id]);
  }
  // Rest by default; project attendance and allowance determine who leaves the lounge.
  const allowance = new Map(ordered.map(a => [a.id, remainingAllowance(a, connections, now)] as const));
  const restingIds = ordered
    .filter(a =>
      shouldRest(
        deskAgents?.has(a.id) ??
          activity.some(x => x.agentId === a.id && (x.kind === 'WORKING' || x.kind === 'MEETING')),
        allowance.get(a.id) ?? null,
      ),
    )
    .map(a => a.id);
  lounge.current = assignRooms(lounge.current, restingIds);
  while (lounge.current.at(-1) === null) lounge.current.pop();
  const loungeSlots = lounge.current;
  const seatInMeeting = new Map<string, number>();
  for (const ids of meetingPeople.values()) ids.forEach((id, i) => seatInMeeting.set(id, i));

  const layout = useMemo(
    () =>
      buildLayout({
        director: zones.directors.length,
        pm: zones.pms.length,
        worker: zones.workers.length,
        tables: roomSlots.length,
        tableSeats: tableSeatDemand([...meetingPeople.values()].map(p => p.length)),
        restSeats: loungeSlots.length,
        empty: !team.length,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      zones.directors.length,
      zones.pms.length,
      zones.workers.length,
      roomSlots.length,
      loungeSlots.length,
      tableSeatDemand([...meetingPeople.values()].map(p => p.length)),
      team.length === 0,
    ],
  );
  const desks = assignDesks(layout, ordered);
  const visuals: AgentVisual[] = ordered.map(agent => {
    const view = views.get(agent.id)!;
    const act = activity.find(x => x.agentId === agent.id);
    const look = avatarLook(agent.id, agent.name);
    const location = locate(agent, desks, act, roomSlots, seatInMeeting, loungeSlots);
    return {
      id: agent.id,
      colors: { shirt: look.shirt, hair: look.hair, skin: look.skin },
      status: STATUS_VAR[view.status],
      monitor: view.monitor,
      home: desks.get(agent.id) ?? 0,
      location,
      typing: location.kind === 'desk' && typesWhile(view.status),
      talking: location.kind === 'room',
      resting: location.kind === 'rest',
    };
  });
  const visualsKey = JSON.stringify(visuals);
  const summary = stageSummary(ordered.map(a => views.get(a.id)!.status));
  const summaryKey = JSON.stringify(summary);
  const busyTables = new Set(roomSlots.flatMap((id, i) => (id ? [i] : [])));
  const busyKey = [...busyTables].join(',');
  const layoutKey = JSON.stringify([
    layout.desks.map(d => [d.zone, d.x, d.z]),
    layout.rooms.map(t => [t.x, t.z, t.seats.length]),
    layout.rest.spots.length,
    layout.bounds,
  ]);
  const roomName = (id: string) => (requests ?? []).find(r => r.id === id)?.name ?? 'Conversation in progress';

  // What the engine is handed when it starts, which can be after the first render.
  const latest = useRef({ layout, visualsKey, summaryKey, busyTables, selectedId, names, theme, reducedMotion });
  latest.current = { layout, visualsKey, summaryKey, busyTables, selectedId, names, theme, reducedMotion };

  // Create the engine once, after the page has painted: building the floor takes a few hundred
  // milliseconds, and the rest of the page should not wait for it. Starting the GPU and laying out
  // the floor run as two tasks, so the page stays responsive in between. A GPU that refuses hands the
  // page back to the flat floor.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let created: OfficeEngine | null = null;
    let observer: MutationObserver | null = null;
    let started = false;
    let task = 0;
    const start = () => {
      if (started) return;
      started = true;
      const now = latest.current;
      try {
        created = new OfficeEngine({
          host: el,
          labels: labels.current,
          tags: tags.current,
          theme: now.theme,
          reducedMotion: now.reducedMotion || rootReduced(),
          onPick: id => pickRef.current(id),
          onHover: () => {},
          onReady: () => setReady(true),
        });
      } catch {
        onFail();
        return;
      }
      task = window.setTimeout(() => furnish(created!), 0);
    };
    const furnish = (engineNow: OfficeEngine) => {
      const now = latest.current;
      engineNow.setLayout(now.layout);
      engineNow.setAgents(JSON.parse(now.visualsKey));
      engineNow.setBoard(JSON.parse(now.summaryKey));
      engineNow.setBusyRooms(now.busyTables);
      engineNow.setSelected(now.selectedId);
      engineNow.setNames(now.names);
      engine.current = engineNow;
      observer = new MutationObserver(() => {
        engineNow.setTheme(rootTheme());
        engineNow.setReducedMotion(rootReduced());
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    };
    // After the next frame is painted; the fallback covers a window that paints no frames (hidden).
    const frame = requestAnimationFrame(() => {
      task = window.setTimeout(start, 0);
    });
    const fallback = window.setTimeout(start, 250);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
      clearTimeout(task);
      observer?.disconnect();
      (created as OfficeEngine | null)?.dispose();
      engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    engine.current?.setLayout(layout);
    engine.current?.setAgents(JSON.parse(visualsKey));
    engine.current?.setBoard(JSON.parse(summaryKey));
    engine.current?.setBusyRooms(busyTables);
    engine.current?.setSelected(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);
  useEffect(() => {
    engine.current?.setAgents(JSON.parse(visualsKey));
  }, [visualsKey]);
  useEffect(() => {
    engine.current?.setBoard(JSON.parse(summaryKey));
  }, [summaryKey]);
  useEffect(() => {
    engine.current?.setBusyRooms(busyTables);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey]);
  useEffect(() => {
    engine.current?.setSelected(selectedId);
  }, [selectedId]);
  useEffect(() => {
    engine.current?.setNames(names);
  }, [names]);
  useEffect(() => {
    engine.current?.setTheme(theme);
  }, [theme]);
  useEffect(() => {
    engine.current?.setReducedMotion(reducedMotion || rootReduced());
  }, [reducedMotion]);

  const locationOf = (agent: Agent) => {
    if (loungeSlots.includes(agent.id)) return 'rest';
    const a = activity.find(x => x.agentId === agent.id);
    if (a?.kind === 'MEETING') return `room:${a.meetingId ?? 'meeting'}`;
    return 'seat';
  };
  // The agents menu closes on Escape, on a click anywhere else, and once an agent is chosen.
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);
  const needle = query.trim().toLowerCase();
  const listed = needle
    ? ordered.filter(a => `${a.name} ${a.role} ${STATUS[views.get(a.id)!.status].label}`.toLowerCase().includes(needle))
    : ordered;
  const meetingCount = summary.meeting;

  return (
    <section
      ref={stage}
      className="office3d"
      data-names={names ? 'on' : 'off'}
      data-chat={chatOpen ? 'open' : 'closed'}
      data-ready={ready ? 'true' : 'false'}
      aria-label="Office floor"
      aria-busy={!ready}
    >
      <div
        ref={host}
        className="office3d-host"
        tabIndex={0}
        role="group"
        aria-label="3D office view. Arrow keys rotate, plus and minus zoom, zero resets the view."
      />
      <div className="office3d-labels">
        {ordered.map(agent => {
          const view = views.get(agent.id)!;
          const look = avatarLook(agent.id, agent.name);
          const act = activity.find(x => x.agentId === agent.id);
          return (
            <button
              key={agent.id}
              type="button"
              ref={el => {
                if (el) labels.current.set(agent.id, el);
                else labels.current.delete(agent.id);
              }}
              data-office-agent={agent.id}
              data-location={locationOf(agent)}
              data-status={view.status}
              data-selected={selectedId === agent.id ? 'true' : 'false'}
              className="person-tag"
              style={{ '--shirt': look.shirt, '--hair': look.hair, '--skin': look.skin } as React.CSSProperties}
              onClick={() => onAgent(agent.id)}
              aria-label={`${agent.name} — ${STATUS[view.status].label}. Open details`}
            >
              <span className="tag-row">
                <span className="tag-name">{agent.name}</span>
                <span className="tag-dot" aria-hidden="true" />
              </span>
              {view.bubble && (
                <span className="tag-bubble" data-status={view.status} aria-hidden="true">
                  {view.bubble}
                </span>
              )}
              <span className="tag-card" aria-hidden="true">
                <strong>{agent.name}</strong>
                <span className="tag-role">
                  {agent.role.replaceAll('_', ' ')} · {agent.provider} {agent.model}
                  {agent.effort && agent.effort !== 'default' ? ` · ${agent.effort}` : ''}
                </span>
                <StatusPill status={view.status} />
                {view.requestName && <span>{view.requestName}</span>}
                {view.elapsed && <span>Elapsed {view.elapsed}</span>}
                <span className="tag-evidence">{view.evidence}</span>
                {loungeSlots.includes(agent.id) && (
                  <span className="tag-evidence">
                    Resting in the rest area
                    {allowance.get(agent.id) !== null &&
                      ` — ${Math.round(allowance.get(agent.id)!)}% of the allowance left`}
                  </span>
                )}
                {act?.kind === 'UNKNOWN' && <span className="tag-evidence">{act.detail}</span>}
              </span>
            </button>
          );
        })}
        {roomSlots.map((id, index) =>
          id ? (
            <div
              key={`room-${index}`}
              className="table-tag"
              ref={el => {
                if (el) tags.current.set(index, el);
                else tags.current.delete(index);
              }}
            >
              <b>{index === 0 ? 'Collaboration' : index === 1 ? 'Review' : `Room ${index + 1}`}</b>
              <span>{roomName(id)}</span>
            </div>
          ) : null,
        )}
      </div>

      <header className="stage-title">
        <h3>QUANT RESEARCH OFFICE</h3>
        <span aria-live="polite">
          {summary.working ? `${summary.working} working now` : 'Nobody working right now'}
        </span>
      </header>
      {meetingCount > 0 && (
        <aside className="stage-banner" aria-live="polite">
          <Users size={14} aria-hidden="true" />
          <span>
            {meetingCount} {meetingCount === 1 ? 'person' : 'people'} in a meeting
          </span>
        </aside>
      )}
      <div
        className="stage-tools"
        role="toolbar"
        aria-label="Office view controls"
        data-menu={menuOpen ? 'open' : 'closed'}
      >
        <div className="tool-slot" ref={menu}>
          <button
            type="button"
            className="tool"
            aria-label="Agents on the floor"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-open={menuOpen ? 'true' : 'false'}
            onClick={() => setMenuOpen(open => !open)}
          >
            <span className="tool-icon">
              <Users size={16} />
            </span>
            <span className="tool-label" aria-hidden="true">
              Agents · {ordered.length}
            </span>
          </button>
          {menuOpen && (
            <div className="agent-menu" role="menu" aria-label="Agents on the floor">
              {ordered.length > 8 && (
                <label className="agent-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    autoFocus
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Find an agent"
                    aria-label="Find an agent"
                  />
                </label>
              )}
              <div className="agent-list">
                {listed.map(agent => {
                  const view = views.get(agent.id)!;
                  const look = avatarLook(agent.id, agent.name);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      role="menuitem"
                      className="agent-item"
                      data-status={view.status}
                      data-selected={selectedId === agent.id ? 'true' : 'false'}
                      style={{ '--shirt': look.shirt } as React.CSSProperties}
                      onClick={() => {
                        setMenuOpen(false);
                        engine.current?.focus(agent.id);
                        onAgent(agent.id);
                      }}
                    >
                      <i className="chip-swatch" aria-hidden="true" />
                      <span className="agent-name">{agent.name}</span>
                      <span className="agent-state">
                        {STATUS[view.status].label}
                        <i className="tag-dot" aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
                {!listed.length && <p className="agent-none">No agent matches.</p>}
              </div>
            </div>
          )}
        </div>
        <span className="tool-rule" aria-hidden="true" />
        {(
          [
            ['Zoom in', <ZoomIn size={16} key="zi" />, () => engine.current?.zoomBy(1.3)],
            ['Zoom out', <ZoomOut size={16} key="zo" />, () => engine.current?.zoomBy(1 / 1.3)],
            ['Reset view', <LocateFixed size={16} key="rv" />, () => engine.current?.resetView()],
          ] as const
        ).map(([label, icon, run]) => (
          <button key={label} type="button" className="tool" aria-label={label} onClick={run}>
            <span className="tool-icon">{icon}</span>
            <span className="tool-label" aria-hidden="true">
              {label}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="tool"
          aria-label="Show names"
          aria-pressed={names}
          onClick={() => setNames(!names)}
        >
          <span className="tool-icon">
            <Tag size={16} />
          </span>
          <span className="tool-label" aria-hidden="true">
            {names ? 'Hide names' : 'Show names'}
          </span>
        </button>
      </div>
      <div className="stage-status" role="status">
        <b className="stage-pulse" data-live={summary.working ? 'on' : 'off'} aria-hidden="true" />
        <span>{stageLine(summary)}</span>
      </div>
      {chat && <div className="stage-chat-panel">{chat}</div>}
      <button
        type="button"
        className="stage-chat"
        aria-pressed={chatOpen}
        aria-label={chatOpen ? 'Hide office chat' : 'Show office chat'}
        onClick={onToggleChat}
      >
        <MessageSquare size={16} />
        <span>CHAT</span>
      </button>
      {!team.length && <p className="stage-empty">The floor is ready. Add an agent to seat the first person.</p>}
      {/* Until the first frame: a plain panel in the page's colours, instead of an empty sky. */}
      <p className="office3d-loading" aria-hidden={ready}>
        Loading…
      </p>
    </section>
  );
}

/** The textual twin of the floor, kept below the 3D stage for keyboard and screen-reader use. */
export function OfficeNow({
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
  return <NowPanel team={team} views={views} onAgent={onAgent} />;
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  Maximize2,
  Minimize2,
  LocateFixed,
  RotateCcw,
  RotateCw,
  Tag,
  Users,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Agent, AppState } from '../shared/types';
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
import { assignDesks, assignRooms, locate, stageLine, stageSummary, STATUS_VAR, typesWhile } from './office3d/visuals';

const rootTheme = (): 'dark' | 'light' => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const rootReduced = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
  document.documentElement.dataset.motion === 'reduced';

/** WebGL available at all? A blocked GPU falls back to the classic floor instead of a blank box. */
let webgl: boolean | undefined;
export function webglAvailable(): boolean {
  if (webgl === undefined)
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      webgl = !!gl;
      (gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    } catch {
      webgl = false;
    }
  return webgl;
}

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
  const flat = view === '2d' || broken || !webglAvailable();
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
  const pickRef = useRef(onAgent);
  pickRef.current = onAgent;
  const [names, setNames] = useBoolPref('office-names', true);
  const [fullscreen, setFullscreen] = useState(false);

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
        empty: !team.length,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      zones.directors.length,
      zones.pms.length,
      zones.workers.length,
      roomSlots.length,
      tableSeatDemand([...meetingPeople.values()].map(p => p.length)),
      team.length === 0,
    ],
  );
  const desks = assignDesks(layout, ordered);
  const visuals: AgentVisual[] = ordered.map(agent => {
    const view = views.get(agent.id)!;
    const act = activity.find(x => x.agentId === agent.id);
    const look = avatarLook(agent.id, agent.name);
    const location = locate(agent, desks, act, roomSlots, seatInMeeting);
    return {
      id: agent.id,
      colors: { shirt: look.shirt, hair: look.hair, skin: look.skin },
      status: STATUS_VAR[view.status],
      monitor: view.monitor,
      home: desks.get(agent.id) ?? 0,
      location,
      typing: location.kind === 'desk' && typesWhile(view.status),
      talking: location.kind === 'table',
    };
  });
  const visualsKey = JSON.stringify(visuals);
  const summary = stageSummary(ordered.map(a => views.get(a.id)!.status));
  const summaryKey = JSON.stringify(summary);
  const busyTables = new Set(roomSlots.flatMap((id, i) => (id ? [i] : [])));
  const busyKey = [...busyTables].join(',');
  const layoutKey = JSON.stringify([
    layout.desks.map(d => [d.zone, d.x, d.z]),
    layout.tables.map(t => [t.x, t.z, t.seats.length]),
  ]);
  const roomName = (id: string) => (requests ?? []).find(r => r.id === id)?.name ?? 'Conversation in progress';

  // Create the engine once; a GPU that refuses hands the page back to the flat floor.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let created: OfficeEngine;
    try {
      created = new OfficeEngine({
        host: el,
        labels: labels.current,
        tags: tags.current,
        theme,
        reducedMotion: reducedMotion || rootReduced(),
        onPick: id => pickRef.current(id),
        onHover: () => {},
      });
    } catch {
      onFail();
      return;
    }
    engine.current = created;
    const observer = new MutationObserver(() => {
      created.setTheme(rootTheme());
      created.setReducedMotion(rootReduced());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    const onFullscreen = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      observer.disconnect();
      document.removeEventListener('fullscreenchange', onFullscreen);
      created.dispose();
      engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    engine.current?.setLayout(layout);
    engine.current?.setAgents(JSON.parse(visualsKey));
    engine.current?.setBoard(JSON.parse(summaryKey));
    engine.current?.setBusyTables(busyTables);
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
    engine.current?.setBusyTables(busyTables);
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
    const a = activity.find(x => x.agentId === agent.id);
    return a?.kind === 'MEETING' ? `room:${a.meetingId ?? 'meeting'}` : 'seat';
  };
  const toggleFullscreen = () => {
    const el = stage.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };
  const meetingCount = summary.meeting;

  return (
    <section
      ref={stage}
      className="office3d"
      data-names={names ? 'on' : 'off'}
      data-chat={chatOpen ? 'open' : 'closed'}
      aria-label="Office floor"
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
      {!!ordered.length && (
        <nav className="stage-chips" aria-label="Focus the camera on an agent">
          {ordered.map(agent => {
            const view = views.get(agent.id)!;
            const look = avatarLook(agent.id, agent.name);
            return (
              <button
                key={agent.id}
                type="button"
                className="stage-chip"
                data-status={view.status}
                data-selected={selectedId === agent.id ? 'true' : 'false'}
                style={{ '--shirt': look.shirt } as React.CSSProperties}
                title={`${agent.name} — ${view.line}`}
                onClick={() => {
                  engine.current?.focus(agent.id);
                  onAgent(agent.id);
                }}
              >
                <i className="chip-swatch" aria-hidden="true" />
                <span>{agent.name}</span>
                <i className="tag-dot" aria-hidden="true" />
              </button>
            );
          })}
        </nav>
      )}
      {meetingCount > 0 && (
        <aside className="stage-banner" aria-live="polite">
          <Users size={14} aria-hidden="true" />
          <span>
            {meetingCount} {meetingCount === 1 ? 'person' : 'people'} in a meeting
          </span>
        </aside>
      )}
      <div className="stage-tools" role="toolbar" aria-label="Office view controls">
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => engine.current?.zoomBy(1.3)}>
          <ZoomIn size={16} />
        </button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => engine.current?.zoomBy(1 / 1.3)}>
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          aria-label="Rotate left"
          title="Rotate left"
          onClick={() => engine.current?.rotate(-Math.PI / 4)}
        >
          <RotateCcw size={16} />
        </button>
        <button
          type="button"
          aria-label="Rotate right"
          title="Rotate right"
          onClick={() => engine.current?.rotate(Math.PI / 4)}
        >
          <RotateCw size={16} />
        </button>
        <button type="button" aria-label="Reset view" title="Reset view" onClick={() => engine.current?.resetView()}>
          <LocateFixed size={16} />
        </button>
        <button
          type="button"
          aria-label="Show names"
          aria-pressed={names}
          title={names ? 'Hide names' : 'Show names'}
          onClick={() => setNames(!names)}
        >
          <Tag size={16} />
        </button>
        <button
          type="button"
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          title={fullscreen ? 'Exit full screen' : 'Full screen'}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <div className="stage-status" role="status">
        <b className="stage-pulse" data-live={summary.working ? 'on' : 'off'} aria-hidden="true" />
        <span>{stageLine(summary)}</span>
        <small>drag rotate · scroll zoom · space + drag pan · double-click focus</small>
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

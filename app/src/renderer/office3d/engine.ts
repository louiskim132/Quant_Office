import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Avatar, AvatarShared, type AvatarColors } from './avatar';
import { Kit } from './kit';
import { WALL_HEIGHT, placePose, routeBetween, samePlace, type OfficeLayout, type Place, type Vec2 } from './layout';
import { buildWorld, type BoardSummary, type MonitorState, type Theme, type World } from './world';

export type Location =
  { kind: 'desk'; index: number } | { kind: 'room'; index: number; seat: number } | { kind: 'rest'; spot: number };
export interface AgentVisual {
  id: string;
  colors: AvatarColors;
  /** CSS custom-property name of the status colour (--st-working, …). */
  status: string;
  monitor: MonitorState;
  /** The person's own desk: its monitor shows their state even while they are away at a meeting. */
  home: number;
  location: Location;
  /** Seated figures type while working and talk while in a meeting. */
  typing: boolean;
  talking: boolean;
  /** Resting in the lounge: the standing figure plays ping-pong, the seated one leans back. */
  resting: boolean;
}
export interface EngineOptions {
  host: HTMLElement;
  labels: Map<string, HTMLElement>;
  tags: Map<number, HTMLElement>;
  theme: Theme;
  reducedMotion: boolean;
  onPick(id: string): void;
  onHover(id: string | null): void;
  onViewChange?(): void;
}

const WALK_SPEED = 2.3;
const AZIMUTH = Math.PI / 4;
const POLAR = THREE.MathUtils.degToRad(56);
/** How much of the courtyard is kept in frame around the building. */
const FIT_PAD = 1.6;
/** Distance from the camera to its target; fog distances are measured from here. */
const CAMERA_DISTANCE = 120;

interface Walker {
  avatar: Avatar;
  visual: AgentVisual;
  place: Place;
  route: Vec2[] | null;
  leg: number;
  pending: Place | null;
  yaw: number;
  fade: number;
  pause: number;
  halo: THREE.Mesh;
}
interface Tween {
  t: number;
  duration: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromZoom: number;
  toZoom: number;
  fromAz: number;
  toAz: number;
  fromPolar: number;
  toPolar: number;
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * The 3D office. The React component owns data; this class owns GPU objects, the camera and the
 * animation loop. It renders only while something moves (walking, typing, a camera glide), so an
 * idle office costs nothing, and it frees every resource on dispose.
 */
export class OfficeEngine {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 600);
  private controls: OrbitControls;
  private kit = new Kit();
  private shared = new AvatarShared();
  private world: World | null = null;
  private layout: OfficeLayout | null = null;
  private walkers = new Map<string, Walker>();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hoverRing: THREE.Mesh;
  private selectRing: THREE.Mesh;
  private haloGeometry: THREE.RingGeometry;
  private haloMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private light: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private envMap: THREE.Texture;
  private observer: ResizeObserver;
  private intersect: IntersectionObserver;
  private width = 1;
  private height = 1;
  private raf = 0;
  private last = 0;
  private lastDraw = 0;
  private dirty = true;
  private visible = true;
  private disposed = false;
  private painted = false;
  private teleport = true;
  private fitZoom = 1;
  private userMoved = false;
  private tween: Tween | null = null;
  private hovered: string | null = null;
  private selected: string | null = null;
  private down: { x: number; y: number; id: string | null } | null = null;
  private showNames = true;
  private theme: Theme;
  private reduced: boolean;
  private board: BoardSummary = { working: 0, idle: 0, attention: 0, meeting: 0, total: 0 };
  private busy = new Set<number>();
  private lastVisuals: readonly AgentVisual[] = [];
  private cleanups: (() => void)[] = [];

  constructor(private opts: EngineOptions) {
    this.theme = opts.theme;
    this.reduced = opts.reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Filmic response and a soft studio environment for ambient light and glass reflections.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envMap = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'office3d-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.dataset.engine = 'webgl';
    opts.host.appendChild(this.canvas);
    this.shared.own(this.kit);

    this.hemi = new THREE.HemisphereLight('#fff6e6', '#8a7b69', 1.15);
    this.light = new THREE.DirectionalLight('#fff0d4', 2.1);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(4096, 4096);
    this.light.shadow.bias = -0.0003;
    this.light.shadow.normalBias = 0.035;
    this.light.shadow.radius = 3;
    this.scene.add(this.hemi, this.light, this.light.target);

    this.haloGeometry = this.kit.own(new THREE.RingGeometry(0.46, 0.58, 40));
    const ringMaterial = (color: string, opacity: number) =>
      this.kit.own(
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
      );
    this.hoverRing = new THREE.Mesh(this.kit.own(new THREE.RingGeometry(0.66, 0.74, 48)), ringMaterial('#ffffff', 0.9));
    this.selectRing = new THREE.Mesh(this.kit.own(new THREE.RingGeometry(0.66, 0.78, 48)), ringMaterial('#f3c777', 1));
    for (const ring of [this.hoverRing, this.selectRing]) {
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      ring.renderOrder = 3;
      this.scene.add(ring);
    }

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = !this.reduced;
    this.controls.dampingFactor = 0.14;
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(22);
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(78);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 1.1;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.tween = null;
      this.wake();
    });
    this.controls.addEventListener('change', () => {
      this.clampTarget();
      this.dirty = true;
      this.opts.onViewChange?.();
      this.wake();
    });

    const listen = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, handler as EventListener);
      this.cleanups.push(() => el.removeEventListener(type, handler as EventListener));
    };
    listen(this.canvas, 'pointermove', e => this.onPointerMove(e));
    listen(this.canvas, 'pointerdown', e => {
      this.down = { x: e.clientX, y: e.clientY, id: this.pick(e)?.id ?? null };
    });
    listen(this.canvas, 'pointerup', e => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const hit = this.pick(e);
      if (hit) this.opts.onPick(hit.id);
    });
    listen(this.canvas, 'pointerleave', () => this.setHover(null));
    listen(this.canvas, 'dblclick', e => {
      const hit = this.pick(e);
      if (hit) this.focus(hit.id);
      else this.resetView();
    });
    const keyHost = opts.host;
    const keydown = (e: KeyboardEvent) => this.onKey(e, true);
    const keyup = (e: KeyboardEvent) => this.onKey(e, false);
    keyHost.addEventListener('keydown', keydown);
    keyHost.addEventListener('keyup', keyup);
    this.cleanups.push(() => {
      keyHost.removeEventListener('keydown', keydown);
      keyHost.removeEventListener('keyup', keyup);
    });
    const visibility = () => {
      if (document.visibilityState === 'visible') {
        this.dirty = true;
        this.wake();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', visibility));
    this.canvas.addEventListener('webglcontextlost', e => e.preventDefault());
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.dirty = true;
      this.wake();
    });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(opts.host);
    this.intersect = new IntersectionObserver(entries => {
      this.visible = entries.some(e => e.isIntersecting);
      if (this.visible) {
        this.dirty = true;
        this.wake();
      }
    });
    this.intersect.observe(opts.host);
    this.resize();
  }

  // ---- data in -----------------------------------------------------------------------------

  setLayout(layout: OfficeLayout) {
    this.layout = layout;
    if (this.world) {
      this.scene.remove(this.world.group);
      this.kit.dispose();
      this.shared = new AvatarShared().own(this.kit);
      this.haloMaterials.clear();
      // The kit freed the shared rings too; rebuild what the engine itself drew.
      this.haloGeometry = this.kit.own(new THREE.RingGeometry(0.46, 0.58, 40));
      this.hoverRing.geometry = this.kit.own(new THREE.RingGeometry(0.66, 0.74, 48));
      this.selectRing.geometry = this.kit.own(new THREE.RingGeometry(0.66, 0.78, 48));
      for (const w of this.walkers.values()) this.scene.remove(w.avatar.root);
      this.walkers.clear();
    }
    this.world = buildWorld(layout, this.kit, this.theme);
    this.scene.add(this.world.group);
    this.world.setBoard(this.board);
    this.setBusyRooms(this.busy);
    this.configureLight();
    this.teleport = true;
    this.fit(true);
    // A rebuild (a theme change, a new desk) clears the people: seat them again right away so the
    // floor is never empty, even when the caller has nothing new to say about them.
    if (this.lastVisuals.length) this.setAgents(this.lastVisuals);
    this.dirty = true;
    this.wake();
  }

  setAgents(visuals: readonly AgentVisual[]) {
    this.lastVisuals = visuals;
    if (!this.layout || !this.world) return;
    const layout = this.layout;
    const keep = new Set(visuals.map(v => v.id));
    for (const [id, w] of this.walkers)
      if (!keep.has(id)) {
        this.scene.remove(w.avatar.root);
        this.walkers.delete(id);
        this.opts.labels.get(id)?.removeAttribute('data-motion');
      }
    const seatedMonitors = new Map<number, MonitorState>();
    for (const v of visuals) {
      const place = this.resolve(layout, v.location);
      if (!place) continue;
      let w = this.walkers.get(v.id);
      if (!w) {
        const avatar = new Avatar(this.kit, this.shared, v.id, v.colors);
        const pose = placePose(place);
        avatar.root.position.set(pose.pos.x, 0, pose.pos.z);
        avatar.root.rotation.y = pose.yaw;
        avatar.setPose(pose.pose);
        const halo = new THREE.Mesh(this.haloGeometry, this.haloMaterial(v.status));
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.025;
        halo.renderOrder = 2;
        avatar.root.add(halo);
        avatar.root.traverse(o => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        this.scene.add(avatar.root);
        w = {
          avatar,
          visual: v,
          place,
          route: null,
          leg: 0,
          pending: null,
          yaw: pose.yaw,
          fade: this.painted && !this.reduced ? 0 : 1,
          pause: 0,
          halo,
        };
        if (w.fade < 1) avatar.root.scale.setScalar(0.001);
        this.walkers.set(v.id, w);
      } else if (!samePlace(w.place, place)) {
        if (this.teleport || this.reduced || !this.painted) this.seat(w, place);
        else if (w.route) w.pending = place;
        else this.startWalk(w, place);
      }
      w.visual = v;
      w.avatar.typing = v.typing;
      w.avatar.talking = v.talking;
      w.avatar.resting = v.resting;
      w.avatar.playing = v.resting && placePose(w.place).pose === 'standing';
      w.halo.material = this.haloMaterial(v.status);
      w.halo.visible = v.status !== '--st-idle';
      seatedMonitors.set(v.home, v.monitor);
      this.opts.labels.get(v.id)?.setAttribute('data-motion', w.route ? 'walking' : 'seated');
    }
    // Desks nobody owns stay dark; a desk whose person is away at a meeting shows the away screen.
    layout.desks.forEach(desk => this.world!.setMonitor(desk.index, seatedMonitors.get(desk.index) ?? 'off'));
    this.teleport = false;
    this.painted = true;
    this.dirty = true;
    this.updateSelection();
    this.wake();
  }

  setBoard(summary: BoardSummary) {
    this.board = summary;
    this.world?.setBoard(summary);
    this.dirty = true;
    this.wake();
  }

  setBusyRooms(busy: ReadonlySet<number>) {
    this.busy = new Set(busy);
    this.world?.roomFloors.forEach(
      (floor, i) =>
        (floor.material = this.busy.has(i) ? this.world!.floorMaterials.busy : this.world!.floorMaterials.idle),
    );
    this.dirty = true;
    this.wake();
  }

  setSelected(id: string | null) {
    this.selected = id;
    this.updateSelection();
    this.dirty = true;
    this.wake();
  }

  setNames(show: boolean) {
    this.showNames = show;
    this.dirty = true;
    this.wake();
  }

  setReducedMotion(reduced: boolean) {
    this.reduced = reduced;
    this.controls.enableDamping = !reduced;
    this.dirty = true;
    this.wake();
  }

  setTheme(theme: Theme) {
    if (theme === this.theme) return;
    this.theme = theme;
    if (this.layout) this.setLayout(this.layout);
  }

  // ---- camera ------------------------------------------------------------------------------

  resetView() {
    this.userMoved = false;
    const goal = this.fitGoal();
    if (goal) this.glide(goal.target, goal.zoom, AZIMUTH, POLAR);
  }

  rotate(radians: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    this.userMoved = true;
    this.glide(this.controls.target.clone(), this.camera.zoom, sph.theta + radians, sph.phi);
  }

  zoomBy(factor: number) {
    this.userMoved = true;
    const z = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom);
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.glide(this.controls.target.clone(), z, sph.theta, sph.phi, 0.18);
  }

  focus(id: string) {
    const w = this.walkers.get(id);
    if (!w) return;
    this.userMoved = true;
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.glide(
      new THREE.Vector3(w.avatar.root.position.x, 0.9, w.avatar.root.position.z),
      Math.max(this.camera.zoom, this.fitZoom * 3.2),
      sph.theta,
      sph.phi,
    );
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.intersect.disconnect();
    for (const undo of this.cleanups.splice(0)) undo();
    this.controls.dispose();
    this.kit.dispose();
    this.envMap.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  // ---- internals ---------------------------------------------------------------------------

  private haloMaterial(statusVar: string) {
    let m = this.haloMaterials.get(statusVar);
    if (!m) {
      const css = getComputedStyle(document.documentElement).getPropertyValue(statusVar).trim() || '#9ca8a7';
      m = this.kit.own(
        new THREE.MeshBasicMaterial({
          color: css,
          transparent: true,
          opacity: statusVar === '--st-working' || statusVar === '--st-needs' ? 0.95 : 0.7,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      this.haloMaterials.set(statusVar, m);
    }
    return m;
  }

  private resolve(layout: OfficeLayout, loc: Location): Place | null {
    if (loc.kind === 'desk') {
      const desk = layout.desks[loc.index];
      return desk ? { kind: 'desk', desk } : null;
    }
    if (loc.kind === 'rest')
      return layout.rest.spots[loc.spot] ? { kind: 'rest', rest: layout.rest, spot: loc.spot } : null;
    const room = layout.rooms[loc.index];
    return room ? { kind: 'room', room, seat: loc.seat } : null;
  }

  private seat(w: Walker, place: Place) {
    const pose = placePose(place);
    w.place = place;
    w.route = null;
    w.pending = null;
    w.avatar.root.position.set(pose.pos.x, 0, pose.pos.z);
    w.avatar.root.rotation.y = pose.yaw;
    w.yaw = pose.yaw;
    w.avatar.setPose(pose.pose);
  }

  private startWalk(w: Walker, to: Place) {
    if (!this.layout) return;
    const route = routeBetween(this.layout, w.place, to);
    w.route = route.points;
    w.leg = 1;
    w.pending = null;
    w.place = to;
    w.avatar.setPose('walking');
    this.opts.labels.get(w.avatar.id)?.setAttribute('data-motion', 'walking');
  }

  private configureLight() {
    if (!this.layout) return;
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // The shadow camera covers the building and the patio just around it.
    const span = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 7;
    const day = this.theme === 'light';
    // Late-afternoon sun from the front left by day, so the faces the camera sees are lit; a high,
    // cool sky light at dusk, when the warm light comes from inside the glass instead.
    this.light.position.set(cx - 16, 34, cz + (day ? 20 : 6));
    this.light.target.position.set(cx, 0, cz);
    const cam = this.light.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = 110;
    cam.updateProjectionMatrix();
    this.hemi.color.set(day ? '#f4f8ff' : '#7f93c4');
    this.hemi.groundColor.set(day ? '#cdbfa4' : '#3a3530');
    this.hemi.intensity = day ? 1.05 : 0.75;
    this.light.color.set(day ? '#fff1dc' : '#b9c8ec');
    this.light.intensity = day ? 2.3 : 0.55;
    this.scene.environmentIntensity = day ? 0.45 : 0.22;
    this.renderer.toneMappingExposure = day ? 1.0 : 1.08;
    // Atmospheric haze: far ground and buildings fade toward the sky colour.
    this.scene.fog = new THREE.Fog(
      day ? '#e3ecef' : '#1b2a4c',
      CAMERA_DISTANCE + (day ? 26 : 20),
      CAMERA_DISTANCE + (day ? 150 : 120),
    );
  }

  private resize() {
    const rect = this.opts.host.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.width && h === this.height && this.painted) return;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
    if (this.layout) this.fit(!this.userMoved);
    // Resizing a canvas clears it: paint again in the same frame so the floor never flashes blank.
    if (this.world && this.painted) this.draw();
    this.dirty = true;
    this.wake();
  }

  /** The target and zoom that frame the whole office from the current view direction. */
  private fitGoal(azimuth?: number, polar?: number) {
    if (!this.layout) return null;
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const probe = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 600);
    const sph = new THREE.Spherical(CAMERA_DISTANCE, polar ?? POLAR, azimuth ?? AZIMUTH);
    const target = new THREE.Vector3(cx, 0, cz);
    probe.position.copy(new THREE.Vector3().setFromSpherical(sph).add(target));
    probe.lookAt(target);
    probe.updateMatrixWorld();
    const inv = probe.matrixWorldInverse;
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    const p = new THREE.Vector3();
    for (const x of [minX - FIT_PAD, maxX + FIT_PAD])
      for (const z of [minZ - FIT_PAD, maxZ + FIT_PAD])
        for (const y of [0, WALL_HEIGHT]) {
          p.set(x, y, z).applyMatrix4(inv);
          x0 = Math.min(x0, p.x);
          x1 = Math.max(x1, p.x);
          y0 = Math.min(y0, p.y);
          y1 = Math.max(y1, p.y);
        }
    const margin = 0.96;
    // The chip row hangs over the top of the stage and the status line over the bottom: frame the
    // office in the band between them so no desk starts underneath either.
    const topInset = 62;
    const bottomInset = 40;
    const zoom =
      Math.min(this.width / (x1 - x0), Math.max(1, this.height - topInset - bottomInset) / (y1 - y0)) * margin;
    // Shift the target so the projected box is centred in that band.
    const bandShift = (topInset - bottomInset) / 2 / zoom;
    const right = new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 1);
    const shift = right.multiplyScalar((x0 + x1) / 2).add(up.multiplyScalar((y0 + y1) / 2 + bandShift));
    target.add(shift);
    return { target, zoom };
  }

  private fit(snap: boolean) {
    const goal = this.fitGoal();
    if (!goal) return;
    this.fitZoom = goal.zoom;
    this.controls.minZoom = goal.zoom * 0.5;
    this.controls.maxZoom = goal.zoom * 12;
    if (!snap) return;
    this.tween = null;
    this.controls.target.copy(goal.target);
    this.camera.zoom = goal.zoom;
    this.camera.position
      .copy(new THREE.Vector3().setFromSpherical(new THREE.Spherical(CAMERA_DISTANCE, POLAR, AZIMUTH)))
      .add(goal.target);
    this.camera.lookAt(goal.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private glide(target: THREE.Vector3, zoom: number, azimuth: number, polar: number, duration = 0.55) {
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const next: Tween = {
      t: 0,
      duration: this.reduced ? 0.0001 : duration,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      fromZoom: this.camera.zoom,
      toZoom: THREE.MathUtils.clamp(zoom, this.controls.minZoom, this.controls.maxZoom),
      fromAz: sph.theta,
      toAz: azimuth,
      fromPolar: sph.phi,
      toPolar: THREE.MathUtils.clamp(polar, this.controls.minPolarAngle, this.controls.maxPolarAngle),
    };
    this.tween = next;
    this.wake();
  }

  private clampTarget() {
    if (!this.layout) return;
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const t = this.controls.target;
    const x = THREE.MathUtils.clamp(t.x, minX - 10, maxX + 10);
    const z = THREE.MathUtils.clamp(t.z, minZ - 10, maxZ + 14);
    const y = THREE.MathUtils.clamp(t.y, -1, 3);
    if (x !== t.x || y !== t.y || z !== t.z) {
      const delta = new THREE.Vector3(x - t.x, y - t.y, z - t.z);
      t.add(delta);
      this.camera.position.add(delta);
    }
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (e.target !== this.opts.host && e.target !== this.canvas) return;
    if (e.key === ' ') {
      this.controls.mouseButtons.LEFT = down ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      if (down) e.preventDefault();
      return;
    }
    if (!down) return;
    const handled = () => e.preventDefault();
    if (e.key === 'ArrowLeft') (this.rotate(-Math.PI / 12), handled());
    else if (e.key === 'ArrowRight') (this.rotate(Math.PI / 12), handled());
    else if (e.key === '+' || e.key === '=') (this.zoomBy(1.3), handled());
    else if (e.key === '-' || e.key === '_') (this.zoomBy(1 / 1.3), handled());
    else if (e.key === '0' || e.key === 'Home') (this.resetView(), handled());
  }

  private pointerRay(e: PointerEvent | MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private pick(e: PointerEvent | MouseEvent): { id: string } | null {
    if (!this.walkers.size) return null;
    this.pointerRay(e);
    const targets = [...this.walkers.values()].map(w => w.avatar.hit);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    const id = hit?.object.userData.agentId as string | undefined;
    return id ? { id } : null;
  }

  private onPointerMove(e: PointerEvent) {
    if (e.buttons) {
      this.setHover(null);
      return;
    }
    this.setHover(this.pick(e)?.id ?? null);
  }

  private setHover(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.canvas.style.cursor = id ? 'pointer' : '';
    this.opts.onHover(id);
    const w = id ? this.walkers.get(id) : undefined;
    this.hoverRing.visible = !!w && id !== this.selected;
    this.dirty = true;
    this.wake();
  }

  private updateSelection() {
    const w = this.selected ? this.walkers.get(this.selected) : undefined;
    this.selectRing.visible = !!w;
  }

  /** Request a frame; the loop stops itself when nothing is moving. */
  private wake() {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(t => this.loop(t));
  }

  private loop(time: number) {
    this.raf = 0;
    if (this.disposed) return;
    const dt = Math.min(0.1, this.last ? (time - this.last) / 1000 : 0.016);
    this.last = time;
    if (!this.visible || document.visibilityState === 'hidden') {
      this.last = 0;
      return;
    }
    let active = this.advanceTween(dt);
    const moving = this.advanceWalkers(dt);
    active = active || moving;
    const controlsMoved = this.controls.update(dt);
    active = active || controlsMoved;
    const ambient =
      !this.reduced &&
      ([...this.walkers.values()].some(w => w.avatar.typing || w.avatar.talking || w.avatar.resting) ||
        this.ballActive());
    const due = moving || active || this.dirty || (ambient && time - this.lastDraw > 66);
    if (due) {
      for (const w of this.walkers.values()) {
        if (w.route) continue;
        w.avatar.update(dt, !this.reduced);
      }
      this.draw();
      this.lastDraw = time;
      this.dirty = false;
    }
    if (active || ambient || this.dirty) this.wake();
  }

  private advanceTween(dt: number): boolean {
    const tw = this.tween;
    if (!tw) return false;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const k = ease(tw.t);
    const target = tw.fromTarget.clone().lerp(tw.toTarget, k);
    const az = THREE.MathUtils.lerp(tw.fromAz, tw.toAz, k);
    const pol = THREE.MathUtils.lerp(tw.fromPolar, tw.toPolar, k);
    this.controls.target.copy(target);
    this.camera.position
      .copy(new THREE.Vector3().setFromSpherical(new THREE.Spherical(CAMERA_DISTANCE, pol, az)))
      .add(target);
    this.camera.zoom = THREE.MathUtils.lerp(tw.fromZoom, tw.toZoom, k);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
    if (tw.t >= 1) this.tween = null;
    return !!this.tween;
  }

  private advanceWalkers(dt: number): boolean {
    let any = false;
    for (const w of this.walkers.values()) {
      if (w.fade < 1) {
        w.fade = Math.min(1, w.fade + dt / 0.32);
        w.avatar.root.scale.setScalar(Math.max(0.001, ease(w.fade)));
        any = true;
      }
      if (w.pause > 0) {
        w.pause -= dt;
        any = true;
        continue;
      }
      if (!w.route) continue;
      any = true;
      const pos = w.avatar.root.position;
      let budget = WALK_SPEED * dt;
      while (budget > 0 && w.route && w.leg < w.route.length) {
        const goal = w.route[w.leg];
        const dx = goal.x - pos.x;
        const dz = goal.z - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-4) {
          w.leg++;
          continue;
        }
        const heading = Math.atan2(dx, dz);
        const turn = Math.atan2(Math.sin(heading - w.yaw), Math.cos(heading - w.yaw));
        w.yaw += turn * Math.min(1, dt * 12);
        const step = Math.min(budget, dist);
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        budget -= step;
        if (step >= dist - 1e-6) w.leg++;
      }
      w.avatar.root.rotation.y = w.yaw;
      w.avatar.update(dt, true);
      if (w.route && w.leg >= w.route.length) {
        const pose = placePose(w.place);
        pos.set(pose.pos.x, 0, pose.pos.z);
        w.avatar.root.rotation.y = pose.yaw;
        w.yaw = pose.yaw;
        w.route = null;
        w.avatar.setPose(pose.pose);
        w.avatar.playing = w.visual.resting && pose.pose === 'standing';
        this.opts.labels.get(w.avatar.id)?.setAttribute('data-motion', 'seated');
        if (w.pending) {
          const next = w.pending;
          w.pending = null;
          w.pause = 0.35;
          const queued = next;
          setTimeout(() => {
            const live = this.walkers.get(w.avatar.id);
            if (live && !live.route && !this.disposed) {
              this.startWalk(live, queued);
              this.wake();
            }
          }, 350);
        }
      }
    }
    return any;
  }

  private draw() {
    if (!this.world) return;
    const hovered = this.hovered ? this.walkers.get(this.hovered) : undefined;
    if (hovered) {
      this.hoverRing.position.set(hovered.avatar.root.position.x, 0.04, hovered.avatar.root.position.z);
      this.hoverRing.visible = this.hovered !== this.selected;
    }
    const selected = this.selected ? this.walkers.get(this.selected) : undefined;
    if (selected) this.selectRing.position.set(selected.avatar.root.position.x, 0.05, selected.avatar.root.position.z);
    const t = performance.now() / 1000;
    for (const w of this.walkers.values()) {
      const pulse = !this.reduced && (w.visual.status === '--st-working' || w.visual.status === '--st-needs');
      w.halo.scale.setScalar(pulse ? 1 + Math.sin(t * 2.4) * 0.07 : 1);
    }
    this.moveBall();
    this.renderer.render(this.scene, this.camera);
    // What the camera shows, readable by assistive checks and acceptance tests (the canvas itself is opaque).
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.canvas.dataset.zoom = this.camera.zoom.toFixed(1);
    this.canvas.dataset.azimuth = String(Math.round((Math.atan2(offset.x, offset.z) * 180) / Math.PI));
    this.canvas.dataset.people = String(this.walkers.size);
    this.placeLabels();
  }

  /** Both ping-pong players are at the table: a ball keeps moving between them. */
  private ballActive() {
    if (this.reduced || !this.world) return false;
    const at = [...this.walkers.values()].filter(
      w => !w.route && w.place.kind === 'rest' && w.place.rest.spots[w.place.spot].kind === 'play',
    );
    return at.length >= 2;
  }
  private moveBall() {
    const pong = this.world?.pingPong;
    if (!pong) return;
    const live = this.ballActive();
    pong.ball.visible = live;
    if (!live) return;
    const t = performance.now() / 1000;
    const k = Math.abs(((t * 0.9) % 2) - 1);
    pong.ball.position.set(
      pong.from.x + (pong.to.x - pong.from.x) * k,
      pong.y + Math.abs(Math.sin(t * 0.9 * Math.PI * 2)) * 0.2,
      pong.from.z + Math.sin(t * 1.3) * 0.2,
    );
  }

  private labelWidths = new WeakMap<HTMLElement, number>();

  /**
   * Hang each name tag over its person, then thin out the crowd: tags are placed nearest-first and
   * a tag that would sit on top of one already placed shrinks to its status dot (the name returns
   * on hover or selection). The hovered and selected people always keep their full tag.
   */
  private placeLabels() {
    const v = new THREE.Vector3();
    const w = this.width;
    const h = this.height;
    const items: { id: string; el: HTMLElement; x: number; y: number; width: number; rank: number }[] = [];
    // Reads first, writes after, so the layout engine runs once per frame.
    for (const [id, walker] of this.walkers) {
      const el = this.opts.labels.get(id);
      if (!el) continue;
      v.set(
        walker.avatar.root.position.x,
        walker.avatar.labelHeight * walker.avatar.root.scale.y,
        walker.avatar.root.position.z,
      );
      v.project(this.camera);
      const expanded = el.dataset.collapsed !== 'true' && this.showNames;
      if (expanded || !this.labelWidths.has(el))
        this.labelWidths.set(el, Math.max(this.labelWidths.get(el) ?? 0, el.offsetWidth));
      items.push({
        id,
        el,
        x: (v.x * 0.5 + 0.5) * w,
        y: (-v.y * 0.5 + 0.5) * h,
        width: this.labelWidths.get(el) ?? 90,
        rank: id === this.hovered ? 3 : id === this.selected ? 2 : 0,
      });
    }
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const collapsed = new Set<string>();
    for (const item of [...items].sort((a, b) => b.rank - a.rank || b.y - a.y)) {
      const box = { x0: item.x - item.width / 2, x1: item.x + item.width / 2, y0: item.y - 30, y1: item.y };
      const clash = placed.some(p => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1);
      if (clash && item.rank === 0) collapsed.add(item.id);
      else placed.push(box);
    }
    for (const item of items) {
      const { el } = item;
      el.style.transform = `translate3d(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.zIndex = String(Math.round(item.y) + (item.id === this.hovered ? 5000 : 0));
      el.dataset.hovered = item.id === this.hovered ? 'true' : 'false';
      el.dataset.collapsed = collapsed.has(item.id) ? 'true' : 'false';
    }
    if (this.layout)
      for (const [index, el] of this.opts.tags) {
        const room = this.layout.rooms[index];
        if (!room) continue;
        v.set(room.x, 1.9, room.z);
        v.project(this.camera);
        el.style.transform = `translate3d(${((v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * h).toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
  }
}

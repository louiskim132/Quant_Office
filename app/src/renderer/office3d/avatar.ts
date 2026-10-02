import * as THREE from 'three';
import type { Kit } from './kit';

export interface AvatarColors {
  shirt: string;
  hair: string;
  skin: string;
}
export type Pose = 'seated' | 'standing' | 'walking';

/**
 * A small voxel person. Local +z is the front. The root sits on the floor under the hips; the
 * rig is a handful of pivots so the pose can switch between standing, walking and sitting without
 * swapping meshes. Everything is shared geometry, so a hundred people cost a hundred small groups.
 */
export class Avatar {
  readonly root = new THREE.Group();
  readonly hit: THREE.Mesh;
  private body = new THREE.Group();
  private head = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private shinL = new THREE.Group();
  private shinR = new THREE.Group();
  private pose: Pose = 'standing';
  private phase = Math.random() * 6;
  /** Seated figures lean into the keyboard while working and sit still otherwise. */
  typing = false;
  talking = false;
  /** A standing figure swings a paddle (ping-pong in the rest area). */
  playing = false;
  /** A seated figure on the sofa leans back, hands loose. */
  resting = false;

  constructor(
    kit: Kit,
    shared: AvatarShared,
    readonly id: string,
    colors: AvatarColors,
  ) {
    const mat = (color: string) => shared.material(kit, color);
    const part = (g: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(g, mat(color));
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    };
    const trousers = '#2d3447';
    // Legs: pivot at the hip, a thigh and a shin that can bend.
    for (const [leg, shin, side] of [
      [this.legL, this.shinL, -1],
      [this.legR, this.shinR, 1],
    ] as const) {
      leg.position.set(side * 0.1, 0, 0);
      leg.add(part(shared.thigh, trousers, 0, -0.19, 0));
      shin.position.set(0, -0.39, 0);
      shin.add(part(shared.shin, trousers, 0, -0.19, 0), part(shared.foot, '#1b1f27', 0, -0.4, 0.04));
      leg.add(shin);
      this.body.add(leg);
    }
    this.body.add(part(shared.torso, colors.shirt, 0, 0.27, 0));
    this.body.add(part(shared.belt, '#20252f', 0, 0.02, 0));
    for (const [arm, side] of [
      [this.armL, -1],
      [this.armR, 1],
    ] as const) {
      arm.position.set(side * 0.26, 0.5, 0);
      arm.add(part(shared.arm, colors.shirt, 0, -0.22, 0), part(shared.hand, colors.skin, 0, -0.5, 0));
      this.body.add(arm);
    }
    this.head.position.set(0, 0.52, 0);
    this.head.add(
      part(shared.head, colors.skin, 0, 0.14, 0),
      part(shared.hairTop, colors.hair, 0, 0.29, -0.005),
      part(shared.hairBack, colors.hair, 0, 0.14, -0.1),
      part(shared.eye, '#1a1a22', -0.06, 0.16, 0.121),
      part(shared.eye, '#1a1a22', 0.06, 0.16, 0.121),
    );
    this.body.add(this.head);
    this.root.add(this.body);

    // An invisible capsule-ish volume that is easy to hover and click.
    this.hit = new THREE.Mesh(shared.hitGeometry, shared.hitMaterial);
    this.hit.position.y = 0.8;
    this.hit.userData.agentId = id;
    this.root.add(this.hit);
    this.setPose('standing');
  }

  get currentPose() {
    return this.pose;
  }

  setPose(pose: Pose) {
    this.pose = pose;
    const seated = pose === 'seated';
    this.body.position.y = seated ? 0.5 : 0.8;
    this.legL.rotation.x = this.legR.rotation.x = seated ? -Math.PI / 2 : 0;
    this.shinL.rotation.x = this.shinR.rotation.x = seated ? Math.PI / 2 : 0;
    this.armL.rotation.x = this.armR.rotation.x = seated ? -1.05 : 0;
    this.hit.position.y = seated ? 0.95 : 0.8;
  }

  /** Where the name tag hangs, in root-local space. */
  get labelHeight() {
    return this.pose === 'seated' ? 1.78 : 2.02;
  }

  update(dt: number, animate: boolean) {
    this.phase += dt;
    const t = this.phase;
    if (this.pose === 'walking') {
      const swing = Math.sin(t * 9) * 0.55;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.shinL.rotation.x = Math.max(0, -swing) * 0.9;
      this.shinR.rotation.x = Math.max(0, swing) * 0.9;
      this.armL.rotation.x = -swing * 0.8;
      this.armR.rotation.x = swing * 0.8;
      this.body.position.y = 0.8 + Math.abs(Math.sin(t * 9)) * 0.03;
      this.head.rotation.x = 0;
      return;
    }
    if (this.pose === 'standing' && this.playing && animate) {
      this.armR.rotation.x = -1.15 + Math.sin(t * 7) * 0.4;
      this.armL.rotation.x = -0.35;
      this.body.position.y = 0.8 + Math.abs(Math.sin(t * 3.5)) * 0.02;
      this.head.rotation.y = Math.sin(t * 3.5) * 0.25;
      return;
    }
    if (this.pose === 'seated' && animate) {
      if (this.typing) {
        this.armL.rotation.x = -1.05 + Math.sin(t * 11) * 0.05;
        this.armR.rotation.x = -1.05 + Math.sin(t * 9 + 1.7) * 0.05;
        this.head.rotation.x = 0.1 + Math.sin(t * 1.3) * 0.02;
      } else if (this.resting) {
        this.head.rotation.x = 0.12 + Math.sin(t * 0.7) * 0.03;
        this.armL.rotation.x = this.armR.rotation.x = -0.6;
      } else if (this.talking) {
        this.head.rotation.x = Math.sin(t * 2.2) * 0.06;
        this.head.rotation.y = Math.sin(t * 0.9) * 0.25;
        this.armR.rotation.x = -1.05 + Math.max(0, Math.sin(t * 1.6)) * -0.7;
      } else {
        this.head.rotation.x = 0.05;
        this.armL.rotation.x = this.armR.rotation.x = -0.95;
      }
    }
  }
}

/** Geometry and materials every avatar reuses. */
export class AvatarShared {
  readonly thigh = new THREE.BoxGeometry(0.15, 0.4, 0.17);
  readonly shin = new THREE.BoxGeometry(0.14, 0.4, 0.15);
  readonly foot = new THREE.BoxGeometry(0.14, 0.07, 0.24);
  readonly torso = new THREE.BoxGeometry(0.44, 0.52, 0.24);
  readonly belt = new THREE.BoxGeometry(0.45, 0.07, 0.25);
  readonly arm = new THREE.BoxGeometry(0.11, 0.46, 0.12);
  readonly hand = new THREE.BoxGeometry(0.1, 0.1, 0.11);
  readonly head = new THREE.BoxGeometry(0.26, 0.28, 0.25);
  readonly hairTop = new THREE.BoxGeometry(0.29, 0.07, 0.29);
  readonly hairBack = new THREE.BoxGeometry(0.28, 0.26, 0.06);
  readonly eye = new THREE.BoxGeometry(0.03, 0.04, 0.01);
  readonly hitGeometry = new THREE.BoxGeometry(0.7, 1.7, 0.6);
  readonly hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private owned = false;
  material(kit: Kit, color: string) {
    let m = this.cache.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
      this.cache.set(color, m);
      kit.own(m);
    }
    return m;
  }
  own(kit: Kit) {
    if (this.owned) return this;
    this.owned = true;
    for (const g of [
      this.thigh,
      this.shin,
      this.foot,
      this.torso,
      this.belt,
      this.arm,
      this.hand,
      this.head,
      this.hairTop,
      this.hairBack,
      this.eye,
      this.hitGeometry,
    ])
      kit.own(g);
    kit.own(this.hitMaterial);
    return this;
  }
}

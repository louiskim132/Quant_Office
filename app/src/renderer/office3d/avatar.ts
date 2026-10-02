import * as THREE from 'three';
import type { Kit } from './kit';

export interface AvatarColors {
  shirt: string;
  hair: string;
  skin: string;
}
export type Pose = 'seated' | 'standing' | 'walking';

const TROUSERS = ['#2d3447', '#3b3f45', '#5a4a3a', '#46505a', '#2f3b33', '#4a4038'];

function seedOf(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A small person built from rounded shapes. Local +z is the front. The root sits on the floor under
 * the hips; the rig is a handful of pivots so the pose can switch between standing, walking and
 * sitting without swapping meshes. Everything is shared geometry, so a hundred people cost a
 * hundred small groups.
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
  /** A standing figure swings a paddle (ping-pong in the lounge). */
  playing = false;
  /** A seated figure on the sofa leans back, hands loose. */
  resting = false;

  constructor(
    kit: Kit,
    shared: AvatarShared,
    readonly id: string,
    colors: AvatarColors,
  ) {
    const seed = seedOf(id);
    const part = (g: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0, rough = 0.85) => {
      const m = new THREE.Mesh(g, shared.material(kit, color, rough));
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    };
    const trousers = TROUSERS[seed % TROUSERS.length];
    const shoes = seed & 4 ? '#1b1f27' : '#5b4636';
    // Legs: pivot at the hip, a thigh and a shin that can bend.
    for (const [leg, shin, side] of [
      [this.legL, this.shinL, -1],
      [this.legR, this.shinR, 1],
    ] as const) {
      leg.position.set(side * 0.095, 0, 0);
      leg.add(part(shared.thigh, trousers, 0, -0.19, 0, 0.9));
      shin.position.set(0, -0.39, 0);
      shin.add(part(shared.shin, trousers, 0, -0.2, 0, 0.9), part(shared.foot, shoes, 0, -0.42, 0.05, 0.6));
      leg.add(shin);
      this.body.add(leg);
    }
    this.body.add(part(shared.pelvis, trousers, 0, -0.04, 0, 0.9));
    this.body.add(part(shared.torso, colors.shirt, 0, 0.28, 0, 0.92));
    this.body.add(part(shared.neck, colors.skin, 0, 0.5, 0, 0.6));
    for (const [arm, side] of [
      [this.armL, -1],
      [this.armR, 1],
    ] as const) {
      arm.position.set(side * 0.235, 0.47, 0);
      arm.add(part(shared.arm, colors.shirt, 0, -0.22, 0, 0.92), part(shared.hand, colors.skin, 0, -0.49, 0.01, 0.6));
      this.body.add(arm);
    }
    this.head.position.set(0, 0.52, 0);
    this.head.add(
      part(shared.head, colors.skin, 0, 0.15, 0, 0.6),
      part(shared.hair, colors.hair, 0, 0.16, -0.008, 0.8),
      part(shared.ear, colors.skin, -0.112, 0.145, 0, 0.6),
      part(shared.ear, colors.skin, 0.112, 0.145, 0, 0.6),
      part(shared.nose, colors.skin, 0, 0.13, 0.112, 0.6),
      part(shared.eye, '#1f1a18', -0.04, 0.165, 0.103, 0.4),
      part(shared.eye, '#1f1a18', 0.04, 0.165, 0.103, 0.4),
    );
    // A little variety: some wear a bun, some longer hair.
    const style = (seed >>> 3) % 3;
    if (style === 1) this.head.add(part(shared.bun, colors.hair, 0, 0.27, -0.09, 0.8));
    if (style === 2) this.head.add(part(shared.longHair, colors.hair, 0, 0.06, -0.075, 0.8));
    this.body.add(this.head);
    this.root.add(this.body);

    // An invisible volume that is easy to hover and click.
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
    this.body.rotation.x = 0;
    this.legL.rotation.x = this.legR.rotation.x = seated ? -Math.PI / 2 : 0;
    this.shinL.rotation.x = this.shinR.rotation.x = seated ? Math.PI / 2 : 0;
    this.armL.rotation.x = this.armR.rotation.x = seated ? -1.05 : 0;
    this.armL.rotation.z = this.armR.rotation.z = 0;
    this.head.rotation.set(0, 0, 0);
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
      const swing = Math.sin(t * 8.5) * 0.5;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.shinL.rotation.x = Math.max(0, -swing) * 1.0;
      this.shinR.rotation.x = Math.max(0, swing) * 1.0;
      this.armL.rotation.x = -swing * 0.7;
      this.armR.rotation.x = swing * 0.7;
      this.armL.rotation.z = -0.06;
      this.armR.rotation.z = 0.06;
      this.body.position.y = 0.8 + Math.abs(Math.sin(t * 8.5)) * 0.025;
      this.body.rotation.x = 0.04;
      this.head.rotation.x = -0.04;
      return;
    }
    if (this.pose === 'standing' && this.playing && animate) {
      this.armR.rotation.x = -1.15 + Math.sin(t * 7) * 0.4;
      this.armL.rotation.x = -0.35;
      this.body.position.y = 0.78 + Math.abs(Math.sin(t * 3.5)) * 0.02;
      this.body.rotation.x = 0.12;
      this.head.rotation.y = Math.sin(t * 3.5) * 0.25;
      return;
    }
    if (this.pose === 'standing' && animate) {
      // Breathing, barely.
      this.body.position.y = 0.8 + Math.sin(t * 1.6) * 0.004;
      return;
    }
    if (this.pose === 'seated' && animate) {
      if (this.typing) {
        this.body.rotation.x = 0.08;
        this.armL.rotation.x = -1.1 + Math.sin(t * 11) * 0.05;
        this.armR.rotation.x = -1.1 + Math.sin(t * 9 + 1.7) * 0.05;
        this.head.rotation.x = 0.06 + Math.sin(t * 1.3) * 0.02;
      } else if (this.resting) {
        this.body.rotation.x = -0.14;
        this.head.rotation.x = 0.1 + Math.sin(t * 0.7) * 0.03;
        this.armL.rotation.x = this.armR.rotation.x = -0.55;
        this.armL.rotation.z = -0.12;
        this.armR.rotation.z = 0.12;
      } else if (this.talking) {
        this.body.rotation.x = 0.02;
        this.head.rotation.x = Math.sin(t * 2.2) * 0.06;
        this.head.rotation.y = Math.sin(t * 0.9) * 0.25;
        this.armR.rotation.x = -1.05 + Math.max(0, Math.sin(t * 1.6)) * -0.7;
      } else {
        this.body.rotation.x = 0;
        this.head.rotation.x = 0.05;
        this.armL.rotation.x = this.armR.rotation.x = -0.95;
      }
    }
  }
}

/** Geometry and materials every avatar reuses. */
export class AvatarShared {
  readonly thigh = new THREE.CapsuleGeometry(0.075, 0.24, 3, 10);
  readonly shin = new THREE.CapsuleGeometry(0.062, 0.27, 3, 10);
  readonly foot = new THREE.CapsuleGeometry(0.05, 0.13, 3, 8).rotateX(Math.PI / 2).scale(1, 0.75, 1);
  readonly pelvis = new THREE.SphereGeometry(1, 14, 10).scale(0.17, 0.11, 0.12);
  readonly torso = new THREE.CapsuleGeometry(0.16, 0.22, 4, 14).scale(1.2, 1, 0.74);
  readonly neck = new THREE.CylinderGeometry(0.045, 0.05, 0.11, 10);
  readonly arm = new THREE.CapsuleGeometry(0.05, 0.36, 3, 8);
  readonly hand = new THREE.SphereGeometry(0.048, 10, 8);
  readonly head = new THREE.SphereGeometry(0.115, 18, 14).scale(1, 1.1, 1.02);
  /** A cap of hair tipped back, so it covers the crown and the back but leaves the face clear. */
  readonly hair = new THREE.SphereGeometry(0.124, 18, 12, 0, Math.PI * 2, 0, 1.55).rotateX(-0.55).scale(1, 1.08, 1.04);
  readonly bun = new THREE.SphereGeometry(0.055, 10, 8);
  readonly longHair = new THREE.CapsuleGeometry(0.085, 0.12, 3, 10).scale(1.25, 1, 0.55);
  readonly ear = new THREE.SphereGeometry(0.025, 8, 6).scale(0.6, 1, 1);
  readonly nose = new THREE.SphereGeometry(0.018, 8, 6);
  readonly eye = new THREE.SphereGeometry(0.012, 8, 6);
  readonly hitGeometry = new THREE.BoxGeometry(0.7, 1.7, 0.6);
  readonly hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private owned = false;
  material(kit: Kit, color: string, roughness = 0.85) {
    const key = `${color}|${roughness}`;
    let m = this.cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
      this.cache.set(key, m);
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
      this.pelvis,
      this.torso,
      this.neck,
      this.arm,
      this.hand,
      this.head,
      this.hair,
      this.bun,
      this.longHair,
      this.ear,
      this.nose,
      this.eye,
      this.hitGeometry,
    ])
      kit.own(g);
    kit.own(this.hitMaterial);
    return this;
  }
}

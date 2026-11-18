import * as THREE from 'three';
import { Terrain, WATER_LEVEL } from './terrain';

export const CREATURE_KINDS = ['longneck', 'plated', 'runner', 'flyer'] as const;
export type CreatureKind = (typeof CREATURE_KINDS)[number];

export const MAX_CREATURES = 200;

/** A placed creature: what is saved and undone. Where it has wandered to since is not kept. */
export interface CreatureSpec {
  readonly k: number; // index into CREATURE_KINDS
  readonly x: number; // home position; it roams around here
  readonly z: number;
  readonly seed: number; // decides its colours and proportions
  readonly young: boolean;
}

export interface CreatureFile {
  kinds: string[];
  /** Flat list: kind, x, z, seed, young (0 or 1), repeated. */
  data: number[];
}

interface Species {
  speed: number; // walking speed, world units per second
  turn: number; // radians per second
  stride: number; // how far a foot travels along the ground each step
  duty: number; // share of each step a foot spends on the ground
  radius: number; // personal space
  reach: number; // how far ahead it checks the ground
  leash: number; // how far it roams from home
  notice: number; // distance at which it looks at the camera
  grazes: boolean;
  skittish: boolean;
  size: [number, number]; // adult scale range
  youngSize: number;
  palettes: [number, number][]; // [body, accent]
}

const SPECIES: Record<CreatureKind, Species> = {
  longneck: {
    speed: 1.7, turn: 0.45, stride: 2.2, duty: 0.7, radius: 3.8, reach: 7, leash: 42, notice: 46,
    grazes: true, skittish: false, size: [0.85, 1.2], youngSize: 0.42,
    palettes: [[0x2fb5c8, 0xbdf0e6], [0x7d6fe0, 0xd9d0ff], [0x3fbf7a, 0xd6f5b0], [0x4f8fe8, 0xcfe6ff]],
  },
  plated: {
    speed: 1.2, turn: 0.6, stride: 1.4, duty: 0.7, radius: 2.6, reach: 5, leash: 30, notice: 26,
    grazes: true, skittish: false, size: [0.85, 1.15], youngSize: 0.45,
    palettes: [[0xf08a3c, 0xe0433f], [0x9bc53d, 0xf2a03d], [0xd9a441, 0x9c4fd0]],
  },
  runner: {
    speed: 4.2, turn: 2.6, stride: 1.2, duty: 0.5, radius: 0.8, reach: 3, leash: 34, notice: 20,
    grazes: false, skittish: true, size: [0.6, 0.9], youngSize: 0.42,
    palettes: [[0xf2c53d, 0xe0533f], [0x6fd65a, 0x2f8f6a], [0xff8fb0, 0xb04fa0]],
  },
  flyer: {
    speed: 7, turn: 1, stride: 1, duty: 0.5, radius: 5, reach: 0, leash: 0, notice: 0,
    grazes: false, skittish: false, size: [0.9, 1.35], youngSize: 0.6,
    palettes: [[0xe8684a, 0xffd23f], [0x8f6fe0, 0xff8fb0], [0x3f9fe0, 0xffe08a]],
  },
};

type Shape = 'blob' | 'taper' | 'cone' | 'octa' | 'wing' | 'shadow';

/** A creature as it is right now. */
interface Creature {
  spec: CreatureSpec;
  kind: CreatureKind;
  size: number;
  body: THREE.Color;
  accent: THREE.Color;
  dark: THREE.Color;
  neck: number; // proportions, each around 1
  tail: number;
  girth: number;
  beat: number; // personal offset for sways and blinks

  x: number;
  z: number;
  y: number;
  heading: number;
  pitch: number;
  speed: number;
  turning: number; // -1..1, how hard it is turning
  phase: number; // step cycle
  state: 'walk' | 'idle' | 'graze';
  timer: number;
  wander: number; // heading it would like
  turnDir: number;
  graze: number; // 0..1 head down
  attention: number; // 0..1 looking at the camera
  lookYaw: number;
  parent: Creature | null;
  parentCheck: number;
  // flyers
  angle: number;
  orbit: number;
  altitude: number;
  clockwise: number;
}

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (v: number) => v - Math.floor(v);
const angleDiff = (to: number, from: number) => {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const WHITE = new THREE.Color(0xfffdf5);
const PUPIL = new THREE.Color(0x1c1430);
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Every creature in the world.
 *
 * Creatures are assembled each frame from a few simple shapes (rounded blobs,
 * tapered tubes, cones, flat diamonds and wing triangles). Each shape is one
 * instanced mesh shared by all creatures, so a whole herd costs six draw calls.
 * They cast soft discs instead of real shadows, which keeps the cached shadow
 * map valid while they move.
 */
export class Creatures {
  readonly group = new THREE.Group();

  private specs: CreatureSpec[] = [];
  private live: Creature[] = [];
  private time = 0;
  private carry = 0;

  private readonly meshes: Record<Shape, THREE.InstancedMesh>;
  private readonly used: Record<Shape, number> = { blob: 0, taper: 0, cone: 0, octa: 0, wing: 0, shadow: 0 };

  // Current creature's frame: where it stands, which way it faces, how big it is.
  private readonly rootPos = new THREE.Vector3();
  private readonly rootQuat = new THREE.Quaternion();
  private rootSize = 1;

  // Scratch
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly euler = new THREE.Euler();

  constructor(private readonly terrain: Terrain) {
    const material = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1030,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0.5, 0, 0, -0.5, 1, 0, -0.2]), 3));
    wing.computeVertexNormals();

    const make = (geometry: THREE.BufferGeometry, capacity: number, mat: THREE.Material = material) => {
      const mesh = new THREE.InstancedMesh(geometry, mat, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, WHITE);
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = mat === material;
      this.group.add(mesh);
      return mesh;
    };
    this.meshes = {
      blob: make(new THREE.IcosahedronGeometry(1, 1), MAX_CREATURES * 18),
      // A tube that narrows to 0.82 of its width, base at the origin, one unit tall.
      taper: make(new THREE.CylinderGeometry(0.82, 1, 1, 6).translate(0, 0.5, 0), MAX_CREATURES * 20),
      cone: make(new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0), MAX_CREATURES * 8),
      octa: make(new THREE.OctahedronGeometry(1, 0), MAX_CREATURES * 12),
      wing: make(wing, MAX_CREATURES * 2),
      shadow: make(new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2), MAX_CREATURES, shadowMaterial),
    };
    this.meshes.shadow.renderOrder = 2;
  }

  get count(): number {
    return this.specs.length;
  }

  // ------------------------------------------------------------ placing

  /**
   * Add creatures inside the brush for one frame. On the first frame of a
   * stroke one is placed exactly under the cursor; holding adds more nearby,
   * some of them young.
   */
  place(kind: CreatureKind, x: number, z: number, radius: number, rate: number, dt: number, first: boolean): boolean {
    let attempts = 0;
    if (first) {
      this.carry = 0;
      if (this.tryPlace(kind, x, z, false)) return true;
    } else {
      this.carry += rate * 0.1 * dt;
      attempts = Math.floor(this.carry);
      this.carry -= attempts;
    }
    let changed = false;
    for (let n = 0; n < attempts; n++) {
      const angle = Math.random() * TAU;
      const reach = radius * Math.sqrt(Math.random());
      const young = kind !== 'flyer' && Math.random() < 0.3 && this.live.some((c) => c.kind === kind && !c.spec.young);
      if (this.tryPlace(kind, x + Math.cos(angle) * reach, z + Math.sin(angle) * reach, young)) changed = true;
    }
    return changed;
  }

  /** Remove every creature whose home or current position is inside the brush. */
  remove(x: number, z: number, radius: number): boolean {
    const r2 = radius * radius;
    const keep = this.live.filter((c) => (c.x - x) ** 2 + (c.z - z) ** 2 > r2 && (c.spec.x - x) ** 2 + (c.spec.z - z) ** 2 > r2);
    if (keep.length === this.live.length) return false;
    this.live = keep;
    this.specs = keep.map((c) => c.spec);
    return true;
  }

  /** Give every creature a new look. */
  reroll(): void {
    this.restore(this.specs.map((spec) => ({ ...spec, seed: Math.floor(Math.random() * 1e6) })));
  }

  snapshot(): CreatureSpec[] {
    return this.specs.slice();
  }

  restore(specs: CreatureSpec[]): void {
    // Keep creatures that are unchanged where they are, so undoing something
    // else doesn't snap the whole herd back to its starting places.
    const existing = new Map<CreatureSpec, Creature>();
    for (const c of this.live) existing.set(c.spec, c);
    this.specs = specs.slice(0, MAX_CREATURES);
    this.live = this.specs.map((spec) => existing.get(spec) ?? this.hatch(spec));
    for (const c of this.live) c.parent = null;
  }

  serialize(): CreatureFile {
    const data: number[] = [];
    const round = (v: number) => Math.round(v * 100) / 100;
    for (const c of this.specs) data.push(c.k, round(c.x), round(c.z), c.seed, c.young ? 1 : 0);
    return { kinds: [...CREATURE_KINDS], data };
  }

  /** Load saved creatures. Anything unrecognised or off the land is skipped. */
  load(file: unknown): void {
    const specs: CreatureSpec[] = [];
    const saved = file as Partial<CreatureFile> | null | undefined;
    if (saved && Array.isArray(saved.kinds) && Array.isArray(saved.data)) {
      const remap = saved.kinds.map((name) => CREATURE_KINDS.indexOf(name as CreatureKind));
      for (let i = 0; i + 4 < saved.data.length; i += 5) {
        const [kind, x, z, seed, young] = saved.data.slice(i, i + 5).map(Number);
        const k = remap[kind];
        if (k === undefined || k < 0 || ![x, z, seed].every(Number.isFinite)) continue;
        if (!this.terrain.contains(x, z)) continue;
        specs.push({ k, x, z, seed, young: young === 1 });
      }
    }
    this.restore(specs);
  }

  private tryPlace(kind: CreatureKind, x: number, z: number, young: boolean): boolean {
    if (this.specs.length >= MAX_CREATURES || !this.terrain.contains(x, z, 1)) return false;
    const species = SPECIES[kind];
    if (kind !== 'flyer' && !this.passable(x, z)) return false;
    const space = species.radius * (young ? species.youngSize : 1);
    for (const other of this.live) {
      if ((other.kind === 'flyer') !== (kind === 'flyer')) continue;
      const gap = (space + SPECIES[other.kind].radius * other.size) * 0.9;
      if ((other.x - x) ** 2 + (other.z - z) ** 2 < gap * gap) return false;
    }
    const spec: CreatureSpec = { k: CREATURE_KINDS.indexOf(kind), x, z, seed: Math.floor(Math.random() * 1e6), young };
    this.specs.push(spec);
    this.live.push(this.hatch(spec));
    return true;
  }

  /** Build a living creature from its spec. Everything about its look comes from the seed. */
  private hatch(spec: CreatureSpec): Creature {
    const kind = CREATURE_KINDS[spec.k];
    const species = SPECIES[kind];
    const r = (i: number) => hash(spec.seed * 0.137 + i * 17.3);
    const [bodyHex, accentHex] = species.palettes[Math.floor(r(1) * species.palettes.length)];
    const body = new THREE.Color(bodyHex).offsetHSL((r(2) - 0.5) * 0.07, 0, (r(3) - 0.5) * 0.08);
    const accent = new THREE.Color(accentHex).offsetHSL((r(4) - 0.5) * 0.05, 0, 0);
    const [lo, hi] = species.size;
    const orbit = 14 + r(8) * 16;
    const angle = r(9) * TAU;
    const flying = kind === 'flyer';
    return {
      spec, kind,
      size: (lo + r(5) * (hi - lo)) * (spec.young ? species.youngSize : 1),
      body, accent,
      dark: body.clone().multiplyScalar(0.78),
      neck: 0.85 + r(6) * 0.35,
      tail: 0.85 + r(7) * 0.3,
      girth: 0.9 + r(10) * 0.25,
      beat: r(11) * 20,
      x: flying ? spec.x + Math.cos(angle) * orbit : spec.x,
      z: flying ? spec.z + Math.sin(angle) * orbit : spec.z,
      y: Math.max(this.terrain.heightAt(spec.x, spec.z), WATER_LEVEL) + (flying ? 16 + r(12) * 10 : 0),
      heading: r(13) * TAU,
      pitch: 0, speed: 0, turning: 0,
      phase: r(14),
      state: 'idle',
      timer: r(15) * 2,
      wander: r(13) * TAU,
      turnDir: 0, graze: 0, attention: 0, lookYaw: 0,
      parent: null, parentCheck: 0,
      angle, orbit,
      altitude: 16 + r(12) * 10,
      clockwise: r(16) < 0.5 ? 1 : -1,
    };
  }

  // ------------------------------------------------------------ behaviour

  /** Somewhere a walking creature is happy to stand: on land, dry, not too steep, not too high. */
  private passable(x: number, z: number): boolean {
    if (!this.terrain.contains(x, z, 1)) return false;
    const h = this.terrain.heightAt(x, z);
    return h > 0.25 && h < 27 && this.terrain.levelAt(x, z) > 0.62;
  }

  private think(c: Creature, dt: number, eye: THREE.Vector3, close: boolean): void {
    const species = SPECIES[c.kind];
    const rand = Math.random;

    c.timer -= dt;
    if (c.timer <= 0) {
      const roll = rand();
      if (roll < 0.6) {
        c.state = 'walk';
        c.timer = 4 + rand() * 7;
        c.wander = c.heading + (rand() - 0.5) * 2.4;
      } else if (roll < 0.78 || !species.grazes) {
        c.state = 'idle';
        c.timer = 2 + rand() * 3;
      } else {
        c.state = 'graze';
        c.timer = 3 + rand() * 5;
      }
    }

    let desired = c.wander;
    let targetSpeed = c.state === 'walk' ? species.speed * Math.sqrt(c.size) : 0;

    const toEyeX = eye.x - c.x;
    const toEyeZ = eye.z - c.z;
    const eyeDistance = Math.hypot(toEyeX, toEyeZ);

    // Small ones bolt when you get close on the ground.
    if (species.skittish && close && eyeDistance < 11) {
      c.state = 'walk';
      c.timer = 1.5;
      c.wander = desired = Math.atan2(-toEyeX, -toEyeZ);
      targetSpeed = species.speed * 2.3;
    }

    if (targetSpeed > 0) {
      // The young keep near an adult of their kind.
      if (c.spec.young) {
        c.parentCheck -= dt;
        if (c.parentCheck <= 0) {
          c.parentCheck = 2;
          c.parent = null;
          let best = 60 * 60;
          for (const other of this.live) {
            if (other.kind !== c.kind || other.spec.young) continue;
            const d2 = (other.x - c.x) ** 2 + (other.z - c.z) ** 2;
            if (d2 < best) {
              best = d2;
              c.parent = other;
            }
          }
        }
        if (c.parent) {
          const d = Math.hypot(c.parent.x - c.x, c.parent.z - c.z);
          const near = SPECIES[c.kind].radius * c.parent.size * 1.6;
          if (d > near) desired = Math.atan2(c.parent.x - c.x, c.parent.z - c.z);
          if (d > near * 2.5) targetSpeed *= 1.6;
        }
      }

      // Don't stray too far from home.
      if (Math.hypot(c.x - c.spec.x, c.z - c.spec.z) > species.leash) {
        desired = Math.atan2(c.spec.x - c.x, c.spec.z - c.z);
      }

      // Look ahead: turn away from water, cliffs and the edge of the land.
      const probe = species.reach * Math.max(c.size, 0.6);
      const at = (angle: number) => this.passable(c.x + Math.sin(angle) * probe, c.z + Math.cos(angle) * probe);
      if (!at(c.heading)) {
        if (!c.turnDir) {
          const left = at(c.heading + 0.9);
          const right = at(c.heading - 0.9);
          c.turnDir = left && !right ? 1 : right && !left ? -1 : rand() < 0.5 ? 1 : -1;
        }
        desired = c.wander = c.heading + c.turnDir * 1.2;
        targetSpeed *= 0.45;
      } else {
        c.turnDir = 0;
      }

      // If it has ended up in the water (the land was sculpted away), head uphill.
      if (this.terrain.heightAt(c.x, c.z) < 0.15) {
        const gx = this.terrain.heightAt(c.x + 1.5, c.z) - this.terrain.heightAt(c.x - 1.5, c.z);
        const gz = this.terrain.heightAt(c.x, c.z + 1.5) - this.terrain.heightAt(c.x, c.z - 1.5);
        if (Math.abs(gx) + Math.abs(gz) > 0.01) desired = Math.atan2(gx, gz);
      }

      // Give each other room: steer away from whoever is ahead.
      for (const other of this.live) {
        if (other === c || other.kind === 'flyer') continue;
        const ox = other.x - c.x;
        const oz = other.z - c.z;
        const gap = (species.radius * c.size + SPECIES[other.kind].radius * other.size) * 0.85;
        const d2 = ox * ox + oz * oz;
        if (d2 > gap * gap || d2 < 1e-6) continue;
        if (c.spec.young && other === c.parent) continue;
        const bearing = angleDiff(Math.atan2(ox, oz), c.heading);
        if (Math.abs(bearing) < 1.4) desired = c.heading - Math.sign(bearing || 1) * 1.1;
      }
    }

    // Bodies never overlap: ease apart from anyone standing too close, moving or not.
    for (const other of this.live) {
      if (other === c || other.kind === 'flyer') continue;
      const ox = c.x - other.x;
      const oz = c.z - other.z;
      const gap = (species.radius * c.size + SPECIES[other.kind].radius * other.size) * 0.6;
      const d = Math.hypot(ox, oz);
      if (d >= gap || d < 1e-4) continue;
      const push = Math.min(gap - d, 2 * dt) * (c.size < other.size ? 1 : 0.5);
      const px = c.x + (ox / d) * push;
      const pz = c.z + (oz / d) * push;
      if (this.terrain.contains(px, pz, 0.5)) {
        c.x = px;
        c.z = pz;
      }
    }

    const step = clamp(angleDiff(desired, c.heading), -species.turn * dt, species.turn * dt);
    c.heading += step;
    c.turning = lerp(c.turning, step / (species.turn * dt + 1e-6), 1 - Math.exp(-dt * 4));
    c.speed = lerp(c.speed, targetSpeed, 1 - Math.exp(-dt * 3));

    const nx = c.x + Math.sin(c.heading) * c.speed * dt;
    const nz = c.z + Math.cos(c.heading) * c.speed * dt;
    if (this.terrain.contains(nx, nz, 0.5)) {
      c.x = nx;
      c.z = nz;
      c.phase += (c.speed * dt) / ((species.stride * c.size) / species.duty);
    } else {
      c.speed = 0;
    }

    c.graze = lerp(c.graze, c.state === 'graze' ? 1 : 0, 1 - Math.exp(-dt * 1.5));

    // Notice the camera when it is nearby and down among them.
    const noticing = close && eyeDistance < species.notice;
    c.attention = lerp(c.attention, noticing ? 1 : 0, 1 - Math.exp(-dt * 2));
    const idleLook = Math.sin(this.time * 0.5 + c.beat) * 0.25;
    const look = noticing ? clamp(angleDiff(Math.atan2(toEyeX, toEyeZ), c.heading), -1.3, 1.3) : idleLook;
    c.lookYaw = lerp(c.lookYaw, look, 1 - Math.exp(-dt * 2.5));

    // Stand on the ground, tipped to match the slope under the body.
    const half = (c.kind === 'runner' ? 0.8 : 2.6) * c.size;
    const fx = Math.sin(c.heading) * half;
    const fz = Math.cos(c.heading) * half;
    const front = this.terrain.heightAt(c.x + fx, c.z + fz);
    const back = this.terrain.heightAt(c.x - fx, c.z - fz);
    const wade = WATER_LEVEL - 1.4 * c.size; // never sinks deeper than its belly
    const ground = Math.max((front + back) / 2, wade);
    c.y = lerp(c.y, ground, 1 - Math.exp(-dt * 8));
    c.pitch = lerp(c.pitch, clamp(Math.atan2(front - back, half * 2), -0.5, 0.5), 1 - Math.exp(-dt * 5));
  }

  private fly(c: Creature, dt: number): void {
    const species = SPECIES.flyer;
    c.angle += (c.clockwise * species.speed * dt) / c.orbit;
    c.x = c.spec.x + Math.cos(c.angle) * c.orbit;
    c.z = c.spec.z + Math.sin(c.angle) * c.orbit;
    // Velocity is the tangent of the circle.
    c.heading = Math.atan2(-Math.sin(c.angle) * c.clockwise, Math.cos(c.angle) * c.clockwise);
    const home = Math.max(this.terrain.heightAt(c.spec.x, c.spec.z), WATER_LEVEL) + c.altitude;
    const below = this.terrain.contains(c.x, c.z) ? this.terrain.heightAt(c.x, c.z) : WATER_LEVEL;
    const target = Math.max(home, below + 7) + Math.sin(this.time * 0.4 + c.beat) * 1.2;
    c.y = lerp(c.y, target, 1 - Math.exp(-dt * 1.5));
    c.phase += dt;
  }

  // ------------------------------------------------------------ frame

  /**
   * Move every creature and rebuild what is drawn.
   * `close` is true when the camera is down among them, which is when they react to it.
   */
  update(dt: number, eye: THREE.Vector3, close: boolean): void {
    this.time += dt;
    for (const shape of Object.keys(this.used) as Shape[]) this.used[shape] = 0;

    for (const c of this.live) {
      if (c.kind === 'flyer') this.fly(c, dt);
      else this.think(c, dt, eye, close);

      this.rootSize = c.size;
      this.rootPos.set(c.x, c.y, c.z);
      if (c.kind === 'flyer') {
        const flap = Math.sin(c.phase * 5.5 + c.beat);
        // Bank into the turn, and rise and fall a little with each wingbeat.
        this.rootPos.y += flap * -0.15 * c.size;
        this.rootQuat.setFromEuler(this.euler.set(0, c.heading, c.clockwise * 0.42, 'YXZ'));
        this.poseFlyer(c, flap);
      } else {
        this.rootQuat.setFromEuler(this.euler.set(-c.pitch, c.heading, 0, 'YXZ'));
        if (c.kind === 'longneck') this.poseLongneck(c);
        else if (c.kind === 'plated') this.posePlated(c);
        else this.poseRunner(c);
      }
      this.castDisc(c);
    }

    for (const shape of Object.keys(this.meshes) as Shape[]) {
      const mesh = this.meshes[shape];
      mesh.count = this.used[shape];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ drawing helpers
  // "Local" coordinates are in the creature's own frame, before its size is
  // applied: x to its right, y up, z forward.

  private put(shape: Shape, position: THREE.Vector3, quaternion: THREE.Quaternion, sx: number, sy: number, sz: number, color: THREE.Color): void {
    const mesh = this.meshes[shape];
    const i = this.used[shape];
    if (i >= mesh.instanceMatrix.count) return;
    mesh.setMatrixAt(i, this.m.compose(position, quaternion, this.s.set(sx, sy, sz)));
    mesh.setColorAt(i, color);
    this.used[shape] = i + 1;
  }

  /** Local point to world. */
  private world(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).multiplyScalar(this.rootSize).applyQuaternion(this.rootQuat).add(this.rootPos);
  }

  /** A rounded lump at a local position. `aim`, a local direction, points its long (z) axis. */
  private blob(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: THREE.Color, aim?: THREE.Vector3): void {
    const k = this.rootSize;
    this.q.copy(this.rootQuat);
    if (aim) this.q.multiply(this.q2.setFromUnitVectors(FORWARD, aim));
    this.put('blob', this.world(x, y, z, this.v0), this.q, sx * k, sy * k, sz * k, color);
  }

  /** A tapered tube between two world points. */
  private tube(shape: 'taper' | 'cone', from: THREE.Vector3, to: THREE.Vector3, radius: number, color: THREE.Color): void {
    this.dir.subVectors(to, from);
    const length = this.dir.length();
    if (length < 1e-5) return;
    this.q.setFromUnitVectors(UP, this.dir.divideScalar(length));
    this.put(shape, from, this.q, radius, length, radius, color);
  }

  /**
   * A chain of tubes (a neck or a tail) starting at a local point. Each link's
   * direction comes from `bend(k)`, which returns [pitch, yaw] in radians;
   * yaw 0 is straight ahead (or straight back when `backward`).
   * Returns the local end point in `end` and the last link's local direction in `aim`.
   */
  private chain(
    x: number, y: number, z: number,
    links: number, linkLength: number, radius: number,
    color: THREE.Color, backward: boolean,
    bend: (k: number) => [number, number],
    end: THREE.Vector3, aim: THREE.Vector3,
  ): void {
    end.set(x, y, z);
    let r = radius;
    const sign = backward ? -1 : 1;
    for (let k = 0; k < links; k++) {
      const [pitch, yaw] = bend(k);
      aim.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), sign * Math.cos(yaw) * Math.cos(pitch));
      this.world(end.x, end.y, end.z, this.v1);
      end.addScaledVector(aim, linkLength);
      this.world(end.x, end.y, end.z, this.v2);
      this.tube('taper', this.v1, this.v2, r * this.rootSize, color);
      r *= 0.82;
    }
  }

  /** A pair of eyes on a head at local `centre`, facing local direction `aim`. */
  private eyes(c: Creature, centre: THREE.Vector3, aim: THREE.Vector3, spread: number, up: number, forward: number, size: number): void {
    const right = this.v3.crossVectors(UP, aim);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const top = this.v4.crossVectors(aim, right);
    // Blink now and then.
    const lid = frac(this.time * 0.23 + c.beat) > 0.965 ? 0.12 : 1;
    for (const side of [-1, 1]) {
      const ex = centre.x + right.x * spread * side + top.x * up + aim.x * forward;
      const ey = centre.y + right.y * spread * side + top.y * up + aim.y * forward;
      const ez = centre.z + right.z * spread * side + top.z * up + aim.z * forward;
      this.blob(ex, ey, ez, size, size * lid, size, WHITE, aim);
      const out = size * 0.55;
      this.blob(ex + right.x * out * side + aim.x * size * 0.4, ey + right.y * out * side + aim.y * size * 0.4, ez + right.z * out * side + aim.z * size * 0.4, size * 0.55, size * 0.55 * lid, size * 0.55, PUPIL, aim);
    }
  }

  /**
   * One leg, from a local hip to a foot planted on the real ground. The foot
   * stays put while it is down and swings forward in an arc between steps.
   */
  private leg(c: Creature, hipX: number, hipY: number, hipZ: number, offset: number, lift: number, radius: number, footOut = 1.12): void {
    const species = SPECIES[c.kind];
    const moving = Math.min(1, c.speed / species.speed);
    const p = frac(c.phase + offset);
    let along: number;
    let raise = 0;
    if (p < species.duty) {
      along = lerp(0.5, -0.5, p / species.duty);
    } else {
      const u = (p - species.duty) / (1 - species.duty);
      along = lerp(-0.5, 0.5, u * u * (3 - 2 * u));
      raise = Math.sin(Math.PI * u);
    }
    const k = this.rootSize;
    const hip = this.world(hipX, hipY, hipZ, this.v1);
    const foot = this.world(hipX * footOut, 0, hipZ + along * species.stride * moving, this.v2);
    foot.y = this.terrain.heightAt(foot.x, foot.z) + (raise * lift * moving + radius * 0.45) * k;
    this.tube('taper', hip, foot, radius * k, c.dark);
    this.q.copy(this.rootQuat);
    this.put('blob', foot, this.q, radius * 1.15 * k, radius * 0.6 * k, radius * 1.3 * k, c.dark);
  }

  /** The soft disc under a creature that stands in for its shadow. */
  private castDisc(c: Creature): void {
    const k = c.size;
    const onLand = this.terrain.contains(c.x, c.z);
    if (c.kind === 'flyer') {
      if (!onLand) return;
      this.v0.set(c.x, Math.max(this.terrain.heightAt(c.x, c.z), WATER_LEVEL) + 0.08, c.z);
      this.q.setFromAxisAngle(UP, c.heading);
      this.put('shadow', this.v0, this.q, 1.5 * k, 1, 1.1 * k, WHITE);
      return;
    }
    const ground = Math.max(this.terrain.heightAt(c.x, c.z), WATER_LEVEL);
    this.v0.set(c.x, ground + 0.08, c.z);
    const [wide, long] = c.kind === 'longneck' ? [2.6, 4.6] : c.kind === 'plated' ? [2.2, 3.4] : [0.6, 1.1];
    this.put('shadow', this.v0, this.rootQuat, wide * k * c.girth, 1, long * k, WHITE);
  }

  // ------------------------------------------------------------ body plans

  private readonly end = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();

  private poseLongneck(c: Creature): void {
    const moving = Math.min(1, c.speed / SPECIES.longneck.speed);
    const length = 6.5;
    const girth = 1.7 * c.girth;
    const legLength = 2.6;
    const bodyY = legLength + girth * 0.75 + Math.sin(c.phase * Math.PI * 4) * 0.07 * moving;
    const young = c.spec.young;

    this.blob(0, bodyY, 0, girth * 0.95, girth, length / 2, c.body);
    for (let i = -1; i <= 1; i++) this.blob(i * 0.35 * girth, bodyY + girth * 0.86, i * 1.5 + 0.2, 0.5, 0.2, 0.65, c.accent);

    // Neck: reaches up and forward; curls down to graze; bends towards you when it has noticed you.
    const links = 5;
    const sway = Math.sin(this.time * 0.6 + c.beat) * 0.1;
    this.chain(
      0, bodyY + girth * 0.3, length * 0.36,
      links, (7 * c.neck * (young ? 0.7 : 1)) / links, girth * 0.52,
      c.body, false,
      (k) => [
        lerp((52 - 8 * k) * DEG, (-15 - 9 * k) * DEG, c.graze) - c.attention * (1 - c.graze) * 9 * DEG * (k / links),
        ((c.lookYaw + sway) * (k + 1)) / links,
      ],
      this.end, this.aim,
    );
    const h = young ? 1.7 : 1.3;
    const head = this.end.addScaledVector(this.aim, 0.4 * h);
    this.blob(head.x, head.y, head.z, 0.6 * h, 0.52 * h, 0.85 * h, c.body, this.aim);
    this.blob(head.x + this.aim.x * 0.6 * h, head.y + this.aim.y * 0.6 * h - 0.1 * h, head.z + this.aim.z * 0.6 * h, 0.36 * h, 0.3 * h, 0.46 * h, c.accent, this.aim);
    this.eyes(c, head, this.aim, 0.46 * h, 0.2 * h, 0.2 * h, 0.23 * h);

    // Tail: held off the ground, swishing, trailing behind in a turn.
    const tailLinks = 6;
    const droop = [-8, -14, -16, -12, -6, 0];
    this.chain(
      0, bodyY + girth * 0.05, -length * 0.4,
      tailLinks, (8 * c.tail * (young ? 0.8 : 1)) / tailLinks, girth * 0.6,
      c.body, true,
      (k) => [droop[k] * DEG, Math.sin(this.time * 1.1 + c.beat - k * 0.7) * 0.07 * (k + 1) - c.turning * 0.5 * ((k + 1) / tailLinks)],
      this.end, this.aim,
    );
    this.world(this.end.x, this.end.y, this.end.z, this.v1);
    this.end.addScaledVector(this.aim, 1.2);
    this.world(this.end.x, this.end.y, this.end.z, this.v2);
    this.tube('cone', this.v1, this.v2, girth * 0.6 * 0.82 ** tailLinks * c.size, c.accent);

    const hipY = bodyY - girth * 0.3;
    const hipX = girth * 0.62;
    this.leg(c, -hipX, hipY, length * 0.3, 0.25, 0.5, girth * 0.4);
    this.leg(c, hipX, hipY, length * 0.3, 0.75, 0.5, girth * 0.4);
    this.leg(c, -hipX, hipY, -length * 0.3, 0, 0.5, girth * 0.42);
    this.leg(c, hipX, hipY, -length * 0.3, 0.5, 0.5, girth * 0.42);
  }

  private posePlated(c: Creature): void {
    const moving = Math.min(1, c.speed / SPECIES.plated.speed);
    const length = 5;
    const girth = 1.5 * c.girth;
    const bodyY = 1.7 + girth * 0.62 + Math.sin(c.phase * Math.PI * 4) * 0.05 * moving;
    const young = c.spec.young;
    const tilt = 0.14; // back end higher than the front

    // Body, arched and tipped forward.
    this.aim.set(0, -Math.sin(tilt), Math.cos(tilt));
    this.blob(0, bodyY, 0, girth * 0.92, girth * 1.05, length / 2, c.body, this.aim);

    // Plates along the spine, biggest in the middle, leaning alternately left and right.
    const plates = 9;
    for (let i = 0; i < plates; i++) {
      const u = i / (plates - 1);
      const z = lerp(length * 0.42, -length * 0.46, u);
      const arch = Math.sqrt(Math.max(0, 1 - (z / (length / 2)) ** 2));
      const size = (0.45 + 0.75 * Math.sin(Math.PI * u)) * (young ? 0.7 : 1);
      const y = bodyY + girth * 1.0 * arch + z * Math.sin(-tilt) * 0.9 + size * 0.45;
      const lean = (i % 2 ? 1 : -1) * 0.22;
      this.q.copy(this.rootQuat).multiply(this.q2.setFromEuler(this.euler.set(0, 0, lean, 'XYZ')));
      const k = this.rootSize;
      this.put('octa', this.world(Math.sin(lean) * -0.3, y, z, this.v0), this.q, 0.1 * k, size * k, size * 0.62 * k, c.accent);
    }

    // Short neck, carried low. Dips further to graze.
    const sway = Math.sin(this.time * 0.7 + c.beat) * 0.12;
    this.chain(
      0, bodyY - girth * 0.25, length * 0.4,
      3, 0.75, girth * 0.46,
      c.body, false,
      (k) => [lerp((-4 - 6 * k) * DEG, (-22 - 12 * k) * DEG, c.graze), ((c.lookYaw + sway) * (k + 1)) / 3],
      this.end, this.aim,
    );
    const h = young ? 1.4 : 1;
    const head = this.end.addScaledVector(this.aim, 0.3 * h);
    this.blob(head.x, head.y, head.z, 0.44 * h, 0.4 * h, 0.7 * h, c.body, this.aim);
    this.world(head.x + this.aim.x * 0.55 * h, head.y + this.aim.y * 0.55 * h - 0.08, head.z + this.aim.z * 0.55 * h, this.v1);
    this.world(head.x + this.aim.x * 1.05 * h, head.y + this.aim.y * 1.05 * h - 0.14, head.z + this.aim.z * 1.05 * h, this.v2);
    this.tube('cone', this.v1, this.v2, 0.26 * h * c.size, c.accent);
    this.eyes(c, head, this.aim, 0.34 * h, 0.16 * h, 0.12 * h, 0.17 * h);

    // Tail with four spikes near the tip.
    const tailLinks = 5;
    const linkLength = (4.6 * c.tail) / tailLinks;
    this.chain(
      0, bodyY + girth * 0.2, -length * 0.42,
      tailLinks, linkLength, girth * 0.55,
      c.body, true,
      (k) => [(4 - 3 * k) * DEG, Math.sin(this.time * 1.4 + c.beat - k * 0.8) * 0.1 * (k + 1) - c.turning * 0.5 * ((k + 1) / tailLinks)],
      this.end, this.aim,
    );
    for (const [back, side] of [[0.3, 1], [0.3, -1], [1.0, 1], [1.0, -1]]) {
      const bx = this.end.x - this.aim.x * back;
      const by = this.end.y - this.aim.y * back;
      const bz = this.end.z - this.aim.z * back;
      this.world(bx, by, bz, this.v1);
      this.world(bx + side * 0.9, by + 0.55, bz - 0.25, this.v2);
      this.tube('cone', this.v1, this.v2, 0.14 * c.size, WHITE);
    }

    const hipX = girth * 0.66;
    this.leg(c, -hipX, bodyY - girth * 0.55, length * 0.3, 0.25, 0.35, girth * 0.36);
    this.leg(c, hipX, bodyY - girth * 0.55, length * 0.3, 0.75, 0.35, girth * 0.36);
    this.leg(c, -hipX, bodyY - girth * 0.2, -length * 0.3, 0, 0.35, girth * 0.42);
    this.leg(c, hipX, bodyY - girth * 0.2, -length * 0.3, 0.5, 0.35, girth * 0.42);
  }

  private poseRunner(c: Creature): void {
    const moving = Math.min(1, c.speed / SPECIES.runner.speed);
    const length = 1.7;
    const girth = 0.44 * c.girth;
    const bodyY = 1.05 + Math.abs(Math.sin(c.phase * TAU)) * 0.1 * moving;
    const young = c.spec.young;

    // Body held level, nose slightly up, balanced over two legs.
    this.aim.set(0, 0.17, 0.985);
    this.blob(0, bodyY, 0.1, girth * 0.9, girth, length / 2, c.body, this.aim);
    this.blob(0, bodyY + girth * 0.75, 0.25, girth * 0.55, 0.1, 0.32, c.accent, this.aim);
    this.blob(0, bodyY + girth * 0.7, -0.25, girth * 0.45, 0.09, 0.26, c.accent, this.aim);

    // Neck up, head bobbing forward with each step like a bird.
    const peck = Math.sin(c.phase * TAU * 2) * 0.12 * moving;
    this.chain(
      0, bodyY + 0.18, length * 0.42,
      3, 0.36 * c.neck, 0.2,
      c.body, false,
      (k) => [(62 - 14 * k) * DEG + peck, (c.lookYaw * (k + 1)) / 3],
      this.end, this.aim,
    );
    const h = young ? 1.35 : 1;
    this.aim.set(Math.sin(c.lookYaw), -0.08, Math.cos(c.lookYaw)).normalize();
    const head = this.end.addScaledVector(this.aim, 0.12 * h);
    this.blob(head.x, head.y, head.z, 0.26 * h, 0.25 * h, 0.4 * h, c.body, this.aim);
    this.world(head.x + this.aim.x * 0.3 * h, head.y - 0.04, head.z + this.aim.z * 0.3 * h, this.v1);
    this.world(head.x + this.aim.x * 0.75 * h, head.y - 0.1, head.z + this.aim.z * 0.75 * h, this.v2);
    this.tube('cone', this.v1, this.v2, 0.15 * h * c.size, c.accent);
    this.eyes(c, head, this.aim, 0.22 * h, 0.1 * h, 0.08 * h, 0.13 * h);

    // Long stiff tail for balance, wagging with the stride.
    const tailLinks = 5;
    this.chain(
      0, bodyY + 0.02, -length * 0.38,
      tailLinks, (2.3 * c.tail) / tailLinks, 0.24,
      c.body, true,
      (k) => [(6 + 2 * k) * DEG, Math.sin(c.phase * TAU + k * 0.5) * 0.09 * moving * (k + 1) + Math.sin(this.time * 1.7 + c.beat) * 0.04 * (k + 1) - c.turning * 0.6 * ((k + 1) / tailLinks)],
      this.end, this.aim,
    );

    // Tiny arms.
    for (const side of [-1, 1]) {
      this.world(side * girth * 0.7, bodyY + 0.02, length * 0.36, this.v1);
      this.world(side * girth * 0.85, bodyY - 0.26, length * 0.36 + 0.22, this.v2);
      this.tube('taper', this.v1, this.v2, 0.07 * c.size, c.dark);
    }

    this.leg(c, -girth * 0.6, bodyY - 0.12, -0.02, 0, 0.4, 0.13, 1.0);
    this.leg(c, girth * 0.6, bodyY - 0.12, -0.02, 0.5, 0.4, 0.13, 1.0);
  }

  private poseFlyer(c: Creature, flap: number): void {
    this.blob(0, 0, 0, 0.32, 0.3, 0.85, c.body);

    // Head, long beak, and a crest sweeping back.
    this.aim.set(0, 0.1, 1).normalize();
    this.blob(0, 0.12, 1.05, 0.24, 0.22, 0.42, c.body, this.aim);
    this.world(0, 0.1, 1.35, this.v1);
    this.world(0, 0.0, 2.45, this.v2);
    this.tube('cone', this.v1, this.v2, 0.13 * c.size, c.accent);
    this.world(0, 0.25, 0.95, this.v1);
    this.world(0, 0.75, 0.15, this.v2);
    this.tube('cone', this.v1, this.v2, 0.12 * c.size, c.accent);
    this.end.set(0, 0.12, 1.05);
    this.eyes(c, this.end, this.aim, 0.2, 0.06, 0.12, 0.1);

    // Stubby tail.
    this.world(0, 0, -0.75, this.v1);
    this.world(0, 0.05, -1.5, this.v2);
    this.tube('cone', this.v1, this.v2, 0.14 * c.size, c.body);

    // Wings: one flat triangle each, hinged at the shoulder.
    const lift = 0.12 + flap * 0.55;
    const k = this.rootSize;
    for (const side of [1, -1]) {
      this.q.copy(this.rootQuat).multiply(this.q2.setFromEuler(this.euler.set(0, 0, side * lift, 'XYZ')));
      this.put('wing', this.world(side * 0.22, 0.08, 0.15, this.v0), this.q, side * 3.1 * k, k, 1.9 * k, c.accent);
    }
  }
}

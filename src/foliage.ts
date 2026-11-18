import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { palette } from './palette';
import { HALF, Terrain, WORLD_SIZE } from './terrain';

export const PLANT_KINDS = ['conifer', 'treefern', 'cycad', 'fern', 'horsetail', 'rock'] as const;
export type PlantKind = (typeof PLANT_KINDS)[number];
/** What the plant brush lays down: one species, or a mix chosen by habitat. */
export type PlantChoice = 'forest' | PlantKind;

/** One placed plant. Records are never mutated, so snapshots can share them. */
export interface Plant {
  readonly k: number; // index into PLANT_KINDS
  readonly x: number;
  readonly z: number;
  readonly s: number; // scale
  readonly r: number; // rotation about the vertical axis
}

export interface FoliageFile {
  kinds: string[];
  /** Flat list: kind, x, z, scale, rotation, repeated. */
  data: number[];
}

const enum Layer {
  Tree,
  Shrub,
  Ground,
}

interface Species {
  layer: Layer;
  /** Personal space. Two plants in the same layer keep the sum of theirs apart. */
  space: number;
  capacity: number;
  scale: [number, number];
  sway: number;
  castShadow: boolean;
  /** Chance (0..1) this species takes root at a given height and levelness. */
  fits(height: number, level: number): number;
  build(): THREE.BufferGeometry;
}

const GRID = 2; // spatial hash cell size
const GRID_SPAN = Math.ceil(WORLD_SIZE / GRID) + 1;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const within = (v: number, lo: number, hi: number) => (v >= lo && v <= hi ? 1 : 0);

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ------------------------------------------------------------ model parts

/** Give a part one flat colour and facet normals, ready to merge. */
function part(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  const color = new THREE.Color(hex);
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

const cone = (radius: number, height: number, sides: number, y: number, hex: number, turn = 0) =>
  part(new THREE.ConeGeometry(radius, height, sides, 1, true).rotateY(turn).translate(0, y + height / 2, 0), hex);

const trunk = (top: number, bottom: number, height: number, sides: number, hex: number, x = 0, z = 0) =>
  part(new THREE.CylinderGeometry(top, bottom, height, sides, 1, true).translate(x, height / 2, z), hex);

/** A leaf made of two triangles: out from `base`, widest at `mid`, to a point at `tip`. Each is [radius, height]. */
function frond(
  angle: number,
  base: [number, number],
  mid: [number, number],
  tip: [number, number],
  width: number,
  hex: number,
): THREE.BufferGeometry {
  const w = width / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        base[0], base[1], 0, mid[0], mid[1], -w, mid[0], mid[1], w,
        mid[0], mid[1], -w, tip[0], tip[1], 0, mid[0], mid[1], w,
      ]),
      3,
    ),
  );
  g.rotateY(angle);
  return part(g, hex);
}

function crown(
  count: number,
  offset: number,
  base: [number, number],
  mid: [number, number],
  tip: [number, number],
  width: number,
  colors: [number, number],
): THREE.BufferGeometry[] {
  const fronds: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    fronds.push(frond(offset + (i / count) * Math.PI * 2, base, mid, tip, width, colors[i % 2]));
  }
  return fronds;
}

function boulder(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // Same corner, same nudge, so shared corners stay joined.
    const key = Math.round(p.getX(i) * 10) + Math.round(p.getY(i) * 10) * 31 + Math.round(p.getZ(i) * 10) * 97;
    const f = 0.78 + hash(key) * 0.44;
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.72, p.getZ(i) * f);
  }
  g.translate(0, 0.38, 0);
  return part(g, palette.boulder);
}

// ------------------------------------------------------------ species

// Sizes are in world units; the ground-level camera's eye is 1.3 units up.
const SPECIES: Record<PlantKind, Species> = {
  // Tall, tiered, the skyline of the forest.
  conifer: {
    layer: Layer.Tree, space: 1.7, capacity: 3000, scale: [0.7, 1.3], sway: 0.0011, castShadow: true,
    fits: (h, level) => within(h, 1, 27) * (level > 0.78 ? 1 : 0) * (1 - smoothstep(17, 27, h) * 0.85),
    build: () =>
      mergeGeometries([
        trunk(0.22, 0.34, 3.2, 5, palette.bark),
        cone(2.3, 3.0, 6, 2.2, palette.needles),
        cone(1.9, 2.8, 6, 4.2, palette.needlesLight, 0.5),
        cone(1.45, 2.6, 6, 6.0, palette.needles),
        cone(1.0, 2.4, 6, 7.6, palette.needlesLight, 0.5),
      ]),
  },
  // A bare trunk with an umbrella of drooping fronds.
  treefern: {
    layer: Layer.Tree, space: 1.4, capacity: 3000, scale: [0.7, 1.25], sway: 0.0055, castShadow: true,
    fits: (h, level) => within(h, 0.8, 14) * (level > 0.8 ? 1 : 0),
    build: () =>
      mergeGeometries([
        trunk(0.2, 0.3, 4.3, 5, palette.barkDark),
        ...crown(8, 0, [0.1, 4.2], [1.5, 4.9], [3.0, 3.7], 1.0, [palette.frond, palette.frondLight]),
        ...crown(4, 0.4, [0.05, 4.2], [0.8, 5.2], [1.6, 4.95], 0.6, [palette.frondLight, palette.frond]),
      ]),
  },
  // Stubby barrel trunk, stiff spiky crown.
  cycad: {
    layer: Layer.Shrub, space: 0.9, capacity: 4000, scale: [0.8, 1.35], sway: 0.018, castShadow: true,
    fits: (h, level) => within(h, 0.6, 18) * (level > 0.75 ? 1 : 0),
    build: () =>
      mergeGeometries([
        trunk(0.38, 0.5, 0.95, 6, palette.cycadTrunk),
        ...crown(9, 0, [0.1, 0.9], [1.0, 1.75], [1.9, 1.35], 0.42, [palette.cycadFrond, palette.cycadFrondDark]),
        ...crown(5, 0.3, [0.05, 0.9], [0.5, 1.9], [1.0, 2.05], 0.3, [palette.cycadFrondDark, palette.cycadFrond]),
      ]),
  },
  // Ground cover. There is no grass in the Jurassic; this is the lawn.
  fern: {
    layer: Layer.Ground, space: 0.45, capacity: 12000, scale: [0.7, 1.5], sway: 0.11, castShadow: false,
    fits: (h, level) => within(h, 0.4, 21) * (level > 0.7 ? 1 : 0),
    build: () =>
      mergeGeometries([
        ...crown(7, 0, [0, 0.02], [0.5, 0.6], [1.05, 0.3], 0.36, [palette.fern, palette.fernDark]),
        ...crown(3, 0.5, [0, 0.02], [0.25, 0.7], [0.5, 0.78], 0.25, [palette.fernDark, palette.fern]),
      ]),
  },
  // Reeds for the water's edge and the shallows.
  horsetail: {
    layer: Layer.Ground, space: 0.3, capacity: 6000, scale: [0.7, 1.2], sway: 0.06, castShadow: false,
    fits: (h, level) => within(h, -0.3, 2.2) * (level > 0.8 ? 1 : 0),
    build: () => {
      const parts: THREE.BufferGeometry[] = [];
      for (const [x, z, height] of [[0, 0, 1.1], [0.2, 0.08, 0.8], [-0.11, 0.18, 0.95]]) {
        parts.push(trunk(0.035, 0.05, height, 4, palette.horsetail, x, z));
        for (const f of [0.5, 0.74, 0.96]) {
          parts.push(cone(0.12, 0.1, 5, height * f, palette.horsetailLight).translate(x, 0, z));
        }
      }
      return mergeGeometries(parts);
    },
  },
  rock: {
    layer: Layer.Shrub, space: 0.8, capacity: 3000, scale: [0.35, 1.2], sway: 0, castShadow: true,
    fits: (h, level) => (h > 0.15 && level > 0.35 ? 1 : 0),
    build: boulder,
  },
};

/** For the forest mix: which species suits this height, as [kind, weight] pairs. */
function forestMix(height: number): [PlantKind, number][] {
  if (height < 1.8) return [['horsetail', 0.42], ['fern', 0.42], ['cycad', 0.13], ['rock', 0.03]];
  if (height < 9) return [['fern', 0.45], ['treefern', 0.22], ['cycad', 0.16], ['conifer', 0.12], ['rock', 0.03]];
  if (height < 18) return [['fern', 0.4], ['conifer', 0.3], ['cycad', 0.12], ['treefern', 0.1], ['rock', 0.05]];
  return [['fern', 0.45], ['conifer', 0.33], ['rock', 0.22]];
}

// ------------------------------------------------------------ foliage

/**
 * Every plant in the world. Each species is one instanced mesh, so thousands
 * of plants cost a handful of draw calls.
 */
export class Foliage {
  readonly group = new THREE.Group();

  private plants: Plant[] = [];
  private readonly grid = new Map<number, Plant[]>();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly counts: number[] = [];
  private readonly time = { value: 0 };
  private carry = 0;

  constructor(private readonly terrain: Terrain) {
    const white = new THREE.Color(1, 1, 1);
    for (const kind of PLANT_KINDS) {
      const species = SPECIES[kind];
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      // A little wind: bend each plant more the higher up the vertex is.
      const sway = { value: species.sway };
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.time;
        shader.uniforms.uSway = sway;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uSway;')
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `#include <begin_vertex>
            #ifdef USE_INSTANCING
              float swayPhase = instanceMatrix[3].x * 0.35 + instanceMatrix[3].z * 0.27;
              float swayBend = uSway * transformed.y * transformed.y;
              transformed.x += sin(uTime * 1.3 + swayPhase) * swayBend;
              transformed.z += cos(uTime * 1.05 + swayPhase * 1.3) * swayBend * 0.7;
            #endif`,
          );
      };
      const mesh = new THREE.InstancedMesh(species.build(), material, species.capacity);
      mesh.setColorAt(0, white);
      mesh.count = 0;
      mesh.castShadow = species.castShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.counts.push(0);
      this.group.add(mesh);
    }
  }

  get count(): number {
    return this.plants.length;
  }

  /**
   * Scatter plants inside the brush for one frame. `rate` is how eagerly.
   * Plants only take root where their species can live and there is room.
   */
  paint(choice: PlantChoice, x: number, z: number, radius: number, rate: number, dt: number): boolean {
    this.carry += rate * radius * radius * 0.12 * dt;
    let attempts = Math.floor(this.carry);
    this.carry -= attempts;
    attempts = Math.min(attempts, 400);
    let changed = false;

    for (let n = 0; n < attempts; n++) {
      const angle = Math.random() * Math.PI * 2;
      const u = Math.sqrt(Math.random());
      if (Math.random() < u * u * 0.7) continue; // thin out towards the rim
      const px = x + Math.cos(angle) * radius * u;
      const pz = z + Math.sin(angle) * radius * u;
      if (Math.abs(px) > HALF - 0.6 || Math.abs(pz) > HALF - 0.6) continue;

      const height = this.terrain.heightAt(px, pz);
      const kind = choice === 'forest' ? pickWeighted(forestMix(height)) : choice;
      const k = PLANT_KINDS.indexOf(kind);
      const species = SPECIES[kind];
      if (this.counts[k] >= species.capacity) continue;
      if (Math.random() >= species.fits(height, this.terrain.levelAt(px, pz))) continue;
      if (this.crowded(k, px, pz)) continue;

      const [lo, hi] = species.scale;
      const plant: Plant = { k, x: px, z: pz, s: lo + Math.random() * (hi - lo), r: Math.random() * Math.PI * 2 };
      this.plants.push(plant);
      this.counts[k]++;
      this.cell(px, pz, true)!.push(plant);
      changed = true;
    }

    if (changed) this.refresh();
    return changed;
  }

  /** Remove every plant inside the brush. */
  erase(x: number, z: number, radius: number): boolean {
    const r2 = radius * radius;
    const kept = this.plants.filter((p) => (p.x - x) ** 2 + (p.z - z) ** 2 > r2);
    if (kept.length === this.plants.length) return false;
    this.restore(kept);
    return true;
  }

  /** The current plants, for undo. Cheap: records are shared, not copied. */
  snapshot(): Plant[] {
    return this.plants.slice();
  }

  restore(plants: Plant[]): void {
    this.plants = plants.slice();
    this.grid.clear();
    this.counts.fill(0);
    for (const plant of this.plants) {
      this.cell(plant.x, plant.z, true)!.push(plant);
      this.counts[plant.k]++;
    }
    this.refresh();
  }

  /** Re-seat every plant on the ground. Call after the terrain changes. */
  refresh(): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    const next = this.meshes.map(() => 0);
    const rock = PLANT_KINDS.indexOf('rock');

    for (const plant of this.plants) {
      const mesh = this.meshes[plant.k];
      const i = next[plant.k]++;
      if (i >= mesh.instanceMatrix.count) continue;
      const seed = plant.x * 12.9898 + plant.z * 78.233;
      position.set(plant.x, this.terrain.heightAt(plant.x, plant.z) - 0.05 * plant.s, plant.z);
      rotation.setFromAxisAngle(up, plant.r);
      if (plant.k === rock) {
        scale.set(plant.s * (0.75 + hash(seed) * 0.6), plant.s * (0.7 + hash(seed + 1) * 0.6), plant.s * (0.75 + hash(seed + 2) * 0.6));
      } else {
        scale.setScalar(plant.s);
      }
      mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
      // Slight per-plant tint so a stand of one species isn't a flat colour.
      mesh.setColorAt(i, color.setRGB(0.86 + hash(seed + 3) * 0.28, 0.9 + hash(seed + 4) * 0.2, 0.84 + hash(seed + 5) * 0.32));
    }

    this.meshes.forEach((mesh, k) => {
      mesh.count = Math.min(next[k], mesh.instanceMatrix.count);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  /** Advance the wind. */
  update(dt: number): void {
    this.time.value += dt;
  }

  serialize(): FoliageFile {
    const data: number[] = [];
    const round = (v: number) => Math.round(v * 100) / 100;
    for (const p of this.plants) data.push(p.k, round(p.x), round(p.z), round(p.s), round(p.r));
    return { kinds: [...PLANT_KINDS], data };
  }

  /** Load saved plants. Anything unrecognised is skipped. */
  load(file: unknown): void {
    const plants: Plant[] = [];
    const saved = file as Partial<FoliageFile> | null | undefined;
    if (saved && Array.isArray(saved.kinds) && Array.isArray(saved.data)) {
      const remap = saved.kinds.map((name) => PLANT_KINDS.indexOf(name as PlantKind));
      for (let i = 0; i + 4 < saved.data.length; i += 5) {
        const [kind, x, z, s, r] = saved.data.slice(i, i + 5).map(Number);
        const k = remap[kind];
        if (k === undefined || k < 0 || ![x, z, s, r].every(Number.isFinite)) continue;
        if (Math.abs(x) > HALF || Math.abs(z) > HALF) continue;
        plants.push({ k, x, z, s, r });
      }
    }
    this.restore(plants);
  }

  private cell(x: number, z: number, create: boolean): Plant[] | undefined {
    const key = Math.floor((z + HALF) / GRID) * GRID_SPAN + Math.floor((x + HALF) / GRID);
    let list = this.grid.get(key);
    if (!list && create) {
      list = [];
      this.grid.set(key, list);
    }
    return list;
  }

  /** Is there already a plant of the same layer too close to (x, z)? */
  private crowded(k: number, x: number, z: number): boolean {
    const mine = SPECIES[PLANT_KINDS[k]];
    const reach = Math.ceil((mine.space + 1.7) / GRID);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const list = this.cell(x + dx * GRID, z + dz * GRID, false);
        if (!list) continue;
        for (const other of list) {
          const theirs = SPECIES[PLANT_KINDS[other.k]];
          if (theirs.layer !== mine.layer) continue;
          const gap = mine.space + theirs.space;
          if ((other.x - x) ** 2 + (other.z - z) ** 2 < gap * gap) return true;
        }
      }
    }
    return false;
  }
}

function pickWeighted<T>(options: [T, number][]): T {
  let roll = Math.random() * options.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of options) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return options[options.length - 1][0];
}

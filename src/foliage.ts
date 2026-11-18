import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { palette } from './palette';
import { HALF, Terrain, TILE_SIZE } from './terrain';

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
  /** Most plants of this species per tile of land. */
  capacity: number;
  scale: [number, number];
  sway: number;
  castShadow: boolean;
  /** Chance (0..1) this species takes root at a given height and levelness. */
  fits(height: number, level: number): number;
  build(): THREE.BufferGeometry;
}

const GRID = 2; // spatial hash cell size, for spacing checks
const KEY_SPAN = 4096; // packs signed cell coordinates into one map key

// The land is divided into squares, six across each tile. Each square draws its
// own plants, so squares outside the camera's view can be skipped whole.
const REGION_SIZE = TILE_SIZE / 6;

// Thinning ranks run 0..RANK_MAX; a plant shrinks away over RANK_FADE as the
// kept fraction drops past its rank. The shader below uses the same numbers.
const RANK_MAX = 0.92;
const RANK_FADE = 0.08;

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

export interface FoliageOptions {
  /** Skip regions the camera can't see. */
  culling: boolean;
  /** Distance at which ground cover starts to thin. It reaches full thinning at twice this. */
  thinStart: number;
  /** Fraction of ground cover removed at full thinning, 0..1. */
  thinAmount: number;
}

/** One species within one region: a single instanced draw. */
interface Batch {
  mesh: THREE.InstancedMesh;
  ranks: Float32Array; // per instance, ascending for ground cover
  capacity: number;
  total: number;
  ground: boolean;
}

interface Region {
  plants: Plant[];
  batches: (Batch | undefined)[];
  dirty: boolean;
  x0: number;
  z0: number;
  minY: number;
  maxY: number;
}

const rankOf = (plant: Plant) => hash(plant.x * 12.9898 + plant.z * 78.233 + 7) * RANK_MAX;

/** Count of leading entries in an ascending array that are below `limit`. */
function countBelow(sorted: Float32Array, length: number, limit: number): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every plant in the world. Plants are drawn as instanced batches, one per
 * species per region, so thousands of plants cost a few dozen draw calls and
 * whole regions can be culled.
 */
export class Foliage {
  readonly group = new THREE.Group();
  readonly options: FoliageOptions = { culling: true, thinStart: 140, thinAmount: 0.6 };
  /** Called whenever what is drawn has changed (for example, to refresh cached shadows). */
  onChange?: () => void;
  /** Plants submitted for drawing in the last frame, after culling and thinning. */
  drawn = 0;

  private plants: Plant[] = [];
  private readonly grid = new Map<number, Plant[]>();
  private readonly counts = PLANT_KINDS.map(() => 0);
  private readonly regions = new Map<number, Region>();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly time = { value: 0 };
  private readonly thinStart = { value: 140 };
  private readonly thinAmount = { value: 0.6 };
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private carry = 0;

  constructor(private readonly terrain: Terrain) {
    for (const kind of PLANT_KINDS) {
      const species = SPECIES[kind];
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      const sway = { value: species.sway };
      const thinAmount = species.layer === Layer.Ground ? this.thinAmount : { value: 0 };
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.time;
        shader.uniforms.uSway = sway;
        shader.uniforms.uThinStart = this.thinStart;
        shader.uniforms.uThinAmount = thinAmount;
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            /* glsl */ `#include <common>
            uniform float uTime;
            uniform float uSway;
            uniform float uThinStart;
            uniform float uThinAmount;
            #ifdef USE_INSTANCING
              attribute float aRank;
            #endif`,
          )
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec3 plantOrigin = instanceMatrix[3].xyz;
              // A little wind: bend each plant more the higher up the vertex is.
              float swayPhase = plantOrigin.x * 0.35 + plantOrigin.z * 0.27;
              float swayBend = uSway * transformed.y * transformed.y;
              transformed.x += sin(uTime * 1.3 + swayPhase) * swayBend;
              transformed.z += cos(uTime * 1.05 + swayPhase * 1.3) * swayBend * 0.7;
              // Distance thinning: far from the camera only the lowest-ranked plants
              // remain, and each one shrinks into the ground instead of popping.
              float thinKeep = 1.0 - uThinAmount * smoothstep(uThinStart, uThinStart * 2.0, distance(cameraPosition, plantOrigin));
              transformed *= clamp((thinKeep - aRank) / ${RANK_FADE.toFixed(2)}, 0.0, 1.0);
            #endif`,
          );
      };
      this.materials.push(material);
      this.geometries.push(species.build());
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
      if (!this.terrain.contains(px, pz, 0.6)) continue;

      const height = this.terrain.heightAt(px, pz);
      const kind = choice === 'forest' ? pickWeighted(forestMix(height)) : choice;
      const k = PLANT_KINDS.indexOf(kind);
      const species = SPECIES[kind];
      if (this.counts[k] >= species.capacity * this.terrain.tileCount) continue;
      if (Math.random() >= species.fits(height, this.terrain.levelAt(px, pz))) continue;
      if (this.crowded(k, px, pz)) continue;

      const [lo, hi] = species.scale;
      this.add({ k, x: px, z: pz, s: lo + Math.random() * (hi - lo), r: Math.random() * Math.PI * 2 });
      changed = true;
    }

    if (changed) this.flush();
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
    this.plants = [];
    this.grid.clear();
    this.counts.fill(0);
    for (const region of this.regions.values()) {
      region.plants = [];
      region.dirty = true;
    }
    for (const plant of plants) this.add(plant);
    this.flush();
  }

  /**
   * Re-seat plants on the ground after the terrain changes. Pass the brush
   * centre and radius to redo only the regions it touched.
   */
  refresh(x?: number, z?: number, radius?: number): void {
    for (const region of this.regions.values()) {
      if (!region.plants.length) continue;
      if (x !== undefined && z !== undefined && radius !== undefined) {
        const outside =
          x + radius < region.x0 || x - radius > region.x0 + REGION_SIZE ||
          z + radius < region.z0 || z - radius > region.z0 + REGION_SIZE;
        if (outside) continue;
      }
      region.dirty = true;
    }
    this.flush();
  }

  /** Advance the wind, and decide what to draw this frame. */
  update(dt: number, camera: THREE.Camera): void {
    this.time.value += dt;
    this.thinStart.value = this.options.thinStart;
    this.thinAmount.value = this.options.thinAmount;

    const { culling, thinStart, thinAmount } = this.options;
    this.frustum.setFromProjectionMatrix(
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const eye = camera.position;
    let drawn = 0;

    for (const region of this.regions.values()) {
      if (!region.plants.length) continue;
      // Thin by the distance to the nearest point of the region, so the cut is
      // never ahead of what the shader has already shrunk to nothing.
      const dx = Math.max(region.x0 - eye.x, 0, eye.x - (region.x0 + REGION_SIZE));
      const dy = Math.max(region.minY - eye.y, 0, eye.y - (region.maxY + 3));
      const dz = Math.max(region.z0 - eye.z, 0, eye.z - (region.z0 + REGION_SIZE));
      const keep = 1 - thinAmount * smoothstep(thinStart, thinStart * 2, Math.hypot(dx, dy, dz));

      for (const batch of region.batches) {
        if (!batch || !batch.total) continue;
        batch.mesh.frustumCulled = culling;
        batch.mesh.count = batch.ground && keep < 1 ? countBelow(batch.ranks, batch.total, keep) : batch.total;
        if (!culling || this.frustum.intersectsSphere(batch.mesh.boundingSphere!)) drawn += batch.mesh.count;
      }
    }
    this.drawn = drawn;
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
        if (!this.terrain.contains(x, z)) continue;
        plants.push({ k, x, z, s, r });
      }
    }
    this.restore(plants);
  }

  private add(plant: Plant): void {
    this.plants.push(plant);
    this.counts[plant.k]++;
    this.cell(plant.x, plant.z, true)!.push(plant);
    const region = this.regionAt(plant.x, plant.z);
    region.plants.push(plant);
    region.dirty = true;
  }

  private regionAt(x: number, z: number): Region {
    const rx = Math.floor((x + HALF) / REGION_SIZE);
    const rz = Math.floor((z + HALF) / REGION_SIZE);
    const key = (rz + KEY_SPAN / 2) * KEY_SPAN + rx + KEY_SPAN / 2;
    let region = this.regions.get(key);
    if (!region) {
      region = {
        plants: [],
        batches: [],
        dirty: false,
        x0: rx * REGION_SIZE - HALF,
        z0: rz * REGION_SIZE - HALF,
        minY: 0,
        maxY: 0,
      };
      this.regions.set(key, region);
    }
    return region;
  }

  /** Rebuild the batches of every region marked dirty. */
  private flush(): void {
    let changed = false;
    for (const region of this.regions.values()) {
      if (!region.dirty) continue;
      this.rebuild(region);
      changed = true;
    }
    if (changed) this.onChange?.();
  }

  private rebuild(region: Region): void {
    region.dirty = false;
    const byKind: Plant[][] = PLANT_KINDS.map(() => []);
    for (const plant of region.plants) byKind[plant.k].push(plant);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    const rock = PLANT_KINDS.indexOf('rock');
    let minY = Infinity;
    let maxY = -Infinity;

    byKind.forEach((list, k) => {
      let batch = region.batches[k];
      if (!list.length) {
        if (batch) {
          batch.total = 0;
          batch.mesh.count = 0;
          batch.mesh.visible = false;
        }
        return;
      }
      if (!batch || batch.capacity < list.length) {
        if (batch) this.discard(batch);
        batch = this.createBatch(k, list.length);
        region.batches[k] = batch;
      }
      // Ground cover is stored in rank order, so thinning is just drawing fewer.
      if (batch.ground) list.sort((a, b) => rankOf(a) - rankOf(b));

      const { mesh, ranks } = batch;
      list.forEach((plant, i) => {
        const seed = plant.x * 12.9898 + plant.z * 78.233;
        const y = this.terrain.heightAt(plant.x, plant.z) - 0.05 * plant.s;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        position.set(plant.x, y, plant.z);
        rotation.setFromAxisAngle(up, plant.r);
        if (k === rock) {
          scale.set(plant.s * (0.75 + hash(seed) * 0.6), plant.s * (0.7 + hash(seed + 1) * 0.6), plant.s * (0.75 + hash(seed + 2) * 0.6));
        } else {
          scale.setScalar(plant.s);
        }
        mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
        // Slight per-plant tint so a stand of one species isn't a flat colour.
        mesh.setColorAt(i, color.setRGB(0.86 + hash(seed + 3) * 0.28, 0.9 + hash(seed + 4) * 0.2, 0.84 + hash(seed + 5) * 0.32));
        ranks[i] = batch!.ground ? rankOf(plant) : 0;
      });

      batch.total = list.length;
      mesh.count = list.length;
      mesh.visible = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      mesh.geometry.attributes.aRank.needsUpdate = true;
    });

    if (minY > maxY) return;
    region.minY = minY;
    region.maxY = maxY;
    // One sphere per region, tall enough for the biggest trees, used for culling.
    const sphere = new THREE.Sphere(
      new THREE.Vector3(region.x0 + REGION_SIZE / 2, (minY + maxY) / 2 + 6, region.z0 + REGION_SIZE / 2),
      Math.hypot(REGION_SIZE * 0.7072 + 4, (maxY - minY) / 2 + 9),
    );
    for (const batch of region.batches) if (batch) batch.mesh.boundingSphere = sphere;
  }

  private createBatch(k: number, needed: number): Batch {
    const species = SPECIES[PLANT_KINDS[k]];
    let capacity = 32;
    while (capacity < needed) capacity *= 2;
    // Shares the species' model data; only the per-instance rank is its own.
    const base = this.geometries[k];
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color']) geometry.setAttribute(name, base.attributes[name]);
    const ranks = new Float32Array(capacity);
    const rankAttribute = new THREE.InstancedBufferAttribute(ranks, 1);
    rankAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aRank', rankAttribute);

    const mesh = new THREE.InstancedMesh(geometry, this.materials[k], capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.castShadow = species.castShadow;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return { mesh, ranks, capacity, total: 0, ground: species.layer === Layer.Ground };
  }

  private discard(batch: Batch): void {
    this.group.remove(batch.mesh);
    batch.mesh.geometry.deleteAttribute('position');
    batch.mesh.geometry.deleteAttribute('normal');
    batch.mesh.geometry.deleteAttribute('color');
    batch.mesh.geometry.dispose(); // frees only the rank buffer; the model data is shared
    batch.mesh.dispose();
  }

  private cell(x: number, z: number, create: boolean): Plant[] | undefined {
    const key = (Math.floor(z / GRID) + KEY_SPAN / 2) * KEY_SPAN + Math.floor(x / GRID) + KEY_SPAN / 2;
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

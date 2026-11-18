import * as THREE from 'three';
import { bands, palette } from './palette';

export const TILE_SIZE = 120; // world units along each side of one tile
export const RES = 120; // cells along each side of one tile
export const CELL = TILE_SIZE / RES;
export const HALF = TILE_SIZE / 2;
export const WATER_LEVEL = 0;
export const BASE_Y = -10; // underside of the diorama slab
export const MIN_HEIGHT = -6;
export const MAX_HEIGHT = 44;
export const MAX_TILES = 12;

const TILE_RANGE = 4; // tiles may sit this many steps from the first one
const STRATA_Y = -6.5; // where the earth layer meets bedrock on the slab sides
const SEA_FLOOR = -4.5; // height new land falls to at a tile's edges
const WATER_INSET = 0.15; // water stops just short of the slab's outer faces
const SEAM_BLEND = 16; // new land eases into a sculpted neighbour over this distance

const TILE_VERTS = RES + 1;

/** Saved terrain. Each tile carries its own (RES+1) x (RES+1) grid of heights. */
export interface TerrainFile {
  kind: '3jsbildr-terrain';
  version: 2;
  resolution: number;
  tileSize: number;
  waterLevel: number;
  tiles: { x: number; z: number; heights: number[] }[];
}

/** The whole terrain at one moment, for undo. */
export interface TerrainSnapshot {
  minTx: number;
  minTz: number;
  cols: number;
  rows: number;
  active: Uint8Array;
  heights: Float32Array;
}

interface TileMesh {
  tx: number;
  tz: number;
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  floor: THREE.Mesh;
  dirty: boolean;
}

/** One exposed edge of a tile: 0 north (-z), 1 south (+z), 2 west (-x), 3 east (+x). */
interface Edge {
  col: number;
  row: number;
  side: 0 | 1 | 2 | 3;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(seed: number) {
  const h = (x: number, y: number) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967295;
  };
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/**
 * The land: a grid of square tiles joined edge to edge into one slab.
 *
 * All heights live in a single array covering the bounding rectangle of the
 * tiles, so brushes, picking and smoothing run straight across the seams.
 * Tiles that haven't been added yet are simply marked inactive. Each active
 * tile draws its own flat-shaded mesh; slab sides and water are built only
 * along the outer edge.
 *
 * Tile (0, 0) is centred on the world origin.
 */
export class Terrain {
  readonly group = new THREE.Group();
  /** Called after tiles are added, removed or restored. */
  onLayout?: () => void;

  /** Heights for the whole bounding rectangle, row by row. Replaced when the world grows. */
  heights = new Float32Array(TILE_VERTS * TILE_VERTS);

  private minTx = 0;
  private minTz = 0;
  private cols = 1;
  private rows = 1;
  private active = new Uint8Array([1]);
  private tiles: (TileMesh | null)[] = [null];
  private edges: Edge[] = [];

  private readonly terrainMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0,
  });
  private readonly floorGeometry = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE).rotateX(Math.PI / 2);
  private readonly floorMaterial = new THREE.MeshStandardMaterial({
    color: palette.bedrock,
    roughness: 1,
    side: THREE.DoubleSide,
  });

  private skirtPos = new Float32Array(0);
  private readonly skirt: THREE.Mesh;
  private readonly water: THREE.Mesh;

  private readonly colors = {
    sand: new THREE.Color(palette.sand),
    grassLow: new THREE.Color(palette.grassLow),
    grassMid: new THREE.Color(palette.grassMid),
    grassHigh: new THREE.Color(palette.grassHigh),
    rock: new THREE.Color(palette.rock),
    rockDark: new THREE.Color(palette.rockDark),
    stone: new THREE.Color(palette.stone),
    snow: new THREE.Color(palette.snow),
  };

  constructor() {
    this.skirt = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, side: THREE.DoubleSide }),
    );
    this.skirt.frustumCulled = false;

    this.water = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        color: palette.water,
        transparent: true,
        opacity: 0.86,
        roughness: 0.3,
        metalness: 0,
        depthWrite: false,
      }),
    );
    this.water.receiveShadow = true;
    this.water.frustumCulled = false;
    this.water.renderOrder = 1;

    this.group.add(this.skirt, this.water);
    this.syncLayout();
  }

  // ------------------------------------------------------------ layout

  /** Number of vertices across the whole height array. */
  get vertsX(): number {
    return this.cols * RES + 1;
  }

  get vertsZ(): number {
    return this.rows * RES + 1;
  }

  /** World position of the first vertex in the height array. */
  get originX(): number {
    return this.minTx * TILE_SIZE - HALF;
  }

  get originZ(): number {
    return this.minTz * TILE_SIZE - HALF;
  }

  get tileCount(): number {
    let n = 0;
    for (const a of this.active) n += a;
    return n;
  }

  /** The bounding rectangle of all tiles, in world units. */
  get bounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return {
      minX: this.originX,
      maxX: this.originX + this.cols * TILE_SIZE,
      minZ: this.originZ,
      maxZ: this.originZ + this.rows * TILE_SIZE,
    };
  }

  /** Tile coordinates of the tile under a world position. */
  tileAt(x: number, z: number): [number, number] {
    return [Math.floor((x + HALF) / TILE_SIZE), Math.floor((z + HALF) / TILE_SIZE)];
  }

  hasTile(tx: number, tz: number): boolean {
    const col = tx - this.minTx;
    const row = tz - this.minTz;
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows && this.active[row * this.cols + col] === 1;
  }

  /** Is this world position on the land (optionally at least `margin` in from the outer edge)? */
  contains(x: number, z: number, margin = 0): boolean {
    if (!margin) return this.hasTile(...this.tileAt(x, z));
    return (
      this.hasTile(...this.tileAt(x - margin, z - margin)) &&
      this.hasTile(...this.tileAt(x + margin, z - margin)) &&
      this.hasTile(...this.tileAt(x - margin, z + margin)) &&
      this.hasTile(...this.tileAt(x + margin, z + margin))
    );
  }

  /** Can a new tile be added here? It must be empty, in range, and touch existing land along an edge. */
  canAddTile(tx: number, tz: number): boolean {
    if (this.hasTile(tx, tz) || this.tileCount >= MAX_TILES) return false;
    if (Math.abs(tx) > TILE_RANGE || Math.abs(tz) > TILE_RANGE) return false;
    return this.hasTile(tx - 1, tz) || this.hasTile(tx + 1, tz) || this.hasTile(tx, tz - 1) || this.hasTile(tx, tz + 1);
  }

  /** Add a tile of fresh generated land, joined to its neighbours. */
  addTile(tx: number, tz: number, seed: number): boolean {
    if (!this.canAddTile(tx, tz)) return false;
    this.resize(
      Math.min(this.minTx, tx),
      Math.min(this.minTz, tz),
      Math.max(this.minTx + this.cols - 1, tx),
      Math.max(this.minTz + this.rows - 1, tz),
    );
    // Generate before marking the tile active, so "already has land" still
    // means "belongs to a neighbour" and shared edges are left alone.
    this.generateTile(tx, tz, seed);
    this.active[(tz - this.minTz) * this.cols + (tx - this.minTx)] = 1;
    this.syncLayout();
    return true;
  }

  /** Start over: a single tile of gentle rolling land that dips under water at the edges. */
  generate(seed: number): void {
    this.minTx = 0;
    this.minTz = 0;
    this.cols = 1;
    this.rows = 1;
    this.active = new Uint8Array([0]);
    this.heights = new Float32Array(TILE_VERTS * TILE_VERTS).fill(SEA_FLOOR);
    this.generateTile(0, 0, seed);
    this.active[0] = 1;
    this.syncLayout();
  }

  snapshot(): TerrainSnapshot {
    return {
      minTx: this.minTx,
      minTz: this.minTz,
      cols: this.cols,
      rows: this.rows,
      active: this.active.slice(),
      heights: this.heights.slice(),
    };
  }

  restore(snapshot: TerrainSnapshot): void {
    this.minTx = snapshot.minTx;
    this.minTz = snapshot.minTz;
    this.cols = snapshot.cols;
    this.rows = snapshot.rows;
    this.active = snapshot.active.slice();
    this.heights = snapshot.heights.slice();
    this.syncLayout();
  }

  // ------------------------------------------------------------ queries

  /** Does this vertex of the height array belong to at least one tile? */
  vertexActive(i: number, j: number): boolean {
    const c0 = Math.max(0, Math.floor((i - 1) / RES));
    const c1 = Math.min(this.cols - 1, Math.floor(i / RES));
    const r0 = Math.max(0, Math.floor((j - 1) / RES));
    const r1 = Math.min(this.rows - 1, Math.floor(j / RES));
    const a = this.active;
    const w = this.cols;
    return a[r0 * w + c0] === 1 || a[r0 * w + c1] === 1 || a[r1 * w + c0] === 1 || a[r1 * w + c1] === 1;
  }

  /** Height of the surface at a world position (bilinear; clamped to the edges). */
  heightAt(x: number, z: number, heights: Float32Array = this.heights): number {
    const stride = this.vertsX;
    const fx = clamp((x - this.originX) / CELL, 0, stride - 1);
    const fz = clamp((z - this.originZ) / CELL, 0, this.vertsZ - 1);
    const i = Math.min(Math.floor(fx), stride - 2);
    const j = Math.min(Math.floor(fz), this.vertsZ - 2);
    const tx = fx - i;
    const tz = fz - j;
    const a = heights[j * stride + i];
    const b = heights[j * stride + i + 1];
    const c = heights[(j + 1) * stride + i];
    const d = heights[(j + 1) * stride + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** How level the ground is at a world position: 1 is flat, 0 is a vertical wall. */
  levelAt(x: number, z: number): number {
    const e = CELL * 0.6;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return 1 / Math.sqrt(1 + dx * dx + dz * dz);
  }

  /**
   * First point where a ray meets the land. Marches the heightfield directly,
   * so it stays fast and correct while the mesh is being edited. Pass `heights`
   * to test against a snapshot instead of the live surface.
   */
  raycast(ray: THREE.Ray, out: THREE.Vector3, heights: Float32Array = this.heights): boolean {
    const o = ray.origin;
    const d = ray.direction;
    const box = this.bounds;
    let t0 = 0;
    let t1 = Infinity;
    const slabs: [number, number, number, number][] = [
      [o.x, d.x, box.minX, box.maxX],
      [o.y, d.y, MIN_HEIGHT - 1, MAX_HEIGHT + 1],
      [o.z, d.z, box.minZ, box.maxZ],
    ];
    for (const [origin, dir, lo, hi] of slabs) {
      if (Math.abs(dir) < 1e-9) {
        if (origin < lo || origin > hi) return false;
        continue;
      }
      let a = (lo - origin) / dir;
      let b = (hi - origin) / dir;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }

    // Height of the ray above the land at distance t. Empty slots count as open air.
    const clearance = (t: number) => {
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      return this.contains(x, z) ? o.y + d.y * t - this.heightAt(x, z, heights) : 1;
    };

    const STEP = 0.4;
    let prevT = t0;
    if (clearance(t0) < 0) return false; // started under the surface
    for (let t = t0 + STEP; t <= t1 + STEP; t += STEP) {
      const tt = Math.min(t, t1);
      if (clearance(tt) < 0) {
        let lo = prevT;
        let hi = tt;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          if (clearance(mid) < 0) hi = mid;
          else lo = mid;
        }
        out.set(o.x + d.x * hi, 0, o.z + d.z * hi);
        out.y = this.heightAt(out.x, out.z, heights);
        return true;
      }
      prevT = tt;
    }
    return false;
  }

  // ------------------------------------------------------------ drawing

  /** Rewrite every mesh from `heights`. */
  rebuild(): void {
    this.updateRegion(0, 0, this.vertsX - 1, this.vertsZ - 1);
  }

  /** Rewrite the meshes for the cells touching vertices i0..i1 by j0..j1 of the height array. */
  updateRegion(i0: number, j0: number, i1: number, j1: number): void {
    const cx0 = Math.max(0, i0 - 1);
    const cz0 = Math.max(0, j0 - 1);
    const cx1 = Math.min(this.cols * RES - 1, i1);
    const cz1 = Math.min(this.rows * RES - 1, j1);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) this.writeCell(cx, cz);
    }
    for (const tile of this.tiles) {
      if (!tile?.dirty) continue;
      tile.dirty = false;
      tile.geometry.attributes.position.needsUpdate = true;
      tile.geometry.attributes.normal.needsUpdate = true;
      tile.geometry.attributes.color.needsUpdate = true;
    }
    // Slab sides follow the land wherever the change reaches a tile boundary.
    const crosses = (a: number, b: number) => a <= 0 || Math.floor((a - 1) / RES) !== Math.floor((b + 1) / RES);
    if (crosses(i0, i1) || crosses(j0, j1)) this.updateSkirt();
  }

  // ------------------------------------------------------------ saving

  serialize(): TerrainFile {
    const tiles: TerrainFile['tiles'] = [];
    const stride = this.vertsX;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (!this.active[row * this.cols + col]) continue;
        const heights: number[] = [];
        for (let j = 0; j < TILE_VERTS; j++) {
          for (let i = 0; i < TILE_VERTS; i++) {
            heights.push(Math.round(this.heights[(row * RES + j) * stride + col * RES + i] * 1000) / 1000);
          }
        }
        tiles.push({ x: col + this.minTx, z: row + this.minTz, heights });
      }
    }
    return { kind: '3jsbildr-terrain', version: 2, resolution: RES, tileSize: TILE_SIZE, waterLevel: WATER_LEVEL, tiles };
  }

  /** Load saved terrain (current format, or the single-tile format from the first version). Returns false if it doesn't fit. */
  load(data: unknown): boolean {
    const file = data as { kind?: string; resolution?: number; heights?: unknown; tiles?: unknown } | null;
    if (!file || file.kind !== '3jsbildr-terrain' || file.resolution !== RES) return false;

    const tiles: { x: number; z: number; heights: number[] }[] = [];
    const source = Array.isArray(file.tiles) ? file.tiles : [{ x: 0, z: 0, heights: file.heights }];
    for (const entry of source as { x?: unknown; z?: unknown; heights?: unknown }[]) {
      if (!Number.isInteger(entry?.x) || !Number.isInteger(entry?.z) || !Array.isArray(entry.heights)) return false;
      if (entry.heights.length !== TILE_VERTS * TILE_VERTS) return false;
      const heights = entry.heights.map(Number);
      if (!heights.every(Number.isFinite)) return false;
      tiles.push({ x: entry.x as number, z: entry.z as number, heights });
    }
    if (!tiles.length || tiles.length > MAX_TILES) return false;

    const xs = tiles.map((t) => t.x);
    const zs = tiles.map((t) => t.z);
    this.minTx = Math.min(...xs);
    this.minTz = Math.min(...zs);
    this.cols = Math.max(...xs) - this.minTx + 1;
    this.rows = Math.max(...zs) - this.minTz + 1;
    this.active = new Uint8Array(this.cols * this.rows);
    this.heights = new Float32Array(this.vertsX * this.vertsZ).fill(SEA_FLOOR);
    const stride = this.vertsX;
    for (const tile of tiles) {
      const col = tile.x - this.minTx;
      const row = tile.z - this.minTz;
      this.active[row * this.cols + col] = 1;
      for (let j = 0; j < TILE_VERTS; j++) {
        for (let i = 0; i < TILE_VERTS; i++) {
          this.heights[(row * RES + j) * stride + col * RES + i] = clamp(tile.heights[j * TILE_VERTS + i], MIN_HEIGHT, MAX_HEIGHT);
        }
      }
    }
    this.syncLayout();
    return true;
  }

  // ------------------------------------------------------------ internals

  /** Grow the height array to cover tiles minTx..maxTx by minTz..maxTz, keeping what's there. */
  private resize(minTx: number, minTz: number, maxTx: number, maxTz: number): void {
    const cols = maxTx - minTx + 1;
    const rows = maxTz - minTz + 1;
    if (minTx === this.minTx && minTz === this.minTz && cols === this.cols && rows === this.rows) return;

    const stride = cols * RES + 1;
    const heights = new Float32Array(stride * (rows * RES + 1)).fill(SEA_FLOOR);
    const active = new Uint8Array(cols * rows);
    const shiftCol = this.minTx - minTx;
    const shiftRow = this.minTz - minTz;
    const oldStride = this.vertsX;
    for (let j = 0; j < this.vertsZ; j++) {
      const from = j * oldStride;
      heights.set(this.heights.subarray(from, from + oldStride), (j + shiftRow * RES) * stride + shiftCol * RES);
    }
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        active[(row + shiftRow) * cols + col + shiftCol] = this.active[row * this.cols + col];
      }
    }
    this.minTx = minTx;
    this.minTz = minTz;
    this.cols = cols;
    this.rows = rows;
    this.heights = heights;
    this.active = active;
  }

  /** Fill one tile with rolling land. Vertices that already belong to a neighbour are kept. */
  private generateTile(tx: number, tz: number, seed: number): void {
    const noise = valueNoise(seed);
    const col = tx - this.minTx;
    const row = tz - this.minTz;
    const stride = this.vertsX;
    const centreX = tx * TILE_SIZE;
    const centreZ = tz * TILE_SIZE;
    const west = this.hasTile(tx - 1, tz);
    const east = this.hasTile(tx + 1, tz);
    const north = this.hasTile(tx, tz - 1);
    const south = this.hasTile(tx, tz + 1);

    for (let j = 0; j <= RES; j++) {
      for (let i = 0; i <= RES; i++) {
        const gi = col * RES + i;
        const gj = row * RES + j;
        if (this.vertexActive(gi, gj)) continue;
        const x = this.originX + gi * CELL;
        const z = this.originZ + gj * CELL;

        let n = 0;
        let amp = 1;
        let freq = 0.022;
        let norm = 0;
        for (let o = 0; o < 4; o++) {
          n += noise(x * freq + 17.3, z * freq - 9.1) * amp;
          norm += amp;
          amp *= 0.5;
          freq *= 2.1;
        }
        const land = (n / norm - 0.42) * 46 + 3;
        const lx = x - centreX;
        const lz = z - centreZ;
        const square = Math.max(Math.abs(lx), Math.abs(lz)) / HALF;
        const round = Math.hypot(lx, lz) / HALF;
        const mask = 1 - smoothstep(0.68, 1.0, square * 0.55 + round * 0.45);
        let h = SEA_FLOOR + (land - SEA_FLOOR) * mask;

        // Ease into whatever a neighbour has along the shared edge, so sculpted
        // coastlines carry across the seam instead of ending in a step.
        const ease = (distance: number, edgeHeight: number) => {
          const w = 1 - smoothstep(0, SEAM_BLEND, distance);
          h += (edgeHeight - h) * w;
        };
        if (west) ease(i * CELL, this.heights[gj * stride + col * RES]);
        if (east) ease((RES - i) * CELL, this.heights[gj * stride + (col + 1) * RES]);
        if (north) ease(j * CELL, this.heights[row * RES * stride + gi]);
        if (south) ease((RES - j) * CELL, this.heights[(row + 1) * RES * stride + gi]);

        this.heights[gj * stride + gi] = clamp(h, MIN_HEIGHT, MAX_HEIGHT);
      }
    }
  }

  /** Bring meshes, slab sides and water in line with the current set of tiles, then redraw. */
  private syncLayout(): void {
    const old = new Map<string, TileMesh>();
    for (const tile of this.tiles) if (tile) old.set(`${tile.tx},${tile.tz}`, tile);

    this.tiles = new Array(this.cols * this.rows).fill(null);
    this.edges = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (!this.active[row * this.cols + col]) continue;
        const tx = col + this.minTx;
        const tz = row + this.minTz;
        const key = `${tx},${tz}`;
        this.tiles[row * this.cols + col] = old.get(key) ?? this.createTile(tx, tz);
        old.delete(key);
        if (!this.hasTile(tx, tz - 1)) this.edges.push({ col, row, side: 0 });
        if (!this.hasTile(tx, tz + 1)) this.edges.push({ col, row, side: 1 });
        if (!this.hasTile(tx - 1, tz)) this.edges.push({ col, row, side: 2 });
        if (!this.hasTile(tx + 1, tz)) this.edges.push({ col, row, side: 3 });
      }
    }
    for (const tile of old.values()) {
      this.group.remove(tile.mesh, tile.floor);
      tile.geometry.dispose();
    }

    this.buildSkirt();
    this.buildWater();
    this.rebuild();
    this.updateSkirt();
    this.onLayout?.();
  }

  private createTile(tx: number, tz: number): TileMesh {
    const count = RES * RES * 6;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    for (const [name, array] of [['position', pos], ['normal', nor], ['color', col]] as const) {
      const attr = new THREE.BufferAttribute(array, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attr);
    }
    // Fixed bounds covering anything the tile could be sculpted into, so tiles off screen are skipped.
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(tx * TILE_SIZE, (MIN_HEIGHT + MAX_HEIGHT) / 2, tz * TILE_SIZE),
      Math.hypot(HALF, HALF, (MAX_HEIGHT - MIN_HEIGHT) / 2),
    );
    const mesh = new THREE.Mesh(geometry, this.terrainMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const floor = new THREE.Mesh(this.floorGeometry, this.floorMaterial);
    floor.position.set(tx * TILE_SIZE, BASE_Y, tz * TILE_SIZE);
    this.group.add(mesh, floor);
    return { tx, tz, pos, nor, col, geometry, mesh, floor, dirty: false };
  }

  private writeCell(cx: number, cz: number): void {
    const col = Math.floor(cx / RES);
    const row = Math.floor(cz / RES);
    const tile = this.tiles[row * this.cols + col];
    if (!tile) return;
    tile.dirty = true;

    const h = this.heights;
    const stride = this.vertsX;
    const x0 = this.originX + cx * CELL;
    const x1 = x0 + CELL;
    const z0 = this.originZ + cz * CELL;
    const z1 = z0 + CELL;
    const ha = h[cz * stride + cx];
    const hb = h[cz * stride + cx + 1];
    const hc = h[(cz + 1) * stride + cx];
    const hd = h[(cz + 1) * stride + cx + 1];
    const o = ((cz - row * RES) * RES + (cx - col * RES)) * 18;
    // A stable id per facet in world terms, so colours don't reshuffle when the world grows.
    const id = ((cz + this.minTz * RES) * 4099 + cx + this.minTx * RES) * 2;
    // Alternate the diagonal in a checkerboard so facets don't all lean one way.
    if ((cx + cz) & 1) {
      this.writeTri(tile, o, x0, ha, z0, x0, hc, z1, x1, hd, z1, id);
      this.writeTri(tile, o + 9, x0, ha, z0, x1, hd, z1, x1, hb, z0, id + 1);
    } else {
      this.writeTri(tile, o, x0, ha, z0, x0, hc, z1, x1, hb, z0, id);
      this.writeTri(tile, o + 9, x1, hb, z0, x0, hc, z1, x1, hd, z1, id + 1);
    }
  }

  private writeTri(
    tile: TileMesh,
    o: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    id: number,
  ): void {
    const p = tile.pos;
    p[o] = ax; p[o + 1] = ay; p[o + 2] = az;
    p[o + 3] = bx; p[o + 4] = by; p[o + 5] = bz;
    p[o + 6] = cx; p[o + 7] = cy; p[o + 8] = cz;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    const c = this.faceColor((ay + by + cy) / 3, ny, id);
    const shade = 0.93 + hash(id * 1.7 + 5.1) * 0.14;
    const r = c.r * shade, g = c.g * shade, b = c.b * shade;

    const n = tile.nor;
    const k = tile.col;
    for (let v = 0; v < 9; v += 3) {
      n[o + v] = nx; n[o + v + 1] = ny; n[o + v + 2] = nz;
      k[o + v] = r; k[o + v + 1] = g; k[o + v + 2] = b;
    }
  }

  private faceColor(height: number, ny: number, id: number): THREE.Color {
    const c = this.colors;
    // Jitter the height each face "thinks" it is at, so bands break up into facets.
    const h = height + (hash(id) - 0.5) * 0.9;
    if (h >= bands.stone && ny > 0.5) return c.snow;
    if (ny < bands.cliffDark) return c.rockDark;
    if (ny < bands.cliff) return c.rock;
    if (h < bands.sand) return c.sand;
    if (h < bands.grassLow) return c.grassLow;
    if (h < bands.grassMid) return c.grassMid;
    if (h < bands.grassHigh) return c.grassHigh;
    if (h < bands.stone) return c.stone;
    return c.snow;
  }

  /** Allocate slab sides for the current outer edge: two colour layers per segment. */
  private buildSkirt(): void {
    const count = this.edges.length * RES * 12;
    this.skirtPos = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const earth = new THREE.Color(palette.earth);
    const bedrock = new THREE.Color(palette.bedrock);
    for (let v = 0; v < count; v++) {
      const c = v % 12 < 6 ? earth : bedrock;
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
    this.skirt.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(this.skirtPos, 3);
    position.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.skirt.geometry = geometry;
  }

  private updateSkirt(): void {
    const p = this.skirtPos;
    const h = this.heights;
    const stride = this.vertsX;
    let o = 0;
    const quad = (
      x0: number, z0: number, top0: number, bot0: number,
      x1: number, z1: number, top1: number, bot1: number,
    ) => {
      p[o++] = x0; p[o++] = top0; p[o++] = z0;
      p[o++] = x0; p[o++] = bot0; p[o++] = z0;
      p[o++] = x1; p[o++] = top1; p[o++] = z1;
      p[o++] = x1; p[o++] = top1; p[o++] = z1;
      p[o++] = x0; p[o++] = bot0; p[o++] = z0;
      p[o++] = x1; p[o++] = bot1; p[o++] = z1;
    };
    const segment = (x0: number, z0: number, h0: number, x1: number, z1: number, h1: number) => {
      quad(x0, z0, h0, STRATA_Y, x1, z1, h1, STRATA_Y);
      quad(x0, z0, STRATA_Y, BASE_Y, x1, z1, STRATA_Y, BASE_Y);
    };
    for (const { col, row, side } of this.edges) {
      const i0 = col * RES;
      const j0 = row * RES;
      const x0 = this.originX + i0 * CELL;
      const z0 = this.originZ + j0 * CELL;
      for (let k = 0; k < RES; k++) {
        const a = k * CELL;
        const b = a + CELL;
        if (side === 0) segment(x0 + a, z0, h[j0 * stride + i0 + k], x0 + b, z0, h[j0 * stride + i0 + k + 1]);
        else if (side === 1) segment(x0 + a, z0 + TILE_SIZE, h[(j0 + RES) * stride + i0 + k], x0 + b, z0 + TILE_SIZE, h[(j0 + RES) * stride + i0 + k + 1]);
        else if (side === 2) segment(x0, z0 + a, h[(j0 + k) * stride + i0], x0, z0 + b, h[(j0 + k + 1) * stride + i0]);
        else segment(x0 + TILE_SIZE, z0 + a, h[(j0 + k) * stride + i0 + RES], x0 + TILE_SIZE, z0 + b, h[(j0 + k + 1) * stride + i0 + RES]);
      }
    }
    if (this.skirt.geometry.attributes.position) this.skirt.geometry.attributes.position.needsUpdate = true;
  }

  /** One body of water over every tile: a surface per tile, and walls only along the outer edge. */
  private buildWater(): void {
    const p: number[] = [];
    type P = [number, number, number];
    const quad = (a: P, b: P, c: P, d: P) => p.push(...a, ...b, ...c, ...b, ...d, ...c);
    const top = WATER_LEVEL;
    const bottom = BASE_Y + 0.05;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (!this.active[row * this.cols + col]) continue;
        const tx = col + this.minTx;
        const tz = row + this.minTz;
        const north = !this.hasTile(tx, tz - 1);
        const south = !this.hasTile(tx, tz + 1);
        const west = !this.hasTile(tx - 1, tz);
        const east = !this.hasTile(tx + 1, tz);
        const x0 = tx * TILE_SIZE - HALF + (west ? WATER_INSET : 0);
        const x1 = tx * TILE_SIZE + HALF - (east ? WATER_INSET : 0);
        const z0 = tz * TILE_SIZE - HALF + (north ? WATER_INSET : 0);
        const z1 = tz * TILE_SIZE + HALF - (south ? WATER_INSET : 0);

        quad([x0, top, z0], [x0, top, z1], [x1, top, z0], [x1, top, z1]);
        if (north) quad([x0, top, z0], [x1, top, z0], [x0, bottom, z0], [x1, bottom, z0]);
        if (south) quad([x1, top, z1], [x0, top, z1], [x1, bottom, z1], [x0, bottom, z1]);
        if (west) quad([x0, top, z1], [x0, top, z0], [x0, bottom, z1], [x0, bottom, z0]);
        if (east) quad([x1, top, z0], [x1, top, z1], [x1, bottom, z0], [x1, bottom, z1]);
      }
    }

    this.water.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
    geometry.computeVertexNormals();
    this.water.geometry = geometry;
  }
}

import * as THREE from 'three';
import { bands, palette } from './palette';

export const WORLD_SIZE = 120; // world units along each side
export const RES = 120; // cells along each side
export const VERTS = RES + 1;
export const CELL = WORLD_SIZE / RES;
export const HALF = WORLD_SIZE / 2;
export const WATER_LEVEL = 0;
export const BASE_Y = -10; // underside of the diorama slab
export const MIN_HEIGHT = -6;
export const MAX_HEIGHT = 44;

const STRATA_Y = -6.5; // where the earth layer meets bedrock on the slab sides

export interface TerrainFile {
  kind: '3jsbildr-terrain';
  version: 1;
  resolution: number;
  worldSize: number;
  waterLevel: number;
  heights: number[];
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
 * A square heightfield drawn as a flat-shaded, vertex-coloured mesh sitting on
 * a slab of earth. `heights` is the single source of truth; the mesh is
 * rewritten from it for whichever region a brush touched.
 */
export class Terrain {
  readonly heights = new Float32Array(VERTS * VERTS);
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;

  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly col: Float32Array;
  private readonly geometry: THREE.BufferGeometry;

  private readonly skirtPos: Float32Array;
  private readonly skirtGeometry: THREE.BufferGeometry;

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
    const count = RES * RES * 6;
    this.pos = new Float32Array(count * 3);
    this.nor = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);

    this.geometry = new THREE.BufferGeometry();
    for (const [name, array] of [
      ['position', this.pos],
      ['normal', this.nor],
      ['color', this.col],
    ] as const) {
      const attr = new THREE.BufferAttribute(array, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, attr);
    }

    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // Slab sides: two colour layers per edge segment, plus an underside.
    const skirtCount = 4 * RES * 12;
    this.skirtPos = new Float32Array(skirtCount * 3);
    const skirtCol = new Float32Array(skirtCount * 3);
    const earth = new THREE.Color(palette.earth);
    const bedrock = new THREE.Color(palette.bedrock);
    for (let q = 0; q < 4 * RES; q++) {
      for (let v = 0; v < 12; v++) {
        const c = v < 6 ? earth : bedrock;
        const o = (q * 12 + v) * 3;
        skirtCol[o] = c.r;
        skirtCol[o + 1] = c.g;
        skirtCol[o + 2] = c.b;
      }
    }
    this.skirtGeometry = new THREE.BufferGeometry();
    const skirtAttr = new THREE.BufferAttribute(this.skirtPos, 3);
    skirtAttr.setUsage(THREE.DynamicDrawUsage);
    this.skirtGeometry.setAttribute('position', skirtAttr);
    this.skirtGeometry.setAttribute('color', new THREE.BufferAttribute(skirtCol, 3));
    const skirt = new THREE.Mesh(
      this.skirtGeometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 1,
        side: THREE.DoubleSide,
      }),
    );
    skirt.frustumCulled = false;
    this.group.add(skirt);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
      new THREE.MeshStandardMaterial({ color: palette.bedrock, roughness: 1, side: THREE.DoubleSide }),
    );
    floor.rotation.x = Math.PI / 2;
    floor.position.y = BASE_Y;
    this.group.add(floor);
  }

  /** Fill the heightfield with gentle rolling land that dips under water at the edges. */
  generate(seed: number): void {
    const noise = valueNoise(seed);
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const x = -HALF + i * CELL;
        const z = -HALF + j * CELL;
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
        n /= norm;
        const land = (n - 0.42) * 46 + 3;
        const square = Math.max(Math.abs(x), Math.abs(z)) / HALF;
        const round = Math.hypot(x, z) / HALF;
        const mask = 1 - smoothstep(0.68, 1.0, square * 0.55 + round * 0.45);
        this.heights[j * VERTS + i] = clamp(-4.5 + (land + 4.5) * mask, MIN_HEIGHT, MAX_HEIGHT);
      }
    }
    this.rebuild();
  }

  /** Height of the surface at a world position (bilinear; clamped to the edges). */
  heightAt(x: number, z: number, heights: Float32Array = this.heights): number {
    const fx = clamp((x + HALF) / CELL, 0, RES);
    const fz = clamp((z + HALF) / CELL, 0, RES);
    const i = Math.min(Math.floor(fx), RES - 1);
    const j = Math.min(Math.floor(fz), RES - 1);
    const tx = fx - i;
    const tz = fz - j;
    const a = heights[j * VERTS + i];
    const b = heights[j * VERTS + i + 1];
    const c = heights[(j + 1) * VERTS + i];
    const d = heights[(j + 1) * VERTS + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /**
   * First point where a ray meets the surface. Marches the heightfield directly,
   * so it stays fast and correct while the mesh is being edited. Pass `heights`
   * to test against a snapshot instead of the live surface.
   */
  raycast(ray: THREE.Ray, out: THREE.Vector3, heights: Float32Array = this.heights): boolean {
    const o = ray.origin;
    const d = ray.direction;
    let t0 = 0;
    let t1 = Infinity;
    const slabs: [number, number, number, number][] = [
      [o.x, d.x, -HALF, HALF],
      [o.y, d.y, MIN_HEIGHT - 1, MAX_HEIGHT + 1],
      [o.z, d.z, -HALF, HALF],
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

    const STEP = 0.4;
    let prevT = t0;
    let prevAbove = o.y + d.y * t0 - this.heightAt(o.x + d.x * t0, o.z + d.z * t0, heights);
    if (prevAbove < 0) return false; // started under the surface
    for (let t = t0 + STEP; t <= t1 + STEP; t += STEP) {
      const tt = Math.min(t, t1);
      const above = o.y + d.y * tt - this.heightAt(o.x + d.x * tt, o.z + d.z * tt, heights);
      if (above < 0) {
        let lo = prevT;
        let hi = tt;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          const m = o.y + d.y * mid - this.heightAt(o.x + d.x * mid, o.z + d.z * mid, heights);
          if (m < 0) hi = mid;
          else lo = mid;
        }
        out.set(o.x + d.x * hi, 0, o.z + d.z * hi);
        out.y = this.heightAt(out.x, out.z, heights);
        return true;
      }
      prevT = tt;
      prevAbove = above;
    }
    return false;
  }

  /** Rewrite the whole mesh from `heights`. */
  rebuild(): void {
    this.updateRegion(0, 0, RES, RES);
  }

  /** Rewrite the mesh for the cells touching vertices i0..i1 by j0..j1. */
  updateRegion(i0: number, j0: number, i1: number, j1: number): void {
    const cx0 = Math.max(0, i0 - 1);
    const cz0 = Math.max(0, j0 - 1);
    const cx1 = Math.min(RES - 1, i1);
    const cz1 = Math.min(RES - 1, j1);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) this.writeCell(cx, cz);
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    if (i0 <= 0 || j0 <= 0 || i1 >= RES || j1 >= RES) this.updateSkirt();
  }

  serialize(): TerrainFile {
    return {
      kind: '3jsbildr-terrain',
      version: 1,
      resolution: RES,
      worldSize: WORLD_SIZE,
      waterLevel: WATER_LEVEL,
      heights: Array.from(this.heights, (h) => Math.round(h * 1000) / 1000),
    };
  }

  /** Load a saved terrain. Returns false if the data doesn't fit this grid. */
  load(data: unknown): boolean {
    const file = data as Partial<TerrainFile> | null;
    if (!file || file.kind !== '3jsbildr-terrain' || !Array.isArray(file.heights)) return false;
    if (file.resolution !== RES || file.heights.length !== this.heights.length) return false;
    for (let k = 0; k < this.heights.length; k++) {
      const h = Number(file.heights[k]);
      if (!Number.isFinite(h)) return false;
      this.heights[k] = clamp(h, MIN_HEIGHT, MAX_HEIGHT);
    }
    this.rebuild();
    return true;
  }

  private writeCell(cx: number, cz: number): void {
    const h = this.heights;
    const x0 = -HALF + cx * CELL;
    const x1 = x0 + CELL;
    const z0 = -HALF + cz * CELL;
    const z1 = z0 + CELL;
    const ha = h[cz * VERTS + cx];
    const hb = h[cz * VERTS + cx + 1];
    const hc = h[(cz + 1) * VERTS + cx];
    const hd = h[(cz + 1) * VERTS + cx + 1];
    const cell = cz * RES + cx;
    const o = cell * 18;
    // Alternate the diagonal in a checkerboard so facets don't all lean one way.
    if ((cx + cz) & 1) {
      this.writeTri(o, x0, ha, z0, x0, hc, z1, x1, hd, z1, cell * 2);
      this.writeTri(o + 9, x0, ha, z0, x1, hd, z1, x1, hb, z0, cell * 2 + 1);
    } else {
      this.writeTri(o, x0, ha, z0, x0, hc, z1, x1, hb, z0, cell * 2);
      this.writeTri(o + 9, x1, hb, z0, x0, hc, z1, x1, hd, z1, cell * 2 + 1);
    }
  }

  private writeTri(
    o: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    id: number,
  ): void {
    const p = this.pos;
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

    const n = this.nor;
    const k = this.col;
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

  private updateSkirt(): void {
    const p = this.skirtPos;
    const h = this.heights;
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
    for (let k = 0; k < RES; k++) {
      const u0 = -HALF + k * CELL;
      const u1 = u0 + CELL;
      segment(u0, -HALF, h[k], u1, -HALF, h[k + 1]);
      segment(u0, HALF, h[RES * VERTS + k], u1, HALF, h[RES * VERTS + k + 1]);
      segment(-HALF, u0, h[k * VERTS], -HALF, u1, h[(k + 1) * VERTS]);
      segment(HALF, u0, h[k * VERTS + RES], HALF, u1, h[(k + 1) * VERTS + RES]);
    }
    this.skirtGeometry.attributes.position.needsUpdate = true;
  }
}

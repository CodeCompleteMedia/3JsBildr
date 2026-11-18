import { CELL, MAX_HEIGHT, MIN_HEIGHT, Terrain } from './terrain';

export type BrushKind = 'raise' | 'lower' | 'smooth' | 'flatten';

/** Everything the left mouse button can do: the sculpting brushes plus foliage. */
export type Tool = BrushKind | 'plant' | 'clear' | 'creature' | 'shoo';

/** The tools on the rail, in number-key order. ('shoo', removing creatures, is Shift + creature.) */
export const TOOLS: Tool[] = ['raise', 'lower', 'smooth', 'flatten', 'plant', 'clear', 'creature'];

export const BRUSH_LIMITS = {
  radius: { min: 1.5, max: 30, initial: 8 },
  strength: { min: 2, max: 40, initial: 12 },
};

/**
 * Apply one frame of a brush centred on (x, z).
 * `strength` is world units per second at the centre for raise/lower, and a
 * rate for smooth/flatten. `target` is the height flatten pulls towards.
 * Works across tile seams; vertices that belong to no tile are left alone.
 */
export function applyBrush(
  terrain: Terrain,
  kind: BrushKind,
  x: number,
  z: number,
  radius: number,
  strength: number,
  dt: number,
  target: number,
): void {
  const ox = terrain.originX;
  const oz = terrain.originZ;
  const stride = terrain.vertsX;
  const lastI = stride - 1;
  const lastJ = terrain.vertsZ - 1;
  const i0 = Math.max(0, Math.ceil((x - radius - ox) / CELL));
  const i1 = Math.min(lastI, Math.floor((x + radius - ox) / CELL));
  const j0 = Math.max(0, Math.ceil((z - radius - oz) / CELL));
  const j1 = Math.min(lastJ, Math.floor((z + radius - oz) / CELL));
  if (i0 > i1 || j0 > j1) return;

  const h = terrain.heights;
  // Smooth reads from a copy so the result doesn't depend on sweep direction.
  const src = kind === 'smooth' ? h.slice() : h;
  const r2 = radius * radius;

  for (let j = j0; j <= j1; j++) {
    const dz = oz + j * CELL - z;
    for (let i = i0; i <= i1; i++) {
      const dx = ox + i * CELL - x;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2 || !terrain.vertexActive(i, j)) continue;
      const q = 1 - d2 / r2;
      const falloff = q * q; // soft bell: full at the centre, zero at the rim
      const idx = j * stride + i;
      let v = h[idx];

      switch (kind) {
        case 'raise':
          v += strength * falloff * dt;
          break;
        case 'lower':
          v -= strength * falloff * dt;
          break;
        case 'smooth': {
          let sum = 0;
          let n = 0;
          for (let b = Math.max(0, j - 1); b <= Math.min(lastJ, j + 1); b++) {
            for (let a = Math.max(0, i - 1); a <= Math.min(lastI, i + 1); a++) {
              if (!terrain.vertexActive(a, b)) continue;
              sum += src[b * stride + a];
              n++;
            }
          }
          v += (sum / n - v) * Math.min(1, falloff * strength * 0.6 * dt);
          break;
        }
        case 'flatten':
          v += (target - v) * Math.min(1, falloff * strength * 0.4 * dt);
          break;
      }

      h[idx] = v < MIN_HEIGHT ? MIN_HEIGHT : v > MAX_HEIGHT ? MAX_HEIGHT : v;
    }
  }

  terrain.updateRegion(i0, j0, i1, j1);
}

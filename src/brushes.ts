import { CELL, HALF, MAX_HEIGHT, MIN_HEIGHT, RES, Terrain, VERTS } from './terrain';

export type BrushKind = 'raise' | 'lower' | 'smooth' | 'flatten';

export const BRUSHES: BrushKind[] = ['raise', 'lower', 'smooth', 'flatten'];

export const BRUSH_LIMITS = {
  radius: { min: 1.5, max: 30, initial: 8 },
  strength: { min: 2, max: 40, initial: 12 },
};

/**
 * Apply one frame of a brush centred on (x, z).
 * `strength` is world units per second at the centre for raise/lower, and a
 * rate for smooth/flatten. `target` is the height flatten pulls towards.
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
  const i0 = Math.max(0, Math.ceil((x - radius + HALF) / CELL));
  const i1 = Math.min(RES, Math.floor((x + radius + HALF) / CELL));
  const j0 = Math.max(0, Math.ceil((z - radius + HALF) / CELL));
  const j1 = Math.min(RES, Math.floor((z + radius + HALF) / CELL));
  if (i0 > i1 || j0 > j1) return;

  const h = terrain.heights;
  // Smooth reads from a copy so the result doesn't depend on sweep direction.
  const src = kind === 'smooth' ? h.slice() : h;
  const r2 = radius * radius;

  for (let j = j0; j <= j1; j++) {
    const dz = -HALF + j * CELL - z;
    for (let i = i0; i <= i1; i++) {
      const dx = -HALF + i * CELL - x;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2) continue;
      const q = 1 - d2 / r2;
      const falloff = q * q; // soft bell: full at the centre, zero at the rim
      const idx = j * VERTS + i;
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
          for (let b = Math.max(0, j - 1); b <= Math.min(RES, j + 1); b++) {
            for (let a = Math.max(0, i - 1); a <= Math.min(RES, i + 1); a++) {
              sum += src[b * VERTS + a];
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

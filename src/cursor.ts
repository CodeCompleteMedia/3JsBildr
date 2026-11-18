import * as THREE from 'three';
import type { Tool } from './brushes';
import type { Terrain } from './terrain';

const SEGMENTS = 72;

const COLORS: Record<Tool, number> = {
  raise: 0xffffff,
  lower: 0xff5fa2,
  smooth: 0x7df9ff,
  flatten: 0xfff06a,
  plant: 0x8dff6a,
  clear: 0xff8a5c,
};

/** A ring that drapes over the terrain to show where the brush will land. */
export class BrushCursor {
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(private readonly terrain: Terrain) {
    this.positions = new Float32Array((SEGMENTS + 1) * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(this.positions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attr);
    const index: number[] = [];
    for (let s = 0; s < SEGMENTS; s++) {
      const a = s * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);

    this.material = new THREE.MeshBasicMaterial({
      color: COLORS.raise,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** `thickness` is the ring's width in world units (scale it with camera distance). */
  update(x: number, z: number, radius: number, thickness: number, kind: Tool): void {
    const p = this.positions;
    const inner = Math.max(radius - thickness, radius * 0.5);
    for (let s = 0; s <= SEGMENTS; s++) {
      const angle = (s / SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const ox = x + cos * radius;
      const oz = z + sin * radius;
      const ix = x + cos * inner;
      const iz = z + sin * inner;
      const o = s * 6;
      p[o] = ox;
      p[o + 1] = this.terrain.heightAt(ox, oz) + 0.06;
      p[o + 2] = oz;
      p[o + 3] = ix;
      p[o + 4] = this.terrain.heightAt(ix, iz) + 0.06;
      p[o + 5] = iz;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.material.color.setHex(COLORS[kind]);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

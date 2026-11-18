import * as THREE from 'three';
import { BASE_Y, TILE_SIZE, WATER_LEVEL } from './terrain';

/** The outline shown over an empty slot beside the land, offering to add a tile there. */
export class TileGhost {
  readonly group = new THREE.Group();
  private readonly fill: THREE.MeshBasicMaterial;

  constructor() {
    this.fill = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE).rotateX(-Math.PI / 2), this.fill);
    surface.position.y = WATER_LEVEL;

    const depth = WATER_LEVEL - BASE_Y;
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(TILE_SIZE, depth, TILE_SIZE)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, fog: false }),
    );
    outline.position.y = WATER_LEVEL - depth / 2;

    const solid = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: false });
    const across = new THREE.Mesh(new THREE.BoxGeometry(22, 0.8, 4), solid);
    const along = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 22), solid);
    across.position.y = along.position.y = WATER_LEVEL + 0.6;

    this.group.add(surface, outline, across, along);
    this.group.visible = false;
  }

  show(tx: number, tz: number, seconds: number): void {
    this.group.position.set(tx * TILE_SIZE, 0, tz * TILE_SIZE);
    this.fill.opacity = 0.15 + 0.07 * Math.sin(seconds * 4);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}

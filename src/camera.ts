import * as THREE from 'three';
import { TILE_SIZE, Terrain, WATER_LEVEL } from './terrain';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Tuning. `zoom` runs from 0 (whole diorama on the table) to 1 (standing on the ground).
const TABLE_DISTANCE = 370; // how far back the table view sits for a single tile
const TABLE_PITCH = 54 * DEG; // how steeply the table view looks down
const TABLE_FOV = 28; // long lens up high: flattens perspective, reads as a miniature
const GROUND_FOV = 62; // wide lens on the ground: things tower over you
const EYE_HEIGHT = 1.3;
const CLEARANCE = 0.6; // keep the camera at least this far above land and water
const MAX_PITCH = 86 * DEG;
const STANDOFF = 9; // when zooming in on a spot, land this far short of it, facing it

const pitchAt = (zoom: number) => TABLE_PITCH * (1 - zoom) ** 0.85;
const fovAt = (zoom: number) => lerp(TABLE_FOV, GROUND_FOV, zoom ** 2.5);
// Lowest allowed pitch. Negative means looking up, which only opens up near the ground.
const minPitchAt = (zoom: number) => lerp(6 * DEG, -65 * DEG, zoom ** 3);

/**
 * One continuous camera from tabletop to ground level.
 *
 * The camera hangs behind a pivot on the ground at a distance set by `zoom`.
 * As zoom goes to 1 the distance shrinks to nothing and the pitch levels out,
 * so the same yaw/pitch that orbits the diorama from above becomes a plain
 * look-around when you are standing in it.
 */
export class DioramaCamera {
  readonly camera: THREE.PerspectiveCamera;

  // Where the controls are heading; the live values below ease towards these.
  private goalZoom = 0;
  private goalYaw = 35 * DEG;
  private goalTilt = 0;
  private readonly goalFocus = new THREE.Vector2(0, 0);

  private zoomNow = 0;
  private yawNow = 35 * DEG;
  private tiltNow = 0;
  private readonly focusNow = new THREE.Vector2(0, 0);
  private pivotY = EYE_HEIGHT;
  private lift = 0;

  /** The point on the ground the camera is centred on. */
  readonly pivot = new THREE.Vector3();

  private readonly scratch = new THREE.Vector2();
  private readonly dir = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  /** Distance of the table view. Grows with the land so the whole world still fits. */
  private reach = TABLE_DISTANCE;

  constructor(private readonly terrain: Terrain, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(TABLE_FOV, aspect, 0.1, 9000);
    this.update(1);
  }

  private distanceAt(zoom: number): number {
    return this.reach * (1 - zoom) ** 2;
  }

  /** How far back the table view needs to be to take in all the land. */
  private get targetReach(): number {
    const { minX, maxX, minZ, maxZ } = this.terrain.bounds;
    return (TABLE_DISTANCE * Math.hypot(maxX - minX, maxZ - minZ)) / Math.hypot(TILE_SIZE, TILE_SIZE);
  }

  private centre(target: THREE.Vector2): THREE.Vector2 {
    const { minX, maxX, minZ, maxZ } = this.terrain.bounds;
    return target.set((minX + maxX) / 2, (minZ + maxZ) / 2);
  }

  /** 0 at the table view, 1 on the ground. */
  get zoom(): number {
    return this.zoomNow;
  }

  /** Distance from the camera to its pivot. */
  get distance(): number {
    return this.distanceAt(this.zoomNow);
  }

  /**
   * Zoom by a fraction of the full range. When zooming in, `anchor` (a point on
   * the ground under the cursor) is where you end up.
   */
  zoomBy(amount: number, anchor?: THREE.Vector3): void {
    const from = this.goalZoom;
    const to = clamp(from + amount, 0, 1);
    if (to === from) return;
    const d0 = this.distanceAt(from);
    const d1 = this.distanceAt(to);
    if (anchor && to > from && d0 > 0.05) {
      const k = 1 - d1 / d0;
      // Aim a little short of the anchor near the ground, so you arrive looking
      // at the thing you pointed to instead of standing on top of it.
      const back = STANDOFF * to ** 3;
      const tx = anchor.x + Math.sin(this.goalYaw) * back;
      const tz = anchor.z + Math.cos(this.goalYaw) * back;
      let dx = (tx - this.goalFocus.x) * k;
      let dz = (tz - this.goalFocus.y) * k;
      // Never travel further in one step than the camera's own arm length.
      const len = Math.hypot(dx, dz);
      if (len > d0) {
        dx *= d0 / len;
        dz *= d0 / len;
      }
      this.goalFocus.x += dx;
      this.goalFocus.y += dz;
      this.clampFocus();
    }
    this.goalZoom = to;
    // Ease any manual tilt back out as the zoom changes.
    this.goalTilt *= 1 - Math.min(1, Math.abs(to - from) * 3);
  }

  /** Drag to orbit (from above) or look around (on the ground). Pixels in. */
  orbit(dxPixels: number, dyPixels: number): void {
    this.goalYaw -= dxPixels * 0.005;
    const base = pitchAt(this.goalZoom);
    const pitch = clamp(base + this.goalTilt + dyPixels * 0.004, minPitchAt(this.goalZoom), MAX_PITCH);
    this.goalTilt = pitch - base;
  }

  /** Drag the ground under the cursor. Pixels in. */
  pan(dxPixels: number, dyPixels: number, viewportHeight: number): void {
    const fov = fovAt(this.zoomNow) * DEG;
    const perPixel = Math.max((2 * this.distance * Math.tan(fov / 2)) / viewportHeight, 0.012);
    const sinPitch = Math.max(Math.sin(pitchAt(this.zoomNow) + this.tiltNow), 0.35);
    this.slide(-dxPixels * perPixel, (dyPixels * perPixel) / sinPitch);
  }

  /** Keyboard movement: -1..1 on each axis, relative to where the camera faces. */
  move(forward: number, right: number, dt: number, fast: boolean): void {
    const speed = Math.max(5, this.distance * 0.9) * (fast ? 2.4 : 1);
    this.slide(right * speed * dt, forward * speed * dt);
  }

  /** Keyboard rotation: -1 or 1. */
  turn(direction: number, dt: number): void {
    this.goalYaw -= direction * 1.6 * dt;
  }

  reset(): void {
    this.goalZoom = 0;
    this.goalYaw = 35 * DEG;
    this.goalTilt = 0;
    this.centre(this.goalFocus);
  }

  /** Send the camera somewhere specific (used by scripts and, later, project sites). */
  goTo(view: { zoom?: number; yawDegrees?: number; x?: number; z?: number }): void {
    if (view.zoom !== undefined) this.goalZoom = clamp(view.zoom, 0, 1);
    if (view.yawDegrees !== undefined) this.goalYaw = view.yawDegrees * DEG;
    if (view.x !== undefined) this.goalFocus.x = view.x;
    if (view.z !== undefined) this.goalFocus.y = view.z;
    this.goalTilt = 0;
    this.clampFocus();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    const ease = 1 - Math.exp(-dt * 12);

    // Fully zoomed out always settles on the centre of the land.
    if (this.goalZoom < 0.02) this.goalFocus.lerp(this.centre(this.scratch), 1 - Math.exp(-dt * 4));
    // When land is added the table view pulls back smoothly to take it in.
    this.reach = lerp(this.reach, this.targetReach, 1 - Math.exp(-dt * 5));

    this.zoomNow = lerp(this.zoomNow, this.goalZoom, ease);
    this.yawNow = lerp(this.yawNow, this.goalYaw, ease);
    this.tiltNow = lerp(this.tiltNow, this.goalTilt, ease);
    this.focusNow.lerp(this.goalFocus, ease);

    const zoom = this.zoomNow;
    const distance = this.distanceAt(zoom);
    const pitch = clamp(pitchAt(zoom) + this.tiltNow, minPitchAt(zoom), MAX_PITCH);
    const cosP = Math.cos(pitch);
    this.dir.set(-Math.sin(this.yawNow) * cosP, -Math.sin(pitch), -Math.cos(this.yawNow) * cosP);

    const fx = this.focusNow.x;
    const fz = this.focusNow.y;
    const ground = Math.max(this.terrain.heightAt(fx, fz), WATER_LEVEL) + EYE_HEIGHT;
    this.pivotY = lerp(this.pivotY, ground, 1 - Math.exp(-dt * 10));

    this.pivot.set(fx, this.pivotY, fz);

    const pos = this.camera.position;
    pos.set(fx - this.dir.x * distance, this.pivotY - this.dir.y * distance, fz - this.dir.z * distance);

    // Ride over the land: never let the camera sink into a hill or the water.
    const floor = Math.max(this.terrain.heightAt(pos.x, pos.z), WATER_LEVEL) + CLEARANCE;
    const needed = Math.max(0, floor - pos.y);
    this.lift = needed > this.lift ? needed : lerp(this.lift, needed, 1 - Math.exp(-dt * 6));
    pos.y += this.lift;

    this.look.copy(pos).add(this.dir);
    this.camera.lookAt(this.look);

    // Push the near plane out with distance to keep depth precise from far away.
    this.camera.fov = fovAt(zoom);
    this.camera.near = clamp(distance * 0.05, 0.4, 40);
    this.camera.updateProjectionMatrix();
  }

  private slide(right: number, forward: number): void {
    const sin = Math.sin(this.yawNow);
    const cos = Math.cos(this.yawNow);
    // forward = (-sin, -cos), right = (cos, -sin) on the ground plane
    this.goalFocus.x += -sin * forward + cos * right;
    this.goalFocus.y += -cos * forward - sin * right;
    this.clampFocus();
  }

  private clampFocus(): void {
    const { minX, maxX, minZ, maxZ } = this.terrain.bounds;
    this.goalFocus.x = clamp(this.goalFocus.x, minX + 1, maxX - 1);
    this.goalFocus.y = clamp(this.goalFocus.y, minZ + 1, maxZ - 1);
  }
}

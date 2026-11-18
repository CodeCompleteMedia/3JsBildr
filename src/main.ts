import * as THREE from 'three';
import './style.css';
import { applyBrush, BRUSH_LIMITS, BRUSHES, type BrushKind } from './brushes';
import { DioramaCamera } from './camera';
import { BrushCursor } from './cursor';
import { palette } from './palette';
import { createClouds, createLights, createSky, createWater } from './scenery';
import { Terrain } from './terrain';

const STORAGE_KEY = '3jsbildr:terrain:v1';
const HISTORY_LIMIT = 60;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- scene

const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const fog = new THREE.FogExp2(palette.skyHorizon, 0);
scene.fog = fog;

const sky = createSky();
const clouds = createClouds();
const terrain = new Terrain();
scene.add(sky, clouds, createLights(), terrain.group, createWater());

const rig = new DioramaCamera(terrain, window.innerWidth / window.innerHeight);
const cursor = new BrushCursor(terrain);
scene.add(cursor.mesh);

// ---------------------------------------------------------------- state

const brush = {
  kind: 'raise' as BrushKind,
  radius: BRUSH_LIMITS.radius.initial,
  strength: BRUSH_LIMITS.strength.initial,
};

type Drag = 'none' | 'sculpt' | 'orbit' | 'pan';
let drag: Drag = 'none';
let explore = false;

const keys = new Set<string>();
const pointer = new THREE.Vector2();
let pointerOverView = false;
const raycaster = new THREE.Raycaster();
const hit = new THREE.Vector3();

let strokeStart: Float32Array | null = null;
let strokeChanged = false;
let flattenTarget = 0;
const undoStack: Float32Array[] = [];
const redoStack: Float32Array[] = [];

// ---------------------------------------------------------------- saving

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(terrain.serialize()));
  } catch {
    // Storage can be full or unavailable; the terrain still lives in memory.
  }
}

function restore(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? terrain.load(JSON.parse(raw)) : false;
  } catch {
    return false;
  }
}

if (!restore()) terrain.generate(1);

// ---------------------------------------------------------------- history

function remember(snapshot: Float32Array): void {
  undoStack.push(snapshot);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  refreshHistoryButtons();
}

function stepHistory(from: Float32Array[], to: Float32Array[]): void {
  const snapshot = from.pop();
  if (!snapshot || drag === 'sculpt') return;
  to.push(terrain.heights.slice());
  terrain.heights.set(snapshot);
  terrain.rebuild();
  save();
  refreshHistoryButtons();
}

const undo = () => stepHistory(undoStack, redoStack);
const redo = () => stepHistory(redoStack, undoStack);

// ---------------------------------------------------------------- HUD

const railButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#rail button'));
const radiusInput = $<HTMLInputElement>('radius');
const strengthInput = $<HTMLInputElement>('strength');
const toastEl = $('toast');
let toastTimer = 0;

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function setBrush(kind: BrushKind): void {
  brush.kind = kind;
  for (const button of railButtons) button.classList.toggle('active', button.dataset.brush === kind);
}

function setRadius(value: number): void {
  brush.radius = clamp(value, BRUSH_LIMITS.radius.min, BRUSH_LIMITS.radius.max);
  radiusInput.value = String(brush.radius);
  $('radius-out').textContent = brush.radius.toFixed(1);
}

function setStrength(value: number): void {
  brush.strength = clamp(value, BRUSH_LIMITS.strength.min, BRUSH_LIMITS.strength.max);
  strengthInput.value = String(brush.strength);
  $('strength-out').textContent = brush.strength.toFixed(0);
}

function setExplore(on: boolean): void {
  explore = on;
  document.body.classList.toggle('explore', on);
  if (on) cursor.hide();
}

function refreshHistoryButtons(): void {
  $<HTMLButtonElement>('undo').disabled = undoStack.length === 0;
  $<HTMLButtonElement>('redo').disabled = redoStack.length === 0;
}

for (const button of railButtons) {
  button.addEventListener('click', () => setBrush(button.dataset.brush as BrushKind));
}

radiusInput.min = String(BRUSH_LIMITS.radius.min);
radiusInput.max = String(BRUSH_LIMITS.radius.max);
strengthInput.min = String(BRUSH_LIMITS.strength.min);
strengthInput.max = String(BRUSH_LIMITS.strength.max);
radiusInput.addEventListener('input', () => setRadius(Number(radiusInput.value)));
strengthInput.addEventListener('input', () => setStrength(Number(strengthInput.value)));
// Hand the keyboard back to the view after using a control.
for (const el of document.querySelectorAll<HTMLElement>('#hud button, #hud input')) {
  el.addEventListener('pointerup', () => el.blur());
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('explore').addEventListener('click', () => setExplore(true));

$('new').addEventListener('click', () => {
  remember(terrain.heights.slice());
  terrain.generate(Math.floor(Math.random() * 1e9));
  save();
  toast('Fresh land. Undo brings the old one back.');
});

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(terrain.serialize())], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'terrain.json';
  link.click();
  URL.revokeObjectURL(link.href);
});

const fileInput = $<HTMLInputElement>('file');
$('import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  const before = terrain.heights.slice();
  let ok = false;
  try {
    ok = terrain.load(JSON.parse(await file.text()));
  } catch {
    ok = false;
  }
  if (ok) {
    remember(before);
    save();
    toast(`Loaded ${file.name}`);
  } else {
    toast("That file isn't a terrain this editor can read.");
  }
});

setBrush(brush.kind);
setRadius(brush.radius);
setStrength(brush.strength);
refreshHistoryButtons();

// ---------------------------------------------------------------- pointer

function trackPointer(event: PointerEvent | WheelEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

/** Ground point under the cursor. `heights` picks against a snapshot instead of the live surface. */
function pick(heights?: Float32Array): boolean {
  raycaster.setFromCamera(pointer, rig.camera);
  return terrain.raycast(raycaster.ray, hit, heights);
}

function setDrag(next: Drag): void {
  drag = next;
  document.body.classList.toggle('orbiting', next === 'orbit');
  document.body.classList.toggle('panning', next === 'pan');
}

canvas.addEventListener('pointerdown', (event) => {
  if (drag !== 'none') return;
  canvas.setPointerCapture(event.pointerId);
  trackPointer(event);
  event.preventDefault();

  const primary = event.button === 0;
  if (event.button === 1 || (primary && keys.has('Space'))) {
    setDrag('pan');
  } else if (event.button === 2 || (primary && (event.altKey || event.ctrlKey || explore))) {
    setDrag('orbit');
  } else if (primary && pick()) {
    setDrag('sculpt');
    strokeStart = terrain.heights.slice();
    strokeChanged = false;
    flattenTarget = hit.y;
  }
});

canvas.addEventListener('pointermove', (event) => {
  trackPointer(event);
  pointerOverView = true;
  if (drag === 'orbit') rig.orbit(event.movementX, event.movementY);
  else if (drag === 'pan') rig.pan(event.movementX, event.movementY, canvas.clientHeight);
});

function endDrag(event: PointerEvent): void {
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (drag === 'sculpt' && strokeStart) {
    if (strokeChanged) {
      remember(strokeStart);
      save();
    }
    strokeStart = null;
  }
  setDrag('none');
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (drag === 'none') pointerOverView = false;
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    trackPointer(event);
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    // Trackpad pinch arrives as a wheel event with ctrlKey set and small deltas.
    const amount = clamp(-delta * (event.ctrlKey ? 0.004 : 0.0007), -0.08, 0.08);
    rig.zoomBy(amount, amount > 0 && pick() ? hit : undefined);
  },
  { passive: false },
);

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;

  if (event.metaKey || event.ctrlKey) {
    if (event.code === 'KeyZ') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (event.code === 'KeyY') {
      event.preventDefault();
      redo();
    }
    return;
  }

  keys.add(event.code);
  if (event.code === 'Space' || event.code === 'Tab' || event.code.startsWith('Arrow')) event.preventDefault();
  if (event.repeat && !['BracketLeft', 'BracketRight', 'Minus', 'Equal'].includes(event.code)) return;

  switch (event.code) {
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4':
      setBrush(BRUSHES[Number(event.code.slice(5)) - 1]);
      if (explore) setExplore(false);
      break;
    case 'BracketLeft':
      setRadius(brush.radius / 1.12);
      break;
    case 'BracketRight':
      setRadius(brush.radius * 1.12);
      break;
    case 'Minus':
      setStrength(brush.strength - 2);
      break;
    case 'Equal':
      setStrength(brush.strength + 2);
      break;
    case 'KeyV':
    case 'Tab':
      setExplore(!explore);
      break;
    case 'Escape':
      setExplore(false);
      break;
    case 'KeyH':
      document.body.classList.toggle('no-hint');
      break;
    case 'Digit0':
    case 'Home':
      rig.reset();
      break;
  }
});

window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  rig.setAspect(window.innerWidth / window.innerHeight);
});

// ---------------------------------------------------------------- frame loop

const altitudeDot = $('altitude-dot');
const held = (...codes: string[]) => codes.some((code) => keys.has(code));
let last = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const forward = Number(held('KeyW', 'ArrowUp')) - Number(held('KeyS', 'ArrowDown'));
  const right = Number(held('KeyD', 'ArrowRight')) - Number(held('KeyA', 'ArrowLeft'));
  if (forward || right) rig.move(forward, right, dt, held('ShiftLeft', 'ShiftRight'));
  const turn = Number(held('KeyE')) - Number(held('KeyQ'));
  if (turn) rig.turn(turn, dt);

  rig.update(dt);

  // Brush: sculpt while held, and keep the ring under the cursor.
  let kind = brush.kind;
  if (held('ShiftLeft', 'ShiftRight')) {
    if (kind === 'raise') kind = 'lower';
    else if (kind === 'lower') kind = 'raise';
  }
  const sculpting = drag === 'sculpt' && strokeStart !== null;
  const showBrush = !explore && (sculpting || (drag === 'none' && pointerOverView));
  if (showBrush) {
    // While raising or lowering, aim at the surface as it was when the stroke
    // began. Otherwise the hill grows towards the camera and drags the brush with it.
    const aimAtSnapshot = sculpting && (kind === 'raise' || kind === 'lower');
    if (pick(aimAtSnapshot ? strokeStart! : undefined)) {
      if (sculpting) {
        applyBrush(terrain, kind, hit.x, hit.z, brush.radius, brush.strength, dt, flattenTarget);
        strokeChanged = true;
      }
      const range = rig.camera.position.distanceTo(hit);
      const perPixel = (2 * range * Math.tan(THREE.MathUtils.degToRad(rig.camera.fov) / 2)) / canvas.clientHeight;
      cursor.update(hit.x, hit.z, brush.radius, clamp(perPixel * 3, 0.05, 2), kind);
    } else {
      cursor.hide();
    }
  } else {
    cursor.hide();
  }

  // Atmosphere: clear air from above, a little haze once you are down in it.
  fog.density = 0.011 * rig.zoom ** 3;
  sky.position.copy(rig.camera.position);
  clouds.rotation.y += dt * 0.012;
  altitudeDot.style.top = `${rig.zoom * 100}%`;

  renderer.render(scene, rig.camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Handy from the browser console: bildr.rig.goTo({ zoom: 1, x: 10, z: -5 })
Object.assign(window, { bildr: { rig, terrain, brush, scene, renderer } });

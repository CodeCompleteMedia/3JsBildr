import * as THREE from 'three';
import './style.css';
import { Atmosphere } from './atmosphere';
import { applyBrush, BRUSH_LIMITS, TOOLS, type BrushKind, type Tool } from './brushes';
import { DioramaCamera } from './camera';
import { BrushCursor } from './cursor';
import { Foliage, type Plant, type PlantChoice } from './foliage';
import { TileGhost } from './ghost';
import { PerfMeter } from './perf';
import { Post } from './post';
import { createClouds } from './scenery';
import { MAX_TILES, Terrain, WATER_LEVEL, type TerrainSnapshot } from './terrain';

const STORAGE_KEY = '3jsbildr:world:v2';
const LEGACY_STORAGE_KEY = '3jsbildr:terrain:v1';
const SETTINGS_KEY = '3jsbildr:settings:v1';
const HISTORY_LIMIT = 60;
const HISTORY_BYTES = 96 * 1024 * 1024; // undo keeps whole-terrain copies, so cap their total size

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- scene

const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const clouds = createClouds();
const atmosphere = new Atmosphere(clouds.material);
scene.fog = atmosphere.fog;

const terrain = new Terrain();
const foliage = new Foliage(terrain);
scene.add(atmosphere.sky, atmosphere.lights, clouds.group, terrain.group, foliage.group);

const rig = new DioramaCamera(terrain, window.innerWidth / window.innerHeight);
const cursor = new BrushCursor(terrain);
const ghost = new TileGhost();
scene.add(cursor.mesh, ghost.group);

const post = new Post(renderer, scene, rig.camera);

function resize(): void {
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  post.setSize(window.innerWidth, window.innerHeight, pixelRatio);
  rig.setAspect(window.innerWidth / window.innerHeight);
}
resize();
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- state

const brush = {
  tool: 'raise' as Tool,
  radius: BRUSH_LIMITS.radius.initial,
  strength: BRUSH_LIMITS.strength.initial,
  plant: 'forest' as PlantChoice,
};

type Drag = 'none' | 'stroke' | 'orbit' | 'pan';
let drag: Drag = 'none';
let explore = false;

// Everything adjustable that isn't part of the world itself. Saved between visits.
const settings = {
  miniature: true,
  stats: true,
  cachedShadows: true,
  culling: true,
  thinStart: 140,
  thinAmount: 0.6,
};

/** With cached shadows on, the shadow map is only redrawn when this is called. */
function invalidateShadows(): void {
  renderer.shadowMap.needsUpdate = true;
}
foliage.onChange = invalidateShadows;

/** Fit everything that depends on the size of the land: shadows, clouds. */
const worldCentre = new THREE.Vector3();
function layoutChanged(): void {
  const { minX, maxX, minZ, maxZ } = terrain.bounds;
  worldCentre.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2;
  atmosphere.setBounds(worldCentre, radius);
  clouds.group.position.copy(worldCentre);
  clouds.group.scale.setScalar(Math.max(1, radius / 85));
  invalidateShadows();
}
terrain.onLayout = layoutChanged;
layoutChanged();

const keys = new Set<string>();
const pointer = new THREE.Vector2();
let pointerOverView = false;
const raycaster = new THREE.Raycaster();
const hit = new THREE.Vector3();
const slot = { tx: 0, tz: 0 }; // the empty space beside the land that the cursor is over
const projected = new THREE.Vector3();

/** Everything a stroke can change, captured so it can be undone. */
interface Snapshot {
  terrain: TerrainSnapshot;
  plants: Plant[];
}

let strokeStart: Snapshot | null = null;
let strokeChanged = false;
let flattenTarget = 0;
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];

const takeSnapshot = (): Snapshot => ({ terrain: terrain.snapshot(), plants: foliage.snapshot() });

function applySnapshot(snapshot: Snapshot): void {
  terrain.restore(snapshot.terrain);
  foliage.restore(snapshot.plants);
  invalidateShadows();
}

// ---------------------------------------------------------------- saving

function serializeWorld() {
  return {
    kind: '3jsbildr-world',
    version: 2,
    terrain: terrain.serialize(),
    plants: foliage.serialize(),
    timeOfDay: Math.round(atmosphere.time * 1000) / 1000,
  };
}

/** Accepts a full world file, or a terrain-only file from the first version. */
function loadWorld(data: unknown): boolean {
  const file = data as { kind?: string; terrain?: unknown; plants?: unknown; timeOfDay?: unknown } | null;
  if (file?.kind === '3jsbildr-world') {
    if (!terrain.load(file.terrain)) return false;
    foliage.load(file.plants);
    if (typeof file.timeOfDay === 'number') setTime(file.timeOfDay);
    invalidateShadows();
    return true;
  }
  if (file?.kind === '3jsbildr-terrain') {
    if (!terrain.load(file)) return false;
    foliage.load(null);
    invalidateShadows();
    return true;
  }
  return false;
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeWorld()));
  } catch {
    // Storage can be full or unavailable; the world still lives in memory.
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not worth interrupting anyone over.
  }
}

function restore(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? loadWorld(JSON.parse(raw)) : false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- history

function remember(snapshot: Snapshot): void {
  undoStack.push(snapshot);
  const bytes = () => undoStack.reduce((sum, s) => sum + s.terrain.heights.byteLength, 0);
  while (undoStack.length > 1 && (undoStack.length > HISTORY_LIMIT || bytes() > HISTORY_BYTES)) undoStack.shift();
  redoStack.length = 0;
  refreshHud();
}

function stepHistory(from: Snapshot[], to: Snapshot[]): void {
  if (drag === 'stroke') return;
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(takeSnapshot());
  applySnapshot(snapshot);
  save();
  refreshHud();
}

const undo = () => stepHistory(undoStack, redoStack);
const redo = () => stepHistory(redoStack, undoStack);

// ---------------------------------------------------------------- HUD

const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#rail button[data-tool]'));
const plantButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#plants button[data-plant]'));
const radiusInput = $<HTMLInputElement>('radius');
const strengthInput = $<HTMLInputElement>('strength');
const timeInput = $<HTMLInputElement>('time');
const toastEl = $('toast');
let toastTimer = 0;

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function setTool(tool: Tool): void {
  brush.tool = tool;
  for (const button of toolButtons) button.classList.toggle('active', button.dataset.tool === tool);
  document.body.classList.toggle('planting', tool === 'plant');
  $('strength-label').textContent = tool === 'plant' ? 'Density' : 'Strength';
}

function setPlant(choice: PlantChoice): void {
  brush.plant = choice;
  for (const button of plantButtons) button.classList.toggle('active', button.dataset.plant === choice);
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

function setTime(value: number): void {
  atmosphere.setTime(value);
  invalidateShadows();
  timeInput.value = String(atmosphere.time);
  $('time-name').textContent = atmosphere.label;
}

function setMiniature(on: boolean): void {
  settings.miniature = on;
  $('miniature').classList.toggle('on', on);
  saveSettings();
}

function setStats(on: boolean): void {
  settings.stats = on;
  $('stats').classList.toggle('on', on);
  document.body.classList.toggle('stats', on);
  saveSettings();
}

/** Push the performance settings into the renderer and the panel's controls. */
function applyPerformance(): void {
  settings.thinStart = clamp(settings.thinStart, 20, 400);
  settings.thinAmount = clamp(settings.thinAmount, 0, 0.95);
  renderer.shadowMap.autoUpdate = !settings.cachedShadows;
  invalidateShadows();
  foliage.options.culling = settings.culling;
  foliage.options.thinStart = settings.thinStart;
  foliage.options.thinAmount = settings.thinAmount;

  $<HTMLInputElement>('opt-shadows').checked = settings.cachedShadows;
  $<HTMLInputElement>('opt-culling').checked = settings.culling;
  $<HTMLInputElement>('opt-thin-start').value = String(settings.thinStart);
  $<HTMLInputElement>('opt-thin-amount').value = String(settings.thinAmount);
  $('opt-thin-start-out').textContent = String(Math.round(settings.thinStart));
  $('opt-thin-amount-out').textContent = settings.thinAmount ? `${Math.round(settings.thinAmount * 100)}%` : 'off';
  saveSettings();
}

function setExplore(on: boolean): void {
  explore = on;
  document.body.classList.toggle('explore', on);
  if (on) cursor.hide();
}

function refreshHud(): void {
  $<HTMLButtonElement>('undo').disabled = undoStack.length === 0;
  $<HTMLButtonElement>('redo').disabled = redoStack.length === 0;
  const count = foliage.count;
  $('plant-count').textContent = count ? `${count.toLocaleString()} plant${count === 1 ? '' : 's'}` : '';
}

for (const button of toolButtons) button.addEventListener('click', () => setTool(button.dataset.tool as Tool));
for (const button of plantButtons) button.addEventListener('click', () => setPlant(button.dataset.plant as PlantChoice));

radiusInput.min = String(BRUSH_LIMITS.radius.min);
radiusInput.max = String(BRUSH_LIMITS.radius.max);
strengthInput.min = String(BRUSH_LIMITS.strength.min);
strengthInput.max = String(BRUSH_LIMITS.strength.max);
radiusInput.addEventListener('input', () => setRadius(Number(radiusInput.value)));
strengthInput.addEventListener('input', () => setStrength(Number(strengthInput.value)));
timeInput.addEventListener('input', () => setTime(Number(timeInput.value)));
timeInput.addEventListener('change', save);
// Hand the keyboard back to the view after using a control.
for (const el of document.querySelectorAll<HTMLElement>('#hud button, #hud input')) {
  el.addEventListener('pointerup', () => el.blur());
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('explore').addEventListener('click', () => setExplore(true));
$('miniature').addEventListener('click', () => setMiniature(!settings.miniature));
$('stats').addEventListener('click', () => setStats(!settings.stats));

$<HTMLInputElement>('opt-shadows').addEventListener('change', (event) => {
  settings.cachedShadows = (event.target as HTMLInputElement).checked;
  applyPerformance();
});
$<HTMLInputElement>('opt-culling').addEventListener('change', (event) => {
  settings.culling = (event.target as HTMLInputElement).checked;
  applyPerformance();
});
$<HTMLInputElement>('opt-thin-start').addEventListener('input', (event) => {
  settings.thinStart = Number((event.target as HTMLInputElement).value);
  applyPerformance();
});
$<HTMLInputElement>('opt-thin-amount').addEventListener('input', (event) => {
  settings.thinAmount = Number((event.target as HTMLInputElement).value);
  applyPerformance();
});

$('new').addEventListener('click', () => {
  remember(takeSnapshot());
  terrain.generate(Math.floor(Math.random() * 1e9));
  foliage.restore([]);
  invalidateShadows();
  save();
  refreshHud();
  toast('Fresh land. Undo brings the old one back.');
});

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(serializeWorld())], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'world.json';
  link.click();
  URL.revokeObjectURL(link.href);
});

const fileInput = $<HTMLInputElement>('file');
$('import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  const before = takeSnapshot();
  let ok = false;
  try {
    ok = loadWorld(JSON.parse(await file.text()));
  } catch {
    ok = false;
  }
  if (ok) {
    remember(before);
    save();
    toast(`Loaded ${file.name}`);
  } else {
    applySnapshot(before);
    toast("That file isn't a world this editor can read.");
  }
  refreshHud();
});

// ---------------------------------------------------------------- start-up

try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
  const target = settings as Record<string, boolean | number>;
  for (const key of Object.keys(target)) {
    if (typeof saved[key] === typeof target[key]) target[key] = saved[key] as boolean | number;
  }
} catch {
  // Fall back to defaults.
}

setTime(atmosphere.time);
if (!restore()) terrain.generate(1);

setTool(brush.tool);
setPlant(brush.plant);
setRadius(brush.radius);
setStrength(brush.strength);
$('miniature').classList.toggle('on', settings.miniature);
setStats(settings.stats);
applyPerformance();
refreshHud();

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

/** Is the cursor over an empty space where a tile could be added? Fills `slot` if so. */
function pickSlot(): boolean {
  raycaster.setFromCamera(pointer, rig.camera);
  const { origin, direction } = raycaster.ray;
  if (direction.y > -1e-4) return false;
  const t = (WATER_LEVEL - origin.y) / direction.y;
  if (t <= 0) return false;
  const [tx, tz] = terrain.tileAt(origin.x + direction.x * t, origin.z + direction.z * t);
  if (!terrain.canAddTile(tx, tz)) return false;
  slot.tx = tx;
  slot.tz = tz;
  return true;
}

function addLand(tx: number, tz: number): void {
  const before = takeSnapshot();
  if (!terrain.addTile(tx, tz, Math.floor(Math.random() * 1e9))) return;
  remember(before);
  save();
  const count = terrain.tileCount;
  toast(count >= MAX_TILES ? `New land added. That's the limit of ${MAX_TILES}.` : 'New land added. Undo removes it.');
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
    setDrag('stroke');
    strokeStart = takeSnapshot();
    strokeChanged = false;
    flattenTarget = hit.y;
  } else if (primary && !explore && pickSlot()) {
    addLand(slot.tx, slot.tz);
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
  if (drag === 'stroke' && strokeStart) {
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
  const repeats = ['BracketLeft', 'BracketRight', 'Minus', 'Equal', 'Comma', 'Period'];
  if (event.repeat && !repeats.includes(event.code)) return;

  switch (event.code) {
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4':
    case 'Digit5':
    case 'Digit6':
      setTool(TOOLS[Number(event.code.slice(5)) - 1]);
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
    case 'Comma':
      setTime(atmosphere.time - 0.02);
      save();
      break;
    case 'Period':
      setTime(atmosphere.time + 0.02);
      save();
      break;
    case 'KeyB':
      setMiniature(!settings.miniature);
      break;
    case 'KeyP':
      setStats(!settings.stats);
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

// ---------------------------------------------------------------- frame loop

const perf = new PerfMeter(renderer, {
  fps: $('perf-fps'),
  times: $('perf-times'),
  detail: $('perf-detail'),
  graph: $<HTMLCanvasElement>('perf-graph'),
});
const altitudeDot = $('altitude-dot');
const held = (...codes: string[]) => codes.some((code) => keys.has(code));
const REVERSE: Partial<Record<Tool, Tool>> = { raise: 'lower', lower: 'raise', plant: 'clear', clear: 'plant' };
let last = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  perf.begin(now);

  const forward = Number(held('KeyW', 'ArrowUp')) - Number(held('KeyS', 'ArrowDown'));
  const right = Number(held('KeyD', 'ArrowRight')) - Number(held('KeyA', 'ArrowLeft'));
  if (forward || right) rig.move(forward, right, dt, held('ShiftLeft', 'ShiftRight'));
  const turn = Number(held('KeyE')) - Number(held('KeyQ'));
  if (turn) rig.turn(turn, dt);

  rig.update(dt);

  // Brush: work while held, and keep the ring under the cursor.
  const shift = held('ShiftLeft', 'ShiftRight');
  const tool = (shift && REVERSE[brush.tool]) || brush.tool;
  const stroking = drag === 'stroke' && strokeStart !== null;
  const showBrush = !explore && (stroking || (drag === 'none' && pointerOverView));
  let onLand = false;
  if (showBrush) {
    // While raising or lowering, aim at the surface as it was when the stroke
    // began. Otherwise the hill grows towards the camera and drags the brush with it.
    const aimAtSnapshot = stroking && (tool === 'raise' || tool === 'lower');
    if (pick(aimAtSnapshot ? strokeStart!.terrain.heights : undefined)) {
      onLand = true;
      if (stroking) {
        if (tool === 'plant') {
          if (foliage.paint(brush.plant, hit.x, hit.z, brush.radius, brush.strength, dt)) strokeChanged = true;
        } else if (tool === 'clear') {
          if (foliage.erase(hit.x, hit.z, brush.radius)) strokeChanged = true;
        } else {
          applyBrush(terrain, tool as BrushKind, hit.x, hit.z, brush.radius, brush.strength, dt, flattenTarget);
          foliage.refresh(hit.x, hit.z, brush.radius); // plants ride the ground as it moves
          invalidateShadows();
          strokeChanged = true;
        }
        if (strokeChanged) refreshHud();
      }
      const range = rig.camera.position.distanceTo(hit);
      const perPixel = (2 * range * Math.tan(THREE.MathUtils.degToRad(rig.camera.fov) / 2)) / canvas.clientHeight;
      cursor.update(hit.x, hit.z, brush.radius, clamp(perPixel * 3, 0.05, 2), tool);
    } else {
      cursor.hide();
    }
  } else {
    cursor.hide();
  }

  // Off the edge of the land, offer the empty space beside it as a place to add more.
  const offering = showBrush && !stroking && !onLand && pickSlot();
  if (offering) ghost.show(slot.tx, slot.tz, now / 1000);
  else ghost.hide();
  document.body.classList.toggle('offering', offering);

  atmosphere.update(rig.camera, rig.zoom);
  foliage.update(dt, rig.camera);
  clouds.group.rotation.y += dt * 0.012;
  altitudeDot.style.top = `${rig.zoom * 100}%`;

  // Miniature blur: strongest from the table, gone by the time you reach the ground.
  // The sharp band sits wherever the camera's pivot lands on screen.
  projected.copy(rig.pivot).project(rig.camera);
  const focus = clamp((projected.y + 1) / 2, 0.25, 0.75);
  perf.gpuBegin();
  post.render(settings.miniature ? (1 - rig.zoom) ** 1.5 : 0, focus);
  perf.gpuEnd();
  perf.end(settings.stats, foliage.drawn, foliage.count);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Handy from the browser console: bildr.rig.goTo({ zoom: 1, x: 10, z: -5 })
Object.assign(window, { bildr: { rig, terrain, foliage, atmosphere, brush, settings, scene, renderer, setTime } });

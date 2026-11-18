import type * as THREE from 'three';

const HISTORY = 138; // frames shown in the graph, one per 2px column
const GRAPH_CEILING = 40; // ms at the top of the graph

/**
 * Frame-time readout. Call `begin` at the top of each frame, wrap the render in
 * `gpuBegin`/`gpuEnd`, and call `end` with whatever extra facts are worth showing.
 *
 * - "frame" is the gap between frames. It can't drop below the display's
 *   refresh interval, so it shows trouble but not headroom.
 * - "cpu" is time spent in script, including handing draw calls to the driver.
 * - "gpu" is how long the graphics card took, where the browser exposes it.
 */
export class PerfMeter {
  private readonly frames = new Float32Array(HISTORY);
  private head = 0;
  private lastNow = 0;
  private startedAt = 0;
  private cpu = 0;
  private gpu = -1;
  private sinceText = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private activeQuery: WebGLQuery | null = null;
  private pendingQuery: WebGLQuery | null = null;

  private readonly graph: CanvasRenderingContext2D | null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly els: { fps: HTMLElement; times: HTMLElement; detail: HTMLElement; graph: HTMLCanvasElement },
  ) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.timer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.graph = els.graph.getContext('2d');
    // Count draw calls across the whole frame (shadow pass and post passes included).
    renderer.info.autoReset = false;
  }

  begin(now: number): void {
    if (this.lastNow) {
      this.frames[this.head] = now - this.lastNow;
      this.head = (this.head + 1) % HISTORY;
    }
    this.lastNow = now;
    this.startedAt = performance.now();
    this.renderer.info.reset();
    this.collectGpu();
  }

  gpuBegin(): void {
    if (!this.timer || this.pendingQuery || this.activeQuery) return;
    this.activeQuery = this.gl.createQuery();
    if (this.activeQuery) this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.activeQuery);
  }

  gpuEnd(): void {
    if (!this.timer || !this.activeQuery) return;
    this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    this.pendingQuery = this.activeQuery;
    this.activeQuery = null;
  }

  /** `visible` skips the DOM work when the panel is closed. */
  end(visible: boolean, plantsDrawn: number, plantsTotal: number): void {
    const cpu = performance.now() - this.startedAt;
    this.cpu += (cpu - this.cpu) * 0.1;
    if (!visible) return;

    this.drawGraph();
    const now = performance.now();
    if (now - this.sinceText < 250) return;
    this.sinceText = now;

    let sum = 0;
    let worst = 0;
    let n = 0;
    for (const ms of this.frames) {
      if (!ms) continue;
      sum += ms;
      worst = Math.max(worst, ms);
      n++;
    }
    const average = n ? sum / n : 0;
    const info = this.renderer.info.render;
    const { els } = this;
    els.fps.textContent = average ? String(Math.round(1000 / average)) : '–';
    els.times.textContent =
      `${average.toFixed(1)} ms · worst ${worst.toFixed(0)} · cpu ${this.cpu.toFixed(1)}` +
      (this.gpu >= 0 ? ` · gpu ${this.gpu.toFixed(1)}` : '');
    els.detail.textContent =
      `${info.calls} draws · ${compact(info.triangles)} triangles · ` +
      `${plantsDrawn.toLocaleString()} of ${plantsTotal.toLocaleString()} plants`;
  }

  private collectGpu(): void {
    if (!this.timer || !this.pendingQuery) return;
    const gl = this.gl;
    if (!gl.getQueryParameter(this.pendingQuery, gl.QUERY_RESULT_AVAILABLE)) return;
    const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    if (!disjoint) {
      const ms = gl.getQueryParameter(this.pendingQuery, gl.QUERY_RESULT) / 1e6;
      this.gpu = this.gpu < 0 ? ms : this.gpu + (ms - this.gpu) * 0.2;
    }
    gl.deleteQuery(this.pendingQuery);
    this.pendingQuery = null;
  }

  private drawGraph(): void {
    const g = this.graph;
    if (!g) return;
    const { width, height } = this.els.graph;
    g.clearRect(0, 0, width, height);
    const column = width / HISTORY;
    for (let i = 0; i < HISTORY; i++) {
      const ms = this.frames[(this.head + i) % HISTORY];
      if (!ms) continue;
      const h = Math.min(1, ms / GRAPH_CEILING) * height;
      g.fillStyle = ms > 34 ? '#ff6b6b' : ms > 18 ? '#ffd23f' : '#8dff6a';
      g.fillRect(i * column, height - h, Math.max(1, column - 0.5), h);
    }
    // Guide line at 60 frames a second.
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(0, height - (16.7 / GRAPH_CEILING) * height, width, 1);
  }
}

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

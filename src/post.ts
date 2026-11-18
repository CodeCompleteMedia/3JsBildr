import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// One direction of a blur that grows with distance from a horizontal focus line.
// Sharp in a band around the line, soft towards the top and bottom of the frame,
// which is what makes a real scene photographed up close look like a miniature.
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    uStep: { value: new THREE.Vector2() },
    uFocus: { value: 0.5 },
    uBand: { value: 0.2 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uStep;
    uniform float uFocus;
    uniform float uBand;
    varying vec2 vUv;
    void main() {
      float amount = smoothstep(uBand, uBand + 0.4, abs(vUv.y - uFocus));
      vec2 o = uStep * amount;
      vec4 c = texture2D(tDiffuse, vUv) * 0.227027;
      c += (texture2D(tDiffuse, vUv + o * 1.384615) + texture2D(tDiffuse, vUv - o * 1.384615)) * 0.316216;
      c += (texture2D(tDiffuse, vUv + o * 3.230769) + texture2D(tDiffuse, vUv - o * 3.230769)) * 0.070270;
      gl_FragColor = c;
    }
  `,
};

/** Renders the scene through an anti-aliased buffer and adds the miniature blur. */
export class Post {
  private readonly composer: EffectComposer;
  private readonly blurs: { pass: ShaderPass; horizontal: boolean; spread: number }[] = [];
  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    // Two rounds at different spreads give a smooth blur from few samples.
    for (const [horizontal, spread] of [[true, 0.8], [false, 0.8], [true, 1.8], [false, 1.8]] as const) {
      const pass = new ShaderPass(TiltShiftShader);
      this.composer.addPass(pass);
      this.blurs.push({ pass, horizontal, spread });
    }
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.pixelRatio = pixelRatio;
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));
    this.composer.setSize(this.width, this.height);
  }

  /**
   * @param strength 0 (no blur) to 1 (full miniature look)
   * @param focus height of the sharp band on screen, 0 at the bottom to 1 at the top
   */
  render(strength: number, focus: number): void {
    const on = strength > 0.02;
    for (const { pass, horizontal, spread } of this.blurs) {
      pass.enabled = on;
      if (!on) continue;
      const reach = strength * spread * this.pixelRatio;
      pass.uniforms.uStep.value.set(horizontal ? reach / this.width : 0, horizontal ? 0 : reach / this.height);
      pass.uniforms.uFocus.value = focus;
    }
    this.composer.render();
  }
}

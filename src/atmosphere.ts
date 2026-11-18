import * as THREE from 'three';
import { WORLD_SIZE } from './terrain';

const DEG = Math.PI / 180;

interface Moment {
  at: number; // position on the time strip, 0..1
  name: string;
  skyTop: number;
  skyHorizon: number;
  skyBottom: number;
  sun: number; // colour of the sun (or moon) and its light
  sunPower: number;
  fillSky: number; // hemisphere light from above
  fillGround: number; // ...and bounced from below
  fillPower: number;
  elevation: number; // degrees above the horizon
  azimuth: number; // degrees around the diorama
}

// The day, as a handful of looks. Everything between them is blended.
const MOMENTS: Moment[] = [
  {
    at: 0, name: 'Dawn',
    skyTop: 0x5b7fd6, skyHorizon: 0xffb199, skyBottom: 0xf5c4b4,
    sun: 0xffc59a, sunPower: 2.3, fillSky: 0xcfd8ff, fillGround: 0xf2b08a, fillPower: 1.15,
    elevation: 17, azimuth: -95,
  },
  {
    at: 0.22, name: 'Morning',
    skyTop: 0x38a3f5, skyHorizon: 0xffe6bf, skyBottom: 0x86d8f2,
    sun: 0xfff1d6, sunPower: 3.0, fillSky: 0xdff2ff, fillGround: 0xf7c88a, fillPower: 1.15,
    elevation: 40, azimuth: -55,
  },
  {
    at: 0.5, name: 'Midday',
    skyTop: 0x2f8ff0, skyHorizon: 0xcfeeff, skyBottom: 0x8fdcf5,
    sun: 0xffffff, sunPower: 3.2, fillSky: 0xe6f4ff, fillGround: 0xf0d9a8, fillPower: 1.25,
    elevation: 70, azimuth: 0,
  },
  {
    at: 0.76, name: 'Golden hour',
    skyTop: 0x5a7fd9, skyHorizon: 0xffc27a, skyBottom: 0xf3b089,
    sun: 0xffb26b, sunPower: 2.9, fillSky: 0xd9d2ff, fillGround: 0xf0a070, fillPower: 0.95,
    elevation: 22, azimuth: 70,
  },
  {
    at: 0.9, name: 'Dusk',
    skyTop: 0x3a3f9a, skyHorizon: 0xff8f7a, skyBottom: 0xa86aa8,
    sun: 0xff8a66, sunPower: 2.1, fillSky: 0xb8b0ff, fillGround: 0xb06a8a, fillPower: 1.05,
    elevation: 14, azimuth: 100,
  },
  {
    at: 1, name: 'Night',
    skyTop: 0x141a4a, skyHorizon: 0x3b3f8c, skyBottom: 0x2a2f6e,
    sun: 0xb9c8ff, sunPower: 1.2, fillSky: 0x6f7fe0, fillGround: 0x2a2f6e, fillPower: 0.8,
    elevation: 50, azimuth: 150,
  },
];

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 color = d.y >= 0.0
      ? mix(uHorizon, uTop, pow(max(d.y, 0.0), 0.55))
      : mix(uHorizon, uBottom, pow(max(-d.y, 0.0), 0.6));
    float facing = dot(d, uSunDir);
    color += uSunColor * pow(max(facing, 0.0), 28.0) * 0.3; // glow
    color = mix(color, uSunColor * 1.15, smoothstep(0.9986, 0.999, facing)); // disc
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Sky, sun, fill light and haze, all driven by one time-of-day value. */
export class Atmosphere {
  readonly sky: THREE.Mesh;
  readonly lights = new THREE.Group();
  readonly fog = new THREE.FogExp2(0xffffff, 0);
  time = 0.22;

  private readonly sun: THREE.DirectionalLight;
  private readonly fill: THREE.HemisphereLight;
  private readonly uniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
  };
  private readonly a = new THREE.Color();
  private readonly b = new THREE.Color();

  constructor(private readonly cloudMaterial?: THREE.MeshStandardMaterial) {
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1500, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;

    this.fill = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const reach = WORLD_SIZE * 0.82;
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -reach;
    shadowCamera.right = reach;
    shadowCamera.top = reach;
    shadowCamera.bottom = -reach;
    shadowCamera.near = 20;
    shadowCamera.far = 460;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.radius = 1.2;
    this.lights.add(this.fill, this.sun, this.sun.target);

    this.setTime(this.time);
  }

  /** Name of the nearest look, for the HUD. */
  get label(): string {
    let best = MOMENTS[0];
    for (const m of MOMENTS) if (Math.abs(m.at - this.time) < Math.abs(best.at - this.time)) best = m;
    return best.name;
  }

  setTime(time: number): void {
    this.time = Math.min(1, Math.max(0, time));
    let i = 0;
    while (i < MOMENTS.length - 2 && this.time > MOMENTS[i + 1].at) i++;
    const from = MOMENTS[i];
    const to = MOMENTS[i + 1];
    const t = (this.time - from.at) / (to.at - from.at);
    const num = (a: number, b: number) => a + (b - a) * t;
    const mix = (target: THREE.Color, a: number, b: number) => target.copy(this.a.setHex(a)).lerp(this.b.setHex(b), t);

    const u = this.uniforms;
    mix(u.uTop.value, from.skyTop, to.skyTop);
    mix(u.uHorizon.value, from.skyHorizon, to.skyHorizon);
    mix(u.uBottom.value, from.skyBottom, to.skyBottom);
    mix(u.uSunColor.value, from.sun, to.sun);

    const elevation = num(from.elevation, to.elevation) * DEG;
    const azimuth = num(from.azimuth, to.azimuth) * DEG;
    u.uSunDir.value.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );

    this.sun.color.copy(u.uSunColor.value);
    this.sun.intensity = num(from.sunPower, to.sunPower);
    this.sun.position.copy(u.uSunDir.value).multiplyScalar(260);
    mix(this.fill.color, from.fillSky, to.fillSky);
    mix(this.fill.groundColor, from.fillGround, to.fillGround);
    this.fill.intensity = num(from.fillPower, to.fillPower);

    this.fog.color.copy(u.uHorizon.value);
    if (this.cloudMaterial) {
      // Clouds pick up some of the horizon colour so they belong to the sky.
      this.cloudMaterial.emissive.copy(u.uHorizon.value).lerp(this.a.setHex(0xffffff), 0.45);
    }
  }

  /** Call every frame: the sky follows the camera, and haze thickens near the ground. */
  update(camera: THREE.Camera, zoom: number): void {
    this.sky.position.copy(camera.position);
    this.fog.density = 0.011 * zoom ** 3;
  }
}

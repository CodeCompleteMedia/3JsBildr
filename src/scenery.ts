import * as THREE from 'three';
import { palette } from './palette';
import { BASE_Y, WATER_LEVEL, WORLD_SIZE } from './terrain';

/** A gradient dome that follows the camera. */
export function createSky(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(1500, 32, 16);
  const top = new THREE.Color(palette.skyTop);
  const horizon = new THREE.Color(palette.skyHorizon);
  const bottom = new THREE.Color(palette.skyBottom);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const t = position.getY(i) / 1500;
    if (t >= 0) c.copy(horizon).lerp(top, Math.pow(t, 0.55));
    else c.copy(horizon).lerp(bottom, Math.pow(-t, 0.6));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

/** Warm sun with soft shadows plus sky/bounce fill. */
export function createLights(): THREE.Group {
  const group = new THREE.Group();

  group.add(new THREE.HemisphereLight(palette.skyLight, palette.bounceLight, 1.15));

  const sun = new THREE.DirectionalLight(palette.sun, 3.0);
  sun.position.set(150, 150, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const reach = WORLD_SIZE * 0.82;
  sun.shadow.camera.left = -reach;
  sun.shadow.camera.right = reach;
  sun.shadow.camera.top = reach;
  sun.shadow.camera.bottom = -reach;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 420;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.35;
  sun.shadow.radius = 3;
  group.add(sun, sun.target);

  return group;
}

/** A block of water filling the slab up to the water line. */
export function createWater(): THREE.Mesh {
  const depth = WATER_LEVEL - BASE_Y - 0.05;
  const water = new THREE.Mesh(
    new THREE.BoxGeometry(WORLD_SIZE - 0.3, depth, WORLD_SIZE - 0.3),
    new THREE.MeshStandardMaterial({
      color: palette.water,
      transparent: true,
      opacity: 0.78,
      roughness: 0.3,
      metalness: 0,
      depthWrite: false,
    }),
  );
  water.position.y = WATER_LEVEL - depth / 2;
  water.receiveShadow = true;
  return water;
}

/** Chunky clouds drifting in a ring around the diorama. */
export function createClouds(count = 11): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: palette.cloud,
    emissive: palette.cloud,
    emissiveIntensity: 0.45,
    flatShading: true,
    roughness: 1,
    fog: false,
  });
  const puff = new THREE.IcosahedronGeometry(1, 0);
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < count; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(rand() * 3);
    for (let p = 0; p < puffs; p++) {
      const mesh = new THREE.Mesh(puff, material);
      const size = 5 + rand() * 6;
      mesh.scale.set(size * 1.25, size * 0.7, size);
      mesh.position.set((p - (puffs - 1) / 2) * 7 + rand() * 2, rand() * 2.5, rand() * 5 - 2.5);
      mesh.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      cloud.add(mesh);
    }
    const angle = (i / count) * Math.PI * 2 + rand() * 0.4;
    const radius = 115 + rand() * 120;
    cloud.position.set(Math.cos(angle) * radius, 24 + rand() * 34, Math.sin(angle) * radius);
    cloud.rotation.y = rand() * Math.PI;
    group.add(cloud);
  }
  return group;
}

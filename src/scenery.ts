import * as THREE from 'three';
import { palette } from './palette';

/** Chunky clouds drifting in a ring around the diorama. `material` is shared so the sky can tint it. */
export function createClouds(count = 11): { group: THREE.Group; material: THREE.MeshStandardMaterial } {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: palette.cloud,
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
  return { group, material };
}

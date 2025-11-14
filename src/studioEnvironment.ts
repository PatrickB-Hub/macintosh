import * as THREE from "three";

/** Soft window reflections coordinated with the room's left-hand key light. */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  const emissive = (hex: number, k: number) =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide });

  const room = new THREE.Mesh(new THREE.BoxGeometry(12, 8, 12), emissive(0xf2efea, 0.75));
  room.geometry.translate(0, 3.6, 0);
  (room.material as THREE.MeshBasicMaterial).side = THREE.BackSide;
  env.add(room);

  const panel = (w: number, h: number, k: number, pos: [number, number, number], look: [number, number, number]) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), emissive(0xfffaf2, k));
    p.position.set(...pos);
    p.lookAt(...look);
    env.add(p);
  };
  panel(6, 6, 1.8, [0, 5, 0.5], [0, 0, 0.5]); // overhead softbox
  panel(5, 4, 4.0, [-4.5, 1.8, 0.8], [0, 0.6, 0]); // large window on the left
  panel(4, 0.9, 2.4, [0.2, 1.7, 3.2], [0, 0.2, 0]); // front/overhead strip -> CRT reflection band

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), emissive(0xf4f3f0, 0.9));
  floor.rotation.x = -Math.PI / 2;
  env.add(floor);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.02).texture;
  pmrem.dispose();
  return texture;
}

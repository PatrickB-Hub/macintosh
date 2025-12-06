import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// Solved 3x3 cube. Visible in the reference: +Y yellow, +Z blue, +X red.
// Hidden (from the user): -Y white, -Z green, -X orange.
export const RUBIKS_FACE_COLORS = {
  px: 0xc8161d, nx: 0xff6a00, py: 0xffd400, ny: 0xf4f4f4, pz: 0x0a5fd6, nz: 0x009b48,
} as const;

type Face = keyof typeof RUBIKS_FACE_COLORS;

// Sticker plane lies in XY facing +Z; these rotate it onto each face.
const FACES: { face: Face; axis: 0 | 1 | 2; sign: 1 | -1; rot: [number, number, number] }[] = [
  { face: 'px', axis: 0, sign: 1, rot: [0, Math.PI / 2, 0] },
  { face: 'nx', axis: 0, sign: -1, rot: [0, -Math.PI / 2, 0] },
  { face: 'py', axis: 1, sign: 1, rot: [-Math.PI / 2, 0, 0] },
  { face: 'ny', axis: 1, sign: -1, rot: [Math.PI / 2, 0, 0] },
  { face: 'pz', axis: 2, sign: 1, rot: [0, 0, 0] },
  { face: 'nz', axis: 2, sign: -1, rot: [0, Math.PI, 0] },
];

function roundedSquare(size: number, radius: number): THREE.ShapeGeometry {
  const h = size / 2;
  const s = new THREE.Shape();
  s.moveTo(-h + radius, -h);
  s.lineTo(h - radius, -h);
  s.quadraticCurveTo(h, -h, h, -h + radius);
  s.lineTo(h, h - radius);
  s.quadraticCurveTo(h, h, h - radius, h);
  s.lineTo(-h + radius, h);
  s.quadraticCurveTo(-h, h, -h, h - radius);
  s.lineTo(-h, -h + radius);
  s.quadraticCurveTo(-h, -h, -h + radius, -h);
  return new THREE.ShapeGeometry(s, 6);
}

/** Units: 1 = one cubie (~1.9 cm). Cube is centred on the origin. */
export function createRubiksCubeModel(options: { gap?: number } = {}): THREE.Group {
  const gap = options.gap ?? 0.012;
  const pitch = 1 + gap;

  const body = new THREE.MeshPhysicalMaterial({ color: 0x0b0b0b, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const stickerMats = Object.fromEntries(
    Object.entries(RUBIKS_FACE_COLORS).map(([f, c]) => [f, new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, clearcoat: 0.4 })]),
  ) as Record<Face, THREE.MeshPhysicalMaterial>;
  const cubieGeo = new RoundedBoxGeometry(1, 1, 1, 3, 0.09);
  const stickerGeo = roundedSquare(0.85, 0.07);

  const root = new THREE.Group();
  root.name = 'rubiks-cube';

  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    const grid = [x, y, z];
    const cubie = new THREE.Group();
    cubie.name = `cubie_${x}_${y}_${z}`;
    cubie.position.set(x * pitch, y * pitch, z * pitch);
    cubie.userData = { part: 'cubie', grid, basePosition: cubie.position.clone(), clickable: true };

    const core = new THREE.Mesh(cubieGeo, body);
    core.name = `${cubie.name}_body`;
    cubie.add(core);

    for (const { face, axis, sign, rot } of FACES) {
      if (grid[axis] !== sign) continue;
      const sticker = new THREE.Mesh(stickerGeo, stickerMats[face]);
      sticker.name = `${cubie.name}_sticker_${face}`;
      sticker.userData = { part: 'sticker', face };
      sticker.rotation.set(...rot);
      sticker.position.setComponent(axis, sign * 0.502);
      cubie.add(sticker);
    }
    root.add(cubie);
  }
  return root;
}

/** Explode view: t=0 assembled, t=1 cubies pushed out by one extra pitch. */
export function setRubiksExplode(model: THREE.Group, t: number): void {
  for (const c of model.children) {
    const base = c.userData.basePosition as THREE.Vector3;
    c.position.copy(base).multiplyScalar(1 + t);
  }
}

/**
 * Desk physics for the mouse
 */
import * as THREE from "three";

export function rectHitsBox(cx: number, cz: number, hw: number, hd: number, yaw: number, box: THREE.Box3): boolean {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const c = Math.abs(cs);
  const s = Math.abs(sn);
  const bw = (box.max.x - box.min.x) / 2;
  const bd = (box.max.z - box.min.z) / 2;
  const dx = (box.max.x + box.min.x) / 2 - cx;
  const dz = (box.max.z + box.min.z) / 2 - cz;
  return (
    Math.abs(dx) <= bw + hw * c + hd * s &&
    Math.abs(dz) <= bd + hw * s + hd * c &&
    Math.abs(dx * cs - dz * sn) <= hw + bw * c + bd * s &&
    Math.abs(dx * sn + dz * cs) <= hd + bw * s + bd * c
  );
}

const N = 40; // rope points
const ITERATIONS = 24;
const GRAVITY = 9.81 / 60 / 60; // m per step², one step per rendered frame (~60 Hz)
const DAMPING = 0.98; // velocity kept per step in the air
const FLOOR_FRICTION = 0.6; // velocity kept per step while sliding on the desk
const MIN_BEND = 1.85; // points i and i+2 stay >= 1.85 segments apart

export function createCable(mesh: THREE.Mesh, path: THREE.Vector3[], radius: number, obstacles: THREE.Box3[]) {
  const curve = new THREE.CatmullRomCurve3(path);
  const length = curve.getLength();
  const seg = length / (N - 1);
  const p = curve.getSpacedPoints(N - 1);
  const prev = p.map((v) => v.clone());
  const d = new THREE.Vector3();
  const free = (i: number) => +(i >= 2 && i < N - 1);
  let asleep = false;

  function constrain(i: number, j: number, rest: number, pushOnly: boolean) {
    d.subVectors(p[j], p[i]);
    const len = d.length();
    const wi = free(i);
    const wj = free(j);
    if (len < 1e-9 || (pushOnly && len >= rest) || !(wi + wj)) return;
    d.multiplyScalar((len - rest) / len / (wi + wj));
    p[i].addScaledVector(d, wi);
    p[j].addScaledVector(d, -wj);
  }

  function collide(i: number) {
    const q = p[i];
    q.y = Math.max(q.y, radius);
    if (i < 4 || i > N - 6) return; // the ends sit in the mouse and inside the Mac
    for (const b of obstacles) {
      const x0 = q.x - b.min.x + radius;
      const x1 = b.max.x + radius - q.x;
      const z0 = q.z - b.min.z + radius;
      const z1 = b.max.z + radius - q.z;
      if (x0 <= 0 || x1 <= 0 || z0 <= 0 || z1 <= 0 || q.y >= b.max.y + radius) continue;
      const m = Math.min(x0, x1, z0, z1); // out through the nearest side
      if (m === x0) q.x -= x0;
      else if (m === x1) q.x += x1;
      else if (m === z0) q.z -= z0;
      else q.z += z1;
    }
  }
  function rebuild() {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p), N * 4, radius, 8, false);
  }

  function step(a0: THREE.Vector3, a1: THREE.Vector3) {
    if (asleep && a0.distanceToSquared(p[0]) < 1e-14 && a1.distanceToSquared(p[1]) < 1e-14) return;
    p[0].copy(a0);
    p[1].copy(a1);
    for (let i = 2; i < N - 1; i++) {
      d.subVectors(p[i], prev[i]).multiplyScalar(DAMPING);
      if (p[i].y <= radius + 1e-4) {
        d.x *= FLOOR_FRICTION;
        d.z *= FLOOR_FRICTION;
      }
      prev[i].copy(p[i]);
      p[i].add(d);
      p[i].y -= GRAVITY;
    }
    for (let k = 0; k < ITERATIONS; k++) {
      for (let i = 0; i < N - 1; i++) constrain(i, i + 1, seg, false);
      for (let i = 0; i < N - 2; i++) constrain(i, i + 2, MIN_BEND * seg, true);
      for (let i = 2; i < N - 1; i++) collide(i);
    }
    let motion = 0;
    for (let i = 2; i < N - 1; i++) motion = Math.max(motion, p[i].distanceToSquared(prev[i]));
    asleep = motion < 1e-12;
    rebuild();
  }

  rebuild();
  return { length, points: p, step };
}

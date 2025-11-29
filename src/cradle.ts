/**
 * Newton's cradle: each ball is a pendulum on its V of wires (one swing angle), touching neighbours
 * trade speed in nearly elastic impacts, and the pointer brushing past a ball pushes it along.
 * Physics runs in the model's own centimetres. Cap and wires are children of the ball node and the
 * wires' top ends lie on its suspension axis, so turning the node about that axis swings the hanger.
 */
import * as THREE from "three";
import { createSound, noise, ring } from "./sound.ts";

const GRAVITY = 981; // cm/s²
const STEP = 0.001; // s, fixed: impacts are resolved per step
const RESTITUTION = 0.98; // share of the closing speed an impact gives back. Calibration knob: lower = settles sooner
const AIR = 0.05; // 1/s, swing decay between impacts. Calibration knob.
const PUSH = 1; // share of the cursor's speed a brushed ball takes on. Calibration knob.
const MAX_SPEED = 90; // cm/s at the ball, ~50° swing: a hard flick does not throw a ball over its rail
const TOUCH = 1e-3; // cm: balls closer than this are in contact
const CLACK_VOLUME = 0.12; // gain of a MAX_SPEED impact. Calibration knob.
const CLACK_FROM = 2; // cm/s closing speed: softer touches (a settling row) stay silent

type Runtime = { nodes: Record<string, THREE.Object3D>; meshes: Record<string, THREE.Mesh> };
/** Swing angles (rad, + = towards the next ball) and their rates; rest centres along the row, all in cm. */
export type CradleState = { theta: number[]; omega: number[]; x0: number[]; len: number; radius: number };

/** One fixed step: swing, then let touching balls that close in trade speed until none does. Returns the hardest impact's closing speed (cm/s). */
export function stepCradle(s: CradleState, dt = STEP) {
  const { theta, omega, len } = s;
  const n = theta.length;
  let hardest = 0;
  for (let i = 0; i < n; i++) {
    omega[i] = (omega[i] - (GRAVITY / len) * Math.sin(theta[i]) * dt) * (1 - AIR * dt);
    theta[i] += omega[i] * dt;
  }
  // impacts act on swing rates (equal pendulums, so exact where balls meet near the bottom)
  // and never push overlapping balls apart; a ball sinks at most MAX_SPEED*STEP (0.9 mm) into its
  // neighbour for a step. Add a position correction if balls ever start large-angle pile-ups.
  for (let pass = 0; pass < 4 * n; pass++) {
    let hit = false;
    for (let i = 0; i + 1 < n; i++) {
      const dx = s.x0[i + 1] + len * Math.sin(theta[i + 1]) - s.x0[i] - len * Math.sin(theta[i]);
      const dy = len * (Math.cos(theta[i]) - Math.cos(theta[i + 1]));
      if (omega[i] <= omega[i + 1] || Math.hypot(dx, dy) > 2 * s.radius + TOUCH) continue;
      hardest = Math.max(hardest, (omega[i] - omega[i + 1]) * len);
      const mean = (omega[i] + omega[i + 1]) / 2;
      const half = (RESTITUTION * (omega[i] - omega[i + 1])) / 2;
      omega[i] = mean - half;
      omega[i + 1] = mean + half;
      hit = true;
    }
    if (!hit) break;
  }
  return hardest;
}

export function createCradleSwing(cradle: THREE.Object3D) {
  const { nodes, meshes } = cradle.userData.sculptRuntime as Runtime;
  const ids = [1, 2, 3, 4, 5].map((k) => `ball-${k}`);
  const balls = ids.map((id) => nodes[id]);
  const shells = ids.map((id) => meshes[id]);
  const rest = balls.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }));
  shells[0].geometry.computeBoundingSphere();
  const s: CradleState = {
    theta: ids.map(() => 0),
    omega: ids.map(() => 0),
    x0: rest.map((r) => r.p.x), // the balls' rest turn is about x only, so local x runs along the row
    len: balls[0].userData.actionProfile.pivot.localPosition[1], // suspension axis above the ball centre
    radius: shells[0].geometry.boundingSphere!.radius,
  };

  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const prev = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  let last: { ray: THREE.Ray; t: number } | null = null;
  /** Pointer moved: `ray` from the camera at time t (ms); `nearer` = world distance of whatever it hit first. */
  function brush(ray: THREE.Ray, t: number, nearer = Infinity) {
    const before = last;
    last = { ray: ray.clone(), t };
    raycaster.ray.copy(ray);
    const hit = raycaster.intersectObjects(shells, false)[0];
    const dt = before ? (t - before.t) / 1000 : 0;
    if (!hit || hit.distance > nearer || dt <= 0 || dt > 0.1) return;
    // the cursor's motion across the screen, measured at the ball's depth
    if (!before!.ray.intersectPlane(plane.setFromNormalAndCoplanarPoint(ray.direction, hit.point), prev)) return;
    const i = shells.indexOf(hit.object as THREE.Mesh);
    const parent = balls[i].parent!;
    if (i !== 0 && i !== shells.length - 1) return; // only the outer balls take a push; inner ones still block the cursor
    const moved = parent
      .worldToLocal(hit.point.clone())
      .sub(parent.worldToLocal(prev))
      .applyQuaternion(turn.copy(rest[i].q).invert());
    const rate = THREE.MathUtils.clamp((PUSH * moved.x) / dt, -MAX_SPEED, MAX_SPEED) / s.len;
    if (rate > 0 ? rate > s.omega[i] : rate < s.omega[i]) s.omega[i] = rate; // pushes, never holds back a faster ball
  }

  // A noise tick over two short steel partials, as loud as the impact is hard
  const clackSound = createSound(
    (t) => noise() * Math.exp(-t / 0.002) + 0.5 * (ring(2900, 0.012, t) + 0.6 * ring(4700, 0.012, t)),
    0.08,
  );
  const clack = (speed: number) => {
    if (speed >= CLACK_FROM) clackSound(CLACK_VOLUME * Math.min(1, speed / MAX_SPEED));
  };

  let acc = 0;
  let then = 0;
  const spin = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);
  const off = new THREE.Vector3();
  function update(now: number) {
    acc = Math.min(acc + (then ? (now - then) / 1000 : 0), 0.1); // a hidden tab resumes, it does not fast-forward
    then = now;
    let hardest = 0; // one clack per frame: a strike running down the row is a single sound
    for (; acc >= STEP; acc -= STEP) hardest = Math.max(hardest, stepCradle(s));
    clack(hardest);
    balls.forEach((b, i) => {
      const a = s.theta[i];
      b.quaternion.copy(rest[i].q).multiply(spin.setFromAxisAngle(Z, a));
      b.position
        .copy(off.set(s.len * Math.sin(a), s.len * (1 - Math.cos(a)), 0).applyQuaternion(rest[i].q))
        .add(rest[i].p);
    });
  }

  return { brush, update };
}

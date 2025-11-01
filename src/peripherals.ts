/**
 * Mouse and keyboard
 */
import * as THREE from "three";
import type { Mac } from "./emulator.ts";
import { createCable, rectHitsBox } from "./physics.ts";
import { createSound, noise, ring } from "./sound.ts";

const KEY_TRAVEL = 0.0035; // in m
const BUTTON_TRAVEL = 0.001;
const PX_PER_M = 3500; // ~3.5 Mac pixels per mm of mouse travel
const SPRING = 0.35; // share of the remaining travel a released key covers per frame
const STICKY = new Set(["ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft"]);
const ALIAS: Record<string, string> = { MetaRight: "MetaLeft" };
const KEY_VOLUME = 0.25;
const BUTTON_VOLUME = 0.3;

type Runtime = { nodes: Record<string, THREE.Object3D>; meshes: Record<string, THREE.Mesh> };
type Spring = { home: THREE.Vector3; axis: THREE.Vector3; target: number; t: number };

const within = (o: THREE.Object3D | undefined, n: THREE.Object3D | undefined) => {
  for (let p = o ?? null; p && n; p = p.parent) if (p === n) return true;
  return false;
};

export function createDesk(model: THREE.Object3D, mac: Mac, props: THREE.Object3D[] = []) {
  const { nodes, meshes } = model.userData.sculptRuntime as Runtime;
  model.updateMatrixWorld(true);
  const springs = new Map<THREE.Object3D, Spring>();
  const spring = (o: THREE.Object3D, travel: number) =>
    springs.set(o, {
      home: o.position.clone(),
      axis: new THREE.Vector3(0, -travel, 0).applyQuaternion(o.quaternion),
      target: 0,
      t: 0,
    });
  const push = (o: THREE.Object3D | undefined, down: boolean) => {
    const s = o && springs.get(o);
    if (!s) return;
    s.target = +down;
    if (down) s.t = Math.max(s.t, 0.9); // snaps down, springs back
  };

  // keyboard
  const caps = new Map<string, THREE.Object3D>();
  nodes.keyBlock?.traverse((o) => {
    if (!o.userData.keyCode) return;
    caps.set(o.userData.keyCode, o);
    spring(o, KEY_TRAVEL);
  });
  const keyDown = createSound(
    (t) => 0.5 * noise() * Math.exp(-t / 0.0015) + 0.5 * ring(1500, 0.006, t) + 0.5 * ring(180, 0.025, t),
    0.08,
  );
  const keyUp = createSound((t) => 0.4 * noise() * Math.exp(-t / 0.001) + 0.4 * ring(2200, 0.004, t), 0.03);
  const down = new Set<string>();
  const latched = new Set<string>();
  function press(code: string, isDown: boolean) {
    if (down.has(code) === isDown) return;
    if (isDown) down.add(code);
    else {
      down.delete(code);
      latched.delete(code);
    }
    mac.key(code, isDown);
    push(caps.get(ALIAS[code] ?? code), isDown);
    if (isDown) keyDown(KEY_VOLUME);
    else keyUp(KEY_VOLUME / 2);
  }
  function releaseAll() {
    for (const code of [...down]) press(code, false);
  }
  addEventListener("blur", releaseAll);

  function clickKey(code: string, isDown: boolean) {
    if (code === "CapsLock" || STICKY.has(code)) {
      if (!isDown) return;
      const on = !down.has(code);
      press(code, on);
      if (on && code !== "CapsLock") latched.add(code);
      return;
    }
    press(code, isDown);
    if (!isDown) for (const m of [...latched]) press(m, false);
  }
  function physicalKey(ev: KeyboardEvent, isDown: boolean) {
    press(ev.code, ev.code === "CapsLock" ? ev.getModifierState("CapsLock") : isDown);
  }

  // mouse
  const mouse = nodes.mouse;
  const button = nodes.mouseButton;
  const cableMesh = meshes.mouseCable;
  if (button) spring(button, BUTTON_TRAVEL);
  const obstacles = ["mainUnit", "frontBezel", "plinth"]
    .filter((id) => meshes[id])
    .map((id) => new THREE.Box3().setFromObject(meshes[id]));
  if (nodes.keyboard) obstacles.push(new THREE.Box3().setFromObject(nodes.keyboard));
  for (const p of props) obstacles.push(new THREE.Box3().setFromObject(p)); // desk props the mouse and its cable bump into
  for (const b of obstacles) b.expandByScalar(0.002);
  const foot =
    meshes.mouse?.geometry.boundingBox ??
    (meshes.mouse?.geometry.computeBoundingBox(), meshes.mouse?.geometry.boundingBox);
  const hw = foot ? (foot.max.x - foot.min.x) / 2 : 0;
  const hd = foot ? (foot.max.z - foot.min.z) / 2 : 0;

  let cable: ReturnType<typeof createCable> | null = null;
  const pins: THREE.Vector3[] = [];
  let end = new THREE.Vector3();
  let reach = Infinity;
  if (mouse && cableMesh?.userData.tubePath) {
    const path = (cableMesh.userData.tubePath as [number, number, number][]).map((q) =>
      mouse.localToWorld(new THREE.Vector3(...q)),
    );
    model.add(cableMesh);
    cableMesh.position.set(0, 0, 0);
    cableMesh.rotation.set(0, 0, 0);
    cable = createCable(cableMesh, path, (cableMesh.geometry as THREE.TubeGeometry).parameters.radius, obstacles);
    pins.push(mouse.worldToLocal(cable.points[0].clone()), mouse.worldToLocal(cable.points[1].clone()));
    end = cable.points[cable.points.length - 1].clone();
    reach = cable.length * 0.95;
  }

  function fits(x: number, z: number) {
    if (obstacles.some((b) => rectHitsBox(x, z, hw, hd, mouse.rotation.y, b))) return false;
    return (
      !cable ||
      pins[0]
        .clone()
        .applyEuler(mouse.rotation)
        .add(new THREE.Vector3(x, mouse.position.y, z))
        .distanceTo(end) <= reach
    );
  }
  function slide(dx: number, dz: number) {
    const p = mouse.position;
    const start = p.clone();
    const n = Math.ceil(Math.hypot(dx, dz) / 0.004) || 1;
    const sx = dx / n;
    const sz = dz / n;
    for (let i = 0; i < n; i++) {
      if (fits(p.x + sx, p.z + sz)) {
        p.x += sx;
        p.z += sz;
      } else if (fits(p.x + sx, p.z)) p.x += sx;
      else if (fits(p.x, p.z + sz)) p.z += sz;
    }
    return p.clone().sub(start);
  }

  const plane = new THREE.Plane();
  let grab: THREE.Vector3 | null = null;
  function beginDrag(point: THREE.Vector3) {
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), point);
    grab = point.clone();
  }
  function drag(ray: THREE.Ray) {
    const p = grab && ray.intersectPlane(plane, new THREE.Vector3());
    if (!p || !grab) return;
    const moved = slide(p.x - grab.x, p.z - grab.z);
    grab = p;
    mac.nudge(moved.x * PX_PER_M, moved.z * PX_PER_M);
  }
  // mouse button
  const buttonDown = createSound(
    (t) => noise() * Math.exp(-t / 0.0008) + 0.6 * ring(3200, 0.003, t) + 0.3 * ring(650, 0.012, t),
    0.05,
  );
  const buttonUp = createSound((t) => 0.7 * noise() * Math.exp(-t / 0.0006) + 0.5 * ring(3800, 0.002, t), 0.03);
  function mouseButton(isDown: boolean) {
    mac.button(isDown);
    push(button, isDown);
    if (isDown) buttonDown(BUTTON_VOLUME);
    else buttonUp(BUTTON_VOLUME / 2);
  }

  function update(simulate: boolean) {
    for (const [o, s] of springs) {
      if (s.t === s.target) continue;
      s.t += (s.target - s.t) * SPRING;
      if (Math.abs(s.target - s.t) < 0.01) s.t = s.target;
      o.position.copy(s.home).addScaledVector(s.axis, s.t);
    }
    if (!cable || !simulate) return;
    mouse.updateMatrixWorld();
    cable.step(mouse.localToWorld(pins[0].clone()), mouse.localToWorld(pins[1].clone()));
  }

  return {
    keyAt: (o?: THREE.Object3D) => o?.userData.keyCode as string | undefined,
    onButton: (o?: THREE.Object3D) => within(o, button),
    onMouse: (o?: THREE.Object3D) => within(o, mouse),
    clickKey,
    physicalKey,
    releaseAll,
    mouseButton,
    beginDrag,
    drag,
    endDrag() {
      grab = null;
    },
    update,
  };
}

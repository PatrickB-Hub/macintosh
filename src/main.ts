import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createMacintoshModel } from "./createMacintoshModel.ts";
import { createStudioEnvironment } from "./studioEnvironment.ts";
import { createMac, uvToMac } from "./emulator.ts";
import { createDesk } from "./peripherals.ts";
import { createCoaster, createRoom, COASTER, DESK, FLOOR_Y } from "./room.ts";
import { createAtomMugModel } from "./models/mug/createAtomMugModel.ts";
import { applyBakedAO } from "./models/mug/applyBakedAO.ts";
import mugAO from "./models/mug/ao.json";
import { createNewtonsCradleModel } from "./models/cradle/createNewtonsCradleModel.ts";
import { createCradleSwing } from "./cradle.ts";
import { createRubiksCubeModel } from "./models/cube/createRubiksCubeModel.ts";

const stage = document.getElementById("stage")!;
const startButton = document.getElementById("start") as HTMLButtonElement;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(stage.clientWidth, stage.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping; // keeps the beige/taupe hues
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
stage.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute(
  "aria-label",
  "Macintosh in 3D. Drag with the mouse to rotate; use Start Macintosh to switch it on.",
);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#EFEEEA");
scene.environment = createStudioEnvironment(renderer); // white sweep + softboxes
scene.environmentIntensity = 0.55;

// A broad light on the left
scene.add(new THREE.HemisphereLight(0xe6f0ff, 0xd6c9b4, 0.65));
const key = new THREE.DirectionalLight(0xfff6e7, 2.2);
key.position.set(-1.5, 2.2, 1.4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -0.7;
key.shadow.camera.right = 0.7;
key.shadow.camera.top = 0.7;
key.shadow.camera.bottom = -0.7;
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 4;
key.shadow.radius = 12;
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.002;
scene.add(key);

// Room floor
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 8),
  new THREE.MeshStandardMaterial({ color: "#D8D4CC", roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
floor.receiveShadow = true;
floor.name = "studioFloor";
scene.add(floor);
const room = createRoom();
scene.add(room);

const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(DESK.w, DESK.d),
  new THREE.ShadowMaterial({ opacity: 0.12 }),
);
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.position.set(DESK.x, 0.0004, DESK.z);
shadowCatcher.receiveShadow = true;
shadowCatcher.name = "shadowCatcher";
scene.add(shadowCatcher);

const model = createMacintoshModel();
model.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
});
scene.add(model);
const mac = createMac();

const mug = createAtomMugModel();
applyBakedAO(mug, mugAO);
mug.scale.setScalar(0.01);
mug.position.set(-0.24, COASTER.h, -0.08); // left of the Mac, back near the desk's rear edge
mug.rotation.y = -0.6 + THREE.MathUtils.degToRad(25); // handle rotated 45 deg towards the default camera
scene.add(mug);

const coaster = createCoaster();
coaster.position.x = mug.position.x;
coaster.position.z = mug.position.z;
scene.add(coaster);

const cradle = createNewtonsCradleModel();
cradle.scale.setScalar(0.01);
cradle.position.set(0.285, 0, -0.12);
scene.add(cradle);
cradle.updateMatrixWorld(true);
const swing = createCradleSwing(cradle);

const cube = createRubiksCubeModel();
cube.scale.setScalar(0.019);
cube.position.set(-0.29, 1.512 * 0.019, 0.18);
cube.rotation.y = 0.35;
cube.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
});
scene.add(cube);

const desk = createDesk(model, mac, [mug, cradle, cube]);

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
function fitCamera() {
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
}
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = !reducedMotion.matches;
// Limit OrbitControl angles
controls.maxAzimuthAngle = THREE.MathUtils.degToRad(72);
controls.minAzimuthAngle = -controls.maxAzimuthAngle;

const DESK_BOX = new THREE.Box3(
  new THREE.Vector3(DESK.x - DESK.w / 2, -DESK.top, DESK.z - DESK.d / 2),
  new THREE.Vector3(DESK.x + DESK.w / 2, 0, DESK.z + DESK.d / 2),
);
const corner = new THREE.Vector3();
const axis = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
/**
 * Max Zoom-out
 */
function leashZoom() {
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * camera.aspect;
  axis.copy(camera.position).sub(controls.target).normalize();
  right.crossVectors(camera.up, axis).normalize();
  up.crossVectors(axis, right);
  let d = 0;
  for (let i = 0; i < 8; i++) {
    corner
      .set(
        i & 1 ? DESK_BOX.max.x : DESK_BOX.min.x,
        i & 2 ? DESK_BOX.max.y : DESK_BOX.min.y,
        i & 4 ? DESK_BOX.max.z : DESK_BOX.min.z,
      )
      .sub(controls.target);
    const behind = corner.dot(axis);
    d = Math.max(d, Math.abs(corner.dot(right)) / tanH + behind, Math.abs(corner.dot(up)) / tanV + behind);
  }
  controls.maxDistance = d;
}

function overview() {
  fitCamera();
  controls.target.set(0.04, 0.17, 0.1);
  const distance = Math.max(1.35, 0.98 / (2 * Math.tan(Math.PI / 12) * camera.aspect));
  camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(0.28, 0.23, 1).normalize(), distance);
  controls.update();
}
overview();

type Runtime = { nodes: Record<string, THREE.Object3D>; meshes: Record<string, THREE.Mesh> };
const runtime = (model.userData.sculptRuntime ?? { nodes: {}, meshes: {} }) as Runtime;

const raycaster = new THREE.Raycaster();
function aim(ev: MouseEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
}
function pick(ev: MouseEvent) {
  aim(ev);
  return raycaster.intersectObject(model, true)[0];
}

const glass = runtime.meshes.crtGlass;
const badge = runtime.nodes.appleBadge;
const GLASS_WHEN_ON = 0.45;
const glassMat = glass?.material as THREE.MeshPhysicalMaterial | undefined;
const glassColor = glassMat?.color.clone();
if (glassMat) Object.assign(glassMat, { emissive: new THREE.Color("#eef3ff"), emissiveMap: mac.texture });
type Held = { kind: "glass" } | { kind: "key"; code: string } | { kind: "mouse"; button: boolean };
let held: Held | null = null;
let macFocus = false;
let fly: { from: THREE.Vector3; fromT: THREE.Vector3; to: THREE.Vector3; toT: THREE.Vector3; t0: number } | null = null;

/** Camera moves to the screen after the Mac is turned on */
function flyToDesk() {
  const box = new THREE.Box3().expandByObject(glass ?? runtime.nodes.mainUnit ?? model);
  const size = box.getSize(new THREE.Vector3());
  const target = box.getCenter(new THREE.Vector3());
  const back = new THREE.Vector3(0, 0, 1); // eye level, square on to the glass
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * camera.aspect;
  const FRAME = 1.9; // frame size, smaller = closer
  let d = (size.y * FRAME) / (2 * tanV);
  d = Math.max(d, (size.x * FRAME) / (2 * tanH));
  d += size.z / 2;
  if (reducedMotion.matches) {
    camera.position.copy(target).addScaledVector(back, d);
    controls.target.copy(target);
    controls.update();
    fly = null;
    return;
  }
  fly = {
    from: camera.position.clone(),
    fromT: controls.target.clone(),
    to: target.clone().addScaledVector(back, d),
    toT: target,
    t0: performance.now(),
  };
}

function resizeStage() {
  fitCamera();
  renderer.setSize(stage.clientWidth, stage.clientHeight);
}

function startMac() {
  document.body.classList.add("playing");
  resizeStage();
  desk.releaseAll();
  if (!mac.on) mac.toggle();
  glassMat?.color.copy(glassColor!).multiplyScalar(GLASS_WHEN_ON);
  macFocus = true;
  renderer.domElement.focus({ preventScroll: true });
  flyToDesk();
}
startButton.onclick = startMac;

function resetView() {
  fly = null;
  macFocus = false;
  desk.releaseAll();
  document.body.classList.remove("playing");
  resizeStage();
  overview();
  startButton.innerHTML = `${mac.on ? "Back to Macintosh" : "Start Macintosh"} <span aria-hidden="true">↗</span>`;
}

renderer.domElement.addEventListener(
  "pointerdown",
  (ev) => {
    if (ev.button !== 0) return;
    fly = null;
    renderer.domElement.dataset.pointerFocus = "";
    renderer.domElement.focus({ preventScroll: true });
    const hit = pick(ev);
    const o = hit?.object;
    const code = desk.keyAt(o);
    macFocus = !!hit;
    held = null;
    let consumed = true;
    if (mac.on && glass && o === glass) {
      held = { kind: "glass" };
      mac.move(uvToMac(hit!.uv!.x, hit!.uv!.y));
      mac.button(true);
    } else if (badge && o?.parent === badge) {
      if (!mac.on) startMac();
      else {
        desk.releaseAll();
        mac.toggle();
        glassMat?.color.copy(glassColor!);
        resetView();
      }
    } else if (!hit) {
      consumed = false;
    } else if (code) {
      held = { kind: "key", code };
      desk.clickKey(code, true);
    } else if (desk.onButton(o) || desk.onMouse(o)) {
      held = { kind: "mouse", button: desk.onButton(o) };
      if (held.button) desk.mouseButton(true);
      desk.beginDrag(hit.point);
    } else {
      consumed = false;
    }
    if (!consumed) return;
    controls.enabled = false;
    if (held) renderer.domElement.setPointerCapture(ev.pointerId);
  },
  true,
);
renderer.domElement.addEventListener("pointermove", (ev) => {
  const style = renderer.domElement.style;
  if (held?.kind === "mouse") {
    aim(ev);
    desk.drag(raycaster.ray);
    style.cursor = "grabbing";
    return;
  }
  const hit = pick(ev);
  const o = hit?.object;
  swing.brush(raycaster.ray, ev.timeStamp, hit?.distance);
  const onGlass = mac.on && !!glass && o === glass;
  if (onGlass && held?.kind !== "key") mac.move(uvToMac(hit!.uv!.x, hit!.uv!.y));
  const pressable = (badge && o?.parent === badge) || desk.keyAt(o) || desk.onButton(o);
  style.cursor = onGlass ? "none" : pressable ? "pointer" : desk.onMouse(o) ? "grab" : "";
});
for (const type of ["pointerup", "pointercancel"])
  addEventListener(type, () => {
    if (held?.kind === "glass") mac.button(false);
    if (held?.kind === "key") desk.clickKey(held.code, false);
    if (held?.kind === "mouse") {
      if (held.button) desk.mouseButton(false);
      desk.endDrag();
    }
    held = null;
    controls.enabled = true;
  });

renderer.domElement.addEventListener("blur", () => delete renderer.domElement.dataset.pointerFocus);
addEventListener("keydown", (ev) => {
  if (ev.code === "Escape" && document.body.classList.contains("playing")) {
    resetView();
    startButton.focus({ preventScroll: true });
    return;
  }
  if (!macFocus || ev.target !== renderer.domElement || ev.code === "Tab" || ev.metaKey || ev.ctrlKey) return;
  ev.preventDefault();
  if (!ev.repeat) desk.physicalKey(ev, true);
});
addEventListener("keyup", (ev) => {
  if (macFocus || ev.code !== "CapsLock") desk.physicalKey(ev, false);
});

document.getElementById("reset")!.onclick = resetView;

addEventListener("resize", () => {
  resizeStage();
  if (document.body.classList.contains("playing")) flyToDesk();
  else overview();
});
let frames = 0;
renderer.setAnimationLoop(() => {
  if (fly) {
    const k = Math.min(1, (performance.now() - fly.t0) / 1000);
    const e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(fly.from, fly.to, e);
    controls.target.lerpVectors(fly.fromT, fly.toT, e);
    if (k === 1) fly = null;
  }
  desk.update(true); // key/button springs
  swing.update(performance.now());
  leashZoom();
  controls.update();
  renderer.render(scene, camera);
  if (++frames === 3) {
    startButton.disabled = false;
    startButton.innerHTML = 'Start Macintosh <span aria-hidden="true">↗</span>';
  }
});

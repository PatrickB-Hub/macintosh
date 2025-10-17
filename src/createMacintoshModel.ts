/**
 * Hand-refined factory for the Apple Macintosh 128K set (M0001 unit + M0110 keyboard + M0100 mouse).
 *
 * Every dimension, position, rotation and material comes from object-sculpt-spec.json. This file
 * only supplies the shape recipes the generator cannot emit: a rounded front outline with real
 * holes, lofted recess walls, the sloped keyboard shell with its key well, the keycap layout and
 * the badge logo. Units: metres. +Y up, +Z toward the user, +X = the computer's own left.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import specJson from "./models/macintosh/object-sculpt-spec.json";

type Vec3 = [number, number, number];
type Level = "macro" | "meso" | "micro";
interface Component {
  id: string;
  name: string;
  level: Level;
  role: string;
  parent: string | null;
  material: string;
  dimensions: { width: number; height: number; depth: number };
  transform: { position: Vec3; rotation: Vec3 };
  geometryDescriptor: any;
  attachment: { parentSocket: string; localStart: Vec3 } | null;
  actionProfile?: unknown;
}
interface SpecMaterial {
  id: string;
  baseColor: string;
  albedo?: { secondary?: string[] };
  roughness?: { base?: number };
  clearcoat?: { base?: number };
  clearcoatRoughness?: { base?: number };
  opacity?: { base?: number };
}
interface Repetition {
  id: string;
  level: Level;
  placement: any;
}

const spec = specJson as unknown as {
  componentTree: Component[];
  materials: SpecMaterial[];
  repetitionSystems: Repetition[];
};
const byId = new Map(spec.componentTree.map((c) => [c.id, c]));
const comp = (id: string) => byId.get(id)!;
const rep = (id: string) => spec.repetitionSystems.find((r) => r.id === id)!;

const KEY = 0.01905; // keycap pitch (0.75 in)
const MOUSE_NUDGE_X = 0.02; // placement over the spec: the mouse sits 2 cm further to the user's right (+X)

type KeyDef = [legend: string, code: string, units: number];
const k1 = (legend: string, code: string): KeyDef => [legend, code, 1];
const letters = (s: string) => [...s].map((c) => k1(c, `Key${c}`));
/**
 * Apple M0110 keyboard, US layout, 58 keys: [legend, KeyboardEvent.code, width in units]. A '\n'
 * prints the shifted legend over the unshifted one. The bottom row's widths and indent are the
 * spec keycapArray's (measured from the reference photo); the other rows are the M0110 US rows.
 */
const M0110: { offsetU: number; keys: KeyDef[] }[] = [
  {
    offsetU: 0,
    keys: [
      k1("~\n`", "Backquote"),
      ...[..."!@#$%^&*()"].map((s, i) => k1(`${s}\n${(i + 1) % 10}`, `Digit${(i + 1) % 10}`)),
      k1("_\n-", "Minus"),
      k1("+\n=", "Equal"),
      ["backspace", "Backspace", 2],
    ],
  },
  {
    offsetU: 0,
    keys: [
      ["tab", "Tab", 1.5],
      ...letters("QWERTYUIOP"),
      k1("{\n[", "BracketLeft"),
      k1("}\n]", "BracketRight"),
      ["|\n\\", "Backslash", 1.5],
    ],
  },
  {
    offsetU: 0,
    keys: [
      ["caps lock", "CapsLock", 1.75],
      ...letters("ASDFGHJKL"),
      k1(":\n;", "Semicolon"),
      k1("\"\n'", "Quote"),
      ["return", "Enter", 2.25],
    ],
  },
  {
    offsetU: 0,
    keys: [
      ["shift", "ShiftLeft", 2.25],
      ...letters("ZXCVBNM"),
      k1("<\n,", "Comma"),
      k1(">\n.", "Period"),
      k1("?\n/", "Slash"),
      ["shift", "ShiftRight", 2.75],
    ],
  },
  {
    offsetU: 0.5,
    keys: [
      ["option", "AltLeft", 1.25],
      ["⌘", "MetaLeft", 1.25],
      ["", "Space", 7.5],
      ["enter", "NumpadEnter", 1.5],
      ["option", "AltRight", 1.25],
    ],
  },
];


// materials
type Mats = Record<string, THREE.MeshStandardMaterial>;

/** Seeded moulded-ABS grain (spec meso/micro frequency bands): value noise, box-blurred once. */
function grainTexture(seed = 128): THREE.CanvasTexture {
  const s = 256;
  let st = seed;
  const rnd = () => (st = (st * 1664525 + 1013904223) >>> 0) / 4294967296;
  const raw = new Float32Array(s * s).map(() => rnd());
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) sum += raw[((y + dy + s) % s) * s + ((x + dx + s) % s)];
      const v = Math.round(215 + 40 * (sum / 9 - 0.5) * 2); // 175..255: roughness x0.7..1, gentle bump
      img.data.set([v, v, v, 255], (y * s + x) * 4);
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

function buildMaterials(): Mats {
  const m: Mats = {};
  for (const s of spec.materials) {
    const mat = new THREE.MeshPhysicalMaterial({
      name: s.id,
      color: new THREE.Color(s.baseColor),
      metalness: 0,
      roughness: s.roughness?.base ?? 0.6,
      clearcoat: s.clearcoat?.base ?? 0,
      clearcoatRoughness: s.clearcoatRoughness?.base ?? 0.2,
    });
    const opacity = s.opacity?.base ?? 1;
    if (opacity < 1) Object.assign(mat, { transparent: true, opacity, depthWrite: false });
    m[s.id] = mat;
  }
  // Moulded grain breaks up the satin highlight (bump + roughness, never albedo).
  const grain = typeof document === "undefined" ? null : grainTexture();
  for (const id of ["housingBeige", "keycapTaupe"]) {
    if (!grain) break;
    Object.assign(m[id], { bumpMap: grain, bumpScale: 0.35, roughnessMap: grain });
  }
  // spec material.localOverrides realised as derived shades
  const vent = m.housingBeige.clone();
  vent.color.multiplyScalar(0.55);
  vent.name = "vent-slot-cavity-dark";
  m.vent = vent;
  const walls = m.housingBeige.clone();
  walls.side = THREE.DoubleSide;
  walls.name = "housingBeige:recess-walls";
  m.walls = walls;
  return m;
}

// geometry helpers
/** Rounded rectangle outline, counter-clockwise. radii = [topRight, topLeft, bottomLeft, bottomRight]. */
function rrPoints(w: number, h: number, r: number | number[], seg = 4, cx = 0, cy = 0): THREE.Vector2[] {
  const hw = w / 2;
  const hh = h / 2;
  const radii = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(v, hw - 1e-4, hh - 1e-4)));
  const corners: Array<[number, number, number, number]> = [
    [hw - radii[0], hh - radii[0], 0, radii[0]],
    [-hw + radii[1], hh - radii[1], 90, radii[1]],
    [-hw + radii[2], -hh + radii[2], 180, radii[2]],
    [hw - radii[3], -hh + radii[3], 270, radii[3]],
  ];
  const out: THREE.Vector2[] = [];
  for (const [x, y, a0, rr] of corners) {
    // A square corner is one point: near-coincident arc points fold an extrude bevel through itself.
    if (rr < 5e-4) {
      out.push(new THREE.Vector2(cx + x, cy + y));
      continue;
    }
    for (let i = 0; i <= seg; i++) {
      const a = THREE.MathUtils.degToRad(a0 + (90 * i) / seg);
      out.push(new THREE.Vector2(cx + x + rr * Math.cos(a), cy + y + rr * Math.sin(a)));
    }
  }
  return out;
}

/** Quad strip between two closed rings of equal length. */
function loft(a: THREE.Vector3[], b: THREE.Vector3[]): THREE.BufferGeometry {
  const n = a.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const p of a.concat(b)) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, j, n + j, i, n + j, n + i);
  }
  const uv: number[] = [];
  for (const v of [0, 1]) for (let i = 0; i < n; i++) uv.push(i / n, v);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Extrude UVs come out in metres (~0..0.3); stretch them toward the 0..1 range other meshes use. */
function scaleUv(g: THREE.BufferGeometry, k = 4): THREE.BufferGeometry {
  const uv = g.getAttribute("uv");
  if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
  return g;
}

/** Extrude a (z, y) side profile along X, centred on x = 0; the bevel stays inside the profile. */
function sideExtrude(
  profile: number[][],
  width: number,
  bevel: number,
  holes: THREE.Vector2[][] = [],
): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  shape.holes.push(...holes.map((h) => new THREE.Path(h))); // holes run straight through along X
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * bevel,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    curveSegments: 4,
  });
  g.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world -x
  g.translate(width / 2 - bevel, 0, 0);
  return scaleUv(g);
}

/** Round every corner of a closed polygon (quadratic arcs); sharp corners fold an extrude bevel. */
function fillet(points: THREE.Vector2[], r: number, seg = 3): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const toPrev = points[(i + n - 1) % n].clone().sub(p);
    const toNext = points[(i + 1) % n].clone().sub(p);
    const rr = Math.min(r, 0.45 * toPrev.length(), 0.45 * toNext.length()); // arcs on a short edge must not cross
    if (rr < 1e-5) continue; // collinear duplicate point
    const s = p.clone().addScaledVector(toPrev.normalize(), rr);
    const e = p.clone().addScaledVector(toNext.normalize(), rr);
    for (let k = 0; k <= seg; k++) {
      const t = k / seg;
      const u = 1 - t;
      out.push(
        new THREE.Vector2(u * u * s.x + 2 * u * t * p.x + t * t * e.x, u * u * s.y + 2 * u * t * p.y + t * t * e.y),
      );
    }
  }
  return out;
}

function steppedOutline(c: Component): THREE.Vector2[] {
  const { tray: t, shutterBox: b } = c.geometryDescriptor.steppedOutline;
  const pts = [
    [t.x0, t.y0],
    [b.x0, t.y0],
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x1, b.y1],
    [b.x0, b.y1],
    [b.x0, t.y1],
    [t.x0, t.y1],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return fillet(pts, c.geometryDescriptor.steppedOutline.cornerRadius ?? 0.0025);
}

function badgeTexture(plate: string, bands: string[]): THREE.CanvasTexture {
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  g.fillStyle = plate;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = "rgba(60,55,40,0.25)";
  g.lineWidth = 5;
  g.strokeRect(6, 6, s - 12, s - 12);
  const u = (v: number) => v * s;
  const apple = new Path2D();
  apple.moveTo(u(0.5), u(0.34));
  apple.bezierCurveTo(u(0.42), u(0.27), u(0.2), u(0.26), u(0.17), u(0.5));
  apple.bezierCurveTo(u(0.15), u(0.7), u(0.28), u(0.9), u(0.38), u(0.9));
  apple.bezierCurveTo(u(0.44), u(0.9), u(0.46), u(0.87), u(0.5), u(0.87));
  apple.bezierCurveTo(u(0.54), u(0.87), u(0.56), u(0.9), u(0.62), u(0.9));
  apple.bezierCurveTo(u(0.72), u(0.9), u(0.8), u(0.76), u(0.83), u(0.66));
  apple.bezierCurveTo(u(0.74), u(0.62), u(0.71), u(0.46), u(0.8), u(0.4));
  apple.bezierCurveTo(u(0.74), u(0.3), u(0.6), u(0.27), u(0.5), u(0.34));
  apple.closePath();
  apple.moveTo(u(0.5), u(0.3));
  apple.bezierCurveTo(u(0.5), u(0.2), u(0.56), u(0.12), u(0.64), u(0.1));
  apple.bezierCurveTo(u(0.64), u(0.2), u(0.58), u(0.28), u(0.5), u(0.3));
  apple.closePath();
  g.save();
  g.translate(u(0.12), u(0.08));
  g.scale(0.76, 0.84);
  g.clip(apple);
  const stops = [0.08, 0.42, 0.53, 0.63, 0.73, 0.82, 0.92];
  bands.forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(0, u(stops[i]), s, u(stops[i + 1] - stops[i]) + 1);
  });
  g.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Flat top of a keycap, [width, depth]: the base (pitch minus a 1.2 mm gap) tapers by 5.5 x 4.5 mm. */
const capTop = (units: number) => [units * KEY - 0.0067, KEY - 0.0057];

/** Tapered keycap: lofted rounded-rect frustum + flat cap. Origin at the base centre. Groups: 0 = sides, 1 = cap (uv 0..1). */
function keycapGeometry(units: number, height: number): THREE.BufferGeometry {
  const bw = units * KEY - 0.0012;
  const bd = KEY - 0.0012;
  const [tw, td] = capTop(units);
  const back = -0.0008;
  const bottom = rrPoints(bw, bd, 0.0015, 3).map((p) => new THREE.Vector3(p.x, 0, -p.y));
  const top = rrPoints(tw, td, 0.0022, 3).map((p) => new THREE.Vector3(p.x, height, -p.y + back));
  const sides = loft(bottom, top);
  // cap keeps its uv: loft() emits uv too, and mergeGeometries returns null on mismatched attributes
  const cap = new THREE.ShapeGeometry(new THREE.Shape(rrPoints(tw, td, 0.0022, 3)));
  const uv = cap.getAttribute("uv"); // shape coordinates in metres -> 0..1 across the cap, for the legend
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / tw + 0.5, uv.getY(i) / td + 0.5);
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, height, back);
  return mergeGeometries([sides, cap], true)!;
}

/** Keycap print for group 1: M0110 legends sit top-left, shifted over unshifted. */
function legendTexture(legend: string, units: number): THREE.CanvasTexture {
  const [tw, td] = capTop(units);
  const ppm = 12000; // canvas px per metre (~0.08 mm)
  const cv = document.createElement("canvas");
  cv.width = Math.round(tw * ppm);
  cv.height = Math.round(td * ppm);
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff"; // the cap material's taupe multiplies through unchanged
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#2B2924";
  g.textBaseline = "top";
  const lines = legend.split("\n");
  const px = (legend.length === 1 ? 0.0034 : lines.length > 1 ? 0.0026 : 0.0022) * ppm; // letters > symbol pairs > words
  g.font = `${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  lines.forEach((t, i) => g.fillText(t, 0.0013 * ppm, 0.0011 * ppm + i * px * 1.2));
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// assembly
export function createMacintoshModel(): THREE.Group {
  const levels: Level[] = ["macro", "meso", "micro"];
  const mats = buildMaterials();
  const root = new THREE.Group();
  root.name = "macSet";
  const nodes: Record<string, THREE.Object3D> = { macSet: root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};

  const has = (id: string) => levels.includes(comp(id).level);
  const node = (id: string): THREE.Group => {
    const c = comp(id);
    const n = new THREE.Group();
    n.name = `${id}__pivot`;
    n.position.set(...c.transform.position);
    n.rotation.set(...c.transform.rotation);
    (nodes[c.parent ?? "macSet"] ?? root).add(n);
    nodes[id] = n;
    type SocketSpec = { id: string; localPosition: Vec3 };
    for (const s of (c.actionProfile as { sockets?: SocketSpec[] } | undefined)?.sockets ?? []) {
      const o = new THREE.Object3D();
      o.name = s.id;
      o.position.set(...s.localPosition);
      n.add(o);
      sockets[s.id] = o;
    }
    if (c.attachment && !sockets[c.attachment.parentSocket]) {
      // parent may already declare the socket
      const s = new THREE.Object3D();
      s.name = c.attachment.parentSocket;
      s.position.set(...c.attachment.localStart);
      (nodes[c.parent!] ?? root).add(s);
      sockets[s.name] = s;
    }
    return n;
  };
  const mesh = (
    n: THREE.Object3D,
    id: string,
    geo: THREE.BufferGeometry,
    mat: THREE.Material | THREE.Material[],
    sub?: string,
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = sub ? `${id}:${sub}` : id;
    n.add(m);
    if (!sub) meshes[id] = m;
    return m;
  };
  const box = (c: Component, r = 0.0008) => {
    const { width, height, depth } = c.dimensions;
    return new RoundedBoxGeometry(width, height, depth, 2, Math.min(r, width / 2, height / 2, depth / 2));
  };

  // main unit
  const unit = comp("mainUnit");
  const unitNode = node("mainUnit");
  mesh(unitNode, "mainUnit", box(unit, 0.006), mats.housingBeige);

  const bezelC = comp("frontBezel");
  const bezelNode = node("frontBezel");
  const o = bezelC.geometryDescriptor.frontOutline;
  const chamferH = 0.01; // chin-bottom-chamfer: 10 mm strip under the flat face
  {
    const h = o.height - chamferH;
    const shape = new THREE.Shape(
      rrPoints(o.width, h, [o.cornerRadius, o.cornerRadius, 1e-4, 1e-4], 5, 0, chamferH / 2),
    );
    for (const hole of o.holes) {
      if (hole.id === "screen") shape.holes.push(new THREE.Path(rrPoints(hole.w, hole.h, hole.r, 6, hole.cx, hole.cy)));
    }
    const fp = comp("floppyPanel").transform.position;
    shape.holes.push(
      new THREE.Path(steppedOutline(comp("floppyPanel")).map((p) => p.add(new THREE.Vector2(fp[0], fp[1])))),
    );
    const bv = o.frontBevel;
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: o.depth - 2 * bv,
      bevelEnabled: true,
      bevelThickness: bv,
      bevelSize: bv,
      bevelOffset: -bv,
      bevelSegments: 3,
      curveSegments: 6,
    });
    g.translate(0, 0, -o.depth / 2 + bv);
    mesh(bezelNode, "frontBezel", scaleUv(g), mats.housingBeige);
    const yb = -o.height / 2;
    const zf = o.depth / 2;
    const strip = sideExtrude(
      [
        [zf, yb + chamferH],
        [zf - 0.008, yb],
        [-zf, yb],
        [-zf, yb + chamferH],
      ],
      o.width,
      0,
    );
    mesh(bezelNode, "frontBezel", strip, mats.housingBeige, "chin-bottom-chamfer");
  }

  if (has("screenRecess")) {
    const c = comp("screenRecess");
    const n = node("screenRecess");
    const L = c.geometryDescriptor.loft;
    const front = c.dimensions.depth / 2;
    const mouth = rrPoints(L.mouth[0], L.mouth[1], L.mouth[2], 6).map(
      (p) => new THREE.Vector3(p.x, p.y, front - 0.0005),
    );
    const inner = rrPoints(L.inner[0], L.inner[1], L.inner[2], 6, 0, L.innerOffsetY).map(
      (p) => new THREE.Vector3(p.x, p.y, front - L.depth),
    );
    mesh(n, "screenRecess", loft(mouth, inner), mats.walls);
  }
  if (has("crtGlass")) {
    const c = comp("crtGlass");
    const n = node("crtGlass");
    const { width: w, height: h } = c.dimensions;
    const g = new THREE.PlaneGeometry(w, h, 40, 32);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const nx = p.getX(i) / (w / 2);
      const ny = p.getY(i) / (h / 2);
      p.setZ(i, 0.005 * (1 - 0.5 * (nx * nx + ny * ny))); // convex faceplate, 5 mm crown
    }
    g.computeVertexNormals();
    mesh(n, "crtGlass", g, mats.crtGlass);
  }

  if (has("floppyPanel")) {
    const c = comp("floppyPanel");
    const n = node("floppyPanel");
    const outline = steppedOutline(c);
    const front = c.dimensions.depth / 2;
    const floor = front - c.geometryDescriptor.steppedOutline.depth;
    const walls = loft(
      outline.map((p) => new THREE.Vector3(p.x, p.y, front - 0.0002)),
      outline.map((p) => new THREE.Vector3(p.x, p.y, floor)),
    );
    mesh(n, "floppyPanel", walls, mats.walls);
    const floorGeo = new THREE.ShapeGeometry(new THREE.Shape(outline));
    floorGeo.translate(0, 0, floor);
    mesh(n, "floppyPanel", floorGeo, mats.housingBeige, "tray-floor");
    const onFloor = (id: string) => {
      const d = comp(id);
      const m = mesh(
        node(id),
        id,
        new THREE.BoxGeometry(d.dimensions.width, d.dimensions.height, 0.001),
        mats.slotBlack,
      );
      m.parent!.position.z = floor + 0.0006;
    };
    if (has("floppySlot")) onFloor("floppySlot");
    if (has("floppyShutter")) onFloor("floppyShutter");
    if (has("ejectHole")) {
      const d = comp("ejectHole");
      const g = new THREE.CylinderGeometry(d.dimensions.width / 2, d.dimensions.width / 2, 0.001, 16);
      g.rotateX(Math.PI / 2);
      const m = mesh(node("ejectHole"), "ejectHole", g, mats.slotBlack);
      m.parent!.rotation.set(0, 0, 0); // axis already baked into the geometry
      m.parent!.position.z = front + 0.0002;
    }
  }

  if (has("appleBadge")) {
    const c = comp("appleBadge");
    const n = node("appleBadge");
    mesh(n, "appleBadge", box(c, 0.0015), mats.badgePlate);
    const plateSpec = spec.materials.find((m) => m.id === "badgePlate")!;
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(c.dimensions.width - 0.0012, c.dimensions.height - 0.0012),
      new THREE.MeshStandardMaterial({
        name: "rainbow-apple-stripes",
        map: badgeTexture(plateSpec.baseColor, plateSpec.albedo!.secondary!),
        roughness: 0.35,
      }),
    );
    logo.name = "appleBadge:rainbow-apple-stripes";
    logo.position.z = c.dimensions.depth / 2 + 0.0001;
    n.add(logo);
  }

  // plinth: core block between two side skins that carry the vent slots
  const pl = comp("plinth");
  const plProfile = fillet(
    (pl.geometryDescriptor.sideProfileYZ as number[][]).map(([z, y]) => new THREE.Vector2(z, y)),
    0.003,
  ).map((p) => [p.x, p.y]);
  const skin = pl.geometryDescriptor.skinThickness as number;
  if (has("plinth")) {
    // ExtrudeGeometry groups: caps = 0, walls = 1. The dark side caps only show through the vent slots.
    mesh(node("plinth"), "plinth", sideExtrude(plProfile, pl.dimensions.width - 2 * skin, 0), [
      mats.vent,
      mats.housingBeige,
    ]);
  }
  for (const id of ["ventGrille-l", "ventGrille-r"]) {
    if (!has(id)) continue;
    const vs = rep("ventSlots").placement;
    const holes = levels.includes(rep("ventSlots").level)
      ? Array.from({ length: vs.perSide }, (_, i) =>
          rrPoints(vs.slotLength, vs.slotHeight, vs.cornerRadius, 3, vs.centerZ, vs.firstY + i * vs.pitch),
        )
      : [];
    const n = node(id);
    mesh(n, id, sideExtrude(plProfile, skin, 0.0004, holes), mats.housingBeige);
  }
  if (has("jackPanel")) {
    const c = comp("jackPanel");
    const n = node("jackPanel");
    mesh(n, "jackPanel", box(c, 0.0006), mats.housingBeige);
    const j = c.geometryDescriptor.jackOpening;
    const m = mesh(n, "jackPanel", new THREE.BoxGeometry(j.w, j.h, 0.001), mats.slotBlack, "jack-opening");
    m.position.set(j.cx, 0, c.dimensions.depth / 2 - 0.0003);
  }
  if (has("keyboardCable")) {
    const c = comp("keyboardCable");
    const n = node("keyboardCable");
    const { points, radius } = c.geometryDescriptor.tubePath;
    const { radius: R, pitch } = c.geometryDescriptor.coil;
    const axis = new THREE.CatmullRomCurve3(points.map((p: Vec3) => new THREE.Vector3(...p)));
    const turns = Math.round(axis.getLength() / pitch);
    const N = turns * 12;
    const { normals, binormals } = axis.computeFrenetFrames(N, false);
    const helix = Array.from({ length: N + 1 }, (_, i) => {
      const t = i / N;
      const a = 2 * Math.PI * turns * t;
      const r = R * Math.min(1, t / 0.08, (1 - t) / 0.08); // the coil starts and ends on the axis
      return axis
        .getPointAt(t)
        .addScaledVector(normals[i], r * Math.cos(a))
        .addScaledVector(binormals[i], r * Math.sin(a));
    });
    mesh(
      n,
      "keyboardCable",
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), N * 2, radius, 6, false),
      mats.cableGrey,
    );
    const plug = mesh(
      n,
      "keyboardCable",
      new RoundedBoxGeometry(0.0085, 0.009, 0.014, 2, 0.001),
      mats.cableGrey,
      "plug",
    );
    plug.position.copy(sockets.keyboardJack.position).add(new THREE.Vector3(0, 0, 0.005)); // 2 mm seated, 12 mm out
  }

  // keyboard
  const kb = comp("keyboard");
  const kbNode = node("keyboard");
  const KH = kb.dimensions.height / 2;
  const KD = kb.dimensions.depth / 2;
  const frontTopZ = KD - 0.008;
  // Frame top: y = KH at the back edge, sloping down to y = 0.007 at the front.
  const topY = (z: number) => KH + (0.007 - KH) * ((z + KD) / (frontTopZ + KD));
  const slope = Math.atan((KH - 0.007) / (frontTopZ + KD));
  const bodyTop = (z: number) => topY(z) - 0.004;
  {
    // Chamfer runs straight into the frame's underside: a concave notch here folds the bevel.
    const body = sideExtrude(
      [
        [-KD, -0.0075],
        [KD, -0.0075],
        [KD, -0.001],
        [frontTopZ, bodyTop(frontTopZ)],
        [-KD, bodyTop(-KD)],
      ],
      kb.dimensions.width,
      0.0015,
    );
    mesh(kbNode, "keyboard", body, mats.housingBeige);
    const well = comp("keyWell");
    const frameShape = new THREE.Shape(
      rrPoints(kb.dimensions.width, frontTopZ + KD, 0.006, 4, 0, -(frontTopZ - KD) / 2),
    );
    frameShape.holes.push(
      new THREE.Path(rrPoints(well.dimensions.width, well.dimensions.depth, 0.002, 3, 0, -well.transform.position[2])),
    );
    const bv = 0.001;
    const frame = new THREE.ExtrudeGeometry(frameShape, {
      depth: 0.004 - 2 * bv,
      bevelEnabled: true,
      bevelThickness: bv,
      bevelSize: bv,
      bevelOffset: -bv,
      bevelSegments: 2,
      curveSegments: 4,
    });
    frame.translate(0, 0, bv);
    frame.rotateX(-Math.PI / 2); // plan shape: shape y -> -z, extrusion -> +y
    frame.rotateX(slope);
    const probe = new THREE.Vector3(0, 0.004, frontTopZ).applyAxisAngle(new THREE.Vector3(1, 0, 0), slope);
    frame.translate(0, 0.007 - probe.y, 0);
    mesh(kbNode, "keyboard", frame, mats.housingBeige, "top-frame");
    const emboss = new RoundedBoxGeometry(0.011, 0.0008, 0.011, 2, 0.0003);
    const e = mesh(kbNode, "keyboard", emboss, mats.housingBeige, "apple-emboss");
    const ez = well.transform.position[2] + 0.035;
    e.position.set(-kb.dimensions.width / 2 + 0.012, topY(ez), ez);
    e.rotation.x = slope;
    // The well follows the key rows: the case surface fills the bottom row's empty ends.
    const rows0: { offsetU: number; keys: number[] }[] = rep("keycapArray").placement.rows;
    const last = rows0[rows0.length - 1];
    const used = last.offsetU + last.keys.reduce((a, b) => a + b, 0);
    const rowZ = well.transform.position[2] - well.dimensions.depth / 2 + 0.003 + (rows0.length - 0.5) * KEY;
    const halfW = well.dimensions.width / 2 + 0.001;
    const ends: Array<[number, number, string]> = [
      [-halfW, (last.offsetU - 7.5) * KEY, "l"],
      [(used - 7.5) * KEY, halfW, "r"],
    ];
    for (const [x0, x1, tag] of ends) {
      if (x1 - x0 < 0.001) continue;
      const f = mesh(
        kbNode,
        "keyboard",
        new THREE.BoxGeometry(x1 - x0, 0.004, KEY + 0.004),
        mats.housingBeige,
        `well-filler-${tag}`,
      );
      f.position.set((x0 + x1) / 2, bodyTop(rowZ) + 0.002, rowZ);
      f.rotation.x = slope;
    }
  }
  if (has("keyboardBasePlate"))
    mesh(node("keyboardBasePlate"), "keyboardBasePlate", box(comp("keyboardBasePlate"), 0.001), mats.housingBeige);
  if (has("keyWell")) {
    const c = comp("keyWell");
    const n = node("keyWell");
    const z = c.transform.position[2];
    n.position.set(0, bodyTop(z) + c.dimensions.height / 2, z);
    n.rotation.x = slope;
    mesh(
      n,
      "keyWell",
      new THREE.BoxGeometry(c.dimensions.width, c.dimensions.height, c.dimensions.depth),
      mats.slotBlack,
    );
  }
  if (has("keyBlock")) {
    const n = node("keyBlock");
    n.position.set(0, 0, 0); // keys are placed in keyboard-local coordinates below
    n.rotation.set(0, 0, 0);
    const well = comp("keyWell");
    const wellBack = well.transform.position[2] - well.dimensions.depth / 2;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), slope);
    const H = 0.0115; // spec sculpted-keycaps: ~11.5 mm tall, ~7.5 mm proud of the case surface
    const printed = levels.includes(rep("keyLegends").level);
    const geos = new Map<number, THREE.BufferGeometry>();
    // One mesh per key (not instanced) so each travels on its own; its cap group carries the legend.
    M0110.forEach((row, r) => {
      let cursor = -7.5 * KEY + row.offsetU * KEY;
      for (const [legend, code, u] of row.keys) {
        if (!geos.has(u)) geos.set(u, keycapGeometry(u, H));
        const top =
          printed && legend
            ? Object.assign(mats.keycapTaupe.clone(), { name: `key-legend-${code}`, map: legendTexture(legend, u) })
            : mats.keycapTaupe;
        const z = wellBack + 0.002 + (r + 0.5) * KEY;
        const k = mesh(n, "keyBlock", geos.get(u)!, [mats.keycapTaupe, top], `key-${code}`);
        k.position.set(cursor + (u * KEY) / 2, bodyTop(z) + 0.002, z);
        k.quaternion.copy(q);
        k.userData.keyCode = code;
        cursor += u * KEY;
      }
    });
  }

  // mouse
  const ms = comp("mouse");
  const msNode = node("mouse");
  msNode.position.x += MOUSE_NUDGE_X;
  {
    const prof = (ms.geometryDescriptor.sideProfileYZ as number[][]).map(([z, y]) => [
      z,
      Math.max(y, -ms.dimensions.height / 2 + 0.0035),
    ]);
    mesh(msNode, "mouse", sideExtrude(prof, ms.dimensions.width, 0.002), mats.housingBeige);
    const e = mesh(
      msNode,
      "mouse",
      new RoundedBoxGeometry(0.008, 0.0006, 0.008, 2, 0.0002),
      mats.housingBeige,
      "apple-emboss",
    );
    e.position.set(-0.016, ms.dimensions.height / 2, 0.006);
  }
  if (has("mouseBasePlate"))
    mesh(node("mouseBasePlate"), "mouseBasePlate", box(comp("mouseBasePlate"), 0.001), mats.housingBeige);
  if (has("mouseButton")) {
    // raised 1.2 mm above the spec (its bottom stays seated in the shell) so the press travel reads
    const { width, height, depth } = comp("mouseButton").dimensions;
    const b = mesh(
      node("mouseButton"),
      "mouseButton",
      new RoundedBoxGeometry(width, height + 0.0012, depth, 2, 0.0008),
      mats.keycapTaupe,
    );
    b.position.y = 0.0006;
  }
  if (has("mouseCable")) {
    const c = comp("mouseCable");
    const n = node("mouseCable");
    const path = c.geometryDescriptor.tubePath;
    // The path is mouse-local: undo the mouse nudge progressively so the Mac end stays where the spec has it.
    const undo = new THREE.Vector3(-MOUSE_NUDGE_X, 0, 0).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -ms.transform.rotation[1],
    );
    const pts = (path.points as Vec3[]).map((p, i, a) =>
      new THREE.Vector3(...p).addScaledVector(undo, i / (a.length - 1)),
    );
    const m = mesh(
      n,
      "mouseCable",
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, path.radius, 10, false),
      mats.cableGrey,
    );
    m.userData.tubePath = pts.map((v) => v.toArray()); // start shape of the rope simulation (peripherals.ts)
    const boot = new THREE.CylinderGeometry(0.003, 0.0025, 0.008, 14);
    boot.rotateX(Math.PI / 2);
    const b = mesh(n, "mouseCable", boot, mats.cableGrey, "strain-relief");
    b.position.set(0, -0.004, -ms.dimensions.depth / 2 - 0.002);
  }

  root.userData.sculptRuntime = { nodes, meshes };
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return root;
}

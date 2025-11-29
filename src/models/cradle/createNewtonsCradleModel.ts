import * as THREE from 'three';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
};

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

export function createNewtonsCradleModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Newtons Cradle";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["chrome-tube"] = createSculptMaterial(
    "chrome-tube",
    {"id": "chrome-tube", "name": "Polished chrome", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#C8C4C0", "color": "#C8C4C0", "albedo": {"dominant": "#C8C4C0", "secondary": ["#B8B2AE", "#D6D2CE"], "samplingNotes": "Base colour chosen from the de-lit crop palette; highlights and reflected studio are lighting, not albedo."}, "colorVariation": {"palette": ["#C8C4C0", "#B8B2AE", "#D6D2CE"], "pattern": "uniform", "amplitude": 0.01, "heightCorrelation": 0.0}, "roughness": {"base": 0.12, "variation": 0.01, "map": "independent-procedural-field", "localResponse": "Uniform finish; no wear visible in the reference."}, "metalness": {"base": 1.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.3}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "chrome-mirror", "region": "frames, clamps, caps", "kind": "gloss", "evidenceRef": "full-object"}], "shaderNotes": ["Bright polished nickel-chrome; slight warm tint measured on the leg crop."], "envMapIntensity": 1.0, "clearcoat": {"base": 0.0, "variation": 0.0}, "materialFamily": "metal", "materialSubtype": "steel", "materialFinish": "polished", "anisotropy": {"base": 0.0, "variation": 0.0}, "needsEnvironment": true, "textureless": {"declared": true}},
    options
  );
  materialMap["ball-steel"] = createSculptMaterial(
    "ball-steel",
    {"id": "ball-steel", "name": "Dark polished steel", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#6E6A68", "color": "#6E6A68", "albedo": {"dominant": "#6E6A68", "secondary": ["#5A5654", "#807C7A"], "samplingNotes": "Base colour chosen from the de-lit crop palette; highlights and reflected studio are lighting, not albedo."}, "colorVariation": {"palette": ["#6E6A68", "#5A5654", "#807C7A"], "pattern": "uniform", "amplitude": 0.01, "heightCorrelation": 0.0}, "roughness": {"base": 0.12, "variation": 0.01, "map": "independent-procedural-field", "localResponse": "Uniform finish; no wear visible in the reference."}, "metalness": {"base": 1.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.3}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "ball-dark-mirror", "region": "all five balls", "kind": "gloss", "evidenceRef": "full-object"}], "shaderNotes": ["The balls read clearly darker than the frame in the reference, so their F0 is lower, not their roughness."], "envMapIntensity": 1.0, "clearcoat": {"base": 0.0, "variation": 0.0}, "materialFamily": "metal", "materialSubtype": "steel", "materialFinish": "polished", "anisotropy": {"base": 0.0, "variation": 0.0}, "needsEnvironment": true, "textureless": {"declared": true}},
    options
  );
  materialMap["base-plastic"] = createSculptMaterial(
    "base-plastic",
    {"id": "base-plastic", "name": "Matte black plastic", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#141414", "color": "#141414", "albedo": {"dominant": "#141414", "secondary": ["#1E1E1E", "#0E0E0E"], "samplingNotes": "Base colour chosen from the de-lit crop palette; highlights and reflected studio are lighting, not albedo."}, "colorVariation": {"palette": ["#141414", "#1E1E1E", "#0E0E0E"], "pattern": "uniform", "amplitude": 0.01, "heightCorrelation": 0.0}, "roughness": {"base": 0.68, "variation": 0.01, "map": "independent-procedural-field", "localResponse": "Uniform finish; no wear visible in the reference."}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.3}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "base-satin-finish", "region": "base top and faces", "kind": "gloss", "evidenceRef": "full-object"}], "shaderNotes": ["Satin dielectric; the fine grain in the crop is below the review scale."], "envMapIntensity": 0.6, "clearcoat": {"base": 0.0, "variation": 0.0}, "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "matte", "ior": {"base": 1.5, "variation": 0.0}, "textureless": {"declared": true}},
    options
  );
  materialMap["rubber-feet"] = createSculptMaterial(
    "rubber-feet",
    {"id": "rubber-feet", "name": "Black rubber", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#0C0C0C", "color": "#0C0C0C", "albedo": {"dominant": "#0C0C0C", "secondary": ["#141414"], "samplingNotes": "Base colour chosen from the de-lit crop palette; highlights and reflected studio are lighting, not albedo."}, "colorVariation": {"palette": ["#0C0C0C", "#141414"], "pattern": "uniform", "amplitude": 0.01, "heightCorrelation": 0.0}, "roughness": {"base": 0.88, "variation": 0.01, "map": "independent-procedural-field", "localResponse": "Uniform finish; no wear visible in the reference."}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.3}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "feet-matte", "region": "four feet", "kind": "gloss", "evidenceRef": "full-object"}], "shaderNotes": ["Matte elastomer."], "envMapIntensity": 0.3, "clearcoat": {"base": 0.0, "variation": 0.0}, "materialFamily": "rubber", "materialSubtype": "generic-elastomer", "materialFinish": "matte", "ior": {"base": 1.48, "variation": 0.0}, "textureless": {"declared": true}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};

  const endpoint_base_platform_0 = makeAttachmentEndpoint(null);
  const node_base_platform_0 = new THREE.Group();
  node_base_platform_0.name = "Base platform__pivot";
  node_base_platform_0.scale.set(1, 1, 1);
  if (endpoint_base_platform_0) {
    node_base_platform_0.position.copy(endpoint_base_platform_0.start);
    node_base_platform_0.rotation.set(-1.5707963267948966, 0.0, 0.0);
  } else {
    node_base_platform_0.position.set(0.0, 0.23492560689115116, 0.0);
    node_base_platform_0.rotation.set(-1.5707963267948966, 0.0, 0.0);
  }
  node_base_platform_0.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["root"] ?? root).add(node_base_platform_0);
  nodes["base-platform"] = node_base_platform_0;
  const mesh_base_platform_0Geometry = endpoint_base_platform_0
    ? new THREE.CylinderGeometry(endpoint_base_platform_0.endRadius, endpoint_base_platform_0.baseRadius, endpoint_base_platform_0.length, 32, 12)
    : buildExtrudeGeometry({"points": [[9.4, -6.0], [9.517054, -5.988471], [9.62961, -5.954328], [9.733342, -5.898882], [9.824264, -5.824264], [9.898882, -5.733342], [9.954328, -5.62961], [9.988471, -5.517054], [10.0, -5.4], [10.0, 5.4], [9.988471, 5.517054], [9.954328, 5.62961], [9.898882, 5.733342], [9.824264, 5.824264], [9.733342, 5.898882], [9.62961, 5.954328], [9.517054, 5.988471], [9.4, 6.0], [-9.4, 6.0], [-9.517054, 5.988471], [-9.62961, 5.954328], [-9.733342, 5.898882], [-9.824264, 5.824264], [-9.898882, 5.733342], [-9.954328, 5.62961], [-9.988471, 5.517054], [-10.0, 5.4], [-10.0, -5.4], [-9.988471, -5.517054], [-9.954328, -5.62961], [-9.898882, -5.733342], [-9.824264, -5.824264], [-9.733342, -5.898882], [-9.62961, -5.954328], [-9.517054, -5.988471], [-9.4, -6.0]], "depth": 2.192639});
  if (!endpoint_base_platform_0) {
    mesh_base_platform_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_base_platform_0 = new THREE.Mesh(
    mesh_base_platform_0Geometry,
    materialMap["rubber-feet"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_base_platform_0.name = "Base platform";
  if (endpoint_base_platform_0) {
    mesh_base_platform_0.position.copy(endpoint_base_platform_0.midpoint);
    mesh_base_platform_0.quaternion.copy(endpoint_base_platform_0.quaternion);
  }
  mesh_base_platform_0.castShadow = options.castShadow ?? true;
  mesh_base_platform_0.receiveShadow = options.receiveShadow ?? true;
  node_base_platform_0.add(mesh_base_platform_0);
  meshes["base-platform"] = mesh_base_platform_0;

  const attachment_frame_front_1 = {"parentId": "base-platform", "parentSocket": "leg-sockets-front", "localStart": [-8.574785, -3.8, 1.792639], "localEnd": [-8.574785, -3.8, 1.792639], "contactType": "embed", "embedDepth": 0.4, "gapTolerance": 0.01, "baseRadius": 0.344558, "endRadius": 0.344558, "evidenceRefs": ["base-detail"], "notes": "Point socket (start == end): both legs embed LEG_EMBED into the base top at x=+-LEG_X; the tube path carries the geometry."};
  const endpoint_frame_front_1 = makeAttachmentEndpoint(attachment_frame_front_1);
  const node_frame_front_1 = new THREE.Group();
  node_frame_front_1.name = "Chrome frame (front)__pivot";
  node_frame_front_1.scale.set(1, 1, 1);
  if (endpoint_frame_front_1) {
    node_frame_front_1.position.copy(endpoint_frame_front_1.start);
    node_frame_front_1.rotation.set(1.570796, 0.0, 0.0);
  } else {
    node_frame_front_1.position.set(0.0, -3.8, -0.234926);
    node_frame_front_1.rotation.set(1.570796, 0.0, 0.0);
  }
  node_frame_front_1.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["base-platform"] ?? root).add(node_frame_front_1);
  nodes["frame-front"] = node_frame_front_1;
  const mesh_frame_front_1Geometry = endpoint_frame_front_1
    ? new THREE.CylinderGeometry(endpoint_frame_front_1.endRadius, endpoint_frame_front_1.baseRadius, endpoint_frame_front_1.length, 32, 12)
    : buildTubeGeometry({"points": [[-8.574785, 2.027565, 0], [-8.574785, 3.573258, 0], [-8.574785, 5.118951, 0], [-8.574785, 6.664644, 0], [-8.574785, 8.210337, 0], [-8.574785, 9.75603, 0], [-8.574785, 11.301723, 0], [-8.574785, 12.847416, 0], [-8.574785, 14.393109, 0], [-8.555224, 14.591713, 0], [-8.497293, 14.782685, 0], [-8.403219, 14.958685, 0], [-8.276616, 15.112951, 0], [-8.12235, 15.239554, 0], [-7.94635, 15.333628, 0], [-7.755378, 15.391559, 0], [-7.556774, 15.41112, 0], [-6.477235, 15.41112, 0], [-5.397695, 15.41112, 0], [-4.318156, 15.41112, 0], [-3.238617, 15.41112, 0], [-2.159078, 15.41112, 0], [-1.079539, 15.41112, 0], [0.0, 15.41112, 0], [1.079539, 15.41112, 0], [2.159078, 15.41112, 0], [3.238617, 15.41112, 0], [4.318156, 15.41112, 0], [5.397695, 15.41112, 0], [6.477235, 15.41112, 0], [7.556774, 15.41112, 0], [7.755378, 15.391559, 0], [7.94635, 15.333628, 0], [8.12235, 15.239554, 0], [8.276616, 15.112951, 0], [8.403219, 14.958685, 0], [8.497293, 14.782685, 0], [8.555224, 14.591713, 0], [8.574785, 14.393109, 0], [8.574785, 12.847416, 0], [8.574785, 11.301723, 0], [8.574785, 9.75603, 0], [8.574785, 8.210337, 0], [8.574785, 6.664644, 0], [8.574785, 5.118951, 0], [8.574785, 3.573258, 0], [8.574785, 2.027565, 0]], "radius": 0.344558, "radialSegments": 24, "closed": false});
  if (!endpoint_frame_front_1) {
    mesh_frame_front_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_frame_front_1 = new THREE.Mesh(
    mesh_frame_front_1Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_front_1.name = "Chrome frame (front)";
  if (endpoint_frame_front_1) {
    mesh_frame_front_1.position.copy(endpoint_frame_front_1.midpoint);
    mesh_frame_front_1.quaternion.copy(endpoint_frame_front_1.quaternion);
  }
  mesh_frame_front_1.castShadow = options.castShadow ?? true;
  mesh_frame_front_1.receiveShadow = options.receiveShadow ?? true;
  node_frame_front_1.add(mesh_frame_front_1);
  meshes["frame-front"] = mesh_frame_front_1;

  const attachment_frame_rear_2 = {"parentId": "base-platform", "parentSocket": "leg-sockets-rear", "localStart": [-8.574785, 3.8, 1.792639], "localEnd": [-8.574785, 3.8, 1.792639], "contactType": "embed", "embedDepth": 0.4, "gapTolerance": 0.01, "baseRadius": 0.344558, "endRadius": 0.344558, "evidenceRefs": ["base-detail"], "notes": "Point socket (start == end): both legs embed LEG_EMBED into the base top at x=+-LEG_X; the tube path carries the geometry."};
  const endpoint_frame_rear_2 = makeAttachmentEndpoint(attachment_frame_rear_2);
  const node_frame_rear_2 = new THREE.Group();
  node_frame_rear_2.name = "Chrome frame (rear)__pivot";
  node_frame_rear_2.scale.set(1, 1, 1);
  if (endpoint_frame_rear_2) {
    node_frame_rear_2.position.copy(endpoint_frame_rear_2.start);
    node_frame_rear_2.rotation.set(1.570796, 0.0, 0.0);
  } else {
    node_frame_rear_2.position.set(0.0, 3.8, -0.234926);
    node_frame_rear_2.rotation.set(1.570796, 0.0, 0.0);
  }
  node_frame_rear_2.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["base-platform"] ?? root).add(node_frame_rear_2);
  nodes["frame-rear"] = node_frame_rear_2;
  const mesh_frame_rear_2Geometry = endpoint_frame_rear_2
    ? new THREE.CylinderGeometry(endpoint_frame_rear_2.endRadius, endpoint_frame_rear_2.baseRadius, endpoint_frame_rear_2.length, 32, 12)
    : buildTubeGeometry({"points": [[-8.574785, 2.027565, 0], [-8.574785, 3.573258, 0], [-8.574785, 5.118951, 0], [-8.574785, 6.664644, 0], [-8.574785, 8.210337, 0], [-8.574785, 9.75603, 0], [-8.574785, 11.301723, 0], [-8.574785, 12.847416, 0], [-8.574785, 14.393109, 0], [-8.555224, 14.591713, 0], [-8.497293, 14.782685, 0], [-8.403219, 14.958685, 0], [-8.276616, 15.112951, 0], [-8.12235, 15.239554, 0], [-7.94635, 15.333628, 0], [-7.755378, 15.391559, 0], [-7.556774, 15.41112, 0], [-6.477235, 15.41112, 0], [-5.397695, 15.41112, 0], [-4.318156, 15.41112, 0], [-3.238617, 15.41112, 0], [-2.159078, 15.41112, 0], [-1.079539, 15.41112, 0], [0.0, 15.41112, 0], [1.079539, 15.41112, 0], [2.159078, 15.41112, 0], [3.238617, 15.41112, 0], [4.318156, 15.41112, 0], [5.397695, 15.41112, 0], [6.477235, 15.41112, 0], [7.556774, 15.41112, 0], [7.755378, 15.391559, 0], [7.94635, 15.333628, 0], [8.12235, 15.239554, 0], [8.276616, 15.112951, 0], [8.403219, 14.958685, 0], [8.497293, 14.782685, 0], [8.555224, 14.591713, 0], [8.574785, 14.393109, 0], [8.574785, 12.847416, 0], [8.574785, 11.301723, 0], [8.574785, 9.75603, 0], [8.574785, 8.210337, 0], [8.574785, 6.664644, 0], [8.574785, 5.118951, 0], [8.574785, 3.573258, 0], [8.574785, 2.027565, 0]], "radius": 0.344558, "radialSegments": 24, "closed": false});
  if (!endpoint_frame_rear_2) {
    mesh_frame_rear_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_frame_rear_2 = new THREE.Mesh(
    mesh_frame_rear_2Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_rear_2.name = "Chrome frame (rear)";
  if (endpoint_frame_rear_2) {
    mesh_frame_rear_2.position.copy(endpoint_frame_rear_2.midpoint);
    mesh_frame_rear_2.quaternion.copy(endpoint_frame_rear_2.quaternion);
  }
  mesh_frame_rear_2.castShadow = options.castShadow ?? true;
  mesh_frame_rear_2.receiveShadow = options.receiveShadow ?? true;
  node_frame_rear_2.add(mesh_frame_rear_2);
  meshes["frame-rear"] = mesh_frame_rear_2;

  const endpoint_ball_1_3 = makeAttachmentEndpoint(null);
  const node_ball_1_3 = new THREE.Group();
  node_ball_1_3.name = "Steel ball 1__pivot";
  node_ball_1_3.scale.set(1, 1, 1);
  if (endpoint_ball_1_3) {
    node_ball_1_3.position.copy(endpoint_ball_1_3.start);
    node_ball_1_3.rotation.set(1.570796, 0.0, 0.0);
  } else {
    node_ball_1_3.position.set(-5.456337, 0.0, 4.385278);
    node_ball_1_3.rotation.set(1.570796, 0.0, 0.0);
  }
  node_ball_1_3.userData.actionProfile = {"pivot": {"localPosition": [0, 10.410916, 0]}};
  (nodes["base-platform"] ?? root).add(node_ball_1_3);
  nodes["ball-1"] = node_ball_1_3;
  const mesh_ball_1_3Geometry = endpoint_ball_1_3
    ? new THREE.CylinderGeometry(endpoint_ball_1_3.endRadius, endpoint_ball_1_3.baseRadius, endpoint_ball_1_3.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ball_1_3) {
    mesh_ball_1_3Geometry.scale(2.728168, 2.728168, 2.728168);
  }
  const mesh_ball_1_3 = new THREE.Mesh(
    mesh_ball_1_3Geometry,
    materialMap["ball-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ball_1_3.name = "Steel ball 1";
  if (endpoint_ball_1_3) {
    mesh_ball_1_3.position.copy(endpoint_ball_1_3.midpoint);
    mesh_ball_1_3.quaternion.copy(endpoint_ball_1_3.quaternion);
  }
  mesh_ball_1_3.castShadow = options.castShadow ?? true;
  mesh_ball_1_3.receiveShadow = options.receiveShadow ?? true;
  node_ball_1_3.add(mesh_ball_1_3);
  meshes["ball-1"] = mesh_ball_1_3;

  const endpoint_cap_1_4 = makeAttachmentEndpoint(null);
  const node_cap_1_4 = new THREE.Group();
  node_cap_1_4.name = "Ball ferrule cap 1__pivot";
  node_cap_1_4.scale.set(1, 1, 1);
  if (endpoint_cap_1_4) {
    node_cap_1_4.position.copy(endpoint_cap_1_4.start);
    node_cap_1_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cap_1_4.position.set(0.0, 1.284084, 0.0);
    node_cap_1_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_cap_1_4.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-1"] ?? root).add(node_cap_1_4);
  nodes["cap-1"] = node_cap_1_4;
  const mesh_cap_1_4Geometry = endpoint_cap_1_4
    ? new THREE.CylinderGeometry(endpoint_cap_1_4.endRadius, endpoint_cap_1_4.baseRadius, endpoint_cap_1_4.length, 32, 12)
    : buildLatheGeometry({"points": [[0.00014, 0.0], [0.294, 0.0], [0.294, 0.308], [0.238, 0.42], [0.126, 0.462], [0.126, 0.7], [0.168, 0.728], [0.168, 0.84], [0.07, 0.868], [0.00014, 0.868]], "segments": 24});
  if (!endpoint_cap_1_4) {
    mesh_cap_1_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_1_4 = new THREE.Mesh(
    mesh_cap_1_4Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_1_4.name = "Ball ferrule cap 1";
  if (endpoint_cap_1_4) {
    mesh_cap_1_4.position.copy(endpoint_cap_1_4.midpoint);
    mesh_cap_1_4.quaternion.copy(endpoint_cap_1_4.quaternion);
  }
  mesh_cap_1_4.castShadow = options.castShadow ?? true;
  mesh_cap_1_4.receiveShadow = options.receiveShadow ?? true;
  node_cap_1_4.add(mesh_cap_1_4);
  meshes["cap-1"] = mesh_cap_1_4;

  const attachment_wire_1_front_5 = {"parentId": "ball-1", "parentSocket": "cap-1-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, 3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_1_front_5 = makeAttachmentEndpoint(attachment_wire_1_front_5);
  const node_wire_1_front_5 = new THREE.Group();
  node_wire_1_front_5.name = "Suspension wire 1 (front)__pivot";
  node_wire_1_front_5.scale.set(1, 1, 1);
  if (endpoint_wire_1_front_5) {
    node_wire_1_front_5.position.copy(endpoint_wire_1_front_5.start);
    node_wire_1_front_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_1_front_5.position.set(0.0, 2.096084, 0.0);
    node_wire_1_front_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_1_front_5.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-1"] ?? root).add(node_wire_1_front_5);
  nodes["wire-1-front"] = node_wire_1_front_5;
  const mesh_wire_1_front_5Geometry = endpoint_wire_1_front_5
    ? new THREE.CylinderGeometry(endpoint_wire_1_front_5.endRadius, endpoint_wire_1_front_5.baseRadius, endpoint_wire_1_front_5.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_1_front_5) {
    mesh_wire_1_front_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_1_front_5 = new THREE.Mesh(
    mesh_wire_1_front_5Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_1_front_5.name = "Suspension wire 1 (front)";
  if (endpoint_wire_1_front_5) {
    mesh_wire_1_front_5.position.copy(endpoint_wire_1_front_5.midpoint);
    mesh_wire_1_front_5.quaternion.copy(endpoint_wire_1_front_5.quaternion);
  }
  mesh_wire_1_front_5.castShadow = options.castShadow ?? true;
  mesh_wire_1_front_5.receiveShadow = options.receiveShadow ?? true;
  node_wire_1_front_5.add(mesh_wire_1_front_5);
  meshes["wire-1-front"] = mesh_wire_1_front_5;

  const attachment_wire_1_rear_6 = {"parentId": "ball-1", "parentSocket": "cap-1-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, -3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_1_rear_6 = makeAttachmentEndpoint(attachment_wire_1_rear_6);
  const node_wire_1_rear_6 = new THREE.Group();
  node_wire_1_rear_6.name = "Suspension wire 1 (rear)__pivot";
  node_wire_1_rear_6.scale.set(1, 1, 1);
  if (endpoint_wire_1_rear_6) {
    node_wire_1_rear_6.position.copy(endpoint_wire_1_rear_6.start);
    node_wire_1_rear_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_1_rear_6.position.set(0.0, 2.096084, 0.0);
    node_wire_1_rear_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_1_rear_6.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-1"] ?? root).add(node_wire_1_rear_6);
  nodes["wire-1-rear"] = node_wire_1_rear_6;
  const mesh_wire_1_rear_6Geometry = endpoint_wire_1_rear_6
    ? new THREE.CylinderGeometry(endpoint_wire_1_rear_6.endRadius, endpoint_wire_1_rear_6.baseRadius, endpoint_wire_1_rear_6.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_1_rear_6) {
    mesh_wire_1_rear_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_1_rear_6 = new THREE.Mesh(
    mesh_wire_1_rear_6Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_1_rear_6.name = "Suspension wire 1 (rear)";
  if (endpoint_wire_1_rear_6) {
    mesh_wire_1_rear_6.position.copy(endpoint_wire_1_rear_6.midpoint);
    mesh_wire_1_rear_6.quaternion.copy(endpoint_wire_1_rear_6.quaternion);
  }
  mesh_wire_1_rear_6.castShadow = options.castShadow ?? true;
  mesh_wire_1_rear_6.receiveShadow = options.receiveShadow ?? true;
  node_wire_1_rear_6.add(mesh_wire_1_rear_6);
  meshes["wire-1-rear"] = mesh_wire_1_rear_6;

  const endpoint_ball_2_7 = makeAttachmentEndpoint(null);
  const node_ball_2_7 = new THREE.Group();
  node_ball_2_7.name = "Steel ball 2__pivot";
  node_ball_2_7.scale.set(1, 1, 1);
  if (endpoint_ball_2_7) {
    node_ball_2_7.position.copy(endpoint_ball_2_7.start);
    node_ball_2_7.rotation.set(1.570796, 0.0, 0.0);
  } else {
    node_ball_2_7.position.set(-2.728168, 0.0, 4.385278);
    node_ball_2_7.rotation.set(1.570796, 0.0, 0.0);
  }
  node_ball_2_7.userData.actionProfile = {"pivot": {"localPosition": [0, 10.410916, 0]}};
  (nodes["base-platform"] ?? root).add(node_ball_2_7);
  nodes["ball-2"] = node_ball_2_7;
  const mesh_ball_2_7Geometry = endpoint_ball_2_7
    ? new THREE.CylinderGeometry(endpoint_ball_2_7.endRadius, endpoint_ball_2_7.baseRadius, endpoint_ball_2_7.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ball_2_7) {
    mesh_ball_2_7Geometry.scale(2.728168, 2.728168, 2.728168);
  }
  const mesh_ball_2_7 = new THREE.Mesh(
    mesh_ball_2_7Geometry,
    materialMap["ball-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ball_2_7.name = "Steel ball 2";
  if (endpoint_ball_2_7) {
    mesh_ball_2_7.position.copy(endpoint_ball_2_7.midpoint);
    mesh_ball_2_7.quaternion.copy(endpoint_ball_2_7.quaternion);
  }
  mesh_ball_2_7.castShadow = options.castShadow ?? true;
  mesh_ball_2_7.receiveShadow = options.receiveShadow ?? true;
  node_ball_2_7.add(mesh_ball_2_7);
  meshes["ball-2"] = mesh_ball_2_7;

  const endpoint_cap_2_8 = makeAttachmentEndpoint(null);
  const node_cap_2_8 = new THREE.Group();
  node_cap_2_8.name = "Ball ferrule cap 2__pivot";
  node_cap_2_8.scale.set(1, 1, 1);
  if (endpoint_cap_2_8) {
    node_cap_2_8.position.copy(endpoint_cap_2_8.start);
    node_cap_2_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cap_2_8.position.set(0.0, 1.284084, 0.0);
    node_cap_2_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_cap_2_8.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-2"] ?? root).add(node_cap_2_8);
  nodes["cap-2"] = node_cap_2_8;
  const mesh_cap_2_8Geometry = endpoint_cap_2_8
    ? new THREE.CylinderGeometry(endpoint_cap_2_8.endRadius, endpoint_cap_2_8.baseRadius, endpoint_cap_2_8.length, 32, 12)
    : buildLatheGeometry({"points": [[0.00014, 0.0], [0.294, 0.0], [0.294, 0.308], [0.238, 0.42], [0.126, 0.462], [0.126, 0.7], [0.168, 0.728], [0.168, 0.84], [0.07, 0.868], [0.00014, 0.868]], "segments": 24});
  if (!endpoint_cap_2_8) {
    mesh_cap_2_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_2_8 = new THREE.Mesh(
    mesh_cap_2_8Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_2_8.name = "Ball ferrule cap 2";
  if (endpoint_cap_2_8) {
    mesh_cap_2_8.position.copy(endpoint_cap_2_8.midpoint);
    mesh_cap_2_8.quaternion.copy(endpoint_cap_2_8.quaternion);
  }
  mesh_cap_2_8.castShadow = options.castShadow ?? true;
  mesh_cap_2_8.receiveShadow = options.receiveShadow ?? true;
  node_cap_2_8.add(mesh_cap_2_8);
  meshes["cap-2"] = mesh_cap_2_8;

  const attachment_wire_2_front_9 = {"parentId": "ball-2", "parentSocket": "cap-2-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, 3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_2_front_9 = makeAttachmentEndpoint(attachment_wire_2_front_9);
  const node_wire_2_front_9 = new THREE.Group();
  node_wire_2_front_9.name = "Suspension wire 2 (front)__pivot";
  node_wire_2_front_9.scale.set(1, 1, 1);
  if (endpoint_wire_2_front_9) {
    node_wire_2_front_9.position.copy(endpoint_wire_2_front_9.start);
    node_wire_2_front_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_2_front_9.position.set(0.0, 2.096084, 0.0);
    node_wire_2_front_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_2_front_9.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-2"] ?? root).add(node_wire_2_front_9);
  nodes["wire-2-front"] = node_wire_2_front_9;
  const mesh_wire_2_front_9Geometry = endpoint_wire_2_front_9
    ? new THREE.CylinderGeometry(endpoint_wire_2_front_9.endRadius, endpoint_wire_2_front_9.baseRadius, endpoint_wire_2_front_9.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_2_front_9) {
    mesh_wire_2_front_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_2_front_9 = new THREE.Mesh(
    mesh_wire_2_front_9Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_2_front_9.name = "Suspension wire 2 (front)";
  if (endpoint_wire_2_front_9) {
    mesh_wire_2_front_9.position.copy(endpoint_wire_2_front_9.midpoint);
    mesh_wire_2_front_9.quaternion.copy(endpoint_wire_2_front_9.quaternion);
  }
  mesh_wire_2_front_9.castShadow = options.castShadow ?? true;
  mesh_wire_2_front_9.receiveShadow = options.receiveShadow ?? true;
  node_wire_2_front_9.add(mesh_wire_2_front_9);
  meshes["wire-2-front"] = mesh_wire_2_front_9;

  const attachment_wire_2_rear_10 = {"parentId": "ball-2", "parentSocket": "cap-2-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, -3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_2_rear_10 = makeAttachmentEndpoint(attachment_wire_2_rear_10);
  const node_wire_2_rear_10 = new THREE.Group();
  node_wire_2_rear_10.name = "Suspension wire 2 (rear)__pivot";
  node_wire_2_rear_10.scale.set(1, 1, 1);
  if (endpoint_wire_2_rear_10) {
    node_wire_2_rear_10.position.copy(endpoint_wire_2_rear_10.start);
    node_wire_2_rear_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_2_rear_10.position.set(0.0, 2.096084, 0.0);
    node_wire_2_rear_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_2_rear_10.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-2"] ?? root).add(node_wire_2_rear_10);
  nodes["wire-2-rear"] = node_wire_2_rear_10;
  const mesh_wire_2_rear_10Geometry = endpoint_wire_2_rear_10
    ? new THREE.CylinderGeometry(endpoint_wire_2_rear_10.endRadius, endpoint_wire_2_rear_10.baseRadius, endpoint_wire_2_rear_10.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_2_rear_10) {
    mesh_wire_2_rear_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_2_rear_10 = new THREE.Mesh(
    mesh_wire_2_rear_10Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_2_rear_10.name = "Suspension wire 2 (rear)";
  if (endpoint_wire_2_rear_10) {
    mesh_wire_2_rear_10.position.copy(endpoint_wire_2_rear_10.midpoint);
    mesh_wire_2_rear_10.quaternion.copy(endpoint_wire_2_rear_10.quaternion);
  }
  mesh_wire_2_rear_10.castShadow = options.castShadow ?? true;
  mesh_wire_2_rear_10.receiveShadow = options.receiveShadow ?? true;
  node_wire_2_rear_10.add(mesh_wire_2_rear_10);
  meshes["wire-2-rear"] = mesh_wire_2_rear_10;

  const endpoint_ball_3_11 = makeAttachmentEndpoint(null);
  const node_ball_3_11 = new THREE.Group();
  node_ball_3_11.name = "Steel ball 3__pivot";
  node_ball_3_11.scale.set(1, 1, 1);
  if (endpoint_ball_3_11) {
    node_ball_3_11.position.copy(endpoint_ball_3_11.start);
    node_ball_3_11.rotation.set(1.570796, 0.0, 0.0);
  } else {
    node_ball_3_11.position.set(0.0, 0.0, 4.385278);
    node_ball_3_11.rotation.set(1.570796, 0.0, 0.0);
  }
  node_ball_3_11.userData.actionProfile = {"pivot": {"localPosition": [0, 10.410916, 0]}};
  (nodes["base-platform"] ?? root).add(node_ball_3_11);
  nodes["ball-3"] = node_ball_3_11;
  const mesh_ball_3_11Geometry = endpoint_ball_3_11
    ? new THREE.CylinderGeometry(endpoint_ball_3_11.endRadius, endpoint_ball_3_11.baseRadius, endpoint_ball_3_11.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ball_3_11) {
    mesh_ball_3_11Geometry.scale(2.728168, 2.728168, 2.728168);
  }
  const mesh_ball_3_11 = new THREE.Mesh(
    mesh_ball_3_11Geometry,
    materialMap["ball-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ball_3_11.name = "Steel ball 3";
  if (endpoint_ball_3_11) {
    mesh_ball_3_11.position.copy(endpoint_ball_3_11.midpoint);
    mesh_ball_3_11.quaternion.copy(endpoint_ball_3_11.quaternion);
  }
  mesh_ball_3_11.castShadow = options.castShadow ?? true;
  mesh_ball_3_11.receiveShadow = options.receiveShadow ?? true;
  node_ball_3_11.add(mesh_ball_3_11);
  meshes["ball-3"] = mesh_ball_3_11;

  const endpoint_cap_3_12 = makeAttachmentEndpoint(null);
  const node_cap_3_12 = new THREE.Group();
  node_cap_3_12.name = "Ball ferrule cap 3__pivot";
  node_cap_3_12.scale.set(1, 1, 1);
  if (endpoint_cap_3_12) {
    node_cap_3_12.position.copy(endpoint_cap_3_12.start);
    node_cap_3_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cap_3_12.position.set(0.0, 1.284084, 0.0);
    node_cap_3_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_cap_3_12.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-3"] ?? root).add(node_cap_3_12);
  nodes["cap-3"] = node_cap_3_12;
  const mesh_cap_3_12Geometry = endpoint_cap_3_12
    ? new THREE.CylinderGeometry(endpoint_cap_3_12.endRadius, endpoint_cap_3_12.baseRadius, endpoint_cap_3_12.length, 32, 12)
    : buildLatheGeometry({"points": [[0.00014, 0.0], [0.294, 0.0], [0.294, 0.308], [0.238, 0.42], [0.126, 0.462], [0.126, 0.7], [0.168, 0.728], [0.168, 0.84], [0.07, 0.868], [0.00014, 0.868]], "segments": 24});
  if (!endpoint_cap_3_12) {
    mesh_cap_3_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_3_12 = new THREE.Mesh(
    mesh_cap_3_12Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_3_12.name = "Ball ferrule cap 3";
  if (endpoint_cap_3_12) {
    mesh_cap_3_12.position.copy(endpoint_cap_3_12.midpoint);
    mesh_cap_3_12.quaternion.copy(endpoint_cap_3_12.quaternion);
  }
  mesh_cap_3_12.castShadow = options.castShadow ?? true;
  mesh_cap_3_12.receiveShadow = options.receiveShadow ?? true;
  node_cap_3_12.add(mesh_cap_3_12);
  meshes["cap-3"] = mesh_cap_3_12;

  const attachment_wire_3_front_13 = {"parentId": "ball-3", "parentSocket": "cap-3-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, 3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_3_front_13 = makeAttachmentEndpoint(attachment_wire_3_front_13);
  const node_wire_3_front_13 = new THREE.Group();
  node_wire_3_front_13.name = "Suspension wire 3 (front)__pivot";
  node_wire_3_front_13.scale.set(1, 1, 1);
  if (endpoint_wire_3_front_13) {
    node_wire_3_front_13.position.copy(endpoint_wire_3_front_13.start);
    node_wire_3_front_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_3_front_13.position.set(0.0, 2.096084, 0.0);
    node_wire_3_front_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_3_front_13.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-3"] ?? root).add(node_wire_3_front_13);
  nodes["wire-3-front"] = node_wire_3_front_13;
  const mesh_wire_3_front_13Geometry = endpoint_wire_3_front_13
    ? new THREE.CylinderGeometry(endpoint_wire_3_front_13.endRadius, endpoint_wire_3_front_13.baseRadius, endpoint_wire_3_front_13.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_3_front_13) {
    mesh_wire_3_front_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_3_front_13 = new THREE.Mesh(
    mesh_wire_3_front_13Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_3_front_13.name = "Suspension wire 3 (front)";
  if (endpoint_wire_3_front_13) {
    mesh_wire_3_front_13.position.copy(endpoint_wire_3_front_13.midpoint);
    mesh_wire_3_front_13.quaternion.copy(endpoint_wire_3_front_13.quaternion);
  }
  mesh_wire_3_front_13.castShadow = options.castShadow ?? true;
  mesh_wire_3_front_13.receiveShadow = options.receiveShadow ?? true;
  node_wire_3_front_13.add(mesh_wire_3_front_13);
  meshes["wire-3-front"] = mesh_wire_3_front_13;

  const attachment_wire_3_rear_14 = {"parentId": "ball-3", "parentSocket": "cap-3-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, -3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_3_rear_14 = makeAttachmentEndpoint(attachment_wire_3_rear_14);
  const node_wire_3_rear_14 = new THREE.Group();
  node_wire_3_rear_14.name = "Suspension wire 3 (rear)__pivot";
  node_wire_3_rear_14.scale.set(1, 1, 1);
  if (endpoint_wire_3_rear_14) {
    node_wire_3_rear_14.position.copy(endpoint_wire_3_rear_14.start);
    node_wire_3_rear_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_3_rear_14.position.set(0.0, 2.096084, 0.0);
    node_wire_3_rear_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_3_rear_14.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-3"] ?? root).add(node_wire_3_rear_14);
  nodes["wire-3-rear"] = node_wire_3_rear_14;
  const mesh_wire_3_rear_14Geometry = endpoint_wire_3_rear_14
    ? new THREE.CylinderGeometry(endpoint_wire_3_rear_14.endRadius, endpoint_wire_3_rear_14.baseRadius, endpoint_wire_3_rear_14.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_3_rear_14) {
    mesh_wire_3_rear_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_3_rear_14 = new THREE.Mesh(
    mesh_wire_3_rear_14Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_3_rear_14.name = "Suspension wire 3 (rear)";
  if (endpoint_wire_3_rear_14) {
    mesh_wire_3_rear_14.position.copy(endpoint_wire_3_rear_14.midpoint);
    mesh_wire_3_rear_14.quaternion.copy(endpoint_wire_3_rear_14.quaternion);
  }
  mesh_wire_3_rear_14.castShadow = options.castShadow ?? true;
  mesh_wire_3_rear_14.receiveShadow = options.receiveShadow ?? true;
  node_wire_3_rear_14.add(mesh_wire_3_rear_14);
  meshes["wire-3-rear"] = mesh_wire_3_rear_14;

  const endpoint_ball_4_15 = makeAttachmentEndpoint(null);
  const node_ball_4_15 = new THREE.Group();
  node_ball_4_15.name = "Steel ball 4__pivot";
  node_ball_4_15.scale.set(1, 1, 1);
  if (endpoint_ball_4_15) {
    node_ball_4_15.position.copy(endpoint_ball_4_15.start);
    node_ball_4_15.rotation.set(1.570796, 0.0, 0.0);
  } else {
    node_ball_4_15.position.set(2.728168, 0.0, 4.385278);
    node_ball_4_15.rotation.set(1.570796, 0.0, 0.0);
  }
  node_ball_4_15.userData.actionProfile = {"pivot": {"localPosition": [0, 10.410916, 0]}};
  (nodes["base-platform"] ?? root).add(node_ball_4_15);
  nodes["ball-4"] = node_ball_4_15;
  const mesh_ball_4_15Geometry = endpoint_ball_4_15
    ? new THREE.CylinderGeometry(endpoint_ball_4_15.endRadius, endpoint_ball_4_15.baseRadius, endpoint_ball_4_15.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ball_4_15) {
    mesh_ball_4_15Geometry.scale(2.728168, 2.728168, 2.728168);
  }
  const mesh_ball_4_15 = new THREE.Mesh(
    mesh_ball_4_15Geometry,
    materialMap["ball-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ball_4_15.name = "Steel ball 4";
  if (endpoint_ball_4_15) {
    mesh_ball_4_15.position.copy(endpoint_ball_4_15.midpoint);
    mesh_ball_4_15.quaternion.copy(endpoint_ball_4_15.quaternion);
  }
  mesh_ball_4_15.castShadow = options.castShadow ?? true;
  mesh_ball_4_15.receiveShadow = options.receiveShadow ?? true;
  node_ball_4_15.add(mesh_ball_4_15);
  meshes["ball-4"] = mesh_ball_4_15;

  const endpoint_cap_4_16 = makeAttachmentEndpoint(null);
  const node_cap_4_16 = new THREE.Group();
  node_cap_4_16.name = "Ball ferrule cap 4__pivot";
  node_cap_4_16.scale.set(1, 1, 1);
  if (endpoint_cap_4_16) {
    node_cap_4_16.position.copy(endpoint_cap_4_16.start);
    node_cap_4_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cap_4_16.position.set(0.0, 1.284084, 0.0);
    node_cap_4_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_cap_4_16.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-4"] ?? root).add(node_cap_4_16);
  nodes["cap-4"] = node_cap_4_16;
  const mesh_cap_4_16Geometry = endpoint_cap_4_16
    ? new THREE.CylinderGeometry(endpoint_cap_4_16.endRadius, endpoint_cap_4_16.baseRadius, endpoint_cap_4_16.length, 32, 12)
    : buildLatheGeometry({"points": [[0.00014, 0.0], [0.294, 0.0], [0.294, 0.308], [0.238, 0.42], [0.126, 0.462], [0.126, 0.7], [0.168, 0.728], [0.168, 0.84], [0.07, 0.868], [0.00014, 0.868]], "segments": 24});
  if (!endpoint_cap_4_16) {
    mesh_cap_4_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_4_16 = new THREE.Mesh(
    mesh_cap_4_16Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_4_16.name = "Ball ferrule cap 4";
  if (endpoint_cap_4_16) {
    mesh_cap_4_16.position.copy(endpoint_cap_4_16.midpoint);
    mesh_cap_4_16.quaternion.copy(endpoint_cap_4_16.quaternion);
  }
  mesh_cap_4_16.castShadow = options.castShadow ?? true;
  mesh_cap_4_16.receiveShadow = options.receiveShadow ?? true;
  node_cap_4_16.add(mesh_cap_4_16);
  meshes["cap-4"] = mesh_cap_4_16;

  const attachment_wire_4_front_17 = {"parentId": "ball-4", "parentSocket": "cap-4-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, 3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_4_front_17 = makeAttachmentEndpoint(attachment_wire_4_front_17);
  const node_wire_4_front_17 = new THREE.Group();
  node_wire_4_front_17.name = "Suspension wire 4 (front)__pivot";
  node_wire_4_front_17.scale.set(1, 1, 1);
  if (endpoint_wire_4_front_17) {
    node_wire_4_front_17.position.copy(endpoint_wire_4_front_17.start);
    node_wire_4_front_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_4_front_17.position.set(0.0, 2.096084, 0.0);
    node_wire_4_front_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_4_front_17.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-4"] ?? root).add(node_wire_4_front_17);
  nodes["wire-4-front"] = node_wire_4_front_17;
  const mesh_wire_4_front_17Geometry = endpoint_wire_4_front_17
    ? new THREE.CylinderGeometry(endpoint_wire_4_front_17.endRadius, endpoint_wire_4_front_17.baseRadius, endpoint_wire_4_front_17.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_4_front_17) {
    mesh_wire_4_front_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_4_front_17 = new THREE.Mesh(
    mesh_wire_4_front_17Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_4_front_17.name = "Suspension wire 4 (front)";
  if (endpoint_wire_4_front_17) {
    mesh_wire_4_front_17.position.copy(endpoint_wire_4_front_17.midpoint);
    mesh_wire_4_front_17.quaternion.copy(endpoint_wire_4_front_17.quaternion);
  }
  mesh_wire_4_front_17.castShadow = options.castShadow ?? true;
  mesh_wire_4_front_17.receiveShadow = options.receiveShadow ?? true;
  node_wire_4_front_17.add(mesh_wire_4_front_17);
  meshes["wire-4-front"] = mesh_wire_4_front_17;

  const attachment_wire_4_rear_18 = {"parentId": "ball-4", "parentSocket": "cap-4-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, -3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_4_rear_18 = makeAttachmentEndpoint(attachment_wire_4_rear_18);
  const node_wire_4_rear_18 = new THREE.Group();
  node_wire_4_rear_18.name = "Suspension wire 4 (rear)__pivot";
  node_wire_4_rear_18.scale.set(1, 1, 1);
  if (endpoint_wire_4_rear_18) {
    node_wire_4_rear_18.position.copy(endpoint_wire_4_rear_18.start);
    node_wire_4_rear_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_4_rear_18.position.set(0.0, 2.096084, 0.0);
    node_wire_4_rear_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_4_rear_18.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-4"] ?? root).add(node_wire_4_rear_18);
  nodes["wire-4-rear"] = node_wire_4_rear_18;
  const mesh_wire_4_rear_18Geometry = endpoint_wire_4_rear_18
    ? new THREE.CylinderGeometry(endpoint_wire_4_rear_18.endRadius, endpoint_wire_4_rear_18.baseRadius, endpoint_wire_4_rear_18.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_4_rear_18) {
    mesh_wire_4_rear_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_4_rear_18 = new THREE.Mesh(
    mesh_wire_4_rear_18Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_4_rear_18.name = "Suspension wire 4 (rear)";
  if (endpoint_wire_4_rear_18) {
    mesh_wire_4_rear_18.position.copy(endpoint_wire_4_rear_18.midpoint);
    mesh_wire_4_rear_18.quaternion.copy(endpoint_wire_4_rear_18.quaternion);
  }
  mesh_wire_4_rear_18.castShadow = options.castShadow ?? true;
  mesh_wire_4_rear_18.receiveShadow = options.receiveShadow ?? true;
  node_wire_4_rear_18.add(mesh_wire_4_rear_18);
  meshes["wire-4-rear"] = mesh_wire_4_rear_18;

  const endpoint_ball_5_19 = makeAttachmentEndpoint(null);
  const node_ball_5_19 = new THREE.Group();
  node_ball_5_19.name = "Steel ball 5__pivot";
  node_ball_5_19.scale.set(1, 1, 1);
  if (endpoint_ball_5_19) {
    node_ball_5_19.position.copy(endpoint_ball_5_19.start);
    node_ball_5_19.rotation.set(1.570796, 0.0, 0.0);
  } else {
    node_ball_5_19.position.set(5.456337, 0.0, 4.385278);
    node_ball_5_19.rotation.set(1.570796, 0.0, 0.0);
  }
  node_ball_5_19.userData.actionProfile = {"pivot": {"localPosition": [0, 10.410916, 0]}};
  (nodes["base-platform"] ?? root).add(node_ball_5_19);
  nodes["ball-5"] = node_ball_5_19;
  const mesh_ball_5_19Geometry = endpoint_ball_5_19
    ? new THREE.CylinderGeometry(endpoint_ball_5_19.endRadius, endpoint_ball_5_19.baseRadius, endpoint_ball_5_19.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ball_5_19) {
    mesh_ball_5_19Geometry.scale(2.728168, 2.728168, 2.728168);
  }
  const mesh_ball_5_19 = new THREE.Mesh(
    mesh_ball_5_19Geometry,
    materialMap["ball-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ball_5_19.name = "Steel ball 5";
  if (endpoint_ball_5_19) {
    mesh_ball_5_19.position.copy(endpoint_ball_5_19.midpoint);
    mesh_ball_5_19.quaternion.copy(endpoint_ball_5_19.quaternion);
  }
  mesh_ball_5_19.castShadow = options.castShadow ?? true;
  mesh_ball_5_19.receiveShadow = options.receiveShadow ?? true;
  node_ball_5_19.add(mesh_ball_5_19);
  meshes["ball-5"] = mesh_ball_5_19;

  const endpoint_cap_5_20 = makeAttachmentEndpoint(null);
  const node_cap_5_20 = new THREE.Group();
  node_cap_5_20.name = "Ball ferrule cap 5__pivot";
  node_cap_5_20.scale.set(1, 1, 1);
  if (endpoint_cap_5_20) {
    node_cap_5_20.position.copy(endpoint_cap_5_20.start);
    node_cap_5_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cap_5_20.position.set(0.0, 1.284084, 0.0);
    node_cap_5_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_cap_5_20.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-5"] ?? root).add(node_cap_5_20);
  nodes["cap-5"] = node_cap_5_20;
  const mesh_cap_5_20Geometry = endpoint_cap_5_20
    ? new THREE.CylinderGeometry(endpoint_cap_5_20.endRadius, endpoint_cap_5_20.baseRadius, endpoint_cap_5_20.length, 32, 12)
    : buildLatheGeometry({"points": [[0.00014, 0.0], [0.294, 0.0], [0.294, 0.308], [0.238, 0.42], [0.126, 0.462], [0.126, 0.7], [0.168, 0.728], [0.168, 0.84], [0.07, 0.868], [0.00014, 0.868]], "segments": 24});
  if (!endpoint_cap_5_20) {
    mesh_cap_5_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_5_20 = new THREE.Mesh(
    mesh_cap_5_20Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_5_20.name = "Ball ferrule cap 5";
  if (endpoint_cap_5_20) {
    mesh_cap_5_20.position.copy(endpoint_cap_5_20.midpoint);
    mesh_cap_5_20.quaternion.copy(endpoint_cap_5_20.quaternion);
  }
  mesh_cap_5_20.castShadow = options.castShadow ?? true;
  mesh_cap_5_20.receiveShadow = options.receiveShadow ?? true;
  node_cap_5_20.add(mesh_cap_5_20);
  meshes["cap-5"] = mesh_cap_5_20;

  const attachment_wire_5_front_21 = {"parentId": "ball-5", "parentSocket": "cap-5-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, 3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_5_front_21 = makeAttachmentEndpoint(attachment_wire_5_front_21);
  const node_wire_5_front_21 = new THREE.Group();
  node_wire_5_front_21.name = "Suspension wire 5 (front)__pivot";
  node_wire_5_front_21.scale.set(1, 1, 1);
  if (endpoint_wire_5_front_21) {
    node_wire_5_front_21.position.copy(endpoint_wire_5_front_21.start);
    node_wire_5_front_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_5_front_21.position.set(0.0, 2.096084, 0.0);
    node_wire_5_front_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_5_front_21.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-5"] ?? root).add(node_wire_5_front_21);
  nodes["wire-5-front"] = node_wire_5_front_21;
  const mesh_wire_5_front_21Geometry = endpoint_wire_5_front_21
    ? new THREE.CylinderGeometry(endpoint_wire_5_front_21.endRadius, endpoint_wire_5_front_21.baseRadius, endpoint_wire_5_front_21.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_5_front_21) {
    mesh_wire_5_front_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_5_front_21 = new THREE.Mesh(
    mesh_wire_5_front_21Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_5_front_21.name = "Suspension wire 5 (front)";
  if (endpoint_wire_5_front_21) {
    mesh_wire_5_front_21.position.copy(endpoint_wire_5_front_21.midpoint);
    mesh_wire_5_front_21.quaternion.copy(endpoint_wire_5_front_21.quaternion);
  }
  mesh_wire_5_front_21.castShadow = options.castShadow ?? true;
  mesh_wire_5_front_21.receiveShadow = options.receiveShadow ?? true;
  node_wire_5_front_21.add(mesh_wire_5_front_21);
  meshes["wire-5-front"] = mesh_wire_5_front_21;

  const attachment_wire_5_rear_22 = {"parentId": "ball-5", "parentSocket": "cap-5-tip", "localStart": [0, 2.096084, 0], "localEnd": [0, 10.410916, -3.8], "contactType": "embed", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.018, "endRadius": 0.018, "evidenceRefs": ["rail-detail"]};
  const endpoint_wire_5_rear_22 = makeAttachmentEndpoint(attachment_wire_5_rear_22);
  const node_wire_5_rear_22 = new THREE.Group();
  node_wire_5_rear_22.name = "Suspension wire 5 (rear)__pivot";
  node_wire_5_rear_22.scale.set(1, 1, 1);
  if (endpoint_wire_5_rear_22) {
    node_wire_5_rear_22.position.copy(endpoint_wire_5_rear_22.start);
    node_wire_5_rear_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wire_5_rear_22.position.set(0.0, 2.096084, 0.0);
    node_wire_5_rear_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_wire_5_rear_22.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["ball-5"] ?? root).add(node_wire_5_rear_22);
  nodes["wire-5-rear"] = node_wire_5_rear_22;
  const mesh_wire_5_rear_22Geometry = endpoint_wire_5_rear_22
    ? new THREE.CylinderGeometry(endpoint_wire_5_rear_22.endRadius, endpoint_wire_5_rear_22.baseRadius, endpoint_wire_5_rear_22.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wire_5_rear_22) {
    mesh_wire_5_rear_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wire_5_rear_22 = new THREE.Mesh(
    mesh_wire_5_rear_22Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wire_5_rear_22.name = "Suspension wire 5 (rear)";
  if (endpoint_wire_5_rear_22) {
    mesh_wire_5_rear_22.position.copy(endpoint_wire_5_rear_22.midpoint);
    mesh_wire_5_rear_22.quaternion.copy(endpoint_wire_5_rear_22.quaternion);
  }
  mesh_wire_5_rear_22.castShadow = options.castShadow ?? true;
  mesh_wire_5_rear_22.receiveShadow = options.receiveShadow ?? true;
  node_wire_5_rear_22.add(mesh_wire_5_rear_22);
  meshes["wire-5-rear"] = mesh_wire_5_rear_22;

  const endpoint_clamp_1_front_23 = makeAttachmentEndpoint(null);
  const node_clamp_1_front_23 = new THREE.Group();
  node_clamp_1_front_23.name = "Rail clamp 1 (front)__pivot";
  node_clamp_1_front_23.scale.set(1, 1, 1);
  if (endpoint_clamp_1_front_23) {
    node_clamp_1_front_23.position.copy(endpoint_clamp_1_front_23.start);
    node_clamp_1_front_23.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_1_front_23.position.set(-5.456337, 15.41112, 0.0);
    node_clamp_1_front_23.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_1_front_23.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-front"] ?? root).add(node_clamp_1_front_23);
  nodes["clamp-1-front"] = node_clamp_1_front_23;
  const mesh_clamp_1_front_23Geometry = endpoint_clamp_1_front_23
    ? new THREE.CylinderGeometry(endpoint_clamp_1_front_23.endRadius, endpoint_clamp_1_front_23.baseRadius, endpoint_clamp_1_front_23.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_1_front_23) {
    mesh_clamp_1_front_23Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_1_front_23 = new THREE.Mesh(
    mesh_clamp_1_front_23Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_1_front_23.name = "Rail clamp 1 (front)";
  if (endpoint_clamp_1_front_23) {
    mesh_clamp_1_front_23.position.copy(endpoint_clamp_1_front_23.midpoint);
    mesh_clamp_1_front_23.quaternion.copy(endpoint_clamp_1_front_23.quaternion);
  }
  mesh_clamp_1_front_23.castShadow = options.castShadow ?? true;
  mesh_clamp_1_front_23.receiveShadow = options.receiveShadow ?? true;
  node_clamp_1_front_23.add(mesh_clamp_1_front_23);
  meshes["clamp-1-front"] = mesh_clamp_1_front_23;

  const endpoint_clamp_2_front_24 = makeAttachmentEndpoint(null);
  const node_clamp_2_front_24 = new THREE.Group();
  node_clamp_2_front_24.name = "Rail clamp 2 (front)__pivot";
  node_clamp_2_front_24.scale.set(1, 1, 1);
  if (endpoint_clamp_2_front_24) {
    node_clamp_2_front_24.position.copy(endpoint_clamp_2_front_24.start);
    node_clamp_2_front_24.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_2_front_24.position.set(-2.728168, 15.41112, 0.0);
    node_clamp_2_front_24.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_2_front_24.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-front"] ?? root).add(node_clamp_2_front_24);
  nodes["clamp-2-front"] = node_clamp_2_front_24;
  const mesh_clamp_2_front_24Geometry = endpoint_clamp_2_front_24
    ? new THREE.CylinderGeometry(endpoint_clamp_2_front_24.endRadius, endpoint_clamp_2_front_24.baseRadius, endpoint_clamp_2_front_24.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_2_front_24) {
    mesh_clamp_2_front_24Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_2_front_24 = new THREE.Mesh(
    mesh_clamp_2_front_24Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_2_front_24.name = "Rail clamp 2 (front)";
  if (endpoint_clamp_2_front_24) {
    mesh_clamp_2_front_24.position.copy(endpoint_clamp_2_front_24.midpoint);
    mesh_clamp_2_front_24.quaternion.copy(endpoint_clamp_2_front_24.quaternion);
  }
  mesh_clamp_2_front_24.castShadow = options.castShadow ?? true;
  mesh_clamp_2_front_24.receiveShadow = options.receiveShadow ?? true;
  node_clamp_2_front_24.add(mesh_clamp_2_front_24);
  meshes["clamp-2-front"] = mesh_clamp_2_front_24;

  const endpoint_clamp_3_front_25 = makeAttachmentEndpoint(null);
  const node_clamp_3_front_25 = new THREE.Group();
  node_clamp_3_front_25.name = "Rail clamp 3 (front)__pivot";
  node_clamp_3_front_25.scale.set(1, 1, 1);
  if (endpoint_clamp_3_front_25) {
    node_clamp_3_front_25.position.copy(endpoint_clamp_3_front_25.start);
    node_clamp_3_front_25.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_3_front_25.position.set(0.0, 15.41112, 0.0);
    node_clamp_3_front_25.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_3_front_25.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-front"] ?? root).add(node_clamp_3_front_25);
  nodes["clamp-3-front"] = node_clamp_3_front_25;
  const mesh_clamp_3_front_25Geometry = endpoint_clamp_3_front_25
    ? new THREE.CylinderGeometry(endpoint_clamp_3_front_25.endRadius, endpoint_clamp_3_front_25.baseRadius, endpoint_clamp_3_front_25.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_3_front_25) {
    mesh_clamp_3_front_25Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_3_front_25 = new THREE.Mesh(
    mesh_clamp_3_front_25Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_3_front_25.name = "Rail clamp 3 (front)";
  if (endpoint_clamp_3_front_25) {
    mesh_clamp_3_front_25.position.copy(endpoint_clamp_3_front_25.midpoint);
    mesh_clamp_3_front_25.quaternion.copy(endpoint_clamp_3_front_25.quaternion);
  }
  mesh_clamp_3_front_25.castShadow = options.castShadow ?? true;
  mesh_clamp_3_front_25.receiveShadow = options.receiveShadow ?? true;
  node_clamp_3_front_25.add(mesh_clamp_3_front_25);
  meshes["clamp-3-front"] = mesh_clamp_3_front_25;

  const endpoint_clamp_4_front_26 = makeAttachmentEndpoint(null);
  const node_clamp_4_front_26 = new THREE.Group();
  node_clamp_4_front_26.name = "Rail clamp 4 (front)__pivot";
  node_clamp_4_front_26.scale.set(1, 1, 1);
  if (endpoint_clamp_4_front_26) {
    node_clamp_4_front_26.position.copy(endpoint_clamp_4_front_26.start);
    node_clamp_4_front_26.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_4_front_26.position.set(2.728168, 15.41112, 0.0);
    node_clamp_4_front_26.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_4_front_26.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-front"] ?? root).add(node_clamp_4_front_26);
  nodes["clamp-4-front"] = node_clamp_4_front_26;
  const mesh_clamp_4_front_26Geometry = endpoint_clamp_4_front_26
    ? new THREE.CylinderGeometry(endpoint_clamp_4_front_26.endRadius, endpoint_clamp_4_front_26.baseRadius, endpoint_clamp_4_front_26.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_4_front_26) {
    mesh_clamp_4_front_26Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_4_front_26 = new THREE.Mesh(
    mesh_clamp_4_front_26Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_4_front_26.name = "Rail clamp 4 (front)";
  if (endpoint_clamp_4_front_26) {
    mesh_clamp_4_front_26.position.copy(endpoint_clamp_4_front_26.midpoint);
    mesh_clamp_4_front_26.quaternion.copy(endpoint_clamp_4_front_26.quaternion);
  }
  mesh_clamp_4_front_26.castShadow = options.castShadow ?? true;
  mesh_clamp_4_front_26.receiveShadow = options.receiveShadow ?? true;
  node_clamp_4_front_26.add(mesh_clamp_4_front_26);
  meshes["clamp-4-front"] = mesh_clamp_4_front_26;

  const endpoint_clamp_5_front_27 = makeAttachmentEndpoint(null);
  const node_clamp_5_front_27 = new THREE.Group();
  node_clamp_5_front_27.name = "Rail clamp 5 (front)__pivot";
  node_clamp_5_front_27.scale.set(1, 1, 1);
  if (endpoint_clamp_5_front_27) {
    node_clamp_5_front_27.position.copy(endpoint_clamp_5_front_27.start);
    node_clamp_5_front_27.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_5_front_27.position.set(5.456337, 15.41112, 0.0);
    node_clamp_5_front_27.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_5_front_27.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-front"] ?? root).add(node_clamp_5_front_27);
  nodes["clamp-5-front"] = node_clamp_5_front_27;
  const mesh_clamp_5_front_27Geometry = endpoint_clamp_5_front_27
    ? new THREE.CylinderGeometry(endpoint_clamp_5_front_27.endRadius, endpoint_clamp_5_front_27.baseRadius, endpoint_clamp_5_front_27.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_5_front_27) {
    mesh_clamp_5_front_27Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_5_front_27 = new THREE.Mesh(
    mesh_clamp_5_front_27Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_5_front_27.name = "Rail clamp 5 (front)";
  if (endpoint_clamp_5_front_27) {
    mesh_clamp_5_front_27.position.copy(endpoint_clamp_5_front_27.midpoint);
    mesh_clamp_5_front_27.quaternion.copy(endpoint_clamp_5_front_27.quaternion);
  }
  mesh_clamp_5_front_27.castShadow = options.castShadow ?? true;
  mesh_clamp_5_front_27.receiveShadow = options.receiveShadow ?? true;
  node_clamp_5_front_27.add(mesh_clamp_5_front_27);
  meshes["clamp-5-front"] = mesh_clamp_5_front_27;

  const endpoint_clamp_1_rear_28 = makeAttachmentEndpoint(null);
  const node_clamp_1_rear_28 = new THREE.Group();
  node_clamp_1_rear_28.name = "Rail clamp 1 (rear)__pivot";
  node_clamp_1_rear_28.scale.set(1, 1, 1);
  if (endpoint_clamp_1_rear_28) {
    node_clamp_1_rear_28.position.copy(endpoint_clamp_1_rear_28.start);
    node_clamp_1_rear_28.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_1_rear_28.position.set(-5.456337, 15.41112, 0.0);
    node_clamp_1_rear_28.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_1_rear_28.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-rear"] ?? root).add(node_clamp_1_rear_28);
  nodes["clamp-1-rear"] = node_clamp_1_rear_28;
  const mesh_clamp_1_rear_28Geometry = endpoint_clamp_1_rear_28
    ? new THREE.CylinderGeometry(endpoint_clamp_1_rear_28.endRadius, endpoint_clamp_1_rear_28.baseRadius, endpoint_clamp_1_rear_28.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_1_rear_28) {
    mesh_clamp_1_rear_28Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_1_rear_28 = new THREE.Mesh(
    mesh_clamp_1_rear_28Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_1_rear_28.name = "Rail clamp 1 (rear)";
  if (endpoint_clamp_1_rear_28) {
    mesh_clamp_1_rear_28.position.copy(endpoint_clamp_1_rear_28.midpoint);
    mesh_clamp_1_rear_28.quaternion.copy(endpoint_clamp_1_rear_28.quaternion);
  }
  mesh_clamp_1_rear_28.castShadow = options.castShadow ?? true;
  mesh_clamp_1_rear_28.receiveShadow = options.receiveShadow ?? true;
  node_clamp_1_rear_28.add(mesh_clamp_1_rear_28);
  meshes["clamp-1-rear"] = mesh_clamp_1_rear_28;

  const endpoint_clamp_2_rear_29 = makeAttachmentEndpoint(null);
  const node_clamp_2_rear_29 = new THREE.Group();
  node_clamp_2_rear_29.name = "Rail clamp 2 (rear)__pivot";
  node_clamp_2_rear_29.scale.set(1, 1, 1);
  if (endpoint_clamp_2_rear_29) {
    node_clamp_2_rear_29.position.copy(endpoint_clamp_2_rear_29.start);
    node_clamp_2_rear_29.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_2_rear_29.position.set(-2.728168, 15.41112, 0.0);
    node_clamp_2_rear_29.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_2_rear_29.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-rear"] ?? root).add(node_clamp_2_rear_29);
  nodes["clamp-2-rear"] = node_clamp_2_rear_29;
  const mesh_clamp_2_rear_29Geometry = endpoint_clamp_2_rear_29
    ? new THREE.CylinderGeometry(endpoint_clamp_2_rear_29.endRadius, endpoint_clamp_2_rear_29.baseRadius, endpoint_clamp_2_rear_29.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_2_rear_29) {
    mesh_clamp_2_rear_29Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_2_rear_29 = new THREE.Mesh(
    mesh_clamp_2_rear_29Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_2_rear_29.name = "Rail clamp 2 (rear)";
  if (endpoint_clamp_2_rear_29) {
    mesh_clamp_2_rear_29.position.copy(endpoint_clamp_2_rear_29.midpoint);
    mesh_clamp_2_rear_29.quaternion.copy(endpoint_clamp_2_rear_29.quaternion);
  }
  mesh_clamp_2_rear_29.castShadow = options.castShadow ?? true;
  mesh_clamp_2_rear_29.receiveShadow = options.receiveShadow ?? true;
  node_clamp_2_rear_29.add(mesh_clamp_2_rear_29);
  meshes["clamp-2-rear"] = mesh_clamp_2_rear_29;

  const endpoint_clamp_3_rear_30 = makeAttachmentEndpoint(null);
  const node_clamp_3_rear_30 = new THREE.Group();
  node_clamp_3_rear_30.name = "Rail clamp 3 (rear)__pivot";
  node_clamp_3_rear_30.scale.set(1, 1, 1);
  if (endpoint_clamp_3_rear_30) {
    node_clamp_3_rear_30.position.copy(endpoint_clamp_3_rear_30.start);
    node_clamp_3_rear_30.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_3_rear_30.position.set(0.0, 15.41112, 0.0);
    node_clamp_3_rear_30.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_3_rear_30.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-rear"] ?? root).add(node_clamp_3_rear_30);
  nodes["clamp-3-rear"] = node_clamp_3_rear_30;
  const mesh_clamp_3_rear_30Geometry = endpoint_clamp_3_rear_30
    ? new THREE.CylinderGeometry(endpoint_clamp_3_rear_30.endRadius, endpoint_clamp_3_rear_30.baseRadius, endpoint_clamp_3_rear_30.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_3_rear_30) {
    mesh_clamp_3_rear_30Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_3_rear_30 = new THREE.Mesh(
    mesh_clamp_3_rear_30Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_3_rear_30.name = "Rail clamp 3 (rear)";
  if (endpoint_clamp_3_rear_30) {
    mesh_clamp_3_rear_30.position.copy(endpoint_clamp_3_rear_30.midpoint);
    mesh_clamp_3_rear_30.quaternion.copy(endpoint_clamp_3_rear_30.quaternion);
  }
  mesh_clamp_3_rear_30.castShadow = options.castShadow ?? true;
  mesh_clamp_3_rear_30.receiveShadow = options.receiveShadow ?? true;
  node_clamp_3_rear_30.add(mesh_clamp_3_rear_30);
  meshes["clamp-3-rear"] = mesh_clamp_3_rear_30;

  const endpoint_clamp_4_rear_31 = makeAttachmentEndpoint(null);
  const node_clamp_4_rear_31 = new THREE.Group();
  node_clamp_4_rear_31.name = "Rail clamp 4 (rear)__pivot";
  node_clamp_4_rear_31.scale.set(1, 1, 1);
  if (endpoint_clamp_4_rear_31) {
    node_clamp_4_rear_31.position.copy(endpoint_clamp_4_rear_31.start);
    node_clamp_4_rear_31.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_4_rear_31.position.set(2.728168, 15.41112, 0.0);
    node_clamp_4_rear_31.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_4_rear_31.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-rear"] ?? root).add(node_clamp_4_rear_31);
  nodes["clamp-4-rear"] = node_clamp_4_rear_31;
  const mesh_clamp_4_rear_31Geometry = endpoint_clamp_4_rear_31
    ? new THREE.CylinderGeometry(endpoint_clamp_4_rear_31.endRadius, endpoint_clamp_4_rear_31.baseRadius, endpoint_clamp_4_rear_31.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_4_rear_31) {
    mesh_clamp_4_rear_31Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_4_rear_31 = new THREE.Mesh(
    mesh_clamp_4_rear_31Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_4_rear_31.name = "Rail clamp 4 (rear)";
  if (endpoint_clamp_4_rear_31) {
    mesh_clamp_4_rear_31.position.copy(endpoint_clamp_4_rear_31.midpoint);
    mesh_clamp_4_rear_31.quaternion.copy(endpoint_clamp_4_rear_31.quaternion);
  }
  mesh_clamp_4_rear_31.castShadow = options.castShadow ?? true;
  mesh_clamp_4_rear_31.receiveShadow = options.receiveShadow ?? true;
  node_clamp_4_rear_31.add(mesh_clamp_4_rear_31);
  meshes["clamp-4-rear"] = mesh_clamp_4_rear_31;

  const endpoint_clamp_5_rear_32 = makeAttachmentEndpoint(null);
  const node_clamp_5_rear_32 = new THREE.Group();
  node_clamp_5_rear_32.name = "Rail clamp 5 (rear)__pivot";
  node_clamp_5_rear_32.scale.set(1, 1, 1);
  if (endpoint_clamp_5_rear_32) {
    node_clamp_5_rear_32.position.copy(endpoint_clamp_5_rear_32.start);
    node_clamp_5_rear_32.rotation.set(0.0, 1.5707963267948966, 0.0);
  } else {
    node_clamp_5_rear_32.position.set(5.456337, 15.41112, 0.0);
    node_clamp_5_rear_32.rotation.set(0.0, 1.5707963267948966, 0.0);
  }
  node_clamp_5_rear_32.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["frame-rear"] ?? root).add(node_clamp_5_rear_32);
  nodes["clamp-5-rear"] = node_clamp_5_rear_32;
  const mesh_clamp_5_rear_32Geometry = endpoint_clamp_5_rear_32
    ? new THREE.CylinderGeometry(endpoint_clamp_5_rear_32.endRadius, endpoint_clamp_5_rear_32.baseRadius, endpoint_clamp_5_rear_32.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.1091, 24, 96);
  if (!endpoint_clamp_5_rear_32) {
    mesh_clamp_5_rear_32Geometry.scale(0.733333, 0.733333, 1.32);
  }
  const mesh_clamp_5_rear_32 = new THREE.Mesh(
    mesh_clamp_5_rear_32Geometry,
    materialMap["chrome-tube"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clamp_5_rear_32.name = "Rail clamp 5 (rear)";
  if (endpoint_clamp_5_rear_32) {
    mesh_clamp_5_rear_32.position.copy(endpoint_clamp_5_rear_32.midpoint);
    mesh_clamp_5_rear_32.quaternion.copy(endpoint_clamp_5_rear_32.quaternion);
  }
  mesh_clamp_5_rear_32.castShadow = options.castShadow ?? true;
  mesh_clamp_5_rear_32.receiveShadow = options.receiveShadow ?? true;
  node_clamp_5_rear_32.add(mesh_clamp_5_rear_32);
  meshes["clamp-5-rear"] = mesh_clamp_5_rear_32;

  const attachment_foot_lb_33 = {"parentId": "base-platform", "parentSocket": "base-underside", "localStart": [-8.794049, 4.794049, 0.02], "localEnd": [-8.794049, 4.794049, -0.234926], "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.01, "baseRadius": 0.54816, "endRadius": 0.54816, "evidenceRefs": ["base-detail"]};
  const endpoint_foot_lb_33 = makeAttachmentEndpoint(attachment_foot_lb_33);
  const node_foot_lb_33 = new THREE.Group();
  node_foot_lb_33.name = "Base foot__pivot";
  node_foot_lb_33.scale.set(1, 1, 1);
  if (endpoint_foot_lb_33) {
    node_foot_lb_33.position.copy(endpoint_foot_lb_33.start);
    node_foot_lb_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_lb_33.position.set(-8.794049, 4.794049, 0.0);
    node_foot_lb_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_lb_33.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["base-platform"] ?? root).add(node_foot_lb_33);
  nodes["foot-lb"] = node_foot_lb_33;
  const mesh_foot_lb_33Geometry = endpoint_foot_lb_33
    ? new THREE.CylinderGeometry(endpoint_foot_lb_33.endRadius, endpoint_foot_lb_33.baseRadius, endpoint_foot_lb_33.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_foot_lb_33) {
    mesh_foot_lb_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_foot_lb_33 = new THREE.Mesh(
    mesh_foot_lb_33Geometry,
    materialMap["rubber-feet"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_lb_33.name = "Base foot";
  if (endpoint_foot_lb_33) {
    mesh_foot_lb_33.position.copy(endpoint_foot_lb_33.midpoint);
    mesh_foot_lb_33.quaternion.copy(endpoint_foot_lb_33.quaternion);
  }
  mesh_foot_lb_33.castShadow = options.castShadow ?? true;
  mesh_foot_lb_33.receiveShadow = options.receiveShadow ?? true;
  node_foot_lb_33.add(mesh_foot_lb_33);
  meshes["foot-lb"] = mesh_foot_lb_33;

  const attachment_foot_lf_34 = {"parentId": "base-platform", "parentSocket": "base-underside", "localStart": [-8.794049, -4.794049, 0.02], "localEnd": [-8.794049, -4.794049, -0.234926], "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.01, "baseRadius": 0.54816, "endRadius": 0.54816, "evidenceRefs": ["base-detail"]};
  const endpoint_foot_lf_34 = makeAttachmentEndpoint(attachment_foot_lf_34);
  const node_foot_lf_34 = new THREE.Group();
  node_foot_lf_34.name = "Base foot__pivot";
  node_foot_lf_34.scale.set(1, 1, 1);
  if (endpoint_foot_lf_34) {
    node_foot_lf_34.position.copy(endpoint_foot_lf_34.start);
    node_foot_lf_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_lf_34.position.set(-8.794049, -4.794049, 0.0);
    node_foot_lf_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_lf_34.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["base-platform"] ?? root).add(node_foot_lf_34);
  nodes["foot-lf"] = node_foot_lf_34;
  const mesh_foot_lf_34Geometry = endpoint_foot_lf_34
    ? new THREE.CylinderGeometry(endpoint_foot_lf_34.endRadius, endpoint_foot_lf_34.baseRadius, endpoint_foot_lf_34.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_foot_lf_34) {
    mesh_foot_lf_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_foot_lf_34 = new THREE.Mesh(
    mesh_foot_lf_34Geometry,
    materialMap["rubber-feet"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_lf_34.name = "Base foot";
  if (endpoint_foot_lf_34) {
    mesh_foot_lf_34.position.copy(endpoint_foot_lf_34.midpoint);
    mesh_foot_lf_34.quaternion.copy(endpoint_foot_lf_34.quaternion);
  }
  mesh_foot_lf_34.castShadow = options.castShadow ?? true;
  mesh_foot_lf_34.receiveShadow = options.receiveShadow ?? true;
  node_foot_lf_34.add(mesh_foot_lf_34);
  meshes["foot-lf"] = mesh_foot_lf_34;

  const attachment_foot_rb_35 = {"parentId": "base-platform", "parentSocket": "base-underside", "localStart": [8.794049, 4.794049, 0.02], "localEnd": [8.794049, 4.794049, -0.234926], "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.01, "baseRadius": 0.54816, "endRadius": 0.54816, "evidenceRefs": ["base-detail"]};
  const endpoint_foot_rb_35 = makeAttachmentEndpoint(attachment_foot_rb_35);
  const node_foot_rb_35 = new THREE.Group();
  node_foot_rb_35.name = "Base foot__pivot";
  node_foot_rb_35.scale.set(1, 1, 1);
  if (endpoint_foot_rb_35) {
    node_foot_rb_35.position.copy(endpoint_foot_rb_35.start);
    node_foot_rb_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_rb_35.position.set(8.794049, 4.794049, 0.0);
    node_foot_rb_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_rb_35.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["base-platform"] ?? root).add(node_foot_rb_35);
  nodes["foot-rb"] = node_foot_rb_35;
  const mesh_foot_rb_35Geometry = endpoint_foot_rb_35
    ? new THREE.CylinderGeometry(endpoint_foot_rb_35.endRadius, endpoint_foot_rb_35.baseRadius, endpoint_foot_rb_35.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_foot_rb_35) {
    mesh_foot_rb_35Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_foot_rb_35 = new THREE.Mesh(
    mesh_foot_rb_35Geometry,
    materialMap["rubber-feet"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_rb_35.name = "Base foot";
  if (endpoint_foot_rb_35) {
    mesh_foot_rb_35.position.copy(endpoint_foot_rb_35.midpoint);
    mesh_foot_rb_35.quaternion.copy(endpoint_foot_rb_35.quaternion);
  }
  mesh_foot_rb_35.castShadow = options.castShadow ?? true;
  mesh_foot_rb_35.receiveShadow = options.receiveShadow ?? true;
  node_foot_rb_35.add(mesh_foot_rb_35);
  meshes["foot-rb"] = mesh_foot_rb_35;

  const attachment_foot_rf_36 = {"parentId": "base-platform", "parentSocket": "base-underside", "localStart": [8.794049, -4.794049, 0.02], "localEnd": [8.794049, -4.794049, -0.234926], "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.01, "baseRadius": 0.54816, "endRadius": 0.54816, "evidenceRefs": ["base-detail"]};
  const endpoint_foot_rf_36 = makeAttachmentEndpoint(attachment_foot_rf_36);
  const node_foot_rf_36 = new THREE.Group();
  node_foot_rf_36.name = "Base foot__pivot";
  node_foot_rf_36.scale.set(1, 1, 1);
  if (endpoint_foot_rf_36) {
    node_foot_rf_36.position.copy(endpoint_foot_rf_36.start);
    node_foot_rf_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_rf_36.position.set(8.794049, -4.794049, 0.0);
    node_foot_rf_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_rf_36.userData.actionProfile = {"pivot": {"localPosition": [0, 0, 0]}};
  (nodes["base-platform"] ?? root).add(node_foot_rf_36);
  nodes["foot-rf"] = node_foot_rf_36;
  const mesh_foot_rf_36Geometry = endpoint_foot_rf_36
    ? new THREE.CylinderGeometry(endpoint_foot_rf_36.endRadius, endpoint_foot_rf_36.baseRadius, endpoint_foot_rf_36.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_foot_rf_36) {
    mesh_foot_rf_36Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_foot_rf_36 = new THREE.Mesh(
    mesh_foot_rf_36Geometry,
    materialMap["rubber-feet"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_rf_36.name = "Base foot";
  if (endpoint_foot_rf_36) {
    mesh_foot_rf_36.position.copy(endpoint_foot_rf_36.midpoint);
    mesh_foot_rf_36.quaternion.copy(endpoint_foot_rf_36.quaternion);
  }
  mesh_foot_rf_36.castShadow = options.castShadow ?? true;
  mesh_foot_rf_36.receiveShadow = options.receiveShadow ?? true;
  node_foot_rf_36.add(mesh_foot_rf_36);
  meshes["foot-rf"] = mesh_foot_rf_36;
  // repetition system "ball-row-system" describes 5 parts that are already built individually; not instanced.
  // repetition system "clamp-system" describes 10 parts that are already built individually; not instanced.
  // repetition system "wire-system" describes 10 parts that are already built individually; not instanced.
  // repetition system "foot-system" describes 4 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets } satisfies ProceduralModelRuntime;
  return root;
}

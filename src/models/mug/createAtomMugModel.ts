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

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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

export function createAtomMugModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Atom Mug";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["ceramic-glaze"] = createSculptMaterial(
    "ceramic-glaze",
    {"id": "ceramic-glaze", "name": "White ceramic glaze", "type": "physical", "shaderModel": "MeshPhysicalMaterial (opaque dielectric + clearcoat)", "baseColor": "#EDE9E4", "color": "#EDE9E4", "albedo": {"dominant": "#EDE9E4", "secondary": ["#ECE8E3", "#EFECE7"], "samplingNotes": "Measured by extract_pbr_evidence on the clean wall crop at (195,520,125x340), left of the badge: palette #EBE8E3..#EDEAE5, mean luma 234, mean saturation 0.036. The clipped specular streaks and the luma-186 shadow side are lighting, not albedo."}, "colorVariation": {"palette": ["#EDE9E4", "#ECE8E3", "#EFECE7"], "pattern": "uniform", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.26, "variation": 0.02, "map": "independent-procedural-field", "localResponse": "Uniform. A fired glaze is one melted layer; the only darkening in the reference is the cavity, which is occlusion."}, "metalness": {"base": 0.0, "variation": 0.0}, "clearcoat": {"base": 0.7, "variation": 0.0}, "clearcoatRoughness": {"base": 0.12, "variation": 0.0}, "ior": {"value": 1.5, "base": 1.5, "variation": 0.0}, "specularF0": {"value": 0.5}, "envMapIntensity": 0.9, "ambientOcclusion": {"cavityStrength": 0.4, "contactShadowBias": 0.35}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One unwrap per part at object scale; the reference shows no repeating structure to tile, so repeat stays 1x1."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.01, "role": "broad tonal drift across the wall; measured gradient strength 0.01"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.004, "role": "glaze pooling; measured mottle 0.002, i.e. at the noise floor"}, {"id": "micro", "frequency": 60.0, "amplitude": 0.002, "role": "highlight breakup under grazing light; not resolvable in the reference"}], "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.03, "scale": 20.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "localOverrides": [{"id": "glaze-clearcoat", "region": "whole vessel", "kind": "gloss", "clearcoat": 0.7, "clearcoatRoughness": 0.12, "evidenceRef": "full-object"}], "shaderNotes": ["MeshPhysicalMaterial: the glaze needs clearcoat, which MeshStandardMaterial has no channel for.", "Scalars are the ceramic.glazed profile from docs/materials/material-reference.json, resolved at confidence 0.831. The analyzer's own finishClass heuristic called this crop 'brushed-steel' with metalness 1.0; that is a heuristic misfire on a bright low-saturation surface and is overridden by direct inspection, per the rule that no script scores visuals.", "The texture channels are authored at their MEASURED amplitudes, which are at the noise floor (mottle 0.002 on the wall crop). They are declared rather than omitted so the spec records a measurement instead of a gap.", "apply_material_analysis wrote textureAnalysis; removed by tools/reconcile_textureless.py -- its finishClass heuristic reads this crop as brushed steel. The raw heuristic output is kept in material-analysis.json."], "materialFamily": "ceramic", "materialSubtype": "glazed", "materialFinish": "glossy"},
    options
  );
  materialMap["decal-ink"] = createSculptMaterial(
    "decal-ink",
    {"id": "decal-ink", "name": "Black print ink", "type": "physical", "shaderModel": "MeshPhysicalMaterial (opaque dielectric, satin)", "baseColor": "#0A0A0A", "color": "#0A0A0A", "albedo": {"dominant": "#0A0A0A", "secondary": ["#060606", "#090909"], "samplingNotes": "Measured by extract_pbr_evidence on the nucleus crop at (531,580,72x64): core palette #060606..#090909. The #868380 and #5D5A58 entries are the antialiased rim and are excluded."}, "colorVariation": {"palette": ["#0A0A0A", "#060606", "#090909"], "pattern": "uniform", "amplitude": 0.01, "heightCorrelation": 0.0}, "roughness": {"base": 0.26, "variation": 0.03, "map": "independent-procedural-field", "localResponse": "The print sits UNDER the same fired glaze, so it shares the glaze's roughness and clearcoat; only the albedo differs."}, "metalness": {"base": 0.0, "variation": 0.0}, "clearcoat": {"base": 0.7, "variation": 0.0}, "clearcoatRoughness": {"base": 0.12, "variation": 0.0}, "ior": {"value": 1.5, "base": 1.5, "variation": 0.0}, "specularF0": {"value": 0.5}, "envMapIntensity": 0.7, "ambientOcclusion": {"cavityStrength": 0.2, "contactShadowBias": 0.3}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One unwrap per part at object scale; the print is one flat layer of ink, so repeat stays 1x1."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.01, "role": "broad tonal drift across the print; none measurable"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.004, "role": "ink lay; no halftone or grain resolvable in the reference"}, {"id": "micro", "frequency": 60.0, "amplitude": 0.002, "role": "highlight breakup under grazing light; not resolvable in the reference"}], "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.03, "scale": 20.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "localOverrides": [{"id": "atom-decal", "region": "front wall, +-36.5 deg of arc, centred at y 0.0485 m", "kind": "decal", "evidenceRef": "atom-badge"}], "shaderNotes": ["Shares the glaze's clearcoat and roughness outright: an in-glaze print is under the same melted layer, so only the albedo separates them.", "Scalars are the ceramic.glazed profile from docs/materials/material-reference.json, resolved at confidence 0.751.", "apply_material_analysis wrote textureAnalysis; removed by tools/reconcile_textureless.py -- its finishClass heuristic reads this crop as brushed steel. The raw heuristic output is kept in material-analysis.json."], "materialFamily": "ceramic", "materialSubtype": "glazed", "materialFinish": "glossy"},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};

  const endpoint_body_shell_0 = makeAttachmentEndpoint(null);
  const node_body_shell_0 = new THREE.Group();
  node_body_shell_0.name = "Vessel body__pivot";
  node_body_shell_0.scale.set(1, 1, 1);
  if (endpoint_body_shell_0) {
    node_body_shell_0.position.copy(endpoint_body_shell_0.start);
    node_body_shell_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_shell_0.position.set(0.0, 0.0, 0.0);
    node_body_shell_0.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["root"] ?? root).add(node_body_shell_0);
  nodes["body-shell"] = node_body_shell_0;
  const mesh_body_shell_0Geometry = endpoint_body_shell_0
    ? new THREE.CylinderGeometry(endpoint_body_shell_0.endRadius, endpoint_body_shell_0.baseRadius, endpoint_body_shell_0.length, 32, 12)
    : buildLatheGeometry({"points": [[0.010544, 0.0], [3.496602, 0.0], [4.099094, 0.0], [4.144383, 0.009009], [4.182778, 0.034663], [4.208432, 0.073057], [4.217441, 0.118347], [4.217441, 9.413929784824463], [4.210889, 9.446867], [4.192231, 9.474791], [4.164308, 9.493448], [4.13137, 9.5], [4.002265, 9.5], [3.969327, 9.493448], [3.941404, 9.474791], [3.922746, 9.446867], [3.916195, 9.41393], [3.916195, 1.0866364665911665], [3.895665, 0.9307], [3.835476, 0.785391], [3.739729, 0.660611], [3.614949, 0.564864], [3.46964, 0.504674], [3.313703, 0.484145], [0.010544, 0.484145]], "segments": 96});
  if (!endpoint_body_shell_0) {
    mesh_body_shell_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_body_shell_0 = new THREE.Mesh(
    mesh_body_shell_0Geometry,
    materialMap["ceramic-glaze"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_shell_0.name = "Vessel body";
  if (endpoint_body_shell_0) {
    mesh_body_shell_0.position.copy(endpoint_body_shell_0.midpoint);
    mesh_body_shell_0.quaternion.copy(endpoint_body_shell_0.quaternion);
  }
  mesh_body_shell_0.castShadow = options.castShadow ?? true;
  mesh_body_shell_0.receiveShadow = options.receiveShadow ?? true;
  node_body_shell_0.add(mesh_body_shell_0);
  meshes["body-shell"] = mesh_body_shell_0;

  const endpoint_handle_1 = makeAttachmentEndpoint(null);
  const node_handle_1 = new THREE.Group();
  node_handle_1.name = "C-handle loop__pivot";
  node_handle_1.scale.set(1, 1, 1);
  if (endpoint_handle_1) {
    node_handle_1.position.copy(endpoint_handle_1.start);
    node_handle_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_handle_1.position.set(0.0, 0.0, 0.0);
    node_handle_1.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_handle_1);
  nodes["handle"] = node_handle_1;
  const mesh_handle_1Geometry = endpoint_handle_1
    ? new THREE.CylinderGeometry(endpoint_handle_1.endRadius, endpoint_handle_1.baseRadius, endpoint_handle_1.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [3.571914, 7.84008, 0.0], "rx": 0.329219, "rz": 0.860702}, {"position": [4.391819, 8.02534, 0.0], "rx": 0.329219, "rz": 0.72058}, {"position": [4.643058, 8.070951, 0.0], "rx": 0.329219, "rz": 0.604772}, {"position": [4.901268, 8.12908, 0.0], "rx": 0.329219, "rz": 0.525588}, {"position": [5.153199, 8.209562, 0.0], "rx": 0.329219, "rz": 0.47083}, {"position": [5.411665, 8.234304, 0.0], "rx": 0.329219, "rz": 0.461217}, {"position": [5.669875, 8.216787, 0.0], "rx": 0.329219, "rz": 0.468936}, {"position": [5.928086, 8.161434, 0.0], "rx": 0.329219, "rz": 0.475193}, {"position": [6.166304, 8.05807, 0.0], "rx": 0.329219, "rz": 0.506319}, {"position": [6.393597, 7.912543, 0.0], "rx": 0.329219, "rz": 0.555025}, {"position": [6.594122, 7.746559, 0.0], "rx": 0.329219, "rz": 0.572145}, {"position": [6.773037, 7.558487, 0.0], "rx": 0.329219, "rz": 0.566729}, {"position": [6.926673, 7.343946, 0.0], "rx": 0.329219, "rz": 0.547105}, {"position": [7.068818, 7.103149, 0.0], "rx": 0.329219, "rz": 0.514877}, {"position": [7.191656, 6.868687, 0.0], "rx": 0.329219, "rz": 0.484559}, {"position": [7.292041, 6.622485, 0.0], "rx": 0.329219, "rz": 0.467146}, {"position": [7.356428, 6.367424, 0.0], "rx": 0.329219, "rz": 0.462363}, {"position": [7.416371, 6.11265, 0.0], "rx": 0.329219, "rz": 0.458305}, {"position": [7.457398, 5.855167, 0.0], "rx": 0.329219, "rz": 0.456957}, {"position": [7.48764, 5.588397, 0.0], "rx": 0.329219, "rz": 0.456929}, {"position": [7.513112, 5.318273, 0.0], "rx": 0.329219, "rz": 0.457242}, {"position": [7.514523, 5.053752, 0.0], "rx": 0.329219, "rz": 0.457654}, {"position": [7.50958, 4.786279, 0.0], "rx": 0.329219, "rz": 0.463198}, {"position": [7.48501, 4.526022, 0.0], "rx": 0.329219, "rz": 0.473257}, {"position": [7.448893, 4.268008, 0.0], "rx": 0.329219, "rz": 0.486204}, {"position": [7.40474, 4.009577, 0.0], "rx": 0.329219, "rz": 0.499598}, {"position": [7.345055, 3.755609, 0.0], "rx": 0.329219, "rz": 0.511161}, {"position": [7.265032, 3.508544, 0.0], "rx": 0.329219, "rz": 0.525441}, {"position": [7.168804, 3.259481, 0.0], "rx": 0.329219, "rz": 0.544488}, {"position": [7.045318, 3.019977, 0.0], "rx": 0.329219, "rz": 0.577612}, {"position": [6.904445, 2.800862, 0.0], "rx": 0.329219, "rz": 0.621992}, {"position": [6.743652, 2.595918, 0.0], "rx": 0.329219, "rz": 0.656369}, {"position": [6.562938, 2.405144, 0.0], "rx": 0.329219, "rz": 0.680745}, {"position": [6.363354, 2.233406, 0.0], "rx": 0.329219, "rz": 0.656453}, {"position": [6.144901, 2.080702, 0.0], "rx": 0.329219, "rz": 0.583496}, {"position": [5.906569, 1.962938, 0.0], "rx": 0.329219, "rz": 0.532662}, {"position": [5.648358, 1.89176, 0.0], "rx": 0.329219, "rz": 0.508422}, {"position": [5.390147, 1.866283, 0.0], "rx": 0.329219, "rz": 0.496585}, {"position": [5.131937, 1.884516, 0.0], "rx": 0.329219, "rz": 0.502758}, {"position": [4.873726, 1.942667, 0.0], "rx": 0.329219, "rz": 0.527772}, {"position": [4.629216, 2.042336, 0.0], "rx": 0.329219, "rz": 0.588455}, {"position": [4.398407, 2.174143, 0.0], "rx": 0.329219, "rz": 0.678391}, {"position": [3.571914, 2.100795, 0.0], "rx": 0.329219, "rz": 0.860702}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_handle_1) {
    mesh_handle_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_handle_1 = new THREE.Mesh(
    mesh_handle_1Geometry,
    materialMap["ceramic-glaze"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_handle_1.name = "C-handle loop";
  if (endpoint_handle_1) {
    mesh_handle_1.position.copy(endpoint_handle_1.midpoint);
    mesh_handle_1.quaternion.copy(endpoint_handle_1.quaternion);
  }
  mesh_handle_1.castShadow = options.castShadow ?? true;
  mesh_handle_1.receiveShadow = options.receiveShadow ?? true;
  node_handle_1.add(mesh_handle_1);
  meshes["handle"] = mesh_handle_1;

  const attachment_atom_orbit_a_2 = {"parentId": "body-shell", "parentSocket": "front-wall-badge", "localStart": [1.011506, 4.85103, 3.982467], "localEnd": [1.011506, 4.85103, 3.982467], "contactNormal": [0.246173, 0.0, 0.969226], "contactType": "embed", "embedDepth": 0.23763, "gapTolerance": 0.001, "baseRadius": 0.129105, "endRadius": 0.129105, "evidenceRefs": ["atom-badge"]};
  const endpoint_atom_orbit_a_2 = makeAttachmentEndpoint(attachment_atom_orbit_a_2);
  const node_atom_orbit_a_2 = new THREE.Group();
  node_atom_orbit_a_2.name = "Atom orbit stroke A (0 deg)__pivot";
  node_atom_orbit_a_2.scale.set(1, 1, 1);
  if (endpoint_atom_orbit_a_2) {
    node_atom_orbit_a_2.position.copy(endpoint_atom_orbit_a_2.start);
    node_atom_orbit_a_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atom_orbit_a_2.position.set(0.0, 0.0, 0.0);
    node_atom_orbit_a_2.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_atom_orbit_a_2);
  nodes["atom-orbit-a"] = node_atom_orbit_a_2;
  const mesh_atom_orbit_a_2Geometry = endpoint_atom_orbit_a_2
    ? new THREE.CylinderGeometry(endpoint_atom_orbit_a_2.endRadius, endpoint_atom_orbit_a_2.baseRadius, endpoint_atom_orbit_a_2.length, 32, 12)
    : buildTubeGeometry({"points": [[1.011506, 4.85103, 3.982467], [1.007137, 5.130274, 3.983574], [0.994066, 5.406828, 3.986856], [0.972397, 5.678029, 3.992196], [0.942307, 5.941266, 3.999406], [0.904041, 6.194004, 4.008229], [0.85792, 6.433808, 4.018353], [0.804338, 6.658369, 4.02942], [0.743762, 6.865524, 4.04104], [0.676733, 7.053278, 4.052804], [0.603863, 7.219824, 4.0643], [0.525832, 7.363557, 4.07513], [0.443384, 7.483093, 4.084923], [0.357318, 7.577281, 4.093349], [0.268484, 7.645213, 4.100134], [0.177766, 7.686236, 4.105068], [0.086079, 7.699954, 4.108014], [-0.005652, 7.686236, 4.108912], [-0.096496, 7.645213, 4.107782], [-0.185537, 7.577281, 4.104724], [-0.27188, 7.483093, 4.099911], [-0.354666, 7.363557, 4.09358], [-0.433082, 7.219824, 4.086028], [-0.50637, 7.053278, 4.077594], [-0.573833, 6.865524, 4.068649], [-0.634842, 6.658369, 4.059576], [-0.688841, 6.433808, 4.050763], [-0.735345, 6.194004, 4.04258], [-0.773947, 5.941266, 4.035368], [-0.804313, 5.678029, 4.029425], [-0.826187, 5.406828, 4.024997], [-0.839384, 5.130274, 4.022266], [-0.843795, 4.85103, 4.021343], [-0.839384, 4.571787, 4.022266], [-0.826187, 4.295233, 4.024997], [-0.804313, 4.024031, 4.029425], [-0.773947, 3.760794, 4.035368], [-0.735345, 3.508057, 4.04258], [-0.688841, 3.268253, 4.050763], [-0.634842, 3.043692, 4.059576], [-0.573833, 2.836537, 4.068649], [-0.50637, 2.648782, 4.077594], [-0.433082, 2.482236, 4.086028], [-0.354666, 2.338504, 4.09358], [-0.27188, 2.218968, 4.099911], [-0.185537, 2.12478, 4.104724], [-0.096496, 2.056847, 4.107782], [-0.005652, 2.015825, 4.108912], [0.086079, 2.002106, 4.108014], [0.177766, 2.015825, 4.105068], [0.268484, 2.056847, 4.100134], [0.357318, 2.12478, 4.093349], [0.443384, 2.218968, 4.084923], [0.525832, 2.338504, 4.07513], [0.603863, 2.482236, 4.0643], [0.676733, 2.648782, 4.052804], [0.743762, 2.836537, 4.04104], [0.804338, 3.043692, 4.02942], [0.85792, 3.268253, 4.018353], [0.904041, 3.508057, 4.008229], [0.942307, 3.760794, 3.999406], [0.972397, 4.024031, 3.992196], [0.994066, 4.295233, 3.986856], [1.007137, 4.571787, 3.983574]], "radius": 0.129105, "radialSegments": 10, "closed": true});
  if (!endpoint_atom_orbit_a_2) {
    mesh_atom_orbit_a_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atom_orbit_a_2 = new THREE.Mesh(
    mesh_atom_orbit_a_2Geometry,
    materialMap["decal-ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atom_orbit_a_2.name = "Atom orbit stroke A (0 deg)";
  if (endpoint_atom_orbit_a_2) {
    mesh_atom_orbit_a_2.position.copy(endpoint_atom_orbit_a_2.midpoint);
    mesh_atom_orbit_a_2.quaternion.copy(endpoint_atom_orbit_a_2.quaternion);
  }
  mesh_atom_orbit_a_2.castShadow = options.castShadow ?? true;
  mesh_atom_orbit_a_2.receiveShadow = options.receiveShadow ?? true;
  node_atom_orbit_a_2.add(mesh_atom_orbit_a_2);
  meshes["atom-orbit-a"] = mesh_atom_orbit_a_2;

  const attachment_atom_orbit_b_3 = {"parentId": "body-shell", "parentSocket": "front-wall-badge", "localStart": [0.580727, 5.733871, 4.06767], "localEnd": [0.580727, 5.733871, 4.06767], "contactNormal": [0.141333, 0.0, 0.989962], "contactType": "embed", "embedDepth": 0.23763, "gapTolerance": 0.001, "baseRadius": 0.129105, "endRadius": 0.129105, "evidenceRefs": ["atom-badge"]};
  const endpoint_atom_orbit_b_3 = makeAttachmentEndpoint(attachment_atom_orbit_b_3);
  const node_atom_orbit_b_3 = new THREE.Group();
  node_atom_orbit_b_3.name = "Atom orbit stroke B (60 deg)__pivot";
  node_atom_orbit_b_3.scale.set(1, 1, 1);
  if (endpoint_atom_orbit_b_3) {
    node_atom_orbit_b_3.position.copy(endpoint_atom_orbit_b_3.start);
    node_atom_orbit_b_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atom_orbit_b_3.position.set(0.0, 0.0, 0.0);
    node_atom_orbit_b_3.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_atom_orbit_b_3);
  nodes["atom-orbit-b"] = node_atom_orbit_b_3;
  const mesh_atom_orbit_b_3Geometry = endpoint_atom_orbit_b_3
    ? new THREE.CylinderGeometry(endpoint_atom_orbit_b_3.endRadius, endpoint_atom_orbit_b_3.baseRadius, endpoint_atom_orbit_b_3.length, 32, 12)
    : buildTubeGeometry({"points": [[0.580727, 5.733871, 4.06767], [0.329908, 5.877784, 4.09565], [0.075493, 6.011808, 4.108222], [-0.17911, 6.134653, 4.10501], [-0.430485, 6.245136, 4.086303], [-0.675325, 6.342194, 4.053039], [-0.910545, 6.42489, 4.006756], [-1.133373, 6.49243, 3.949513], [-1.341417, 6.544161, 3.883785], [-1.532709, 6.579588, 3.812347], [-1.705712, 6.598367, 3.738146], [-1.859308, 6.600318, 3.664173], [-1.992749, 6.585423, 3.593346], [-2.105607, 6.553824, 3.5284], [-2.197692, 6.505827, 3.471791], [-2.268984, 6.441893, 3.425624], [-2.319553, 6.362638, 3.391587], [-2.3495, 6.268826, 3.37091], [-2.358905, 6.16136, 3.364335], [-2.347797, 6.041274, 3.372097], [-2.316142, 5.909726, 3.393917], [-2.263856, 5.767981, 3.429014], [-2.190841, 5.617406, 3.476119], [-2.097029, 5.459451, 3.533505], [-1.982453, 5.295636, 3.599037], [-1.847318, 5.127539, 3.670232], [-1.692079, 4.956779, 3.744337], [-1.517509, 4.785001, 3.818423], [-1.324763, 4.613859, 3.889497], [-1.115411, 4.445001, 3.954623], [-0.891458, 4.280053, 4.011046], [-0.655329, 4.120604, 4.05632], [-0.409825, 3.968189, 4.088426], [-0.158054, 3.824277, 4.105874], [0.096664, 3.690253, 4.107778], [0.350909, 3.567408, 4.093904], [0.601279, 3.456924, 4.064683], [0.844511, 3.359867, 4.021192], [1.077587, 3.27717, 3.965097], [1.297821, 3.209631, 3.89857], [1.502929, 3.157899, 3.824185], [1.69106, 3.122473, 3.744797], [1.860804, 3.103694, 3.663413], [2.011165, 3.101743, 3.583071], [2.141523, 3.116638, 3.506717], [2.251561, 3.148236, 3.4371], [2.341195, 3.196234, 3.376684], [2.410489, 3.260167, 3.327571], [2.459588, 3.339422, 3.291445], [2.488643, 3.433234, 3.269533], [2.497764, 3.540701, 3.262569], [2.486991, 3.660787, 3.270789], [2.456278, 3.792335, 3.293917], [2.405509, 3.934079, 3.331173], [2.334531, 4.084654, 3.381295], [2.243205, 4.24261, 3.44256], [2.131474, 4.406425, 3.512834], [1.99944, 4.574521, 3.589627], [1.847441, 4.745281, 3.67017], [1.676128, 4.917059, 3.751504], [1.486528, 5.088202, 3.83059], [1.280088, 5.25706, 3.904428], [1.058695, 5.422008, 3.970183], [0.82467, 5.581457, 4.025308]], "radius": 0.129105, "radialSegments": 10, "closed": true});
  if (!endpoint_atom_orbit_b_3) {
    mesh_atom_orbit_b_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atom_orbit_b_3 = new THREE.Mesh(
    mesh_atom_orbit_b_3Geometry,
    materialMap["decal-ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atom_orbit_b_3.name = "Atom orbit stroke B (60 deg)";
  if (endpoint_atom_orbit_b_3) {
    mesh_atom_orbit_b_3.position.copy(endpoint_atom_orbit_b_3.midpoint);
    mesh_atom_orbit_b_3.quaternion.copy(endpoint_atom_orbit_b_3.quaternion);
  }
  mesh_atom_orbit_b_3.castShadow = options.castShadow ?? true;
  mesh_atom_orbit_b_3.receiveShadow = options.receiveShadow ?? true;
  node_atom_orbit_b_3.add(mesh_atom_orbit_b_3);
  meshes["atom-orbit-b"] = mesh_atom_orbit_b_3;

  const attachment_atom_orbit_c_4 = {"parentId": "body-shell", "parentSocket": "front-wall-badge", "localStart": [-0.409825, 5.733871, 4.088426], "localEnd": [-0.409825, 5.733871, 4.088426], "contactNormal": [-0.09974, 0.0, 0.995013], "contactType": "embed", "embedDepth": 0.23763, "gapTolerance": 0.001, "baseRadius": 0.129105, "endRadius": 0.129105, "evidenceRefs": ["atom-badge"]};
  const endpoint_atom_orbit_c_4 = makeAttachmentEndpoint(attachment_atom_orbit_c_4);
  const node_atom_orbit_c_4 = new THREE.Group();
  node_atom_orbit_c_4.name = "Atom orbit stroke C (120 deg)__pivot";
  node_atom_orbit_c_4.scale.set(1, 1, 1);
  if (endpoint_atom_orbit_c_4) {
    node_atom_orbit_c_4.position.copy(endpoint_atom_orbit_c_4.start);
    node_atom_orbit_c_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atom_orbit_c_4.position.set(0.0, 0.0, 0.0);
    node_atom_orbit_c_4.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_atom_orbit_c_4);
  nodes["atom-orbit-c"] = node_atom_orbit_c_4;
  const mesh_atom_orbit_c_4Geometry = endpoint_atom_orbit_c_4
    ? new THREE.CylinderGeometry(endpoint_atom_orbit_c_4.endRadius, endpoint_atom_orbit_c_4.baseRadius, endpoint_atom_orbit_c_4.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.409825, 5.733871, 4.088426], [-0.655329, 5.581457, 4.05632], [-0.891458, 5.422008, 4.011046], [-1.115411, 5.25706, 3.954623], [-1.324763, 5.088202, 3.889497], [-1.517509, 4.917059, 3.818423], [-1.692079, 4.745281, 3.744337], [-1.847318, 4.574521, 3.670232], [-1.982453, 4.406425, 3.599037], [-2.097029, 4.24261, 3.533505], [-2.190841, 4.084654, 3.476119], [-2.263856, 3.934079, 3.429014], [-2.316142, 3.792335, 3.393917], [-2.347797, 3.660787, 3.372097], [-2.358905, 3.540701, 3.364335], [-2.3495, 3.433234, 3.37091], [-2.319553, 3.339422, 3.391587], [-2.268984, 3.260167, 3.425624], [-2.197692, 3.196234, 3.471791], [-2.105607, 3.148236, 3.5284], [-1.992749, 3.116638, 3.593346], [-1.859308, 3.101743, 3.664173], [-1.705712, 3.103694, 3.738146], [-1.532709, 3.122473, 3.812347], [-1.341417, 3.157899, 3.883785], [-1.133373, 3.209631, 3.949513], [-0.910545, 3.27717, 4.006756], [-0.675325, 3.359867, 4.053039], [-0.430485, 3.456924, 4.086303], [-0.17911, 3.567408, 4.10501], [0.075493, 3.690253, 4.108222], [0.329908, 3.824277, 4.09565], [0.580727, 3.968189, 4.06767], [0.82467, 4.120604, 4.025308], [1.058695, 4.280053, 3.970183], [1.280088, 4.445001, 3.904428], [1.486528, 4.613859, 3.83059], [1.676128, 4.785001, 3.751504], [1.847441, 4.956779, 3.67017], [1.99944, 5.127539, 3.589627], [2.131474, 5.295636, 3.512834], [2.243205, 5.459451, 3.44256], [2.334531, 5.617406, 3.381295], [2.405509, 5.767981, 3.331173], [2.456278, 5.909726, 3.293917], [2.486991, 6.041274, 3.270789], [2.497764, 6.16136, 3.262569], [2.488643, 6.268826, 3.269533], [2.459588, 6.362638, 3.291445], [2.410489, 6.441893, 3.327571], [2.341195, 6.505827, 3.376684], [2.251561, 6.553824, 3.4371], [2.141523, 6.585423, 3.506717], [2.011165, 6.600318, 3.583071], [1.860804, 6.598367, 3.663413], [1.69106, 6.579588, 3.744797], [1.502929, 6.544161, 3.824185], [1.297821, 6.49243, 3.89857], [1.077587, 6.42489, 3.965097], [0.844511, 6.342194, 4.021192], [0.601279, 6.245136, 4.064683], [0.350909, 6.134653, 4.093904], [0.096664, 6.011808, 4.107778], [-0.158054, 5.877784, 4.105874]], "radius": 0.129105, "radialSegments": 10, "closed": true});
  if (!endpoint_atom_orbit_c_4) {
    mesh_atom_orbit_c_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atom_orbit_c_4 = new THREE.Mesh(
    mesh_atom_orbit_c_4Geometry,
    materialMap["decal-ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atom_orbit_c_4.name = "Atom orbit stroke C (120 deg)";
  if (endpoint_atom_orbit_c_4) {
    mesh_atom_orbit_c_4.position.copy(endpoint_atom_orbit_c_4.midpoint);
    mesh_atom_orbit_c_4.quaternion.copy(endpoint_atom_orbit_c_4.quaternion);
  }
  mesh_atom_orbit_c_4.castShadow = options.castShadow ?? true;
  mesh_atom_orbit_c_4.receiveShadow = options.receiveShadow ?? true;
  node_atom_orbit_c_4.add(mesh_atom_orbit_c_4);
  meshes["atom-orbit-c"] = mesh_atom_orbit_c_4;

  const attachment_atom_nucleus_5 = {"parentId": "body-shell", "parentSocket": "front-wall-badge", "localStart": [0.087514, 4.85103, 4.176524], "localEnd": [0.08919, 4.85103, 4.256506], "contactNormal": [0.020949, 0.0, 0.999781], "contactType": "embed", "embedDepth": 0.04000000000000001, "gapTolerance": 0.001, "baseRadius": 0.414213, "endRadius": 0.414213, "evidenceRefs": ["atom-badge"]};
  const endpoint_atom_nucleus_5 = makeAttachmentEndpoint(attachment_atom_nucleus_5);
  const node_atom_nucleus_5 = new THREE.Group();
  node_atom_nucleus_5.name = "Nucleus disc__pivot";
  node_atom_nucleus_5.scale.set(1, 1, 1);
  if (endpoint_atom_nucleus_5) {
    node_atom_nucleus_5.position.copy(endpoint_atom_nucleus_5.start);
    node_atom_nucleus_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atom_nucleus_5.position.set(0.0, 0.0, 0.0);
    node_atom_nucleus_5.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_atom_nucleus_5);
  nodes["atom-nucleus"] = node_atom_nucleus_5;
  const mesh_atom_nucleus_5Geometry = endpoint_atom_nucleus_5
    ? new THREE.CylinderGeometry(endpoint_atom_nucleus_5.endRadius, endpoint_atom_nucleus_5.baseRadius, endpoint_atom_nucleus_5.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_atom_nucleus_5) {
    mesh_atom_nucleus_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atom_nucleus_5 = new THREE.Mesh(
    mesh_atom_nucleus_5Geometry,
    materialMap["decal-ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atom_nucleus_5.name = "Nucleus disc";
  if (endpoint_atom_nucleus_5) {
    mesh_atom_nucleus_5.position.copy(endpoint_atom_nucleus_5.midpoint);
    mesh_atom_nucleus_5.quaternion.copy(endpoint_atom_nucleus_5.quaternion);
  }
  mesh_atom_nucleus_5.castShadow = options.castShadow ?? true;
  mesh_atom_nucleus_5.receiveShadow = options.receiveShadow ?? true;
  node_atom_nucleus_5.add(mesh_atom_nucleus_5);
  meshes["atom-nucleus"] = mesh_atom_nucleus_5;

  const attachment_atom_electron_1_6 = {"parentId": "body-shell", "parentSocket": "front-wall-badge", "localStart": [1.719262, 6.579588, 3.80725], "localEnd": [1.752186, 6.579588, 3.88016], "contactNormal": [0.411559, 0.0, 0.911383], "contactType": "embed", "embedDepth": 0.04000000000000001, "gapTolerance": 0.001, "baseRadius": 0.225934, "endRadius": 0.225934, "evidenceRefs": ["atom-badge"]};
  const endpoint_atom_electron_1_6 = makeAttachmentEndpoint(attachment_atom_electron_1_6);
  const node_atom_electron_1_6 = new THREE.Group();
  node_atom_electron_1_6.name = "Electron dot 1__pivot";
  node_atom_electron_1_6.scale.set(1, 1, 1);
  if (endpoint_atom_electron_1_6) {
    node_atom_electron_1_6.position.copy(endpoint_atom_electron_1_6.start);
    node_atom_electron_1_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atom_electron_1_6.position.set(0.0, 0.0, 0.0);
    node_atom_electron_1_6.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_atom_electron_1_6);
  nodes["atom-electron-1"] = node_atom_electron_1_6;
  const mesh_atom_electron_1_6Geometry = endpoint_atom_electron_1_6
    ? new THREE.CylinderGeometry(endpoint_atom_electron_1_6.endRadius, endpoint_atom_electron_1_6.baseRadius, endpoint_atom_electron_1_6.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_atom_electron_1_6) {
    mesh_atom_electron_1_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atom_electron_1_6 = new THREE.Mesh(
    mesh_atom_electron_1_6Geometry,
    materialMap["decal-ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atom_electron_1_6.name = "Electron dot 1";
  if (endpoint_atom_electron_1_6) {
    mesh_atom_electron_1_6.position.copy(endpoint_atom_electron_1_6.midpoint);
    mesh_atom_electron_1_6.quaternion.copy(endpoint_atom_electron_1_6.quaternion);
  }
  mesh_atom_electron_1_6.castShadow = options.castShadow ?? true;
  mesh_atom_electron_1_6.receiveShadow = options.receiveShadow ?? true;
  node_atom_electron_1_6.add(mesh_atom_electron_1_6);
  meshes["atom-electron-1"] = mesh_atom_electron_1_6;

  const attachment_atom_electron_2_7 = {"parentId": "body-shell", "parentSocket": "front-wall-badge", "localStart": [-1.878127, 5.127539, 3.731441], "localEnd": [-1.914094, 5.127539, 3.8029], "contactNormal": [-0.449588, 0.0, 0.893236], "contactType": "embed", "embedDepth": 0.04000000000000001, "gapTolerance": 0.001, "baseRadius": 0.225934, "endRadius": 0.225934, "evidenceRefs": ["atom-badge"]};
  const endpoint_atom_electron_2_7 = makeAttachmentEndpoint(attachment_atom_electron_2_7);
  const node_atom_electron_2_7 = new THREE.Group();
  node_atom_electron_2_7.name = "Electron dot 2__pivot";
  node_atom_electron_2_7.scale.set(1, 1, 1);
  if (endpoint_atom_electron_2_7) {
    node_atom_electron_2_7.position.copy(endpoint_atom_electron_2_7.start);
    node_atom_electron_2_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atom_electron_2_7.position.set(0.0, 0.0, 0.0);
    node_atom_electron_2_7.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_atom_electron_2_7);
  nodes["atom-electron-2"] = node_atom_electron_2_7;
  const mesh_atom_electron_2_7Geometry = endpoint_atom_electron_2_7
    ? new THREE.CylinderGeometry(endpoint_atom_electron_2_7.endRadius, endpoint_atom_electron_2_7.baseRadius, endpoint_atom_electron_2_7.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_atom_electron_2_7) {
    mesh_atom_electron_2_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atom_electron_2_7 = new THREE.Mesh(
    mesh_atom_electron_2_7Geometry,
    materialMap["decal-ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atom_electron_2_7.name = "Electron dot 2";
  if (endpoint_atom_electron_2_7) {
    mesh_atom_electron_2_7.position.copy(endpoint_atom_electron_2_7.midpoint);
    mesh_atom_electron_2_7.quaternion.copy(endpoint_atom_electron_2_7.quaternion);
  }
  mesh_atom_electron_2_7.castShadow = options.castShadow ?? true;
  mesh_atom_electron_2_7.receiveShadow = options.receiveShadow ?? true;
  node_atom_electron_2_7.add(mesh_atom_electron_2_7);
  meshes["atom-electron-2"] = mesh_atom_electron_2_7;

  const attachment_atom_electron_3_8 = {"parentId": "body-shell", "parentSocket": "front-wall-badge", "localStart": [1.319465, 3.209631, 3.963587], "localEnd": [1.344733, 3.209631, 4.039492], "contactNormal": [0.315855, 0.0, 0.948808], "contactType": "embed", "embedDepth": 0.04000000000000001, "gapTolerance": 0.001, "baseRadius": 0.225934, "endRadius": 0.225934, "evidenceRefs": ["atom-badge"]};
  const endpoint_atom_electron_3_8 = makeAttachmentEndpoint(attachment_atom_electron_3_8);
  const node_atom_electron_3_8 = new THREE.Group();
  node_atom_electron_3_8.name = "Electron dot 3__pivot";
  node_atom_electron_3_8.scale.set(1, 1, 1);
  if (endpoint_atom_electron_3_8) {
    node_atom_electron_3_8.position.copy(endpoint_atom_electron_3_8.start);
    node_atom_electron_3_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atom_electron_3_8.position.set(0.0, 0.0, 0.0);
    node_atom_electron_3_8.rotation.set(0.0, 0.0, 0.0);
  }
  (nodes["body-shell"] ?? root).add(node_atom_electron_3_8);
  nodes["atom-electron-3"] = node_atom_electron_3_8;
  const mesh_atom_electron_3_8Geometry = endpoint_atom_electron_3_8
    ? new THREE.CylinderGeometry(endpoint_atom_electron_3_8.endRadius, endpoint_atom_electron_3_8.baseRadius, endpoint_atom_electron_3_8.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_atom_electron_3_8) {
    mesh_atom_electron_3_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atom_electron_3_8 = new THREE.Mesh(
    mesh_atom_electron_3_8Geometry,
    materialMap["decal-ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atom_electron_3_8.name = "Electron dot 3";
  if (endpoint_atom_electron_3_8) {
    mesh_atom_electron_3_8.position.copy(endpoint_atom_electron_3_8.midpoint);
    mesh_atom_electron_3_8.quaternion.copy(endpoint_atom_electron_3_8.quaternion);
  }
  mesh_atom_electron_3_8.castShadow = options.castShadow ?? true;
  mesh_atom_electron_3_8.receiveShadow = options.receiveShadow ?? true;
  node_atom_electron_3_8.add(mesh_atom_electron_3_8);
  meshes["atom-electron-3"] = mesh_atom_electron_3_8;
  // repetition system "orbit-stroke-system" describes 3 parts that are already built individually; not instanced.
  // repetition system "electron-dot-system" describes 3 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets } satisfies ProceduralModelRuntime;
  return root;
}

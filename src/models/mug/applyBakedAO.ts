import * as THREE from 'three';

/**
 * Apply baked per-vertex ambient occlusion (geometry/ao.json, produced by tools/bake_ao.mts)
 * to a model built by createAtomMugModel.
 *
 * It multiplies into the vertex colour rather than the albedo, so the authored base colour is
 * untouched and the occlusion stays a lighting term. The material is cloned per mesh because
 * enabling vertexColors on the shared glaze material would make every mesh read a colour
 * attribute, and the ones that have none render black.
 *
 * Keyed by mesh NAME, which is the component's display name in the generated factory. A mesh
 * with no entry, or an entry whose length does not match its vertex count, is left alone and
 * reported, so a stale bake shows up instead of silently half-applying.
 */
export function applyBakedAO(
  model: THREE.Object3D,
  baked: Record<string, number[]>,
): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const ao = baked[mesh.name];
    const count = mesh.geometry.getAttribute('position').count;
    if (!ao || ao.length !== count) {
      skipped.push(mesh.name);
      return;
    }
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      colors[i * 3] = ao[i];
      colors[i * 3 + 1] = ao[i];
      colors[i * 3 + 2] = ao[i];
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = (mesh.material as THREE.Material).clone();
    (material as THREE.MeshPhysicalMaterial).vertexColors = true;
    mesh.material = material;
    applied.push(mesh.name);
  });
  return { applied, skipped };
}

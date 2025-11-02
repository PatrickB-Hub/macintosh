import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export const DESK = { w: 1.4, d: 0.8, x: 0.07, z: 0.16, top: 0.032 }; // top face at y = 0
export const FLOOR_Y = -0.74; // desk height
const WALL_Z = DESK.z - DESK.d / 2 - 0.03; // just behind the desk's back edge

const loader = new THREE.TextureLoader();
function texture(url: string, repeatX: number, repeatY: number): THREE.Texture {
  const t = loader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  return t;
}

export const COASTER = { r: 0.058, h: 0.006 };

export function createCoaster(): THREE.Mesh {
  const coaster = new THREE.Mesh(
    new THREE.CylinderGeometry(COASTER.r, COASTER.r, COASTER.h, 48),
    new THREE.MeshStandardMaterial({
      name: "cork",
      map: texture("/textures/cork.png", 1, 1),
      color: "#c2a685",
      roughness: 0.85,
    }),
  );
  coaster.position.y = COASTER.h / 2;
  coaster.castShadow = coaster.receiveShadow = true;
  coaster.name = "coaster";
  return coaster;
}

export function createRoom(): THREE.Group {
  const room = new THREE.Group();
  room.name = "room";

  const wood = new THREE.MeshStandardMaterial({
    name: "deskWood",
    map: texture("/textures/wood.png", 1, 1),
    color: "#cbbd9f",
    roughness: 0.82,
    metalness: 0,
  });
  wood.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `
      #ifdef USE_MAP
        vec4 grain = texture2D(map, vMapUv);
        float value = dot(grain.rgb, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb *= mix(vec3(value), grain.rgb, 0.12) * 0.48 + 0.42;
      #endif
    `,
    );
  };
  const top = new THREE.Mesh(new RoundedBoxGeometry(DESK.w, DESK.top, DESK.d, 3, 0.004), wood);
  top.position.set(DESK.x, -DESK.top / 2, DESK.z);
  top.name = "deskTop";
  room.add(top);

  const legGeo = new THREE.BoxGeometry(0.07, -FLOOR_Y - DESK.top, 0.07);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, wood);
      leg.position.set(DESK.x + sx * (DESK.w / 2 - 0.09), (FLOOR_Y - DESK.top) / 2, DESK.z + sz * (DESK.d / 2 - 0.09));
      leg.name = "deskLeg";
      room.add(leg);
    }

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 4),
    new THREE.MeshStandardMaterial({
      name: "blueGreyPlaster",
      color: "#8babb4",
      roughness: 0.96,
      side: THREE.FrontSide,
    }),
  );
  wall.position.set(0, FLOOR_Y + 2, WALL_Z);
  wall.name = "wall";
  room.add(wall);

  room.traverse((o) => {
    (o as THREE.Mesh).castShadow = (o as THREE.Mesh).receiveShadow = true;
  });
  return room;
}

/**
 * A classic Mac running in a hidden Infinite Mac embed, drawn into a texture for the CRT glass.
 * Protocol: https://github.com/mihaip/infinite-mac/blob/main/src/embed-types.ts
 */
import * as THREE from "three";

const ORIGIN = "https://infinitemac.org";
// System 6.0.8 runs on a Mac SE/30 here: still 512x342 1-bit, so the CRT calibration below holds.
// infinite_hd defaults to false on /embed?disk=, so the software library needs asking for by name.
const SRC = `${ORIGIN}/embed?disk=System%206.0.8&infinite_hd=true&screen_update_messages=true`;
export const MAC_W = 512;
export const MAC_H = 342;
// The canvas covers the whole crtGlass (191.4 x 157.6 mm) at one texel per Mac pixel.
// Calibration knobs: smaller CW/CH = bigger picture
export const CW = 544;
export const CH = 448;
export const X0 = 16;
export const Y0 = 53;

/** Glass UV (v = 1 at the top) -> Mac pixel, clamped to the raster */
export function uvToMac(u: number, v: number): [number, number] {
  const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.floor(n)));
  return [clamp(u * CW - X0, MAC_W - 1), clamp((1 - v) * CH - Y0, MAC_H - 1)];
}

export type Mac = ReturnType<typeof createMac>;

export function createMac() {
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  const clear = () => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CW, CH);
    texture.needsUpdate = true;
  };
  clear();

  let iframe: HTMLIFrameElement | null = null;
  let cursor = [MAC_W / 2, MAC_H / 2];
  const send = (msg: object) => iframe?.contentWindow?.postMessage(msg, ORIGIN);
  const move = (x: number, y: number) => {
    cursor = [Math.min(MAC_W - 1, Math.max(0, x)), Math.min(MAC_H - 1, Math.max(0, y))];
    send({ type: "emulator_mouse_move", x: Math.round(cursor[0]), y: Math.round(cursor[1]), deltaX: 0, deltaY: 0 });
  };

  addEventListener("message", (e) => {
    if (!iframe || e.source !== iframe.contentWindow || e.origin !== ORIGIN) return;
    if (e.data?.type !== "emulator_screen") return;
    const { data, width, height } = e.data as { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
    ctx.putImageData(new ImageData(data, width, height), X0, Y0);
    texture.needsUpdate = true;
  });

  return {
    texture,
    get on() {
      return iframe !== null;
    },
    /** Power switch: a fresh iframe per power-on, so the Mac really boots */
    toggle() {
      if (iframe) {
        iframe.remove();
        iframe = null;
        clear();
        return;
      }
      iframe = document.createElement("iframe");
      iframe.src = SRC;
      iframe.width = String(MAC_W);
      iframe.height = String(MAC_H);
      iframe.allow = "cross-origin-isolated; autoplay";
      iframe.tabIndex = -1;
      iframe.style.cssText = "position:fixed;left:0;top:0;border:0;opacity:0;pointer-events:none";
      document.body.appendChild(iframe);
    },
    move([x, y]: [number, number]) {
      move(x, y);
    },
    nudge(dx: number, dy: number) {
      move(cursor[0] + dx, cursor[1] + dy);
    },
    button(down: boolean) {
      send({ type: down ? "emulator_mouse_down" : "emulator_mouse_up", button: 0 });
    },
    key(code: string, down: boolean) {
      send({ type: down ? "emulator_key_down" : "emulator_key_up", code });
    },
  };
}

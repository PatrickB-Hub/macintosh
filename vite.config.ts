import { defineConfig } from "vite";

// Cross-origin isolation: the Infinite Mac iframe needs SharedArrayBuffer for full speed.
// Production hosting must send the same two headers.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
});

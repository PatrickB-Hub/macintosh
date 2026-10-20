# Hello, again.

An interactive Macintosh 128K on a desk, built with TypeScript, SCSS and Three.js. Switch it on and a real System 6.0.8 boots on the CRT, driven by an [Infinite Mac](https://infinitemac.org) embed and operated with your own keyboard and mouse or the modelled ones on the desk.

**Live:** [macintosh.patrickbecker.work](https://macintosh.patrickbecker.work)

## Run

```sh
npm install
npm run dev
```

Open the local address printed by Vite. `npm run check` runs the TypeScript check, `npm run build` produces `dist/` and `npm run preview` serves that build locally. `npm run format` runs Prettier.

The emulator needs `SharedArrayBuffer`, so the page must be cross-origin isolated. The dev and preview servers already send the headers (see `vite.config.ts`); a production host must send them too:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Play

- **Start Macintosh** switches the Mac on. Clicking the badge on the case switches it off and on again.
- Click the screen to give the Mac focus, then use your own keyboard and mouse. Clicks and keys on the modelled M0110 keyboard work as well; modifier keys latch until the next key.
- Drag the desk mouse to move it. It bumps into the other objects and pulls its cable behind it.
- Apps and games are on the **Infinite HD** drive.
- Drag the background to rotate the camera, scroll to zoom. **Reset view** or **Esc** returns to the overview.

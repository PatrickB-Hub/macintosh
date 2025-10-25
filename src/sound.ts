/**
 * Short synthesized sounds for the desk objects: each is one waveform, baked on first play and replayed
 * with a little pitch spread so repeats don't sound looped. Browsers only start audio after a click or
 * key press on the page, so anything before that stays silent.
 */
let audio: AudioContext | undefined;
let listening = false;
const unlock = () => {
  audio ??= new AudioContext();
  audio.resume();
};

export const noise = () => Math.random() * 2 - 1;
/** A decaying sine: frequency f (Hz), decay time tau (s), at time t (s). */
export const ring = (f: number, tau: number, t: number) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t / tau);

/** Bakes `wave` (sample at t seconds, about ±1) over `seconds`; the returned function plays it at `gain`. */
export function createSound(wave: (t: number) => number, seconds: number, spread = 0.1) {
  if (!listening) for (const type of ["pointerdown", "keydown"]) addEventListener(type, unlock, true);
  listening = true;
  let clip: AudioBuffer | undefined;
  return (gain: number) => {
    if (!audio || gain <= 0) return; // still resuming (the unlocking press itself): it plays once running
    if (!clip) {
      clip = audio.createBuffer(1, Math.round(audio.sampleRate * seconds), audio.sampleRate);
      const d = clip.getChannelData(0);
      for (let k = 0; k < d.length; k++) d[k] = wave(k / audio.sampleRate);
    }
    const src = audio.createBufferSource();
    const amp = audio.createGain();
    src.buffer = clip;
    src.playbackRate.value = 1 - spread + 2 * spread * Math.random();
    amp.gain.value = gain;
    src.connect(amp).connect(audio.destination);
    src.start();
  };
}

// Tiny WebAudio synthesiser — every sound effect is generated at runtime, so
// the game ships with no audio assets.

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
let volume = 0.5;

try {
  muted = localStorage.getItem('aa-muted') === '1';
  volume = +(localStorage.getItem('aa-volume') ?? 0.5);
} catch {}

function ensure() {
  if (ctx) return ctx.state === 'running';
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx.state === 'running';
}

export function unlockAudio() {
  ensure();
  if (ctx?.state === 'suspended') ctx.resume();
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : volume;
  try {
    localStorage.setItem('aa-muted', muted ? '1' : '0');
  } catch {}
  return muted;
}

export const isMuted = () => muted;

function tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.2, gain = 0.3, delay = 0, attack = 0.005 }) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise({ dur = 0.3, gain = 0.3, f0 = 2000, f1 = 200, q = 1, type = 'lowpass', delay = 0 }) {
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.Q.value = q;
  filt.frequency.setValueAtTime(f0, t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

const SOUNDS = {
  fireball: () => noise({ dur: 0.35, gain: 0.25, f0: 3000, f1: 300, type: 'bandpass', q: 0.8 }),
  homing: () => tone({ type: 'triangle', f0: 300, f1: 900, dur: 0.3, gain: 0.15 }),
  bouncer: () => tone({ type: 'square', f0: 500, f1: 250, dur: 0.15, gain: 0.08 }),
  boomerang: () => noise({ dur: 0.4, gain: 0.15, f0: 800, f1: 2400, type: 'bandpass', q: 3 }),
  lightning: () => {
    noise({ dur: 0.25, gain: 0.35, f0: 6000, f1: 800, type: 'highpass' });
    tone({ type: 'sawtooth', f0: 1200, f1: 80, dur: 0.2, gain: 0.08 });
  },
  meteor: () => tone({ type: 'sawtooth', f0: 900, f1: 120, dur: 0.9, gain: 0.07 }),
  drain: () => tone({ type: 'sine', f0: 200, f1: 600, dur: 0.35, gain: 0.2 }),
  gravity: () => tone({ type: 'sine', f0: 120, f1: 40, dur: 0.8, gain: 0.3 }),
  link: () => tone({ type: 'square', f0: 700, f1: 700, dur: 0.12, gain: 0.07 }),
  swap: () => tone({ type: 'triangle', f0: 400, f1: 1200, dur: 0.25, gain: 0.15 }),
  teleport: () => tone({ type: 'sine', f0: 300, f1: 1800, dur: 0.3, gain: 0.18 }),
  thrust: () => noise({ dur: 0.3, gain: 0.3, f0: 600, f1: 3000, type: 'bandpass', q: 1 }),
  shield: () => tone({ type: 'triangle', f0: 660, f1: 990, dur: 0.4, gain: 0.15 }),
  windwalk: () => noise({ dur: 0.6, gain: 0.12, f0: 400, f1: 2000, type: 'bandpass', q: 2 }),
  boom: () => {
    noise({ dur: 0.5, gain: 0.45, f0: 1200, f1: 60 });
    tone({ type: 'sine', f0: 120, f1: 40, dur: 0.4, gain: 0.35 });
  },
  bigboom: () => {
    noise({ dur: 1.0, gain: 0.6, f0: 900, f1: 40 });
    tone({ type: 'sine', f0: 90, f1: 30, dur: 0.8, gain: 0.5 });
  },
  hit: () => noise({ dur: 0.12, gain: 0.25, f0: 1500, f1: 300 }),
  reflect: () => tone({ type: 'square', f0: 1400, f1: 2000, dur: 0.1, gain: 0.08 }),
  death: () => tone({ type: 'sawtooth', f0: 400, f1: 60, dur: 0.7, gain: 0.15 }),
  zap: () => {
    tone({ type: 'square', f0: 1500, f1: 200, dur: 0.3, gain: 0.1 });
    noise({ dur: 0.2, gain: 0.2, f0: 5000, f1: 1000, type: 'highpass' });
  },
  splash: () => noise({ dur: 0.7, gain: 0.35, f0: 3000, f1: 200, type: 'bandpass', q: 0.6 }),
  squish: () => noise({ dur: 0.3, gain: 0.4, f0: 400, f1: 60 }),
  kodo: () => tone({ type: 'sawtooth', f0: 90, f1: 60, dur: 0.5, gain: 0.12 }),
  smack: () => noise({ dur: 0.2, gain: 0.35, f0: 800, f1: 100 }),
  shove: () => {
    tone({ type: 'sine', f0: 180, f1: 60, dur: 0.25, gain: 0.3 });
    noise({ dur: 0.2, gain: 0.2, f0: 1000, f1: 200 });
  },
  coin: () => {
    tone({ type: 'square', f0: 988, f1: 988, dur: 0.08, gain: 0.07 });
    tone({ type: 'square', f0: 1319, f1: 1319, dur: 0.25, gain: 0.07, delay: 0.07 });
  },
  buy: () => {
    tone({ type: 'triangle', f0: 880, f1: 880, dur: 0.08, gain: 0.12 });
    tone({ type: 'triangle', f0: 1320, f1: 1320, dur: 0.15, gain: 0.12, delay: 0.06 });
  },
  tag: () => tone({ type: 'square', f0: 300, f1: 900, dur: 0.15, gain: 0.1 }),
  beep: () => tone({ type: 'sine', f0: 880, f1: 880, dur: 0.15, gain: 0.2 }),
  start: () => {
    tone({ type: 'triangle', f0: 523, f1: 523, dur: 0.15, gain: 0.2 });
    tone({ type: 'triangle', f0: 1047, f1: 1047, dur: 0.35, gain: 0.2, delay: 0.12 });
  },
  intro: () => [392, 523, 659].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f, dur: 0.25, gain: 0.15, delay: i * 0.1 })),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f, dur: 0.3, gain: 0.15, delay: i * 0.09 })),
  victory: () => [392, 523, 659, 784, 659, 1047].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f, dur: 0.45, gain: 0.16, delay: i * 0.16 })),
  click: () => tone({ type: 'sine', f0: 600, f1: 600, dur: 0.05, gain: 0.08 }),
  error: () => tone({ type: 'square', f0: 200, f1: 150, dur: 0.15, gain: 0.08 }),
};

let lastPlayed = {};

export function play(name) {
  if (!ensure() || muted) return;
  const fn = SOUNDS[name];
  if (!fn) return;
  // Throttle identical sounds so 10 simultaneous fireballs don't clip.
  const now = performance.now();
  if (now - (lastPlayed[name] || 0) < 40) return;
  lastPlayed[name] = now;
  fn();
}

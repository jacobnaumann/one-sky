// Audio QA: measures what src/audio/engine.ts really outputs, in a real browser engine.
//
// Nobody has to listen: the engine runs in headless Chromium, everything it sends to
// ctx.destination is also recorded sample-for-sample by an AudioWorklet, and this script
// reports levels, clicks, DC, spectrum and timing per scenario.
//
// Usage:  node scripts/audio-qa.mjs [--only=bed,waveIn,...] [--out=test-results/audio-qa] [--wav] [--long]
//   Needs the dev server (npm run dev) on http://localhost:5173 (override with --url=).
//   --wav   also writes each recording as a 32-bit float WAV so a human can listen later
//   --long  records the bed for 150 s instead of 30 s (shows the slow LFO range)
// Exit code 1 when a hard limit is broken (clipping, peak > -3 dBFS, DC, not silent when muted).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const BASE = arg('url', 'http://localhost:5173');
const OUT = arg('out', 'test-results/audio-qa');
const ONLY = arg('only', '') ? String(arg('only', '')).split(',') : null;
const WAV = !!arg('wav', false);
const LONG = !!arg('long', false);
const SR = 48000;

/* ------------------------------------------------------------------ page side */

// Runs inside the page. Returns { sr, f0, b64 (interleaved stereo float32), marks, oscs, extra }.
async function pageMain({ scenario, sr, long }) {
  const wall = (ms) => new Promise((r) => setTimeout(r, ms));
  // Waits are measured on the audio clock (a headless audio clock can run a few % off wall time);
  // while the context is suspended they fall back to wall time.
  const clock = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime').get;
  const now = () => clock.call(ctx); // the real audio clock, even when a scenario makes the engine see a stale one
  const sleep = async (ms) => {
    const end = now() + ms / 1000;
    const t0 = performance.now();
    while (now() < end) {
      await wall(4);
      if (ctx.state !== 'running' && performance.now() - t0 >= ms) return;
    }
  };
  const ctx = new AudioContext({ sampleRate: sr });
  const workletSrc = `
    class Rec extends AudioWorkletProcessor {
      constructor() { super(); this.n = 0; this.buf = new Float32Array(8192); this.start = -1; }
      process(inputs) {
        const inp = inputs[0];
        const l = inp[0], r = inp[1] || inp[0];
        if (this.n === 0) this.start = currentFrame;
        for (let i = 0; i < 128; i++) {
          this.buf[this.n++] = l ? l[i] : 0;
          this.buf[this.n++] = r ? r[i] : 0;
        }
        if (this.n >= this.buf.length) {
          this.port.postMessage({ frame: this.start, data: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(8192);
          this.n = 0;
        }
        return true;
      }
    }
    registerProcessor('qa-rec', Rec);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([workletSrc], { type: 'text/javascript' })));
  const rec = new AudioWorkletNode(ctx, 'qa-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  const chunks = [];
  rec.port.onmessage = (e) => chunks.push(e.data);
  const zero = ctx.createGain();
  zero.gain.value = 0;
  const origConnect = AudioNode.prototype.connect;
  origConnect.call(rec, zero);
  origConnect.call(zero, ctx.destination);
  // Everything the engine sends to the speakers is also recorded.
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest === ctx.destination && this !== zero) origConnect.call(this, rec);
    return origConnect.call(this, dest, ...rest);
  };
  // The engine's `new AudioContext()` gets the context that already has the recorder.
  const RealAC = window.AudioContext;
  window.AudioContext = function () { return ctx; };
  window.AudioContext.prototype = RealAC.prototype;

  // Log every oscillator the engine starts (intended pitch + time); optionally keep the bed silent.
  const oscs = [];
  let skipStarts = false;
  const oscStart = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (when = 0) {
    if (skipStarts) return;
    oscs.push({ t: when, f: this.frequency.value, type: this.type });
    return oscStart.call(this, when);
  };
  const bufStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    if (skipStarts) return;
    return bufStart.apply(this, a);
  };
  let comp = null;
  let conv = null;
  const mkComp = RealAC.prototype.createDynamicsCompressor;
  RealAC.prototype.createDynamicsCompressor = function () { return (comp = mkComp.call(this)); };
  const mkConv = RealAC.prototype.createConvolver;
  RealAC.prototype.createConvolver = function () { return (conv = mkConv.call(this)); };

  const { AudioEngine } = await import('/src/audio/engine.ts');
  const E = new AudioEngine();
  if (ctx.state !== 'running') await ctx.resume();
  await sleep(250);

  const marks = [];
  const mark = (label, dur, extra = {}) => marks.push({ label, t: now(), dur, ...extra });
  const start = async (bed) => {
    skipStarts = !bed;
    await E.start();
    skipStarts = false;
    if (!E.started) throw new Error('engine did not start');
  };
  /** Isolated events (bed kept silent so the event itself can be measured down to -60 dBFS). */
  const events = async (steps) => {
    await start(false);
    await sleep(300);
    for (const [label, dur, fn] of steps) {
      mark(label, dur);
      await fn();
      await sleep(dur * 1000 + 250);
    }
  };
  const lights = (n) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, lon: -180 + ((i + 0.5) * 360) / n, lat: 0 }));
  const extra = {};

  const S = {
    bed: async () => {
      mark('bed', long ? 150 : 30);
      await start(true);
      await sleep((long ? 150 : 30) * 1000 + 300);
    },
    arrive: () => events([['arrive', 9, () => E.arrive()]]),
    lightJoined: () => events([
      ['lightJoined(-120)', 6, () => E.lightJoined(-120)],
      ['lightJoined(0)', 6, () => E.lightJoined(0)],
      ['lightJoined(120)', 6, () => E.lightJoined(120)],
    ]),
    waveOut: () => events([['waveOut(-87,139,2.5)', 9, () => E.waveOut(-87, 139, 2.5)]]),
    waveIn: () => events([['waveIn(10)', 8, () => E.waveIn(10)]]),
    thread: () => events([
      ['thread(500)', 10, () => E.thread(500)],
      ['thread(5000)', 10, () => E.thread(5000)],
      ['thread(15000)', 11, () => E.thread(15000)],
    ]),
    lantern: () => events([
      ['lantern()', 6, () => E.lantern()],
      ['lanternOpen()', 6, () => E.lanternOpen()],
      ['warm() x4', 7, async () => { for (let i = 0; i < 4; i++) { E.warm(); await sleep(350); } }],
      ['uiTick()', 2, () => E.uiTick()],
    ]),
    ring: () => events([
      ['ringSegment(0)', 5, () => E.ringSegment(0)],
      ['ringSegment(12)', 5, () => E.ringSegment(12)],
      ['ringSegment(23)', 5, () => E.ringSegment(23)],
      ['ringSegment 0..23', 8, async () => { for (let i = 0; i < 24; i++) { E.ringSegment(i); await sleep(150); } }],
      ['ringComplete()', 11, () => E.ringComplete()],
    ]),
    stress: async () => {
      await start(true);
      await sleep(8000);
      mark('bed before stress', 1, { pre: true });
      await sleep(1000);
      mark('stress', 12);
      E.arrive(); E.waveIn(10); E.waveOut(-87, 139, 2.5); E.thread(15000); E.lantern(); E.lanternOpen(); E.warm(); E.ringComplete();
      for (let i = 0; i < 24; i++) E.ringSegment(i);
      for (let i = 0; i < 60; i++) { E.lightJoined(-180 + i * 6); await sleep(33); }
      await sleep(11000);
    },
    mute: async () => {
      await start(true);
      await sleep(8000);
      E.waveIn(10);
      await sleep(700);
      mark('mute (during waveIn + bed)', 2);
      E.muted = true;
      await sleep(1000);
      mark('muted, settled', 1);
      await sleep(1100);
      mark('unmute', 2);
      E.muted = false;
      await sleep(2100);
      E.waveIn(10);
      await sleep(700);
      // The context freezes ~0.32 s after suspend(); the recording then continues straight
      // into the resume, which is exactly the splice a listener hears.
      mark('suspend -> resume', 3);
      E.suspend();
      await sleep(2000);
      extra.stateWhileSuspended = ctx.state;
      extra.baseLatency = ctx.baseLatency;
      E.resume();
      await sleep(3200);
    },
    twinkle1: async () => { await start(false); E.setLights(lights(1)); mark('twinkle 1 light', 40); await sleep(40300); },
    twinkle8: async () => { await start(false); E.setLights(lights(8)); mark('twinkle 8 lights', 40); await sleep(40300); },
    twinkle200: async () => { await start(false); E.setLights(lights(200)); mark('twinkle 200 lights', 40); await sleep(40300); },
    // Late scheduling: the engine sees a clock that is behind the render clock (what a main
    // thread behind a large audio callback buffer sees). Every event must still sound.
    late: async () => {
      await start(false);
      await sleep(300);
      for (const lag of [0.045, 0.08, 0.2]) {
        Object.defineProperty(ctx, 'currentTime', { get: () => now() - lag, configurable: true });
        const steps = [
          ['lightJoined(120)', 2.5, () => E.lightJoined(120)],
          ['waveIn(10)', 3.5, () => E.waveIn(10)],
          ['lanternOpen()', 2.5, () => E.lanternOpen()],
          ['warm()', 2, () => E.warm()],
          ['ringSegment(5)', 2.5, () => E.ringSegment(5)],
          ['thread(5000)', 4, () => E.thread(5000)],
          ['lantern()', 3, () => E.lantern()],
        ];
        for (const [label, dur, fn] of steps) { mark(`${Math.round(lag * 1000)} ms late ${label}`, dur); fn(); await sleep(dur * 1000 + 250); }
        delete ctx.currentTime;
      }
    },
    // Reliability: 60 identical bells (E5, a pitch the bed does not contain), 2 s apart. Every one must sound.
    drops: async () => {
      await start(true);
      await sleep(7000);
      for (let i = 0; i < 60; i++) { mark(`bell ${i}`, 0.4, { probeHz: 659.2551 }); E.lightJoined(120); await sleep(2000); }
    },
    dropsQuiet: async () => {
      await start(false);
      await sleep(500);
      for (let i = 0; i < 20; i++) { mark(`bell ${i}`, 0.4, { probeHz: 659.2551 }); E.lightJoined(120); await sleep(7000); }
    },
    // Static transfer curve + step response of the engine's own master chain (compressor → trim).
    chain: async () => {
      await start(false);
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const g = ctx.createGain();
      g.gain.value = 0;
      origConnect.call(osc, g);
      origConnect.call(g, comp);
      oscStart.call(osc);
      await sleep(200);
      for (const a of [0.03, 0.1, 0.2, 0.35, 0.5, 0.7, 1.0, 1.5, 2.5]) {
        g.gain.setTargetAtTime(a, ctx.currentTime, 0.003);
        await sleep(1000);
        mark(`sine in ${a}`, 0.8, { amp: a });
        await sleep(850);
      }
      g.gain.setTargetAtTime(0, ctx.currentTime, 0.003);
      await sleep(1500);
      mark('step 0 -> 1.5', 0.6, { amp: 1.5 });
      g.gain.setTargetAtTime(1.5, ctx.currentTime + 0.02, 0.0005);
      await sleep(900);
      g.gain.setTargetAtTime(0, ctx.currentTime, 0.003);
      extra.comp = { threshold: comp.threshold.value, knee: comp.knee.value, ratio: comp.ratio.value, attack: comp.attack.value, release: comp.release.value };
      // Reverb impulse: Schroeder decay of the buffer the engine actually installed.
      const ir = conv.buffer.getChannelData(0);
      const edc = new Float64Array(ir.length);
      let acc = 0;
      for (let i = ir.length - 1; i >= 0; i--) { acc += ir[i] * ir[i]; edc[i] = acc; }
      const at = (db) => { const th = edc[0] * Math.pow(10, db / 10); let i = 0; while (i < edc.length && edc[i] > th) i++; return i / ctx.sampleRate; };
      extra.reverb = { irSeconds: ir.length / ctx.sampleRate, t10: at(-10), t20: at(-20), t30: at(-30), t40: at(-40), t60: at(-60), rt60FromT30: (at(-35) - at(-5)) * 2, normalize: conv.normalize };
      await sleep(300);
    },
  };

  await S[scenario]();
  await sleep(250);
  E.dispose();

  chunks.sort((a, b) => a.frame - b.frame);
  let gaps = 0;
  for (let i = 1; i < chunks.length; i++) if (i > 1 && chunks[i].frame !== chunks[i - 1].frame + 4096) { gaps++; (extra.gapInfo ??= []).push([chunks[i - 1].frame - chunks[0].frame, chunks[i].frame - chunks[i - 1].frame, chunks.length]); }
  // place every block at its own frame, so a skipped block cannot shift what follows
  const first = chunks.length ? chunks[0].frame : 0;
  const frames = chunks.length ? chunks[chunks.length - 1].frame + 4096 - first : 0;
  const all = new Float32Array(frames * 2);
  chunks.forEach((c) => all.set(c.data, (c.frame - first) * 2));
  const bytes = new Uint8Array(all.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { sr: ctx.sampleRate, f0: chunks.length ? chunks[0].frame : 0, gaps, b64: btoa(bin), marks, oscs, extra };
}

/* --------------------------------------------------------------- analysis side */

const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-inf');
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PENTA = new Set([2, 4, 6, 9, 11]);
function noteOf(hz) {
  const m = 69 + 12 * Math.log2(hz / 440);
  const r = Math.round(m);
  const inKey = [1, 2, 3, 4].some((h) => { const b = 69 + 12 * Math.log2(hz / h / 440); return Math.abs(b - Math.round(b)) < 0.12 && PENTA.has(((Math.round(b) % 12) + 12) % 12); });
  return { name: `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`, cents: Math.round((m - r) * 100), inKey };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const a = re[i]; re[i] = re[j]; re[j] = a; const b = im[i]; im[i] = im[j]; im[j] = b; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Welch power spectrum of a mono signal. Returns peaks (amplitude-calibrated) and band energy shares. */
function spectrum(x, sr) {
  const N = 32768;
  if (x.length < N) return null;
  const win = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); wsum += win[i]; }
  const pow = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    for (let k = 0; k < N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const amp = (k) => (2 * Math.sqrt(pow[k] / frames)) / wsum; // sine amplitude at bin k
  let total = 0, lt60 = 0, lt120 = 0;
  const hz = (k) => (k * sr) / N;
  for (let k = 2; k < N / 2; k++) {
    total += pow[k];
    if (hz(k) < 60) lt60 += pow[k];
    if (hz(k) < 120) lt120 += pow[k];
  }
  const peaks = [];
  for (let k = 3; k < N / 2 - 1; k++) {
    if (pow[k] > pow[k - 1] && pow[k] >= pow[k + 1]) {
      const a = Math.log(pow[k - 1] + 1e-30), b = Math.log(pow[k] + 1e-30), c = Math.log(pow[k + 1] + 1e-30);
      const off = (0.5 * (a - c)) / (a - 2 * b + c);
      // sum the main lobe for an amplitude that does not depend on where the tone falls between bins
      const lobe = Math.sqrt((pow[k - 2] + pow[k - 1] + pow[k] + pow[k + 1] + pow[k + 2]) / frames / 1.5) * 2 / wsum;
      peaks.push({ hz: hz(k + off), amp: lobe, raw: amp(k) });
    }
  }
  peaks.sort((p, q) => q.amp - p.amp);
  const top = [];
  for (const p of peaks) {
    if (top.length >= 10 || p.amp < peaks[0].amp * 0.05) break;
    if (top.some((t) => Math.abs(t.hz - p.hz) < 6)) continue;
    top.push(p);
  }
  return { top, all: peaks.slice(0, 400), lt60: total ? lt60 / total : 0, lt120: total ? lt120 / total : 0 };
}

/** All the numbers for one stretch of stereo audio. */
function analyse(L, R, sr, opts = {}) {
  const n = L.length;
  let peak = 0, sumL = 0, sumR = 0, sqL = 0, sqR = 0, clipped = 0, peakAt = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) { peak = a; peakAt = i; }
    if (a >= 1) clipped++;
    sumL += l; sumR += r; sqL += l * l; sqR += r * r;
  }
  // RMS = mean power of the two channels (so panning does not change a sound's level); peak = louder channel
  const rms = Math.sqrt((sqL + sqR) / 2 / Math.max(1, n));
  const dc = Math.max(Math.abs(sumL / n), Math.abs(sumR / n));

  // 100 ms windows
  const w = Math.round(sr * 0.1);
  const win = [];
  for (let s = 0; s + w <= n; s += w) {
    let a = 0, b = 0;
    for (let i = s; i < s + w; i++) { a += L[i] * L[i]; b += R[i] * R[i]; }
    win.push(dB(Math.sqrt((a + b) / 2 / w)));
  }
  const lastAbove = (th) => { let k = -1; win.forEach((v, i) => { if (v > th) k = i; }); return (k + 1) * 0.1; };

  // clicks: biggest sample-to-sample jump, and how much it sticks out of its surroundings
  let maxJump = 0, jumpAt = 0, clickRatio = 0, clickAt = 0;
  for (const X of [L, R]) {
    const d2 = new Float64Array(n + 1);
    for (let i = 1; i < n; i++) { const d = X[i] - X[i - 1]; d2[i + 1] = d2[i] + d * d; }
    const H = 256;
    for (let i = 1; i < n; i++) {
      const d = Math.abs(X[i] - X[i - 1]);
      if (d > maxJump) { maxJump = d; jumpAt = i; }
      if (d < 0.0005) continue;
      const lo = Math.max(1, i - H), hi = Math.min(n - 1, i + H);
      const e = d2[hi + 1] - d2[lo] - (d2[Math.min(n, i + 3)] - d2[Math.max(1, i - 2)]);
      const ref = Math.sqrt(Math.max(0, e) / Math.max(1, hi - lo - 4));
      const ratio = d / Math.max(ref, 2e-5);
      if (ratio > clickRatio) { clickRatio = ratio; clickAt = i; }
    }
  }
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i]);
  const spec = opts.spectrum === false ? null : spectrum(mono, sr);
  return {
    seconds: n / sr,
    peakDb: dB(peak), peakAt: peakAt / sr, rmsDb: dB(rms), dc, clipped,
    winMaxDb: win.length ? Math.max(...win) : -Infinity, winMinDb: win.length ? Math.min(...win) : -Infinity,
    to50: lastAbove(-50), to60: lastAbove(-60), win,
    maxJump, jumpAt: jumpAt / sr, clickRatio, clickAt: clickAt / sr,
    // the frequency a sine as loud as this segment's peak would need to produce maxJump legitimately
    jumpAsHz: peak > 0 ? (maxJump * sr) / (2 * Math.PI * peak) : 0,
    spec: spec && { top: spec.top, lt60: spec.lt60, lt120: spec.lt120 },
    specAll: opts.keepAll && spec ? spec.all : undefined,
  };
}

function writeWav(path, L, R, sr) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], 44 + i * 8); buf.writeFloatLE(R[i], 48 + i * 8); }
  writeFileSync(path, buf);
}

/* ------------------------------------------------------------------------ run */

const OPTIONAL = ['drops', 'dropsQuiet']; // only with --only=
const SCENARIOS = ['chain', 'bed', 'arrive', 'lightJoined', 'waveOut', 'waveIn', 'thread', 'lantern', 'ring', 'late', 'stress', 'mute', 'twinkle1', 'twinkle8', 'twinkle200'];
const todo = ONLY ? ONLY.filter((s) => SCENARIOS.includes(s) || OPTIONAL.includes(s)) : SCENARIOS;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext();
await context.route('**/__audio_qa__.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>audio qa</title>' }));

async function run(name) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] page error: ${e.message}`));
  await page.goto(`${BASE}/__audio_qa__.html`);
  const res = await page.evaluate(pageMain, { scenario: name, sr: SR, long: LONG });
  await page.close();
  const raw = Buffer.from(res.b64, 'base64');
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = f.length / 2;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  if (WAV) writeWav(`${OUT}/${name}.wav`, L, R, res.sr);
  const segs = res.marks.map((m) => {
    const a = Math.max(0, Math.round(m.t * res.sr) - res.f0);
    const b = Math.min(n, a + Math.round(m.dur * res.sr));
    return { ...m, ...analyse(L.subarray(a, b), R.subarray(a, b), res.sr, { keepAll: name === 'chain' }), a, b };
  });
  return { name, sr: res.sr, gaps: res.gaps, seconds: n / res.sr, segs, oscs: res.oscs, extra: res.extra, whole: analyse(L, R, res.sr, { spectrum: false }), L, R, f0: res.f0 };
}

console.log(`audio-qa: ${todo.length} scenario(s), real time, ${SR} Hz …`);
const JOBS = Number(arg('jobs', 5));
const results = new Array(todo.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, todo.length) }, async () => {
  while (next < todo.length) {
    const i = next++;
    results[i] = await run(todo[i]).catch((e) => ({ name: todo[i], error: String(e?.stack ?? e) }));
  }
}));
await browser.close();

const problems = [];
const warnings = [];
const bad = (msg) => { problems.push(msg); };
const row = (cols, widths) => cols.map((c, i) => String(c).padEnd(widths[i])).join(' ');
const W = [28, 7, 7, 7, 7, 8, 6, 6, 9, 7, 8];
const by = Object.fromEntries(results.map((r) => [r.name, r]));
const peaksText = (spec, k = 6) => (spec ? spec.top.slice(0, k).map((p) => { const nn = noteOf(p.hz); return `${p.hz.toFixed(1)}Hz ${nn.name}${nn.cents ? (nn.cents > 0 ? '+' : '') + nn.cents + 'c' : ''}${nn.inKey ? '' : '(!)'} ${f1(dB(p.amp))}`; }).join(' | ') : 'n/a');

for (const r of results) {
  console.log(`\n=== ${r.name} ===`);
  if (r.error) { console.log(r.error); bad(`${r.name}: failed to run`); continue; }
  if (r.gaps && r.name === 'mute') console.log(`  (${r.gaps} discontinuity in the frame counter: the suspend)`);
  else if (r.gaps) warnings.push(`${r.name}: the recording has ${r.gaps} discontinuity(ies) (frame offset, step, blocks: ${JSON.stringify(r.extra.gapInfo)}) — a hiccup of this machine's audio thread, not of the engine; rerun with --only=${r.name} before trusting its click numbers`);
  if (r.name.startsWith('drops')) {
    // amplitude of the bell's fundamental in the 0.4 s after each call (Goertzel on the mono mix)
    const amps = r.segs.map((sg) => {
      const w = (2 * Math.PI * sg.probeHz) / r.sr;
      let re = 0, im = 0;
      const n = sg.b - sg.a;
      for (let i = 0; i < n; i++) { const x = 0.5 * (r.L[sg.a + i] + r.R[sg.a + i]); re += x * Math.cos(w * i); im -= x * Math.sin(w * i); }
      return (2 * Math.hypot(re, im)) / n;
    });
    const sorted = [...amps].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const missing = amps.map((a, i) => (a < med * 0.25 ? i : -1)).filter((i) => i >= 0);
    console.log(`  ${amps.length} bells; fundamental level median ${f1(dB(med))} dBFS, min ${f1(dB(sorted[0]))}, max ${f1(dB(sorted[sorted.length - 1]))}; missing: ${missing.length ? missing.join(',') : 'none'}`);
    if (missing.length) bad(`${r.name}: ${missing.length} of ${amps.length} bells did not sound (#${missing.join(',')})`);
    continue;
  }
  if (r.name === 'chain') {
    console.log('master chain (compressor -> trim), 440 Hz sine straight into the compressor:');
    for (const s of r.segs.filter((x) => x.label.startsWith('sine'))) {
      let thd = NaN;
      if (s.specAll) {
        const at = (hz) => Math.max(0, ...s.specAll.filter((p) => Math.abs(p.hz - hz) < 8).map((p) => p.amp));
        const h1 = at(440);
        thd = h1 ? Math.sqrt([2, 3, 4, 5, 6, 7].reduce((a, h) => a + at(440 * h) ** 2, 0)) / h1 : NaN;
      }
      console.log(`  in ${f1(dB(s.amp)).padStart(6)} dBFS -> out ${f1(s.peakDb).padStart(6)} dBFS   gain ${f1(s.peakDb - dB(s.amp)).padStart(5)} dB   THD ${Number.isFinite(thd) ? (thd * 100).toFixed(3) + ' %' : 'n/a'}`);
    }
    const st = r.segs.find((x) => x.label.startsWith('step'));
    if (st) console.log(`  step 0 -> +3.5 dBFS: overshoot peak ${f1(st.peakDb)} dBFS at ${(st.peakAt * 1000).toFixed(1)} ms, settles to ${f1(st.win[st.win.length - 1] + 3.01)} dBFS peak`);
    console.log('  compressor:', JSON.stringify(r.extra.comp));
    console.log('  reverb impulse:', JSON.stringify(r.extra.reverb, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
    continue;
  }
  console.log(row(['segment', 'peak', 'rms', 'win max', 'win min', 'DC', 'clip', 'to-50', 'maxJump', 'as Hz', 'click x'], W));
  for (const s of r.segs) {
    console.log(row([s.label, f1(s.peakDb), f1(s.rmsDb), f1(s.winMaxDb), f1(s.winMinDb), s.dc.toFixed(5), s.clipped, s.to50.toFixed(1), s.maxJump.toFixed(5), Math.round(s.jumpAsHz), s.clickRatio.toFixed(1)], W));
    if (s.spec) console.log(`    spectrum: ${peaksText(s.spec)}\n    energy <60 Hz ${(s.spec.lt60 * 100).toFixed(2)} %, <120 Hz ${(s.spec.lt120 * 100).toFixed(1)} %`);
    if (!s.pre && s.peakDb < -60 && !s.label.startsWith('muted')) bad(`${r.name}/${s.label}: produced no sound (peak ${f1(s.peakDb)} dBFS)`);
    if (s.clipped) bad(`${r.name}/${s.label}: ${s.clipped} sample(s) >= 1.0`);
    if (s.peakDb > -3) bad(`${r.name}/${s.label}: peak ${f1(s.peakDb)} dBFS > -3`);
    if (s.dc > 0.002) bad(`${r.name}/${s.label}: DC ${s.dc.toFixed(4)}`);
    if (s.clickRatio > 8) bad(`${r.name}/${s.label}: possible click (jump ${s.maxJump.toFixed(4)} is ${s.clickRatio.toFixed(1)}x its surroundings at ${s.clickAt.toFixed(3)} s)`);
  }
  if (r.name === 'bed') {
    const s = r.segs[0];
    const sec = [];
    for (let i = 0; i + 10 <= s.win.length; i += 10) sec.push(dB(Math.sqrt(s.win.slice(i, i + 10).reduce((a, v) => a + Math.pow(10, v / 10), 0) / 10)));
    console.log('    per-second RMS dBFS: ' + sec.map((v) => f1(v)).join(' '));
    const a = r.segs[0].a + 8 * r.sr, b = r.segs[0].b;
    const steady = analyse(r.L.subarray(a, b), r.R.subarray(a, b), r.sr);
    r.steady = steady;
    console.log(`    steady state (8 s on): rms ${f1(steady.rmsDb)} dBFS, peak ${f1(steady.peakDb)}, 100 ms windows ${f1(steady.winMinDb)} .. ${f1(steady.winMaxDb)}, DC ${steady.dc.toFixed(5)}`);
    console.log(`    steady spectrum: ${peaksText(steady.spec, 10)}`);
    // audible-band level: what is left above 120 Hz (small speakers reproduce nothing below)
    console.log(`    share of energy below 120 Hz: ${(steady.spec.lt120 * 100).toFixed(1)} %  ->  above-120 Hz level ≈ ${f1(steady.rmsDb + 10 * Math.log10(Math.max(1e-9, 1 - steady.spec.lt120)))} dBFS`);
    if (steady.rmsDb < -34 || steady.rmsDb > -26) bad(`bed steady RMS ${f1(steady.rmsDb)} dBFS outside -34..-26`);
    if (steady.winMaxDb - steady.winMinDb > 8) bad(`bed pumps: 100 ms windows span ${f1(steady.winMaxDb - steady.winMinDb)} dB`);
  }
  if (r.name === 'mute') {
    const m = r.segs.find((s) => s.label.startsWith('muted'));
    if (m && m.peakDb > -80) bad(`not silent when muted: peak ${f1(m.peakDb)} dBFS`);
    console.log(`    context state while suspended: ${r.extra.stateWhileSuspended}; baseLatency ${r.extra.baseLatency}`);
  }
  if (r.name.startsWith('twinkle')) {
    const s = r.segs[0];
    const times = [...new Set(r.oscs.filter((o) => o.t >= s.t).map((o) => o.t.toFixed(4)))].map(Number).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const notes = [...new Set(r.oscs.filter((o) => o.t >= s.t).map((o) => noteOf(o.f).name))];
    console.log(`    ${times.length} bells in ${s.dur} s (${(times.length / s.dur * 60).toFixed(1)}/min); gaps ${gaps.length ? Math.min(...gaps).toFixed(2) : '-'} .. ${gaps.length ? Math.max(...gaps).toFixed(2) : '-'} s; ${notes.length} distinct partial pitches`);
    r.bells = times.length;
  }
  // intended pitches: every oscillator the engine started must be a harmonic 1..4 of a D-pentatonic note
  const off = r.oscs.filter((o) => o.f > 20 && ![1, 2, 3, 4].some((h) => { const m = 69 + 12 * Math.log2(o.f / h / 440); return Math.abs(m - Math.round(m)) < 0.01 && PENTA.has(((Math.round(m) % 12) + 12) % 12); }));
  if (off.length) bad(`${r.name}: ${off.length} oscillator(s) off the D pentatonic scale, e.g. ${off[0].f.toFixed(2)} Hz`);
}

// Events vs bed
const bedRms = by.bed?.steady?.rmsDb;
if (bedRms !== undefined) {
  console.log(`\n=== events against the bed (bed steady RMS ${f1(bedRms)} dBFS) ===`);
  for (const r of results) {
    if (r.error || ['bed', 'chain', 'mute', 'stress', 'late'].includes(r.name) || r.name.startsWith('drops')) continue;
    for (const s of r.segs) {
      const over = s.winMaxDb - bedRms;
      console.log(`  ${s.label.padEnd(26)} peak ${f1(s.peakDb).padStart(6)}  loudest 100 ms ${f1(s.winMaxDb).padStart(6)}  = bed ${over >= 0 ? '+' : ''}${f1(over)} dB   audible ≈ ${s.to50.toFixed(1)} s`);
    }
  }
}

console.log(`\n=== verdict ===`);
for (const w of warnings) console.log('  WARN ' + w);
if (problems.length) { for (const p of problems) console.log('  FAIL ' + p); } else console.log('  no hard limit broken');

mkdirSync(OUT, { recursive: true });
const strip = (r) => { const { L, R, ...rest } = r; return { ...rest, segs: rest.segs?.map(({ win, specAll, ...s }) => s) }; };
writeFileSync(`${OUT}/report.json`, JSON.stringify({ when: new Date().toISOString(), problems, results: results.map(strip) }, null, 1));
console.log(`\nreport: ${OUT}/report.json${WAV ? `, recordings: ${OUT}/*.wav` : ''}`);
process.exit(problems.length ? 1 : 0);

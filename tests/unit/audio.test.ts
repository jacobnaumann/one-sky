import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, lonToNote, midiToHz } from '../../src/audio/engine';

/* ------------------------------------------------------------------ pure parts */

const PENTATONIC_D = new Set([2, 4, 6, 9, 11]); // D E F# A B

describe('lonToNote / midiToHz', () => {
  it('midiToHz is exact at A4 and doubles per octave', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBeCloseTo(880, 9);
    expect(midiToHz(57)).toBeCloseTo(220, 9);
    expect(midiToHz(62)).toBeCloseTo(293.6648, 3); // D4
    expect(midiToHz(50)).toBeCloseTo(146.8324, 3); // D3
  });

  it('is monotonic non-decreasing west → east', () => {
    let prev = -Infinity;
    for (let lon = -180; lon <= 180; lon += 0.25) {
      const n = lonToNote(lon);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('stays in D3..A5 and on D major pentatonic', () => {
    const seen = new Set<number>();
    for (let lon = -180; lon <= 180; lon += 0.25) {
      const n = lonToNote(lon);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(50);
      expect(n).toBeLessThanOrEqual(81);
      expect(PENTATONIC_D.has(n % 12)).toBe(true);
      seen.add(n);
    }
    expect(lonToNote(-180)).toBe(50);
    expect(lonToNote(180)).toBe(81);
    expect(seen.size).toBe(14); // every scale note is reachable
  });

  it('is deterministic and tolerates garbage', () => {
    expect(lonToNote(12.34)).toBe(lonToNote(12.34));
    for (const bad of [NaN, Infinity, -Infinity, 9999, -9999]) {
      const n = lonToNote(bad);
      expect(n).toBeGreaterThanOrEqual(50);
      expect(n).toBeLessThanOrEqual(81);
      expect(PENTATONIC_D.has(n % 12)).toBe(true);
    }
  });
});

/* ------------------------------------------------------- every method, driver */

function exercise(e: AudioEngine): void {
  e.setLights([
    { id: 'a', lon: -122, lat: 37 },
    { id: 'b', lon: 2, lat: 48 },
    { id: 'c', lon: 139, lat: 35 },
  ]);
  e.arrive();
  for (const lon of [-180, -75, 0, 77, 180, NaN]) e.lightJoined(lon);
  e.waveOut(-122, 139, 1.8);
  e.waveOut(139, -122, 0);
  e.waveOut(0, 0, NaN);
  e.waveOut(180, -180, 99);
  e.waveIn(2);
  e.waveIn(NaN);
  for (const km of [0, 800, 5000, 9000, 20000, 1e9, -5, NaN]) e.thread(km);
  e.lantern();
  e.lanternOpen();
  e.warm();
  e.warm();
  e.warm();
  e.warm();
  for (let i = -1; i <= 24; i++) e.ringSegment(i);
  e.ringSegment(NaN);
  e.ringComplete();
  e.uiTick();
  e.uiTick();
}

describe('AudioEngine without Web Audio', () => {
  it('constructs and every method is a silent no-op', async () => {
    expect((globalThis as any).AudioContext).toBeUndefined();
    const e = new AudioEngine();
    expect(e.started).toBe(false);
    expect(e.muted).toBe(false);
    expect(() => exercise(e)).not.toThrow(); // before start()
    await expect(e.start()).resolves.toBeUndefined();
    expect(e.started).toBe(false);
    expect(() => exercise(e)).not.toThrow();
    e.muted = true;
    expect(e.muted).toBe(true);
    e.muted = false;
    expect(() => {
      e.suspend();
      e.resume();
      e.dispose();
      e.dispose();
      exercise(e);
    }).not.toThrow();
    await expect(e.start()).resolves.toBeUndefined();
  });

  it('survives an AudioContext constructor that throws', async () => {
    (globalThis as any).AudioContext = class {
      constructor() {
        throw new Error('nope');
      }
    };
    try {
      const e = new AudioEngine();
      await expect(e.start()).resolves.toBeUndefined();
      expect(e.started).toBe(false);
      expect(() => exercise(e)).not.toThrow();
    } finally {
      delete (globalThis as any).AudioContext;
    }
  });
});

/* ---------------------------------------------------------- fake AudioContext */

interface Rec {
  kind: string; // gain | frequency | pan | detune | Q | ...
  method: string;
  value: number;
  time: number;
  extra?: number;
  node: FakeNode;
}

let records: Rec[] = [];
let nodes: FakeNode[] = [];
let contexts: FakeContext[] = [];

class FakeParam {
  private _value: number;
  constructor(public kind: string, public node: FakeNode, initial: number) {
    this._value = initial;
  }
  private rec(method: string, value: number, time: number, extra?: number): this {
    records.push({ kind: this.kind, method, value, time, extra, node: this.node });
    return this;
  }
  get value(): number {
    return this._value;
  }
  set value(v: number) {
    this._value = v;
    this.rec('value', v, this.node.ctx.currentTime);
  }
  setValueAtTime(v: number, t: number) { return this.rec('setValueAtTime', v, t); }
  linearRampToValueAtTime(v: number, t: number) { return this.rec('linearRamp', v, t); }
  exponentialRampToValueAtTime(v: number, t: number) { return this.rec('expRamp', v, t); }
  setTargetAtTime(v: number, t: number, tc: number) { return this.rec('setTarget', v, t, tc); }
  cancelScheduledValues(_t: number) { return this; }
}

class FakeNode {
  modulator = false; // output feeds an AudioParam (LFO depth), not the audio path
  connected = 0;
  disconnected = false;
  startTime: number | null = null;
  stopTime = Infinity;
  onended: (() => void) | null = null;
  ended = false;
  type = '';
  loop = false;
  buffer: unknown = null;
  [k: string]: unknown;
  constructor(public ctx: FakeContext, public name: string, params: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(params)) this[k] = new FakeParam(k, this, v);
    nodes.push(this);
  }
  connect(dest: unknown): void {
    if (dest instanceof FakeParam) this.modulator = true;
    else if (!(dest instanceof FakeNode)) throw new TypeError('connect: bad destination');
    this.connected++;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  start(t = 0): void {
    if (this.startTime !== null) throw new Error('start called twice');
    if (!Number.isFinite(t) || t < 0) throw new RangeError('bad start time');
    this.startTime = t;
  }
  stop(t = 0): void {
    if (this.startTime === null) throw new Error('stop before start');
    if (!Number.isFinite(t) || t < 0) throw new RangeError('bad stop time');
    this.stopTime = Math.max(t, this.ctx.currentTime);
  }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 44100;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination: FakeNode;
  constructor() {
    this.destination = new FakeNode(this, 'destination');
    contexts.push(this);
  }
  resume() { if (this.state !== 'closed') this.state = 'running'; return Promise.resolve(); }
  suspend() { if (this.state !== 'closed') this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() { return new FakeNode(this, 'gain', { gain: 1 }); }
  createOscillator() { return new FakeNode(this, 'osc', { frequency: 440, detune: 0 }); }
  createBufferSource() { return new FakeNode(this, 'bufsrc', { playbackRate: 1, detune: 0 }); }
  createBiquadFilter() { return new FakeNode(this, 'biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 }); }
  createStereoPanner() { return new FakeNode(this, 'panner', { pan: 0 }); }
  createConvolver() { return new FakeNode(this, 'convolver'); }
  createDynamicsCompressor() {
    return new FakeNode(this, 'comp', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c: number) => data[c]! };
  }
  /** Move the clock and fire `onended` for sources that have finished. */
  advance(to: number): void {
    this.currentTime = to;
    for (const n of nodes) {
      if (n.ctx === this && n.startTime !== null && !n.ended && n.stopTime <= to) {
        n.ended = true;
        n.onended?.();
      }
    }
  }
}

const liveSourcesAt = (t: number, from = 0): FakeNode[] =>
  nodes.slice(from).filter((n) => n.name === 'osc' && n.startTime !== null && n.startTime <= t && n.stopTime > t);

/** Assert every value ever written to an AudioParam is sane. */
function checkRecords(): void {
  expect(records.length).toBeGreaterThan(0);
  for (const r of records) {
    const where = `${r.node.name}.${r.kind} ${r.method}(${r.value}, ${r.time}, ${r.extra})`;
    expect(Number.isFinite(r.value), where).toBe(true);
    expect(Number.isFinite(r.time) && r.time >= 0, where).toBe(true);
    if (r.method === 'setTarget') expect(r.extra! > 0 && Number.isFinite(r.extra!), where).toBe(true);
    if (r.method === 'expRamp') expect(r.value > 0, where).toBe(true);
    if (r.kind === 'gain' && r.node.name === 'gain' && !r.node.modulator) {
      expect(r.value >= 0 && r.value <= 1, where).toBe(true);
    }
    if (r.kind === 'frequency') {
      expect(r.value > 0 && r.value < 20000, where).toBe(true);
    }
    if (r.kind === 'pan') expect(Math.abs(r.value) <= 1, where).toBe(true);
  }
}

describe('AudioEngine on a fake AudioContext', () => {
  beforeEach(() => {
    records = [];
    nodes = [];
    contexts = [];
    vi.useFakeTimers();
    (globalThis as any).AudioContext = FakeContext;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).AudioContext;
    delete (globalThis as any).webkitAudioContext;
  });

  it('start() is idempotent, resumes the context and builds a quiet bed', async () => {
    const e = new AudioEngine();
    exercise(e); // before start: nothing may be created
    expect(nodes.length).toBe(0);
    await e.start();
    await e.start();
    expect(e.started).toBe(true);
    expect(contexts.length).toBe(1);
    expect(contexts[0]!.state).toBe('running');
    expect(nodes.some((n) => n.name === 'convolver' && n.buffer !== null)).toBe(true);
    expect(nodes.some((n) => n.name === 'comp')).toBe(true);
    // bed fades in from 0 to a low level over ~6 s
    const ramp = records.find((r) => r.method === 'linearRamp' && r.kind === 'gain');
    expect(ramp).toBeDefined();
    expect(ramp!.value).toBeLessThan(0.1);
    expect(ramp!.time).toBeCloseTo(6, 5);
    checkRecords();
    e.dispose();
    expect(contexts[0]!.state).toBe('closed');
    expect(e.started).toBe(false);
  });

  it('every event schedules only sane values (gain 0..1, finite positive frequencies)', async () => {
    const e = new AudioEngine();
    await e.start();
    const before = nodes.length;
    exercise(e);
    expect(nodes.length).toBeGreaterThan(before);
    checkRecords();

    // event envelopes stay conservative: no single partial above 0.3 (≈ -10.5 dBFS; the measured
    // output peak of the loudest event, waveIn, is ≈ -10 dBFS — see scripts/audio-qa.mjs)
    const eventGains = records.filter(
      (r) => ['setTarget', 'linearRamp', 'setValueAtTime'].includes(r.method) && r.kind === 'gain' && nodes.indexOf(r.node) >= before,
    );
    expect(eventGains.length).toBeGreaterThan(0);
    for (const r of eventGains) expect(r.value).toBeLessThanOrEqual(0.3);

    // every oscillator frequency in events is a harmonic (1..4) of a D-pentatonic pitch, or a glide endpoint of one
    for (const r of records) {
      if (r.kind !== 'frequency' || r.node.name !== 'osc' || nodes.indexOf(r.node) < before) continue;
      const ok = [1, 2, 3, 4].some((h) => {
        const midi = 69 + 12 * Math.log2(r.value / h / 440);
        return Math.abs(midi - Math.round(midi)) < 1e-6 && PENTATONIC_D.has(((Math.round(midi) % 12) + 12) % 12);
      });
      expect(ok, `off-scale frequency ${r.value}`).toBe(true);
    }
    e.dispose();
  });

  it('each event method makes sound on its own', async () => {
    const e = new AudioEngine();
    await e.start();
    const calls: [string, () => void][] = [
      ['arrive', () => e.arrive()],
      ['lightJoined', () => e.lightJoined(10)],
      ['waveOut', () => e.waveOut(-50, 60, 1)],
      ['waveIn', () => e.waveIn(30)],
      ['thread', () => e.thread(12000)],
      ['lantern', () => e.lantern()],
      ['lanternOpen', () => e.lanternOpen()],
      ['warm', () => e.warm()],
      ['ringSegment', () => e.ringSegment(7)],
      ['ringComplete', () => e.ringComplete()],
      ['uiTick', () => e.uiTick()],
    ];
    let t = 0;
    for (const [name, fn] of calls) {
      t += 20;
      contexts[0]!.advance(t);
      const before = nodes.length;
      fn();
      const started = nodes.slice(before).filter((n) => n.startTime !== null);
      expect(started.length, name).toBeGreaterThan(0);
      for (const s of started) {
        expect(s.startTime!, name).toBeGreaterThanOrEqual(t);
        expect(Number.isFinite(s.stopTime), `${name} must schedule a stop`).toBe(true);
        expect(s.stopTime, name).toBeGreaterThan(s.startTime!);
      }
    }
    checkRecords();
    e.dispose();
  });

  it('waveIn is the fixed chime A4 → D5; waveOut lands its second note on arrival', async () => {
    const e = new AudioEngine();
    await e.start();
    let before = nodes.length;
    e.waveIn(0);
    const fundamentals = (from: number) =>
      nodes.slice(from).filter((n) => n.name === 'osc').map((n) => ({ f: (n.frequency as FakeParam).value, at: n.startTime! }));
    const inF = fundamentals(before);
    expect(inF[0]!.f).toBeCloseTo(440, 6);
    const d5 = inF.find((o) => Math.abs(o.f - 587.3295) < 0.01);
    expect(d5).toBeDefined();
    expect(d5!.at - inF[0]!.at).toBeCloseTo(0.19, 6);

    before = nodes.length;
    e.waveOut(-100, 100, 2);
    const out = fundamentals(before);
    const t0 = Math.min(...out.map((o) => o.at));
    const last = out.filter((o) => Math.abs(o.at - (t0 + 2)) < 1e-6);
    expect(last.length).toBeGreaterThan(0);
    expect(last[0]!.f).toBeGreaterThan(out[0]!.f); // rising
    e.dispose();
  });

  it('short attacks are a linear ramp anchored at the peak (a late-scheduled note must not be lost)', async () => {
    // Measured in Chromium: when a whole attack is already in the past, an exponential-approach
    // attack (and sometimes a bare ramp) collapses to gain 0. The setValueAtTime anchor prevents it.
    const e = new AudioEngine();
    await e.start();
    const mark = records.length;
    e.lightJoined(0);
    const env = records.slice(mark).filter((r) => r.kind === 'gain' && r.method !== 'value');
    const ramps = env.filter((r) => r.method === 'linearRamp');
    expect(ramps.length).toBe(3); // fundamental + two partials
    for (const ramp of ramps) {
      const own = env.filter((r) => r.node === ramp.node);
      expect(own.map((r) => r.method)).toEqual(['setValueAtTime', 'linearRamp', 'setValueAtTime', 'setTarget']);
      expect(own[0]!.value).toBe(0);
      expect(own[2]!.value).toBe(ramp.value); // anchor = peak
      expect(own[2]!.time).toBe(ramp.time); // at the end of the ramp
      expect(own[3]!.value).toBe(0);
      expect(own[3]!.time).toBeGreaterThanOrEqual(ramp.time);
    }
    e.dispose();
  });

  it('schedules further ahead on outputs with a large buffer', async () => {
    const e = new AudioEngine();
    await e.start();
    contexts[0]!.advance(5);
    let before = nodes.length;
    e.lightJoined(0);
    expect(Math.min(...nodes.slice(before).filter((n) => n.startTime !== null).map((n) => n.startTime!))).toBeCloseTo(5.03, 6);
    (contexts[0] as unknown as { baseLatency: number }).baseLatency = 0.08;
    before = nodes.length;
    e.lightJoined(0);
    expect(Math.min(...nodes.slice(before).filter((n) => n.startTime !== null).map((n) => n.startTime!))).toBeCloseTo(5.095, 6);
    e.dispose();
  });

  it('bells arriving in a burst get quieter, and recover after a pause', async () => {
    const e = new AudioEngine();
    await e.start();
    const peakOf = (fn: () => void): number => {
      const mark = records.length;
      fn();
      return Math.max(...records.slice(mark).filter((r) => r.method === 'linearRamp' && r.kind === 'gain').map((r) => r.value));
    };
    for (const fn of [() => e.lightJoined(0), () => e.ringSegment(12)]) {
      const first = peakOf(fn);
      let last = first;
      for (let i = 0; i < 20; i++) {
        const p = peakOf(fn);
        expect(p).toBeLessThan(last);
        last = p;
      }
      expect(last).toBeLessThan(first * 0.3);
      contexts[0]!.advance(contexts[0]!.currentTime + 30);
      expect(peakOf(fn)).toBeCloseTo(first, 6);
    }
    e.dispose();
  });

  it('caps simultaneous voices at 24', async () => {
    const e = new AudioEngine();
    await e.start();
    const before = nodes.length;
    for (let i = 0; i < 200; i++) e.lightJoined(-180 + (i * 360) / 200);
    // each bell voice has at most 3 oscillators; stolen voices have stopped by +0.2 s
    expect(liveSourcesAt(0.5, before).length).toBeLessThanOrEqual(24 * 3);
    expect(liveSourcesAt(0.5, before).length).toBeGreaterThan(0);
    checkRecords();
    e.dispose();
  });

  it('disconnects finished voices (no leaks)', async () => {
    const e = new AudioEngine();
    await e.start();
    const before = nodes.length;
    exercise(e);
    const made = nodes.slice(before);
    expect(made.every((n) => !n.disconnected)).toBe(true);
    contexts[0]!.advance(60);
    expect(made.filter((n) => !n.disconnected).length).toBe(0);
    e.dispose();
  });

  it('twinkles only when there are lights, and not while muted or suspended', async () => {
    const e = new AudioEngine();
    await e.start();
    const base = nodes.length;
    vi.advanceTimersByTime(60_000);
    expect(nodes.length).toBe(base); // zero lights → silence

    e.setLights(Array.from({ length: 500 }, (_, i) => ({ id: `l${i}`, lon: -180 + (i * 360) / 500, lat: 0 })));
    vi.advanceTimersByTime(60_000);
    const bells = nodes.slice(base).filter((n) => n.name === 'osc').length / 3;
    expect(bells).toBeGreaterThanOrEqual(60 / 7 - 1); // at least one every 7 s
    expect(bells).toBeLessThanOrEqual((60 / 2.5) * 2); // density capped however many lights
    checkRecords();

    const afterTwinkles = nodes.length;
    e.muted = true;
    e.lightJoined(0);
    vi.advanceTimersByTime(30_000);
    expect(nodes.length).toBe(afterTwinkles);
    e.muted = false;

    e.suspend();
    vi.advanceTimersByTime(30_000);
    expect(contexts[0]!.state).toBe('suspended');
    e.waveIn(0);
    expect(nodes.length).toBe(afterTwinkles);
    e.resume();
    expect(contexts[0]!.state).toBe('running');
    e.waveIn(0);
    expect(nodes.length).toBeGreaterThan(afterTwinkles);

    e.dispose();
    const end = nodes.length;
    vi.advanceTimersByTime(60_000);
    exercise(e);
    expect(nodes.length).toBe(end);
  });

  it('mute fades the master to 0 and back to 1, never jumping', async () => {
    const e = new AudioEngine();
    await e.start();
    const mark = records.length;
    e.muted = true;
    e.muted = false;
    const fades = records.slice(mark).filter((r) => r.method === 'setTarget' && r.kind === 'gain');
    expect(fades.map((r) => r.value)).toEqual([0, 1]);
    for (const r of fades) expect(r.extra! * 3).toBeCloseTo(0.4, 1);
    expect(records.slice(mark).some((r) => r.method === 'value' || r.method === 'setValueAtTime')).toBe(false);
    e.dispose();
  });

  it('works with webkitAudioContext and without StereoPanner', async () => {
    delete (globalThis as any).AudioContext;
    class Webkit extends FakeContext {}
    (Webkit.prototype as any).createStereoPanner = undefined;
    (globalThis as any).webkitAudioContext = Webkit;
    const e = new AudioEngine();
    await e.start();
    expect(e.started).toBe(true);
    expect(() => exercise(e)).not.toThrow();
    expect(nodes.some((n) => n.name === 'panner')).toBe(false);
    expect(nodes.filter((n) => n.name === 'osc').length).toBeGreaterThan(20);
    checkRecords();
    e.dispose();
  });
});

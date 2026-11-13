/**
 * One Sky — sound engine.
 *
 * A quiet observatory at night. Raw Web Audio only, no samples, no dependencies.
 *
 * KEY: D major pentatonic (D E F# A B). Every pitched sound in the app uses only
 * these pitch classes, so any overlap in any order is consonant.
 *
 * Reference frequencies (equal temperament, A4 = 440 Hz):
 *   D2  38   73.42 | A2  45  110.00
 *   D3  50  146.83 | E3  52  164.81 | F#3 54  185.00 | A3  57  220.00 | B3  59  246.94
 *   D4  62  293.66 | E4  64  329.63 | F#4 66  369.99 | A4  69  440.00 | B4  71  493.88
 *   D5  74  587.33 | E5  76  659.26 | F#5 78  739.99 | A5  81  880.00 | B5  83  987.77
 *   D6  86 1174.66 | E6  88 1318.51
 *
 * SIGNAL FLOW
 *   voices ─┬─────────────────────────────► dry ─┐
 *           └─ per-voice send ─► HP 180 Hz ─► convolver ─► wet 0.55 ─┤
 *   bed (drone + air) ─► dry / send                                  ▼
 *                              master (mute / visibility fade) ─► limiter ─► trim 0.62 ─► out
 *
 * LEVELS — measured, not estimated. `node scripts/audio-qa.mjs` runs this file in headless
 * Chromium, records every sample sent to the destination and reports peak / RMS / DC /
 * clicks / spectrum per scenario. Re-run it after changing any number in here.
 * (dBFS; peak = louder channel, RMS = mean power of both channels, 100 ms windows.)
 *   bed        -32.5 RMS steady (drifts about ±3 dB over minutes with its LFOs), peak ≈ -20
 *   twinkle    -23 .. -28 peak (loudest 100 ms ≈ the bed's level: an ambient layer, not an event)
 *   events     -18 .. -12 peak, loudest 100 ms 7-11 dB above the bed
 *   waveIn     ≈ -10 peak, loudest 100 ms ≈ 15 dB above the bed: the most noticeable sound
 *   uiTick     ≈ -31 peak (deliberately almost subliminal)
 *   everything at once: ≤ -5.5 peak (the limiter's ceiling is ≈ -6)
 * Things the arithmetic alone gets wrong (all measured):
 *   - A mono voice through a centred StereoPanner is -3 dB in each channel.
 *   - The reverb adds 1-3 dB to short bells, and its random impulse changes any one note's
 *     level by about ±1 dB from page load to page load.
 *   - DynamicsCompressorNode applies automatic make-up gain: +4.2 dB for the settings used
 *     here (it was +1.8 dB for threshold -6 / knee 6 / ratio 6). MASTER_TRIM 0.62 (-4.2 dB)
 *     undoes it exactly, so below the threshold the master chain is 0.0 dB. Change the
 *     compressor settings and the trim must be re-measured (scenario "chain").
 *   - Limiter curve: in ≤ -9 dBFS → unchanged; -6 → -7.3; 0 → -6.7; +8 → -6.1. No overshoot
 *     on a hard step (the node looks ahead), THD < 0.02 %.
 *
 * ENVELOPES
 *   Decays and slow swells are setTargetAtTime (exponential approach): click-free, cannot
 *   overshoot, and can be interrupted smoothly at any moment (voice stealing). Short attacks
 *   are a linear ramp with an anchor — see envelope() for why that is not a matter of taste.
 *   "attack" = time to peak (slow swells: to 95 %); "decay" = T60, time to fall 60 dB (time
 *   constant decay/6.908).
 */

export interface LightNote {
  id: string;
  lon: number;
  lat: number;
}

/** D major pentatonic, D3 (50) .. A5 (81): 14 notes, ~2.6 octaves. */
const SCALE: readonly number[] = [50, 52, 54, 57, 59, 62, 64, 66, 69, 71, 74, 76, 78, 81];

/** Longitude -180..180 (west → east) onto the scale, low → high. Deterministic. */
export function lonToNote(lon: number): number {
  if (!Number.isFinite(lon)) return SCALE[7]!; // F#4, the middle of the range
  const c = Math.min(180, Math.max(-180, lon));
  const i = Math.min(SCALE.length - 1, Math.floor(((c + 180) / 360) * SCALE.length));
  return SCALE[i]!;
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/* ------------------------------------------------------------------ constants */

const MAX_VOICES = 24;
const MIN_ATTACK = 0.006; // seconds; nothing ever starts faster than this
const LEAD = 0.03; // minimum scheduling lead over ctx.currentTime; see now()
const T60 = 6.908; // ln(1000): time-constant → 60 dB decay time

const MASTER_TRIM = 0.62; // undoes the compressor's automatic make-up gain (measured +4.2 dB)
const WET_LEVEL = 0.55;
const BED_LEVEL = 0.066; // measured: bed ≈ -32.5 dBFS RMS at the output
const BED_FADE_IN = 6;

interface Partial {
  ratio: number;
  level: number; // relative to the fundamental's peak
  decay?: number; // multiplier on the note's decay (upper partials die sooner, like a real bell)
}

/** Soft bell: fundamental + quiet octave + very quiet twelfth. Sum of levels = 1.34. */
const BELL: readonly Partial[] = [
  { ratio: 2, level: 0.25, decay: 0.55 },
  { ratio: 3, level: 0.09, decay: 0.35 },
];
/** Clearer chime for waveIn. Sum of levels = 1.52. */
const CHIME: readonly Partial[] = [
  { ratio: 2, level: 0.35, decay: 0.6 },
  { ratio: 3, level: 0.12, decay: 0.4 },
  { ratio: 4, level: 0.05, decay: 0.3 },
];
/** Rounder tone for pads. Sum of levels = 1.12. */
const SOFT: readonly Partial[] = [{ ratio: 2, level: 0.12, decay: 0.7 }];

interface NoteSpec {
  hz: number;
  at: number;
  /** peak amplitude of the fundamental */
  peak: number;
  attack?: number;
  hold?: number;
  decay: number;
  pan?: number;
  panTo?: number;
  panTime?: number;
  send?: number;
  type?: OscillatorType;
  partials?: readonly Partial[];
  glideTo?: number;
  glideTime?: number;
}

interface NoiseSpec {
  at: number;
  peak: number;
  attack?: number;
  hold?: number;
  decay: number;
  filter: BiquadFilterType;
  freq: number;
  freqTo?: number;
  sweep?: number;
  q?: number;
  pan?: number;
  send?: number;
}

interface Voice {
  at: number;
  sustainEnd: number; // at + attack + hold
  tau: number; // decay time constant of the fundamental
  peak: number;
  end: number;
  killed: boolean;
  envs: AudioParam[];
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const lonPan = (lon: number): number => (Number.isFinite(lon) ? clamp(lon / 180, -1, 1) * 0.85 : 0);

/**
 * Gentle loudness compensation across the lon-mapped range: low sines are weak on laptop
 * speakers, high ones are piercing. D3 → ×1.25, A5 → ×0.80.
 */
const eq = (midi: number): number => clamp(1.25 - ((midi - 50) / 31) * 0.45, 0.7, 1.25);

type Ctor = new () => AudioContext;

function contextCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private send: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  private bedSources: AudioScheduledSourceNode[] = [];
  private bedNodes: AudioNode[] = [];
  private voices = new Set<Voice>();

  private lights: LightNote[] = [];
  private twinkleTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  private _started = false;
  private _muted = false;
  private hidden = false;
  private disposed = false;
  private warmStep = 0;
  private lastTick = -1;
  private heat: Record<string, { t: number; h: number }> = {};

  get started(): boolean {
    return this._started;
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(v: boolean) {
    this._muted = !!v;
    this.fadeMaster(0.13); // 3 time constants ≈ 0.4 s
  }

  /* ---------------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.ctx) {
        const AC = contextCtor();
        if (!AC) return;
        const ctx = new AC();
        this.ctx = ctx;
        this.build(ctx);
        this._started = true;
        this.scheduleTwinkle();
      }
      if (!this.hidden) this.wake();
    } catch {
      // Web Audio unavailable or broken: stay silent.
      this.teardown();
    }
  }

  suspend(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    this.hidden = true;
    this.stopTwinkle();
    this.fadeMaster(0.06); // ~0.2 s fade out
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (!this.hidden || !this.ctx) return;
      try {
        void Promise.resolve(this.ctx.suspend()).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }, 320);
  }

  resume(): void {
    if (!this.ctx || this.disposed) return;
    this.hidden = false;
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    this.wake();
    this.fadeMaster(0.2); // ~0.6 s fade in
    this.scheduleTwinkle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
  }

  setLights(lights: LightNote[]): void {
    this.lights = Array.isArray(lights) ? lights.slice() : [];
  }

  /* ------------------------------------------------------------------- events */

  /**
   * Your own light igniting. A chord of D rises from the bottom up, then one bell.
   *   D3 A3 D4 F#4 A4 E5 entering at 0, .25, .5, .8, 1.1, 1.45 s; each 1.4 s attack,
   *   0.3 s hold, 2.6 s decay → the whole swell is ~4-4.5 s.
   *   Fundamental peaks .060 .050 .050 .042 .036 .022; bell: D5 at 1.9 s, peak .085.
   *   Measured: peak ≈ -14.5 dBFS, audible for ≈ 4 s.
   */
  arrive(): void {
    const t = this.now();
    if (t === null) return;
    const chord: [number, number, number, number][] = [
      // midi, delay, peak, pan
      [50, 0.0, 0.06, 0],
      [57, 0.25, 0.05, -0.25],
      [62, 0.5, 0.05, 0.25],
      [66, 0.8, 0.042, -0.4],
      [69, 1.1, 0.036, 0.4],
      [76, 1.45, 0.022, 0],
    ];
    for (const [m, d, peak, pan] of chord) {
      this.note({
        hz: midiToHz(m), at: t + d, peak, attack: 1.4, hold: 0.3, decay: 2.6,
        pan, send: 0.6, type: m <= 57 ? 'triangle' : 'sine', partials: m <= 57 ? undefined : SOFT,
      });
    }
    this.note({ hz: midiToHz(74), at: t + 1.9, peak: 0.085, attack: 0.01, decay: 3.4, send: 0.7, partials: BELL });
  }

  /**
   * Someone else appeared: one soft bell on their longitude's note, panned to them.
   * Fundamental peak .155 × eq, 3 s decay. Measured: peak -18 .. -14.5 dBFS (low notes are
   * the louder ones on purpose). A burst of joins is turned down by crowd(): 60 in 2 s stays
   * under the limiter.
   */
  lightJoined(lon: number): void {
    const t = this.now();
    if (t === null) return;
    const m = lonToNote(lon);
    this.note({ hz: midiToHz(m), at: t, peak: 0.155 * eq(m) * this.crowd('join', t), attack: 0.008, decay: 3, pan: lonPan(lon), send: 0.55, partials: BELL });
  }

  /**
   * You waved. Note 1 (your longitude's note folded into D4..C#5) sounds now; a very quiet
   * sine glides upward while the arc travels, panning from you to them; note 2 (their
   * longitude's pitch class, placed 2-12 semitones above note 1) lands as the arc arrives.
   *   note 1: peak .13, 1.6 s decay
   *   glide : peak .03, swells over the travel time, 0.5 s release
   *   note 2: peak .165, 2.8 s decay
   * Measured: peak ≈ -15 dBFS.
   */
  waveOut(fromLon: number, toLon: number, travelSeconds: number): void {
    const t = this.now();
    if (t === null) return;
    const travel = Number.isFinite(travelSeconds) ? clamp(travelSeconds, 0.15, 10) : 1.2;
    let n1 = lonToNote(fromLon);
    while (n1 < 62) n1 += 12;
    while (n1 > 73) n1 -= 12;
    let n2 = lonToNote(toLon);
    while (n2 <= n1) n2 += 12;
    while (n2 > n1 + 12) n2 -= 12;
    const p1 = lonPan(fromLon) * 0.6;
    const p2 = lonPan(toLon) * 0.6;
    const f1 = midiToHz(n1);
    const f2 = midiToHz(n2);
    this.note({ hz: f1, at: t, peak: 0.13, attack: 0.008, decay: 1.6, pan: p1, send: 0.5, partials: BELL });
    this.note({
      hz: f1, at: t + 0.02, peak: 0.03, attack: travel, decay: 0.5,
      glideTo: f2, glideTime: travel, pan: p1, panTo: p2, panTime: travel, send: 0.9,
    });
    this.note({ hz: f2, at: t + travel, peak: 0.165, attack: 0.008, decay: 2.8, pan: p2, send: 0.6, partials: BELL });
  }

  /**
   * Someone waved at you — the signature sound. Always the same rising fourth onto the
   * tonic, A4 (440 Hz) → D5 (587.33 Hz), 0.19 s apart, with a warm D4 underneath note 2.
   *   A4: peak .23, 2.2 s decay
   *   D5: peak .26, 3.4 s decay
   *   D4 underlay: peak .065, 2.4 s decay
   * Measured: peak ≈ -10 dBFS, 4-5 dB above every other event and just under the limiter's
   * threshold; 10 ms attack, largest sample-to-sample step 0.04 (no click).
   * Panned only slightly toward the sender so it stays centred and clear.
   */
  waveIn(fromLon: number): void {
    const t = this.now();
    if (t === null) return;
    const pan = lonPan(fromLon) * 0.35;
    this.note({ hz: midiToHz(69), at: t, peak: 0.23, attack: 0.01, decay: 2.2, pan, send: 0.45, partials: CHIME });
    this.note({ hz: midiToHz(74), at: t + 0.19, peak: 0.26, attack: 0.01, decay: 3.4, pan, send: 0.5, partials: CHIME });
    this.note({ hz: midiToHz(62), at: t + 0.19, peak: 0.065, attack: 0.03, decay: 2.4, pan, send: 0.4 });
  }

  /**
   * A mutual wave became a thread: a chord blooms from the bottom up.
   *   < 2 500 km : D4 F#4 A4 D5                (close)
   *   < 7 000 km : D3 A3 F#4 A4 D5
   *   < 13 000 km: D3 A3 E4 F#4 B4 E5          (add 9 / 6)
   *   farther    : D2 A2 D3 A3 F#4 B4 E5 A5    (widest, lowest)
   * Each note: 0.5 s attack, 0.4 s hold, 3.5-5.5 s decay; entries 70-120 ms apart.
   * Fundamental peak 0.145/sqrt(n) (.073 .. .051). Measured: peak -15 .. -12 dBFS at any size,
   * audible for 3-3.5 s.
   */
  thread(km: number): void {
    const t = this.now();
    if (t === null) return;
    const d = Number.isFinite(km) ? clamp(km / 20000, 0, 1) : 0.3;
    const notes =
      d < 0.125 ? [62, 66, 69, 74]
      : d < 0.35 ? [50, 57, 66, 69, 74]
      : d < 0.65 ? [50, 57, 64, 66, 71, 76]
      : [38, 45, 50, 57, 66, 71, 76, 81];
    const peak = 0.145 / Math.sqrt(notes.length);
    const gap = 0.07 + 0.05 * d;
    const width = 0.2 + 0.5 * d;
    notes.forEach((m, i) => {
      const low = m <= 57;
      this.note({
        hz: midiToHz(m), at: t + i * gap, peak: peak * (m >= 76 ? 0.7 : 1),
        attack: 0.5, hold: 0.4, decay: 3.5 + 2 * d,
        pan: i === 0 ? 0 : (i % 2 ? -1 : 1) * width, send: 0.65,
        type: low ? 'triangle' : 'sine', partials: low ? undefined : SOFT,
      });
    });
  }

  /**
   * You released a lantern: a breath of air sweeping upward plus six tiny rising bells
   * D5 F#5 A5 B5 D6 E6, 75 ms apart, drifting left → right.
   *   bells: peak .11 falling to .068, 1.5 s decay, mostly reverb
   *   air  : band-passed noise 1.2 → 4.5 kHz over 0.9 s, peak gain .075
   * Measured: peak ≈ -14.5 dBFS (the six bells pile up briefly), audible for ≈ 1.5 s.
   */
  lantern(): void {
    const t = this.now();
    if (t === null) return;
    this.noise({ at: t, peak: 0.075, attack: 0.35, decay: 1.1, filter: 'bandpass', freq: 1200, freqTo: 4500, sweep: 0.9, q: 1.2, send: 0.8 });
    const run = [74, 78, 81, 83, 86, 88];
    run.forEach((m, i) => {
      this.note({
        hz: midiToHz(m), at: t + 0.05 + i * 0.075, peak: 0.11 - i * 0.0085,
        attack: 0.012, decay: 1.5, pan: -0.35 + i * 0.14, send: 0.85,
      });
    });
  }

  /**
   * Opening someone's lantern: a paper/glass tick and one soft tone.
   *   tick: high-passed noise (3.5 kHz), 6 ms attack, 70 ms decay, peak gain .07
   *   tone: F#5 (739.99 Hz), peak .12, 1.6 s decay
   * Measured: peak ≈ -17 dBFS.
   */
  lanternOpen(): void {
    const t = this.now();
    if (t === null) return;
    this.noise({ at: t, peak: 0.07, attack: MIN_ATTACK, decay: 0.07, filter: 'highpass', freq: 3500, q: 0.7, send: 0.3 });
    this.note({ hz: midiToHz(78), at: t + 0.012, peak: 0.12, attack: 0.01, decay: 1.6, send: 0.6, partials: BELL });
  }

  /**
   * Warming a lantern: a small warm pluck. Successive warms step D4 → F#4 → A4 and wrap.
   *   triangle at the note, peak .125, 0.9 s decay + sine an octave below, peak .065, 1.2 s.
   * Measured: peak ≈ -15 dBFS.
   */
  warm(): void {
    const t = this.now();
    if (t === null) return;
    const m = [62, 66, 69][this.warmStep % 3]!;
    this.warmStep++;
    this.note({ hz: midiToHz(m), at: t, peak: 0.125, attack: 0.007, decay: 0.9, send: 0.35, type: 'triangle' });
    this.note({ hz: midiToHz(m - 12), at: t, peak: 0.065, attack: 0.012, decay: 1.2, send: 0.3 });
  }

  /**
   * A time zone lit. Index 0..23 walks a rising zig-zag over the whole scale:
   *   scale step = floor(i/2) + (i odd ? 2 : 0) → D3 F#3 E3 A3 F#3 B3 … B4 E5 D5 F#5 E5 A5
   * One bell, fundamental peak .165 × eq, 2.8 s decay, panned west → east with the index.
   * Measured: peak -17.5 .. -13.5 dBFS alone. When zones light in quick succession crowd()
   * turns each one down: all 24 fired 150 ms apart peak at ≈ -12 dBFS, not -5.
   */
  ringSegment(index: number): void {
    const t = this.now();
    if (t === null) return;
    const i = Number.isFinite(index) ? clamp(Math.round(index), 0, 23) : 0;
    const m = SCALE[Math.floor(i / 2) + (i % 2 ? 2 : 0)]!;
    this.note({ hz: midiToHz(m), at: t, peak: 0.165 * eq(m) * this.crowd('ring', t), attack: 0.008, decay: 2.8, pan: ((i - 11.5) / 11.5) * 0.6, send: 0.6, partials: BELL });
  }

  /**
   * All 24 lit: ~6 s, joyful but calm.
   *   0.0 s  pad D3 + A3 swells underneath (1.5 s attack, 2.6 s hold, 2.5 s decay; .055 / .043)
   *   0.0 s  rising run D4 E4 F#4 A4 B4 D5 E5 F#5 A5 B5 D6, 0.17 s apart (last at 1.70 s)
   *   1.95 s falling cascade D6 A5 B5 F#5 A5 E5 F#5 D5 E5 B4 D5 A4, 0.2 s apart (last at 4.15 s)
   *   4.45 s closing strum D3 · D4 A4 D5 F#5, 60 ms apart, 3.2 s decay
   * Run/cascade bells: fundamental .088 × min(1, eq(m)), 2.0-2.2 s decay.
   * Measured: peak ≈ -14.5 dBFS, audible for ≈ 6.5 s.
   */
  ringComplete(): void {
    const t = this.now();
    if (t === null) return;
    this.note({ hz: midiToHz(50), at: t, peak: 0.055, attack: 1.5, hold: 2.6, decay: 2.5, pan: -0.2, send: 0.5, type: 'triangle' });
    this.note({ hz: midiToHz(57), at: t, peak: 0.043, attack: 1.5, hold: 2.6, decay: 2.5, pan: 0.2, send: 0.5, type: 'triangle' });
    const bell = (m: number, at: number, pan: number, decay: number): void => {
      this.note({ hz: midiToHz(m), at, peak: 0.088 * Math.min(1, eq(m)), attack: 0.008, decay, pan, send: 0.65, partials: BELL });
    };
    const up = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86];
    up.forEach((m, i) => bell(m, t + i * 0.17, -0.6 + (i / (up.length - 1)) * 1.2, 2.2));
    const down = [86, 81, 83, 78, 81, 76, 78, 74, 76, 71, 74, 69];
    down.forEach((m, i) => bell(m, t + 1.95 + i * 0.2, (i % 2 ? -1 : 1) * (0.55 - i * 0.03), 2.0));
    this.note({ hz: midiToHz(50), at: t + 4.45, peak: 0.06, attack: 0.03, decay: 3.2, send: 0.5, type: 'triangle' });
    [62, 69, 74, 78].forEach((m, i) => {
      this.note({ hz: midiToHz(m), at: t + 4.45 + i * 0.06, peak: 0.08, attack: 0.008, decay: 3.2, pan: -0.3 + i * 0.2, send: 0.7, partials: BELL });
    });
  }

  /**
   * Hover/press tick: D6 (1174.66 Hz) sine, peak .03 (measured ≈ -31 dBFS), 50 ms decay.
   * Rate-limited to one per 40 ms.
   */
  uiTick(): void {
    const t = this.now();
    if (t === null) return;
    if (this.lastTick >= 0 && t - this.lastTick < 0.04 && t >= this.lastTick) return;
    this.lastTick = t;
    this.note({ hz: midiToHz(86), at: t, peak: 0.03, attack: MIN_ATTACK, decay: 0.05, send: 0.15 });
  }

  /* ---------------------------------------------------------------- internals */

  /** Scheduling time for an event, or null when nothing should sound. */
  private now(): number | null {
    const ctx = this.ctx;
    if (!ctx || !this._started || this.disposed || this._muted || this.hidden) return null;
    if (ctx.state === 'closed') return null;
    const t = ctx.currentTime;
    if (!Number.isFinite(t)) return null;
    // ctx.currentTime as seen from the main thread can be one audio callback behind the
    // render clock; on outputs with big buffers (Bluetooth, some Android) that is > 30 ms.
    const base = ctx.baseLatency;
    const lead = Number.isFinite(base) && base > 0 ? clamp(base + 0.015, LEAD, 0.12) : LEAD;
    return t + lead;
  }

  /**
   * Crowd control for bells that can arrive in bursts (many people joining at once, a run of
   * time zones lighting). Each call adds 1 to a "heat" that cools with a 0.5 s time constant;
   * the returned gain is 1/sqrt(1 + 2 × heat before this call). A lone bell gets 1.0, the
   * second of a pair 150 ms apart 0.64, a steady 150 ms run settles at 0.39, 30 per second
   * at 0.18. Measured: 24 ringSegments 150 ms apart peak ≈ 1 dB above a single one.
   */
  private crowd(key: string, t: number): number {
    const c = this.heat[key] ?? (this.heat[key] = { t, h: 0 });
    const dt = t - c.t;
    c.h = dt >= 0 ? c.h * Math.exp(-dt / 0.5) : 0;
    c.t = t;
    const gain = 1 / Math.sqrt(1 + 2 * c.h);
    c.h += 1;
    return gain;
  }

  private wake(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      // Not awaited: outside a user gesture this promise can stay pending indefinitely.
      void Promise.resolve(ctx.resume()).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  private fadeMaster(timeConstant: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const target = this._muted || this.hidden ? 0 : 1;
    try {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(target, t, timeConstant);
    } catch {
      /* ignore */
    }
  }

  private build(ctx: AudioContext): void {
    const t0 = ctx.currentTime;

    // master → limiter → trim → out
    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9;
    comp.knee.value = 5;
    comp.ratio.value = 16;
    comp.attack.value = 0.005;
    comp.release.value = 0.3;
    const trim = ctx.createGain();
    trim.gain.value = MASTER_TRIM;
    master.connect(comp);
    comp.connect(trim);
    trim.connect(ctx.destination);

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);

    // reverb send bus: HP (keeps the tail from getting muddy) → convolver → wet
    const send = ctx.createGain();
    send.gain.value = 1;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    hp.Q.value = 0.5;
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, 3.5);
    const wet = ctx.createGain();
    wet.gain.value = WET_LEVEL;
    send.connect(hp);
    hp.connect(conv);
    conv.connect(wet);
    wet.connect(master);

    this.master = master;
    this.dry = dry;
    this.send = send;
    this.noiseBuf = makeNoise(ctx, 4);
    this.bedNodes.push(master, comp, trim, dry, send, hp, conv, wet);

    this.buildBed(ctx, t0);
  }

  /**
   * Ambient bed. Seven drone voices on root / fifth / ninth (+ a faint third), each with its
   * own slow amplitude LFO; LFO periods are all different primes (23..61 s) so the texture
   * never repeats audibly. Summed through a low-pass whose cutoff drifts 380..860 Hz (47 s).
   * Plus band-passed noise "air" breathing on a 34 s cycle.
   *
   *   voice             amp   LFO period / depth   gain range
   *   D2  sine          .30   43 s / 25 %          .225 .. .375
   *   A2  sine          .30   31 s / 35 %          .195 .. .405
   *   D3  tri  -3.5 c   .30   23 s / 40 %          .180 .. .420   (panned L 0.7)
   *   D3  tri  +3.5 c   .30   29 s / 40 %          .180 .. .420   (panned R 0.7)
   *   A3  sine +3 c     .26   37 s / 45 %          .143 .. .377
   *   E4  sine          .14   53 s / 60 %          .056 .. .224
   *   F#4 sine -2 c     .09   61 s / 80 %          .018 .. .162
   *
   * Measured at the output (150 s): -32.5 dBFS RMS, per-second level drifting -30.5 .. -36
   * with the LFOs, no DC, the six strongest partials (D3 A3 D2 A2 E4 F#4) within 11 dB of
   * each other. 40 % of the energy is below 120 Hz, which small speakers do not reproduce;
   * what they do reproduce is ≈ -35 dBFS. (The first version put 70 % below 120 Hz — a bed
   * that was a 73 Hz hum on headphones and nearly absent on a laptop.) The two D3 voices
   * beat at 0.6 Hz; panned wide, that is mostly movement between the ears rather than a
   * change in level.
   */
  private buildBed(ctx: AudioContext, t0: number): void {
    const dry = this.dry!;
    const send = this.send!;

    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.gain.setValueAtTime(0, t0);
    bus.gain.linearRampToValueAtTime(BED_LEVEL, t0 + BED_FADE_IN);
    bus.connect(dry);
    const bedSend = ctx.createGain();
    bedSend.gain.value = 0.35;
    bus.connect(bedSend);
    bedSend.connect(send);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 620;
    lp.Q.value = 0.5;
    lp.connect(bus);
    this.lfo(ctx, t0, 47, 240, lp.frequency);
    this.bedNodes.push(bus, bedSend, lp);

    const voices: [number, OscillatorType, number, number, number, number, number][] = [
      // midi, type, detune cents, amp, LFO period s, LFO depth, pan
      [38, 'sine', 0, 0.3, 43, 0.25, 0],
      [45, 'sine', 0, 0.3, 31, 0.35, 0],
      [50, 'triangle', -3.5, 0.3, 23, 0.4, -0.7],
      [50, 'triangle', 3.5, 0.3, 29, 0.4, 0.7],
      [57, 'sine', 3, 0.26, 37, 0.45, 0.15],
      [64, 'sine', 0, 0.14, 53, 0.6, -0.2],
      [66, 'sine', -2, 0.09, 61, 0.8, 0.25],
    ];
    voices.forEach(([m, type, cents, amp, period, depth, pan], i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = midiToHz(m);
      osc.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = amp;
      // alternate LFO polarity so the voices do not all swell together at the start
      this.lfo(ctx, t0, period, amp * depth * (i % 2 ? -1 : 1), g.gain);
      osc.connect(g);
      const p = this.panner(ctx, pan);
      if (p) {
        g.connect(p);
        p.connect(lp);
        this.bedNodes.push(p);
      } else {
        g.connect(lp);
      }
      osc.start(t0);
      this.bedSources.push(osc);
      this.bedNodes.push(osc, g);
    });

    // air: white noise → band-pass 1.6 kHz, Q 0.5 → 0.22 ± 0.10 → bus (through BED_LEVEL)
    if (this.noiseBuf) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1600;
      bp.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.value = 0.22;
      this.lfo(ctx, t0, 34, 0.1, g.gain);
      src.connect(bp);
      bp.connect(g);
      g.connect(bus);
      src.start(t0);
      this.bedSources.push(src);
      this.bedNodes.push(src, bp, g);
    }
  }

  /** A slow sine LFO adding ±depth to an AudioParam. */
  private lfo(ctx: AudioContext, t0: number, periodSeconds: number, depth: number, target: AudioParam): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1 / periodSeconds;
    const g = ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(target);
    osc.start(t0);
    this.bedSources.push(osc);
    this.bedNodes.push(osc, g);
  }

  private panner(ctx: AudioContext, pan: number | undefined): StereoPannerNode | null {
    if (pan === undefined || typeof ctx.createStereoPanner !== 'function') return null;
    try {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      return p;
    } catch {
      return null;
    }
  }

  /* ---- twinkle layer ---- */

  private scheduleTwinkle(): void {
    if (this.twinkleTimer !== null || this.disposed || !this._started || this.hidden) return;
    const delay = 2500 + Math.random() * 4500; // 2.5 .. 7 s
    this.twinkleTimer = setTimeout(() => {
      this.twinkleTimer = null;
      try {
        this.twinkle();
      } catch {
        /* never let the ambient layer break the app */
      }
      this.scheduleTwinkle();
    }, delay);
  }

  private stopTwinkle(): void {
    if (this.twinkleTimer !== null) {
      clearTimeout(this.twinkleTimer);
      this.twinkleTimer = null;
    }
  }

  /**
   * One soft bell for a random light: fundamental peak .05 × eq (measured -28 .. -23 dBFS
   * peak, about the bed's own level), 2-4 s decay, panned by longitude. With 12+ lights there is a 35 %
   * chance of one extra, quieter grace note 0.25-0.7 s later. Never more than two per tick,
   * so density is capped at < 1 note/s however many people are online.
   */
  private twinkle(): void {
    const ctx = this.ctx;
    const n = this.lights.length;
    if (!ctx || n === 0 || ctx.state !== 'running') return;
    const t = this.now();
    if (t === null) return;
    const play = (at: number, level: number): void => {
      const light = this.lights[Math.floor(Math.random() * n)];
      if (!light) return;
      const m = lonToNote(light.lon);
      this.note({
        hz: midiToHz(m), at, peak: level * eq(m), attack: 0.008, decay: 2 + Math.random() * 2,
        pan: lonPan(light.lon), send: 0.6, partials: BELL,
      });
    };
    play(t, 0.05);
    if (n >= 12 && Math.random() < 0.35) play(t + 0.25 + Math.random() * 0.45, 0.034);
  }

  /* ---- voices ---- */

  private static levelAt(v: Voice, t: number): number {
    return t <= v.sustainEnd ? v.peak : v.peak * Math.exp(-(t - v.sustainEnd) / v.tau);
  }

  /**
   * Polyphony guard. Counts voices sounding at `at`; when the cap is reached, the quietest
   * one at that moment (oldest on ties) is faded out in ~50 ms to make room — unless the new
   * request is quieter still, in which case the new request is dropped.
   */
  private admit(at: number, peak: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const nowT = ctx.currentTime;
    let count = 0;
    let victim: Voice | null = null;
    let victimLevel = Infinity;
    for (const v of this.voices) {
      if (v.end <= nowT) {
        this.cleanup(v); // onended missed (e.g. context was suspended): reclaim now
        continue;
      }
      if (v.killed || v.at > at || v.end <= at) continue;
      count++;
      const level = AudioEngine.levelAt(v, at);
      if (level < victimLevel || (level === victimLevel && victim !== null && v.at < victim.at)) {
        victim = v;
        victimLevel = level;
      }
    }
    if (count < MAX_VOICES) return true;
    if (!victim || victimLevel > peak) return false;
    this.kill(victim, Math.max(at, nowT));
    return true;
  }

  private kill(v: Voice, at: number): void {
    v.killed = true;
    v.end = at + 0.12;
    for (const p of v.envs) {
      try {
        // cancelAndHold keeps the value where it is even in the middle of a linear attack
        // ramp; plain cancel (Firefox) is only exact outside one, i.e. after the first few ms.
        if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(at);
        else p.cancelScheduledValues(at);
        p.setTargetAtTime(0, at, 0.015); // -60 dB after ~0.1 s
      } catch {
        /* ignore */
      }
    }
    for (const s of v.sources) {
      try {
        s.stop(at + 0.12);
      } catch {
        /* ignore */
      }
    }
  }

  private cleanup(v: Voice): void {
    if (!this.voices.delete(v)) return;
    for (const s of v.sources) s.onended = null;
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 0 → peak → hold → exponential fall. Returns the decay time constant.
   *
   * Short attacks (< 0.1 s: every bell, pluck and tick) are a linear ramp followed by an
   * explicit setValueAtTime(peak) at the ramp's end. That anchor matters. Chromium clamps
   * automation events that are already in the past to "now"; measured there, when a whole
   * attack is in the past (main thread tens of ms behind the render clock: a big output
   * buffer, or a stall under load) an exponential-approach attack always, and a bare linear
   * ramp about one time in ten, collapses to gain 0 and the note is silently lost. With the
   * anchor no note was lost in 900 late starts on a bare graph and 250 through this engine
   * (scripts/audio-qa.mjs, scenario "late").
   * A late note then simply starts late, at its peak.
   *
   * Slow swells (>= 0.1 s) keep the exponential approach (95 % after `attack`): they are
   * never wholly in the past, and voice stealing can interrupt them smoothly at any point.
   */
  private envelope(g: AudioParam, at: number, peak: number, attack: number, hold: number, decay: number): number {
    const tau = Math.max(0.005, decay / T60);
    g.setValueAtTime(0, at);
    if (attack < 0.1) {
      g.linearRampToValueAtTime(peak, at + attack);
      g.setValueAtTime(peak, at + attack);
    } else {
      g.setTargetAtTime(peak, at, attack / 3);
    }
    g.setTargetAtTime(0, at + attack + hold, tau);
    return tau;
  }

  /** Route a finished voice subgraph to dry + reverb, with optional (moving) pan. */
  private route(ctx: AudioContext, out: AudioNode, nodes: AudioNode[], at: number, pan?: number, panTo?: number, panTime?: number, sendLevel = 0.5): void {
    let tail = out;
    const p = this.panner(ctx, pan);
    if (p) {
      if (panTo !== undefined && panTime !== undefined && panTime > 0) {
        p.pan.setValueAtTime(clamp(pan ?? 0, -1, 1), at);
        p.pan.linearRampToValueAtTime(clamp(panTo, -1, 1), at + panTime);
      }
      out.connect(p);
      nodes.push(p);
      tail = p;
    }
    tail.connect(this.dry!);
    const s = clamp(sendLevel, 0, 1);
    if (s > 0) {
      const sg = ctx.createGain();
      sg.gain.value = s;
      tail.connect(sg);
      sg.connect(this.send!);
      nodes.push(sg);
    }
  }

  private register(v: Voice): void {
    this.voices.add(v);
    const first = v.sources[0];
    if (first) first.onended = () => this.cleanup(v);
  }

  private note(s: NoteSpec): void {
    const ctx = this.ctx;
    if (!ctx || !this.dry || !this.send) return;
    if (!Number.isFinite(s.hz) || s.hz <= 0 || !Number.isFinite(s.at) || !Number.isFinite(s.peak) || s.peak <= 0) return;
    const peak = Math.min(0.5, s.peak);
    const attack = Math.max(MIN_ATTACK, s.attack ?? 0.008);
    const hold = Math.max(0, s.hold ?? 0);
    const decay = Math.max(0.03, s.decay);
    const end = s.at + attack + hold + decay + 0.05;
    try {
      if (!this.admit(s.at, peak)) return;
      const maxHz = Math.min(9000, ctx.sampleRate * 0.45);
      const out = ctx.createGain();
      out.gain.value = 1;
      const voice: Voice = {
        at: s.at, sustainEnd: s.at + attack + hold, tau: decay / T60, peak, end,
        killed: false, envs: [], sources: [], nodes: [out],
      };
      const partials: Partial[] = [{ ratio: 1, level: 1 }, ...(s.partials ?? [])];
      for (const p of partials) {
        const f = s.hz * p.ratio;
        const fTo = s.glideTo !== undefined ? s.glideTo * p.ratio : f;
        if (f > maxHz || fTo > maxHz) continue;
        const osc = ctx.createOscillator();
        osc.type = s.type ?? 'sine';
        osc.frequency.value = f;
        if (s.glideTo !== undefined && s.glideTime !== undefined && s.glideTime > 0 && fTo > 0) {
          osc.frequency.setValueAtTime(f, s.at);
          osc.frequency.exponentialRampToValueAtTime(fTo, s.at + s.glideTime);
        }
        const g = ctx.createGain();
        g.gain.value = 0;
        this.envelope(g.gain, s.at, peak * p.level, attack, hold, decay * (p.decay ?? 1));
        osc.connect(g);
        g.connect(out);
        osc.start(s.at);
        osc.stop(end);
        voice.envs.push(g.gain);
        voice.sources.push(osc);
        voice.nodes.push(osc, g);
      }
      if (voice.sources.length === 0) return;
      this.route(ctx, out, voice.nodes, s.at, s.pan, s.panTo, s.panTime, s.send);
      this.register(voice);
    } catch {
      /* a failed voice must never surface to the app */
    }
  }

  private noise(s: NoiseSpec): void {
    const ctx = this.ctx;
    const buf = this.noiseBuf;
    if (!ctx || !buf || !this.dry || !this.send) return;
    if (!Number.isFinite(s.at) || !(s.peak > 0)) return;
    const peak = Math.min(0.5, s.peak);
    const attack = Math.max(MIN_ATTACK, s.attack ?? MIN_ATTACK);
    const hold = Math.max(0, s.hold ?? 0);
    const decay = Math.max(0.03, s.decay);
    const end = s.at + attack + hold + decay + 0.05;
    try {
      if (!this.admit(s.at, peak)) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = s.filter;
      f.frequency.value = s.freq;
      f.Q.value = s.q ?? 0.7;
      if (s.freqTo !== undefined && s.sweep !== undefined && s.sweep > 0) {
        f.frequency.setValueAtTime(s.freq, s.at);
        f.frequency.exponentialRampToValueAtTime(s.freqTo, s.at + s.sweep);
      }
      const g = ctx.createGain();
      g.gain.value = 0;
      this.envelope(g.gain, s.at, peak, attack, hold, decay);
      src.connect(f);
      f.connect(g);
      // random offset so repeated ticks are not the identical grain of noise
      src.start(s.at, Math.random() * Math.max(0, buf.duration - 0.5));
      src.stop(end);
      const voice: Voice = {
        at: s.at, sustainEnd: s.at + attack + hold, tau: decay / T60, peak, end,
        killed: false, envs: [g.gain], sources: [src], nodes: [src, f, g],
      };
      this.route(ctx, g, voice.nodes, s.at, s.pan, undefined, undefined, s.send);
      this.register(voice);
    } catch {
      /* ignore */
    }
  }

  private teardown(): void {
    this.stopTwinkle();
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    for (const v of Array.from(this.voices)) {
      for (const s of v.sources) {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
      }
      this.cleanup(v);
    }
    this.voices.clear();
    for (const s of this.bedSources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.bedNodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.bedSources = [];
    this.bedNodes = [];
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.dry = null;
    this.send = null;
    this.noiseBuf = null;
    this._started = false;
    if (ctx && ctx.state !== 'closed') {
      try {
        void Promise.resolve(ctx.close()).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }
}

/* --------------------------------------------------------------- buffer makers */

/**
 * Procedural hall impulse: stereo decorrelated noise, 60 dB decay over `seconds`, getting
 * darker as it decays (one-pole low-pass sliding 6 kHz → 900 Hz), 8 ms fade-in so there is
 * no hard onset. ConvolverNode.normalize (default true) scales it to a sane loudness.
 */
function makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const tau = seconds / T60;
  const fadeIn = Math.max(1, Math.floor(sr * 0.008));
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const cutoff = 900 + 5100 * Math.exp(-t / 0.9);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
      y += a * (Math.random() * 2 - 1 - y);
      data[i] = y * Math.exp(-t / tau) * Math.min(1, i / fadeIn);
    }
  }
  return buf;
}

/** Mono white noise in [-1, 1]. */
function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

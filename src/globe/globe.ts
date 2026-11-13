import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { latLonToVec3, vec3ToLatLon, arcPoints } from '../lib/geo';
import { sunDirection } from '../lib/sun';
import {
  earthVert, earthFrag, atmoVert, atmoFrag, starVert, starFrag,
  dotVert, dotFrag, arcVert, arcFrag, ringFrag,
} from './shaders';

export type DotKind = 'live' | 'self' | 'echo';
export interface LightDot { id: string; lat: number; lon: number; kind: DotKind; age?: number }
export interface LanternDot { id: string; lat: number; lon: number; warmth: number; mine: boolean }
export interface GazeDot { id: string; lat: number; lon: number }
export interface Pick { type: 'light' | 'lantern'; id: string }
export interface LatLon { lat: number; lon: number }

const MAX_POINTS = 4096;
const R_LIGHT = 1.008;
const R_RING = 1.36;
const KIND = { live: 0, self: 1, echo: 2, gaze: 3, lantern: 4, lanternMine: 5, comet: 6 } as const;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const hash01 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
};
const shortestLon = (from: number, to: number) => {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

interface Arc {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  kind: 'wave' | 'thread';
  id?: string;
  born: number;
  travel: number;       // seconds for the head to cross
  phase: number;
  curve: THREE.CatmullRomCurve3;
  done?: () => void;
  dying?: number;
}

export interface GlobeOptions { lowPower?: boolean; reducedMotion?: boolean; fixedQuality?: boolean }

export class Globe {
  readonly canvas: HTMLCanvasElement;
  readonly ready: Promise<void>;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private earthMat!: THREE.ShaderMaterial;
  private atmoMat!: THREE.ShaderMaterial;
  private starMat!: THREE.ShaderMaterial;
  private dotMat!: THREE.ShaderMaterial;
  private dotGeo!: THREE.BufferGeometry;
  private sunSprite!: THREE.Sprite;
  private tetherGeo!: THREE.BufferGeometry;
  private ringMats: THREE.ShaderMaterial[] = [];
  private ringLit: boolean[] = new Array(24).fill(false);
  private arcs: Arc[] = [];
  private lights: LightDot[] = [];
  private lanterns: LanternDot[] = [];
  private gazes = new Map<string, { lat: number; lon: number; v: THREE.Vector3; t: THREE.Vector3; seen: number }>();
  private comets: { v: THREE.Vector3; size: number }[] = [];
  private pings: { v: THREE.Vector3; born: number }[] = [];
  private frameCbs: ((dt: number, t: number) => void)[] = [];
  private opts: GlobeOptions;

  // camera state
  camLat = 18;
  camLon = 0;
  dist = 3.3;
  private vLat = 0;
  private vLon = 0;
  private targetDist = 3.3;
  private fly: { fromLat: number; fromLon: number; dLat: number; dLon: number; fromDist: number; toDist: number; t0: number; ms: number; resolve: () => void } | null = null;
  private dragging = false;
  private lastInput = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private pinchDist = 0;
  private moved = 0;
  private downAt = { x: 0, y: 0, t: 0 };
  autoRotate = true;
  private reveal = 0;
  private revealTarget = 0;
  private time = 0;
  private last = 0;
  private running = true;
  private pxScale = 1;
  private sunDir = new THREE.Vector3(1, 0, 0);
  private sunClock = 0;
  private pointerNdc: { x: number; y: number } | null = null;
  private ripO = Array.from({ length: 6 }, () => new THREE.Vector3(0, 1, 0));
  private ripT = [-1, -1, -1, -1, -1, -1];
  /** milliseconds added to the real time when placing the sun (0 = now) */
  sunOffset = 0;
  private yShift = 0;
  private perfN = 0;
  private perfT = 0;
  private stage = 0; // 0 full, 1 lower resolution, 2 no bloom
  private maxDpr = 2; // view offset in px (shifts globe up on small screens)

  onTap: (pick: Pick | null, ev: { x: number; y: number }) => void = () => {};
  onHover: (pick: Pick | null, ev: { x: number; y: number }) => void = () => {};
  onUserMove: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, opts: GlobeOptions = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !opts.lowPower, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);

    this.buildStars();
    this.buildSun();
    this.buildAtmosphere();
    this.buildDots();
    this.buildRing();
    this.ready = this.buildEarth().catch(async () => {
      try { await this.buildEarth(); } catch {
        const dark = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshBasicMaterial({ color: 0x05070d }));
        dark.renderOrder = 1;
        this.scene.add(dark);
      }
    });

    if (!opts.lowPower) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.72, 0.82);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    this.setSun(new Date());
    this.resize();
    this.bind();
    this.last = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ───────────────────────── build ─────────────────────────

  private async buildEarth(): Promise<void> {
    const loader = new THREE.TextureLoader();
    const base = import.meta.env.BASE_URL;
    const load = (name: string, srgb: boolean) =>
      new Promise<THREE.Texture>((resolve, reject) => {
        loader.load(`${base}tex/${name}`, (t) => {
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
          t.wrapS = THREE.RepeatWrapping;
          resolve(t);
        }, undefined, reject);
      });
    const [day, night, water, clouds] = await Promise.all([
      load('day.jpg', true), load('night.jpg', true), load('water.png', false), load('clouds.png', false),
    ]);
    this.earthMat = new THREE.ShaderMaterial({
      vertexShader: earthVert,
      fragmentShader: earthFrag,
      uniforms: {
        uDay: { value: day }, uNight: { value: night }, uWater: { value: water }, uClouds: { value: clouds },
        uSun: { value: this.sunDir }, uTime: { value: 0 }, uReveal: { value: 0 },
        uRipO: { value: this.ripO }, uRipT: { value: this.ripT },
      },
    });
    const seg = this.opts.lowPower ? 64 : 128;
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, seg, seg * 0.75), this.earthMat);
    earth.renderOrder = 1;
    this.scene.add(earth);
  }

  private buildAtmosphere() {
    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: atmoVert,
      fragmentShader: atmoFrag,
      uniforms: { uSun: { value: this.sunDir }, uReveal: { value: 0 } },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.32, 96, 64), this.atmoMat);
    m.renderOrder = 2;
    this.scene.add(m);
  }

  private buildStars() {
    const n = this.opts.lowPower ? 2500 : 7000;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const color = new Float32Array(n * 3);
    let seed = 1337;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      // a soft band of extra density, like a far galaxy plane
      let y = u;
      if (rnd() < 0.35) y = u * 0.22 + (rnd() - 0.5) * 0.08;
      const v = new THREE.Vector3(s * Math.cos(th), y, s * Math.sin(th)).normalize().applyAxisAngle(new THREE.Vector3(1, 0, 0.4).normalize(), 1.05).multiplyScalar(180);
      pos.set([v.x, v.y, v.z], i * 3);
      const m = Math.pow(rnd(), 5.5);
      size[i] = 1.1 + m * 4.2;
      phase[i] = rnd();
      const b = 0.18 + Math.pow(rnd(), 2.2) * 0.75;
      const tint = rnd();
      const c = tint < 0.14 ? [1.0, 0.82, 0.66] : tint < 0.30 ? [0.72, 0.82, 1.0] : [0.95, 0.96, 1.0];
      color.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: starVert, fragmentShader: starFrag,
      uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uReveal: { value: 1 } },
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const pts = new THREE.Points(geo, this.starMat);
    pts.frustumCulled = false;
    pts.renderOrder = 0;
    this.scene.add(pts);
  }

  private buildSun() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,250,235,1)');
    grad.addColorStop(0.06, 'rgba(255,240,205,0.95)');
    grad.addColorStop(0.14, 'rgba(255,215,160,0.22)');
    grad.addColorStop(0.40, 'rgba(255,180,110,0.035)');
    grad.addColorStop(1, 'rgba(255,150,60,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(1.6, 1.5, 1.35) });
    this.sunSprite = new THREE.Sprite(mat);
    this.sunSprite.scale.setScalar(20);
    this.sunSprite.renderOrder = 0;
    this.scene.add(this.sunSprite);
  }

  private buildDots() {
    this.dotGeo = new THREE.BufferGeometry();
    const mk = (n: number) => new THREE.BufferAttribute(new Float32Array(MAX_POINTS * n), n).setUsage(THREE.DynamicDrawUsage);
    this.dotGeo.setAttribute('position', mk(3));
    this.dotGeo.setAttribute('aSize', mk(1));
    this.dotGeo.setAttribute('aPhase', mk(1));
    this.dotGeo.setAttribute('aKind', mk(1));
    this.dotGeo.setAttribute('aGlow', mk(1));
    this.dotGeo.setDrawRange(0, 0);
    this.dotMat = new THREE.ShaderMaterial({
      vertexShader: dotVert, fragmentShader: dotFrag,
      uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uDist: { value: 3.3 }, uReveal: { value: 0 } },
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: true,
    });
    const pts = new THREE.Points(this.dotGeo, this.dotMat);
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    this.scene.add(pts);

    // faint tethers from the ground up to each lantern
    this.tetherGeo = new THREE.BufferGeometry();
    this.tetherGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2048 * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.tetherGeo.setDrawRange(0, 0);
    const lines = new THREE.LineSegments(this.tetherGeo, new THREE.LineBasicMaterial({ color: new THREE.Color(1.0, 0.55, 0.22), transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    lines.frustumCulled = false;
    lines.renderOrder = 4;
    this.scene.add(lines);
  }

  private buildRing() {
    for (let i = 0; i < 24; i++) {
      const centre = (i <= 12 ? i : i - 24) * 15;
      const pts: THREE.Vector3[] = [];
      const half = 7.5 - 0.9;
      for (let k = 0; k <= 12; k++) {
        const lon = centre - half + (2 * half * k) / 12;
        const v = latLonToVec3(0, lon, R_RING);
        pts.push(new THREE.Vector3(v[0], v[1], v[2]));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const geo = new THREE.TubeGeometry(curve, 24, 0.0042, 6, false);
      const mat = new THREE.ShaderMaterial({
        vertexShader: arcVert, fragmentShader: ringFrag,
        uniforms: { uLit: { value: 0 }, uFlash: { value: 0 }, uReveal: { value: 0 } },
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 3;
      this.ringMats.push(mat);
      this.scene.add(mesh);
    }
  }

  // ───────────────────────── public API ─────────────────────────

  setSun(date: Date) {
    const d = sunDirection(date);
    this.sunDir.set(d[0], d[1], d[2]).normalize();
    this.sunSprite.position.copy(this.sunDir).multiplyScalar(150);
  }

  setLights(list: LightDot[]) { this.lights = list; }
  setLanterns(list: LanternDot[]) { this.lanterns = list; }

  setGazes(list: GazeDot[]) {
    const now = this.time;
    for (const g of list) {
      const p = latLonToVec3(g.lat, g.lon, 1.004);
      const t = new THREE.Vector3(p[0], p[1], p[2]);
      const cur = this.gazes.get(g.id);
      if (cur) { cur.t.copy(t); cur.seen = now; cur.lat = g.lat; cur.lon = g.lon; }
      else this.gazes.set(g.id, { lat: g.lat, lon: g.lon, v: t.clone(), t, seen: now });
    }
  }
  dropGaze(id: string) { this.gazes.delete(id); }

  setRing(lit: boolean[], flash = true) {
    for (let i = 0; i < 24; i++) {
      if (lit[i] && !this.ringLit[i] && flash) this.ringMats[i].uniforms.uFlash.value = 1;
    }
    this.ringLit = lit.slice();
  }

  /** A travelling arc of light from a to b. Resolves when it lands. */
  wave(a: LatLon, b: LatLon): { seconds: number; landed: Promise<void> } {
    const { curve, ang } = this.makeCurve(a, b, 0.22);
    const seconds = this.opts.reducedMotion ? 0.6 : 1.5 + ang * 0.75;
    // never let a flood of waves build unbounded geometry
    if (this.arcs.filter((x) => x.kind === 'wave').length >= 24) return { seconds: 0, landed: Promise.resolve() };
    let done!: () => void;
    const landed = new Promise<void>((r) => (done = r));
    this.addArc(curve, 'wave', seconds, new THREE.Color(1.0, 0.86, 0.62), done);
    return { seconds, landed };
  }

  addThread(id: string, a: LatLon, b: LatLon, animate: boolean) {
    if (this.arcs.some((x) => x.kind === 'thread' && x.id === id)) return;
    const { curve, ang } = this.makeCurve(a, b, 0.16);
    const arc = this.addArc(curve, 'thread', animate ? 1.4 + ang * 0.6 : 0, new THREE.Color(1.0, 0.62, 0.36));
    arc.id = id;
    if (!animate) arc.born = -100;
    const threads = this.arcs.filter((x) => x.kind === 'thread' && x.dying === undefined);
    if (threads.length > 160) threads[0].dying = this.time;
  }

  private makeCurve(a: LatLon, b: LatLon, lift: number) {
    const pts = arcPoints(a.lat, a.lon, b.lat, b.lon, 48, lift).map((p) => new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(R_LIGHT));
    const va = latLonToVec3(a.lat, a.lon), vb = latLonToVec3(b.lat, b.lon);
    const ang = Math.acos(clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1));
    return { curve: new THREE.CatmullRomCurve3(pts), ang };
  }

  private addArc(curve: THREE.CatmullRomCurve3, kind: 'wave' | 'thread', travel: number, color: THREE.Color, done?: () => void): Arc {
    const geo = new THREE.TubeGeometry(curve, 72, kind === 'wave' ? 0.0034 : 0.0022, 5, false);
    const mat = new THREE.ShaderMaterial({
      vertexShader: arcVert, fragmentShader: arcFrag,
      uniforms: {
        uColor: { value: color }, uHead: { value: 0 }, uTail: { value: 0.32 }, uBase: { value: kind === 'thread' ? 0.34 : 0.0 },
        uDrawn: { value: 0 }, uFade: { value: 1 }, uShimmer: { value: -1 },
      },
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const arc: Arc = { mesh, mat, kind, born: this.time, travel, phase: Math.random(), curve, done };
    this.arcs.push(arc);
    return arc;
  }

  /** A short bloom of light where something just arrived. */
  ping(lat: number, lon: number) {
    const p = latLonToVec3(lat, lon, R_LIGHT);
    this.pings.push({ v: new THREE.Vector3(p[0], p[1], p[2]), born: this.time });
    if (this.pings.length > 24) this.pings.shift();
  }

  /** A ring of light that spreads over the whole Earth from one point. */
  ripple(lat: number, lon: number) {
    let slot = this.ripT.findIndex((t) => t < 0);
    if (slot < 0) slot = this.ripT.indexOf(Math.max(...this.ripT));
    const p = latLonToVec3(lat, lon, 1);
    this.ripO[slot].set(p[0], p[1], p[2]);
    this.ripT[slot] = 0;
  }

  flyTo(lat: number, lon: number, dist = this.targetDist, ms = 1800): Promise<void> {
    if (this.opts.reducedMotion) ms = Math.min(ms, 300);
    if (this.fly) this.fly.resolve();
    return new Promise((resolve) => {
      this.vLat = this.vLon = 0;
      this.fly = {
        fromLat: this.camLat, fromLon: this.camLon,
        dLat: clamp(lat, -80, 80) - this.camLat, dLon: shortestLon(this.camLon, lon),
        fromDist: this.dist, toDist: dist, t0: performance.now(), ms, resolve,
      };
      this.targetDist = dist;
    });
  }

  /** Start far away and dark; used before the arrival flight. */
  prepareIntro(lat: number, lon: number) {
    this.camLat = clamp(lat * 0.4 + 10, -50, 50);
    this.camLon = lon - 110;
    this.dist = this.targetDist = 5.0;
    this.reveal = 0;
    this.revealTarget = 0.62;
  }
  revealAll() { this.revealTarget = 1; }

  homeDist() { const a = this.aspect(); return a < 0.62 ? 5.3 : a < 0.85 ? 4.3 : 3.3; }
  private aspect() { return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight); }

  setYShift(px: number) { this.yShift = px; this.applyViewOffset(); }

  onFrame(cb: (dt: number, t: number) => void) { this.frameCbs.push(cb); }

  /** Screen position (CSS px) of a point on the globe, and whether it faces the camera. */
  project(lat: number, lon: number, r = R_LIGHT): { x: number; y: number; visible: boolean } {
    const p = latLonToVec3(lat, lon, r);
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    const visible = v.dot(this.camera.position) / (r * this.dist) > 1 / this.dist + 0.10;
    v.project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * this.canvas.clientHeight, visible };
  }

  lanternRadius(id: string) { return 1.05 + hash01(id) * 0.05; }

  pick(x: number, y: number, radius = 22): Pick | null {
    let best: Pick | null = null;
    let bd = radius * radius;
    const test = (type: Pick['type'], id: string, lat: number, lon: number, r: number, bias: number) => {
      const s = this.project(lat, lon, r);
      if (!s.visible) return;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2 - bias;
      if (d < bd) { bd = d; best = { type, id }; }
    };
    for (const l of this.lanterns) test('lantern', l.id, l.lat, l.lon, this.lanternRadius(l.id), 0);
    for (const l of this.lights) if (l.kind !== 'self') test('light', l.id, l.lat, l.lon, R_LIGHT, l.kind === 'live' ? 60 : -40);
    return best;
  }

  /** Lat/lon under a screen point, or null if it misses the Earth. */
  hit(x: number, y: number): LatLon | null {
    const ndc = new THREE.Vector2((x / this.canvas.clientWidth) * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const b = o.dot(d), c = o.dot(o) - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const p = o.clone().addScaledVector(d, t);
    return vec3ToLatLon([p.x, p.y, p.z]);
  }

  /** What this visitor is looking at: the pointer if it is on the globe, else the centre of view. */
  gaze(): LatLon {
    if (this.pointerNdc) {
      const h = this.hit(this.pointerNdc.x, this.pointerNdc.y);
      if (h) return h;
    }
    return { lat: this.camLat, lon: ((this.camLon + 540) % 360) - 180 };
  }

  capture(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }

  pause() { this.running = false; }
  resumeLoop() { this.running = true; this.last = performance.now(); }

  // ───────────────────────── input ─────────────────────────

  private bind() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.dragging = true; this.moved = 0;
        this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
        this.vLat = this.vLon = 0;
        if (this.fly) { this.fly.resolve(); this.fly = null; }
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
        this.pinchDist = this.targetDist;
        this.moved = 999;
      }
      this.lastInput = performance.now();
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointerNdc = e.pointerType === 'mouse' ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
      const prev = this.pointers.get(e.pointerId);
      // a mouse whose button-up we never saw (context menu, lost capture) is no longer dragging
      if (prev && e.pointerType === 'mouse' && e.buttons === 0) { this.release(e.pointerId); return; }
      if (!prev) {
        if (e.pointerType === 'mouse') this.onHover(this.pick(e.clientX - r.left, e.clientY - r.top), { x: e.clientX, y: e.clientY });
        return;
      }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.lastInput = performance.now();
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchStart > 0) this.targetDist = clamp(this.pinchDist * (this.pinchStart / d), 1.85, 6.5);
        return;
      }
      this.moved += Math.abs(dx) + Math.abs(dy);
      const k = (0.22 * (this.dist - 0.9)) / 2.4 * (900 / Math.max(500, el.clientHeight));
      this.vLon = -dx * k; this.vLat = dy * k;
      this.camLon += this.vLon; this.camLat = clamp(this.camLat + this.vLat, -84, 84);
      if (this.moved > 6) this.onUserMove();
    });
    const up = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      if (!had) return;
      if (this.pointers.size === 0) {
        this.dragging = false;
        const quick = performance.now() - this.downAt.t < 600;
        if (this.moved < 7 && quick) {
          const r = el.getBoundingClientRect();
          const x = e.clientX - r.left, y = e.clientY - r.top;
          this.vLat = this.vLon = 0;
          this.onTap(this.pick(x, y, e.pointerType === 'mouse' ? 22 : 34), { x: e.clientX, y: e.clientY });
        }
      }
      this.pinchStart = 0;
      this.lastInput = performance.now();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', (e) => this.release(e.pointerId));
    el.addEventListener('pointerleave', () => { this.pointerNdc = null; this.onHover(null, { x: 0, y: 0 }); });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.targetDist = clamp(this.targetDist * Math.exp(e.deltaY * 0.0011), 1.85, 6.5);
      this.lastInput = performance.now();
      this.onUserMove();
    }, { passive: false });
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); else this.resumeLoop(); });
  }

  private release(id: number) {
    if (!this.pointers.delete(id)) return;
    if (this.pointers.size === 0) this.dragging = false;
    this.pinchStart = 0;
  }

  nudge(dLon: number, dLat: number) {
    this.camLon += dLon; this.camLat = clamp(this.camLat + dLat, -84, 84); this.lastInput = performance.now();
  }
  zoom(f: number) { this.targetDist = clamp(this.targetDist * f, 1.85, 6.5); this.lastInput = performance.now(); }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.lowPower ? 1.25 : this.maxDpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the whole globe comfortably in view on tall screens
    this.camera.fov = w / h < 0.8 ? 46 : 38;
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
    this.pxScale = (h / 900) * dpr;
    if (this.composer) { this.composer.setPixelRatio(dpr); this.composer.setSize(w, h); }
    if (this.bloom) this.bloom.resolution.set(w * dpr, h * dpr);
  }

  private applyViewOffset() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (this.yShift) this.camera.setViewOffset(w, h, 0, this.yShift, w, h);
    else this.camera.clearViewOffset();
  }

  // ───────────────────────── frame ─────────────────────────

  private frame() {
    if (!this.running) return;
    const now = performance.now();
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.05, raw);
    this.last = now;
    this.watchPerformance(raw);
    this.time += dt;
    const t = this.time;

    // real sun, refreshed every 20 s
    this.sunClock += dt;
    if (this.sunOffset !== 0) this.setSun(new Date(Date.now() + this.sunOffset));
    else if (this.sunClock > 20) { this.sunClock = 0; this.setSun(new Date()); }

    // camera
    if (this.fly) {
      const f = this.fly;
      const k = clamp((now - f.t0) / f.ms, 0, 1);
      const e = ease(k);
      this.camLat = f.fromLat + f.dLat * e;
      this.camLon = f.fromLon + f.dLon * e;
      this.dist = f.fromDist + (f.toDist - f.fromDist) * e;
      if (k >= 1) { this.fly = null; f.resolve(); }
    } else {
      if (!this.dragging) {
        this.camLon += this.vLon; this.camLat = clamp(this.camLat + this.vLat, -84, 84);
        const damp = Math.pow(0.0025, dt);
        this.vLon *= damp; this.vLat *= damp;
        if (this.autoRotate && !this.opts.reducedMotion && now - this.lastInput > 9000) this.camLon += dt * 1.1;
      }
      this.dist += (this.targetDist - this.dist) * (1 - Math.pow(0.002, dt));
    }
    const cp = latLonToVec3(this.camLat, this.camLon, this.dist);
    this.camera.position.set(cp[0], cp[1], cp[2]);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld(); // so labels projected this frame match what is drawn

    // reveal
    this.reveal += (this.revealTarget - this.reveal) * (1 - Math.pow(0.12, dt));
    if (this.earthMat) { this.earthMat.uniforms.uTime.value = t; this.earthMat.uniforms.uReveal.value = this.reveal; }
    this.atmoMat.uniforms.uReveal.value = this.reveal;
    this.starMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uPx.value = this.pxScale;
    const dotReveal = clamp((this.reveal - 0.45) / 0.5, 0, 1);
    this.dotMat.uniforms.uTime.value = t;
    this.dotMat.uniforms.uPx.value = this.pxScale;
    this.dotMat.uniforms.uDist.value = 3.3 * (0.55 + 0.45 * (this.dist / 3.3));
    this.dotMat.uniforms.uReveal.value = dotReveal;
    (this.sunSprite.material as THREE.SpriteMaterial).opacity = this.reveal;

    // ring
    for (let i = 0; i < 24; i++) {
      const u = this.ringMats[i].uniforms;
      u.uLit.value += ((this.ringLit[i] ? 1 : 0) - u.uLit.value) * (1 - Math.pow(0.02, dt));
      u.uFlash.value *= Math.pow(0.18, dt);
      u.uReveal.value = dotReveal * clamp((Math.abs(this.camLat) - 2.5) / 14, 0, 1);
    }

    for (let i = 0; i < 6; i++) if (this.ripT[i] >= 0) { this.ripT[i] += dt; if (this.ripT[i] > 5.2) this.ripT[i] = -1; }

    this.updateArcs(dt, t, dotReveal);
    this.updateDots(dt, t);
    for (const cb of this.frameCbs) cb(dt, t);
    this.render();
  }

  /** If the device can't hold a smooth frame rate, trade resolution and then bloom for speed. */
  private watchPerformance(raw: number) {
    if (this.opts.fixedQuality || this.stage >= 2 || raw > 0.5 || this.reveal < 0.9) return;
    this.perfN++; this.perfT += raw;
    if (this.perfN < 150) return;
    const avg = this.perfT / this.perfN;
    this.perfN = 0; this.perfT = 0;
    if (avg < 0.037) return; // slower than ~27 fps (a 30 fps cap alone does not trigger this)
    this.stage++;
    if (this.stage === 1) { this.maxDpr = 1.25; this.resize(); }
    else { this.composer?.dispose(); this.composer = null; this.bloom = null; this.maxDpr = 1; this.resize(); }
  }

  private updateArcs(dt: number, t: number, reveal: number) {
    this.comets.length = 0;
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      const u = a.mat.uniforms;
      const age = t - a.born;
      if (a.kind === 'wave') {
        const k = age / a.travel;
        const head = ease(clamp(k, 0, 1));
        u.uHead.value = head;
        u.uDrawn.value = 1;
        u.uFade.value = (k < 1 ? 1 : clamp(1 - (k - 1) * 2.2, 0, 1)) * reveal;
        if (k < 1) this.comets.push({ v: a.curve.getPoint(head), size: 46 });
        if (k >= 1 && a.done) { const end = a.curve.getPoint(1); this.pings.push({ v: end.clone(), born: t }); a.done(); a.done = undefined; }
        if (k > 1.5) { this.removeArc(i); continue; }
      } else {
        const k = a.travel > 0 ? clamp(age / a.travel, 0, 1) : 1;
        const drawn = ease(k);
        u.uDrawn.value = drawn;
        u.uHead.value = k < 1 ? drawn : 2;
        if (k < 1) this.comets.push({ v: a.curve.getPoint(drawn), size: 34 });
        const cyc = ((t * 0.07 + a.phase) % 1) * 1.6 - 0.3;
        u.uShimmer.value = k < 1 ? -1 : cyc;
        let fade = reveal;
        if (a.dying !== undefined) {
          fade *= clamp(1 - (t - a.dying) / 2, 0, 1);
          if (t - a.dying > 2) { this.removeArc(i); continue; }
        }
        u.uFade.value = fade;
      }
    }
  }

  private removeArc(i: number) {
    const a = this.arcs[i];
    this.scene.remove(a.mesh);
    a.mesh.geometry.dispose();
    a.mat.dispose();
    this.arcs.splice(i, 1);
  }

  removeThread(id: string) {
    const a = this.arcs.find((x) => x.id === id);
    if (a && a.dying === undefined) a.dying = this.time;
  }

  private updateDots(dt: number, t: number) {
    const pos = this.dotGeo.getAttribute('position') as THREE.BufferAttribute;
    const size = this.dotGeo.getAttribute('aSize') as THREE.BufferAttribute;
    const phase = this.dotGeo.getAttribute('aPhase') as THREE.BufferAttribute;
    const kind = this.dotGeo.getAttribute('aKind') as THREE.BufferAttribute;
    const glow = this.dotGeo.getAttribute('aGlow') as THREE.BufferAttribute;
    let n = 0;
    const put = (x: number, y: number, z: number, s: number, ph: number, k: number, g: number) => {
      if (n >= MAX_POINTS) return;
      pos.setXYZ(n, x, y, z); size.setX(n, s); phase.setX(n, ph); kind.setX(n, k); glow.setX(n, g); n++;
    };

    // gazes (drawn first, underneath)
    for (const [id, g] of this.gazes) {
      if (t - g.seen > 12) { this.gazes.delete(id); continue; }
      g.v.lerp(g.t, 1 - Math.pow(0.004, dt)).normalize().multiplyScalar(1.004);
      put(g.v.x, g.v.y, g.v.z, 110, hash01(id), KIND.gaze, 1);
    }
    for (const l of this.lights) {
      const p = latLonToVec3(l.lat, l.lon, R_LIGHT);
      if (l.kind === 'echo') put(p[0], p[1], p[2], 26, hash01(l.id), KIND.echo, clamp(1 - (l.age ?? 24) / 48, 0, 1));
      else put(p[0], p[1], p[2], l.kind === 'self' ? 54 : 38, hash01(l.id), l.kind === 'self' ? KIND.self : KIND.live, 1);
    }
    const teth = this.tetherGeo.getAttribute('position') as THREE.BufferAttribute;
    let tn = 0;
    for (const l of this.lanterns) {
      const r = this.lanternRadius(l.id);
      const p = latLonToVec3(l.lat, l.lon, 1);
      const g = clamp(Math.log2(1 + l.warmth) / 5, 0, 1);
      put(p[0] * r, p[1] * r, p[2] * r, 62 + g * 26, hash01(l.id), l.mine ? KIND.lanternMine : KIND.lantern, g);
      if (tn < 2048) {
        teth.setXYZ(tn * 2, p[0] * 1.002, p[1] * 1.002, p[2] * 1.002);
        teth.setXYZ(tn * 2 + 1, p[0] * (r - 0.006), p[1] * (r - 0.006), p[2] * (r - 0.006));
        tn++;
      }
    }
    for (const c of this.comets) put(c.v.x, c.v.y, c.v.z, c.size, 0, KIND.comet, 1);
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const k = (t - this.pings[i].born) / 1.6;
      if (k >= 1) { this.pings.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3);
      put(this.pings[i].v.x, this.pings[i].v.y, this.pings[i].v.z, 44 + e * 120, 0, KIND.gaze, 1.6 + 3.2 * (1 - k) * (1 - k));
    }

    pos.needsUpdate = size.needsUpdate = phase.needsUpdate = kind.needsUpdate = glow.needsUpdate = true;
    this.dotGeo.setDrawRange(0, n);
    teth.needsUpdate = true;
    this.tetherGeo.setDrawRange(0, tn * 2);
  }

  private render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

// Everything that talks to Supabase: anonymous identity, who is here (presence),
// gaze + waves (broadcast), and lanterns / threads / ring (database).
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';
import { placeByTz, JITTER_DEGREES } from '../lib/tz';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lonGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

export interface Me { lat: number; lon: number; city: string; country: string; tz: string; zone: number }
export interface Person { id: string; lat: number; lon: number; city: string; country: string; tz: string; since: number }
export interface Lantern {
  id: string; day: string; question_id: number; body: string; lat: number; lon: number;
  place: string; tz: string; warmth: number; seeded: boolean; created_at: string;
}
export interface Thread {
  id: string; a_lat: number; a_lon: number; a_place: string; b_lat: number; b_lon: number; b_place: string;
  km: number; created_at: string;
}
export interface Echo { lat: number; lon: number; place: string; last_seen: string }
export interface ZoneDay { day: string; zone: number; place: string; lit_at: string }
export interface Stats {
  threads_total: number; km_total: number; lanterns_48h: number; lights_today: number; lights_48h: number;
  zones_today: number[]; day: string;
}
export interface WaveMsg { from: Person; to: string; target: { lat: number; lon: number } | null }
export interface Marks { lanterns: string[]; warmed: string[]; threads: string[] }

type Events = {
  people: (people: Map<string, Person>, joined: Person[], left: Person[]) => void;
  gaze: (g: { id: string; lat: number; lon: number }) => void;
  wave: (w: WaveMsg) => void;
  thread: (t: Thread) => void;
  ripple: (from: Person) => void;
  lantern: (l: Lantern, fresh: boolean) => void;
  zone: (z: ZoneDay) => void;
  lanternHidden: (id: string) => void;
  status: (online: boolean) => void;
};

const LANTERN_COLS = 'id,day,question_id,body,lat,lon,place,tz,warmth,seeded,created_at';
const THREAD_COLS = 'id,a_lat,a_lon,a_place,b_lat,b_lon,b_place,km,created_at';
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export class Sky {
  uid: string | null = null;
  online = false;
  people = new Map<string, Person>();
  private db: SupabaseClient;
  private ch: RealtimeChannel | null = null;
  private me: Me | null = null;
  private tracking = false;
  private handlers: { [K in keyof Events]?: Events[K][] } = {};
  private goneAt = new Map<string, number>();
  private goneTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWaveFrom = new Map<string, number>();
  private lastRippleFrom = new Map<string, number>();
  private hiddenChecked = new Map<string, number>();
  /** ids the UI currently shows; hidden-lantern hints for anything else are ignored */
  knownLantern: (id: string) => boolean = () => false;

  constructor() {
    this.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'onesky.auth' },
      realtime: { params: { eventsPerSecond: 8 } },
    });
  }

  on<K extends keyof Events>(ev: K, fn: Events[K]) { (this.handlers[ev] ??= [] as any).push(fn); }
  private emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>) {
    for (const fn of this.handlers[ev] ?? []) { try { (fn as any)(...args); } catch (e) { console.error(e); } }
  }

  /** Sign in anonymously (or reuse the stored session) and join the sky as a watcher. */
  async connect(): Promise<void> {
    const { data } = await this.db.auth.getSession();
    if (data.session?.user) this.uid = data.session.user.id;
    else {
      const res = await this.db.auth.signInAnonymously();
      if (res.error || !res.data.user) throw res.error ?? new Error('sign-in failed');
      this.uid = res.data.user.id;
    }
    await this.db.realtime.setAuth();
    this.join();
  }

  private join() {
    const ch = this.db.channel('sky', { config: { presence: { key: this.uid! }, broadcast: { self: false, ack: false } } });
    this.ch = ch;
    ch.on('presence', { event: 'sync' }, () => this.syncPeople());
    ch.on('broadcast', { event: 'gaze' }, ({ payload }) => {
      if (!payload || typeof payload.id !== 'string' || !this.people.has(payload.id)) return;
      const lat = num(payload.lat, 999), lon = num(payload.lon, 999);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      this.emit('gaze', { id: payload.id, lat, lon });
    });
    ch.on('broadcast', { event: 'wave' }, ({ payload }) => {
      // A broadcast can be sent by anyone, so only the two ids are read from it; who and where
      // they are comes from presence. One wave per sender every 3 seconds.
      if (!payload || typeof payload.from !== 'string' || typeof payload.to !== 'string') return;
      const from = this.people.get(payload.from);
      if (!from || payload.from === this.uid) return;
      const now = Date.now();
      if (now - (this.lastWaveFrom.get(from.id) ?? 0) < 3000) return;
      this.lastWaveFrom.set(from.id, now);
      const to = payload.to === this.uid ? null : this.people.get(payload.to);
      if (payload.to !== this.uid && !to) return;
      this.emit('wave', { from, to: payload.to, target: to ? { lat: to.lat, lon: to.lon } : null });
    });
    ch.on('broadcast', { event: 'ripple' }, ({ payload }) => {
      // only the sender's id is trusted; one ripple per sender every 4 seconds
      const from = payload && typeof payload.from === 'string' ? this.people.get(payload.from) : undefined;
      if (!from || from.id === this.uid) return;
      const now = Date.now();
      if (now - (this.lastRippleFrom.get(from.id) ?? 0) < 4000) return;
      this.lastRippleFrom.set(from.id, now);
      this.emit('ripple', from);
    });
    ch.on('broadcast', { event: 'lantern_hidden' }, ({ payload }) => { if (payload && typeof payload.id === 'string' && UUID.test(payload.id)) void this.confirmHidden(payload.id); });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lanterns' }, (p) => { const l = this.cleanLantern(p.new); if (l) this.emit('lantern', l, true); });
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lanterns' }, (p) => { const l = this.cleanLantern(p.new); if (l) this.emit('lantern', l, false); });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'threads' }, (p) => { const t = this.cleanThread(p.new); if (t) this.emit('thread', t); });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'zone_days' }, (p) => {
      const z = p.new as any;
      if (z && typeof z.zone === 'number') this.emit('zone', { day: str(z.day, 10), zone: z.zone, place: str(z.place, 60), lit_at: str(z.lit_at, 40) });
    });
    ch.subscribe((status) => {
      const ok = status === 'SUBSCRIBED';
      if (ok !== this.online) { this.online = ok; this.emit('status', ok); }
      if (ok && this.tracking && this.me) void ch.track(this.presencePayload());
    });
  }

  private presencePayload() {
    const m = this.me!;
    return { lat: m.lat, lon: m.lon, city: m.city, country: m.country, tz: m.tz, since: Date.now() };
  }

  private syncPeople() {
    if (!this.ch) return;
    const state = this.ch.presenceState() as Record<string, any[]>;
    const next = new Map<string, Person>();
    for (const [id, metas] of Object.entries(state)) {
      // Presence is client-supplied. Accept only a uuid key, a known time zone, and a position
      // inside that zone's jitter box; the names shown come from our own table, never the payload.
      if (!UUID.test(id) || next.size >= 2000) continue;
      const m = metas[0];
      if (!m || typeof m.lat !== 'number' || typeof m.lon !== 'number') continue;
      const place = placeByTz(m.tz);
      if (!place) continue;
      if (Math.abs(m.lat - place.lat) > JITTER_DEGREES + 0.01 || lonGap(m.lon, place.lon) > JITTER_DEGREES + 0.01) continue;
      const since = num(m.since, Date.now());
      next.set(id, { id, lat: m.lat, lon: m.lon, city: place.city, country: place.country, tz: place.tz, since: Math.min(since, Date.now()) });
    }
    // Presence can flicker (a re-track or a brief reconnect shows as leave-then-join).
    // Keep someone for a few seconds after they vanish before calling them gone.
    const now = Date.now();
    for (const [id, p] of this.people) {
      if (next.has(id)) { this.goneAt.delete(id); continue; }
      const t = this.goneAt.get(id) ?? now;
      this.goneAt.set(id, t);
      if (now - t < 3500) next.set(id, p); else this.goneAt.delete(id);
    }
    if (this.goneAt.size) { clearTimeout(this.goneTimer); this.goneTimer = setTimeout(() => this.syncPeople(), 3600); }
    const joined: Person[] = [], left: Person[] = [];
    for (const [id, p] of next) if (!this.people.has(id)) joined.push(p);
    for (const [id, p] of this.people) if (!next.has(id)) { left.push(p); this.lastWaveFrom.delete(id); this.lastRippleFrom.delete(id); }
    this.people = next;
    this.emit('people', next, joined, left);
  }

  /** Become a light. */
  async appear(me: Me) {
    this.me = me; this.tracking = true;
    if (this.ch && this.online) await this.ch.track(this.presencePayload());
    void this.checkIn();
  }
  async move(me: Me) { return this.appear(me); }

  async checkIn() {
    const m = this.me;
    if (!m || !this.uid) return;
    await this.db.rpc('check_in', { p_lat: m.lat, p_lon: m.lon, p_place: m.city, p_tz: m.tz, p_zone: m.zone });
  }

  sendGaze(lat: number, lon: number) {
    if (!this.ch || !this.online || !this.uid || !this.tracking) return;
    void this.ch.send({ type: 'broadcast', event: 'gaze', payload: { id: this.uid, lat: +lat.toFixed(2), lon: +lon.toFixed(2) } });
  }

  sendRipple() {
    if (!this.ch || !this.online || !this.uid || !this.tracking) return;
    void this.ch.send({ type: 'broadcast', event: 'ripple', payload: { from: this.uid } });
  }

  /** Wave at someone. Returns a thread if this completed a mutual wave. */
  async wave(to: Person): Promise<Thread | null> {
    const m = this.me;
    if (!m || !this.uid || !this.ch) return null;
    void this.ch.send({ type: 'broadcast', event: 'wave', payload: { from: this.uid, to: to.id } });
    const { data, error } = await this.db.rpc('send_wave', { p_to: to.id, p_lat: m.lat, p_lon: m.lon, p_place: m.city, p_tz: m.tz });
    if (error) throw new Error(error.message);
    const t = this.cleanThread((data as any)?.thread);
    return t;
  }

  async releaseLantern(body: string, questionId: number): Promise<Lantern> {
    const m = this.me!;
    const { data, error } = await this.db.rpc('release_lantern', { p_body: body, p_question_id: questionId, p_lat: m.lat, p_lon: m.lon, p_place: m.city, p_tz: m.tz });
    if (error) throw new Error(error.message);
    const l = this.cleanLantern(data);
    if (!l) throw new Error('bad_response');
    return l;
  }
  async warm(id: string): Promise<number> {
    const { data, error } = await this.db.rpc('warm_lantern', { p_id: id });
    if (error) throw new Error(error.message);
    return num(data);
  }
  async report(id: string): Promise<void> {
    const { error } = await this.db.rpc('report_lantern', { p_id: id });
    if (error) throw new Error(error.message);
  }

  async lanterns(): Promise<Lantern[]> {
    const { data } = await this.db.from('lanterns').select(LANTERN_COLS).order('created_at', { ascending: false }).limit(600);
    return (data ?? []).map((r) => this.cleanLantern(r)).filter(Boolean) as Lantern[];
  }
  async threads(): Promise<Thread[]> {
    const { data } = await this.db.from('threads').select(THREAD_COLS).order('created_at', { ascending: false }).limit(160);
    return (data ?? []).map((r) => this.cleanThread(r)).filter(Boolean) as Thread[];
  }
  async echoes(): Promise<Echo[]> {
    const { data } = await this.db.rpc('recent_echoes');
    return ((data as any[]) ?? []).filter((e) => typeof e.lat === 'number' && typeof e.lon === 'number')
      .map((e) => ({ lat: e.lat, lon: e.lon, place: str(e.place, 60), last_seen: str(e.last_seen, 40) }));
  }
  async zones(day: string): Promise<ZoneDay[]> {
    const { data } = await this.db.from('zone_days').select('day,zone,place,lit_at').eq('day', day);
    return (data as ZoneDay[]) ?? [];
  }
  async stats(): Promise<Stats | null> {
    const { data } = await this.db.rpc('world_stats');
    const s = data as any;
    if (!s) return null;
    return {
      threads_total: num(s.threads_total), km_total: num(s.km_total), lanterns_48h: num(s.lanterns_48h),
      lights_today: num(s.lights_today), lights_48h: num(s.lights_48h),
      zones_today: Array.isArray(s.zones_today) ? s.zones_today.filter((z: unknown) => typeof z === 'number') : [], day: str(s.day, 10),
    };
  }
  async marks(): Promise<Marks> {
    const { data } = await this.db.rpc('my_marks');
    const m = (data as any) ?? {};
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return { lanterns: arr(m.lanterns), warmed: arr(m.warmed), threads: arr(m.threads) };
  }

  /** A hidden-lantern broadcast is only a hint (anyone can send one); confirm against the database. */
  private async confirmHidden(id: string) {
    if (!this.knownLantern(id)) return;
    const now = Date.now();
    if (now - (this.hiddenChecked.get(id) ?? 0) < 60000) return;
    if (this.hiddenChecked.size > 500) this.hiddenChecked.clear();
    this.hiddenChecked.set(id, now);
    const { data, error } = await this.db.from('lanterns').select('id').eq('id', id).limit(1);
    if (!error && data && data.length === 0) this.emit('lanternHidden', id);
  }

  private cleanLantern(r: any): Lantern | null {
    if (!r || typeof r.id !== 'string' || typeof r.body !== 'string') return null;
    if (typeof r.lat !== 'number' || typeof r.lon !== 'number') return null;
    return {
      id: r.id, day: str(r.day, 10), question_id: num(r.question_id), body: r.body.slice(0, 160), lat: r.lat, lon: r.lon,
      place: str(r.place, 60), tz: str(r.tz, 64), warmth: num(r.warmth), seeded: !!r.seeded, created_at: str(r.created_at, 40),
    };
  }
  private cleanThread(r: any): Thread | null {
    if (!r || typeof r.id !== 'string') return null;
    for (const k of ['a_lat', 'a_lon', 'b_lat', 'b_lon', 'km']) if (typeof r[k] !== 'number' || !isFinite(r[k])) return null;
    return { id: r.id, a_lat: r.a_lat, a_lon: r.a_lon, a_place: str(r.a_place, 60), b_lat: r.b_lat, b_lon: r.b_lon, b_place: str(r.b_place, 60), km: r.km, created_at: str(r.created_at, 40) };
  }
}

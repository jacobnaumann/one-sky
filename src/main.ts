import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/hanken-grotesk';
import './styles.css';

import { Globe, type LightDot, type Pick } from './globe/globe';
import { Sky, type Person, type Lantern, type Thread, type Echo, type ZoneDay, type Stats, type Me } from './net/sky';
import { AudioEngine } from './audio/engine';
import { placeForTimeZone, placeForOffset, searchPlaces, jitter, PLACES, type Place } from './lib/tz';
import { localTimeString, zoneIndex, zoneLabel, utcDay, relativeTime, utcOffsetMinutes } from './lib/time';
import { skyState, solarElevation } from './lib/sun';
import { greatCircleKm, formatKm } from './lib/geo';
import { questionForDay, QUESTIONS } from './lib/questions';
import { cleanLantern, reasonMessage, MAX_LANTERN_LENGTH } from './lib/moderation';
import { $, h, rich, modal, isModalOpen, toast, feed, countTo } from './ui/dom';
import { makePostcard } from './ui/postcard';

// ───────────────────────── state ─────────────────────────

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const lowPower = (navigator.hardwareConcurrency ?? 8) <= 2 || /[?&]low\b/.test(location.search);

let seed = store.get('onesky.seed');
if (!seed) { seed = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('onesky.seed', seed); }

function buildMe(place: Place): Me & { place: Place } {
  const j = jitter(place, seed!);
  return { place, lat: +j.lat.toFixed(3), lon: +j.lon.toFixed(3), city: place.city, country: place.country, tz: place.tz, zone: zoneIndex(place.tz) };
}
let browserTz: string | undefined;
try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* keep undefined */ }
let me = buildMe(placeForTimeZone(store.get('onesky.tz') ?? browserTz));

const sky = new Sky();
const audio = new AudioEngine();
let globe: Globe;

let entered = false;
let echoes: Echo[] = [];
const lanterns = new Map<string, Lantern>();
const threads = new Map<string, Thread>();
const marks = { lanterns: new Set<string>(), warmed: new Set<string>(), threads: new Set<string>() };
const zonesLit = new Map<number, ZoneDay>();
let stats: Stats = { threads_total: 0, km_total: 0, lanterns_48h: 0, lights_today: 0, lights_48h: 0, zones_today: [], day: utcDay() };
let today = utcDay();
let question = questionForDay(today);
let selection: Pick | null = null;
const wavedAt = new Map<string, number>();      // uid → when I last waved at them
const wavedBy = new Map<string, number>();      // uid → when they last waved at me
let ringWasComplete = false;

const echoKey = (e: Echo) => `echo:${e.eid ?? `${e.lat},${e.lon},${e.place}`}`;
const echoById = (id: string) => echoes.find((e) => echoKey(e) === id);
const placeLine = (city: string, country: string) => (country && country !== city ? `${city}, ${country}` : city);
const skyLine = (lat: number, lon: number, tz: string) => `${localTimeString(tz)} · ${skyState(lat, lon, new Date())}`;
const others = () => [...sky.people.values()].filter((p) => p.id !== sky.uid);
const liveCount = () => others().length + (entered ? 1 : 0);

// ───────────────────────── globe data ─────────────────────────

function refreshLights() {
  const dots: LightDot[] = [];
  const taken: { lat: number; lon: number }[] = [];
  if (entered) { dots.push({ id: 'self', lat: me.lat, lon: me.lon, kind: 'self' }); taken.push(me); }
  for (const p of others()) { dots.push({ id: p.id, lat: p.lat, lon: p.lon, kind: 'live' }); taken.push(p); }
  const now = Date.now();
  const seenEcho = new Set<string>();
  echoes.forEach((e) => {
    const key = echoKey(e);
    if (seenEcho.has(key)) return;
    seenEcho.add(key);
    if (taken.some((t) => Math.abs(t.lat - e.lat) < 0.02 && Math.abs(t.lon - e.lon) < 0.02)) return;
    dots.push({ id: key, lat: e.lat, lon: e.lon, kind: 'echo', age: (now - Date.parse(e.last_seen)) / 3600000 });
  });
  globe.setLights(dots);
  audio.setLights(dots.filter((d) => d.kind !== 'echo').map((d) => ({ id: d.id, lat: d.lat, lon: d.lon })));
  renderCensus();
}

function refreshLanterns() {
  globe.setLanterns([...lanterns.values()].map((l) => ({ id: l.id, lat: l.lat, lon: l.lon, warmth: l.warmth, mine: marks.lanterns.has(l.id) })));
  countTo($('st-lanterns'), lanterns.size);
}

function renderCensus() {
  const n = liveCount();
  const el = $('census');
  const sig = `${sky.uid ? 1 : 0}|${n}|${entered}|${stats.lights_48h}|${echoes.length}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren();
  if (!sky.uid) { el.textContent = 'Finding the others…'; return; }
  const live = n === 0 ? 'No lights awake yet' : n === 1 ? (entered ? 'You are the only light awake' : '1 light awake') : `${n} lights awake`;
  el.append(h('b', {}, live));
  if (stats.lights_48h >= 25) el.append(h('span', { class: 'wide' }, ` · ${stats.lights_48h.toLocaleString('en-US')} in the last two days`));
  else if (echoes.length >= 2) el.append(h('span', { class: 'wide' }, ` · ${echoes.length} echoes of earlier visitors`));
}

/** A place where the sun is on the horizon right now, if any. */
function horizonPlace(): { place: Place; rising: boolean } | null {
  const now = new Date(), soon = new Date(now.getTime() + 6 * 60000);
  const hits: { place: Place; rising: boolean }[] = [];
  for (const p of PLACES) {
    const e = solarElevation(p.lat, p.lon, now);
    if (Math.abs(e) < 1.2) hits.push({ place: p, rising: solarElevation(p.lat, p.lon, soon) > e });
  }
  if (!hits.length) return null;
  const rising = hits.filter((x) => x.rising);
  const pool = rising.length ? rising : hits;
  return pool[Math.floor(now.getTime() / 240000) % pool.length];
}

/** Minutes until the sun next crosses the horizon at my place, and which way. */
let sunCache: { at: number; text: string } | null = null;
function mySunLine(): string {
  const nowMs = Date.now();
  if (sunCache && nowMs - sunCache.at < 60000) return sunCache.text;
  const up = solarElevation(me.lat, me.lon, new Date(nowMs)) > -0.83;
  let text = '';
  for (let m = 2; m <= 24 * 60; m += 2) {
    if ((solarElevation(me.lat, me.lon, new Date(nowMs + m * 60000)) > -0.83) !== up) {
      const hh = Math.floor(m / 60), mm = m % 60;
      text = `${up ? 'sunset' : 'sunrise'} in ${hh ? `${hh} h ` : ''}${mm} min`;
      break;
    }
  }
  sunCache = { at: nowMs, text };
  return text;
}

function renderYou() {
  $('you-place').textContent = placeLine(me.city, me.country);
  const sun = mySunLine();
  $('you-time').textContent = skyLine(me.lat, me.lon, me.tz) + (sun ? ` · ${sun}` : '');
}

function renderMine() {
  let n = 0, km = 0;
  for (const id of marks.threads) { const t = threads.get(id); if (t) { n++; km += t.km; } }
  const el = $('you-threads');
  el.hidden = n === 0;
  if (n) el.textContent = `${n} ${n === 1 ? 'thread' : 'threads'} of yours · ${formatKm(km)}`;
}

function renderStats() {
  renderMine();
  countTo($('st-threads'), stats.threads_total);
  countTo($('st-km'), stats.km_total);
}

// ───────────────────────── the ring ─────────────────────────

const RING_ORDER = [...Array(11).keys()].map((i) => i + 13).concat([...Array(13).keys()]); // UTC−11 … UTC+12
function zoneCity(i: number) { return placeForOffset((i <= 12 ? i : i - 24) * 60).city; }

function buildRingStrip() {
  const strip = $('ringstrip');
  strip.replaceChildren();
  for (const z of RING_ORDER) {
    const tick = h('i', { 'data-z': z });
    tick.addEventListener('pointerenter', () => ringHint(z));
    tick.addEventListener('pointerleave', () => ringHint(null));
    strip.append(tick);
  }
}

function ringHint(z: number | null) {
  const el = $('ring-hint');
  if (z !== null) {
    const lit = zonesLit.get(z);
    el.textContent = lit
      ? `${z === me.zone ? myZoneLabel() : zoneLabel(z)} · lit by ${lit.place}${z === me.zone ? ' — your zone' : ''}`
      : `${zoneLabel(z)} · still dark. Know someone near ${zoneCity(z)}?`;
    return;
  }
  const dark = RING_ORDER.filter((x) => !zonesLit.has(x));
  if (dark.length === 0) el.textContent = 'The ring is closed. Every time zone showed up today.';
  else if (dark.length === 24) el.textContent = 'A new day. Nobody has lit the ring yet.';
  else {
    const names = dark.sort((a, b) => Math.abs(a - 12) - Math.abs(b - 12)).slice(0, 3).map(zoneCity);
    el.textContent = `${dark.length} still dark · e.g. ${names.join(', ')}`;
  }
}

function renderRing(flash = true) {
  const lit = Array.from({ length: 24 }, (_, i) => zonesLit.has(i));
  globe.setRing(lit, flash);
  for (const tick of $('ringstrip').children as HTMLCollectionOf<HTMLElement>) {
    const z = Number(tick.dataset.z);
    tick.classList.toggle('lit', zonesLit.has(z));
    tick.classList.toggle('mine', z === me.zone);
  }
  $('ring-count').textContent = String(zonesLit.size);
  ringHint(null);
  const complete = zonesLit.size === 24;
  if (complete && !ringWasComplete && entered && flash) {
    audio.ringComplete();
    toast(rich([{ b: 'The ring is closed.' }, ' All 24 time zones have a light today.', { small: 'It starts again at midnight UTC.' }]), { ms: 12000 });
  }
  ringWasComplete = complete;
}

/** The visitor's own offset as a label; unlike the 24-band index this is right for UTC+13 and +14. */
function myZoneLabel() {
  const off = Math.round(utcOffsetMinutes(me.tz) / 60);
  return off === 0 ? 'UTC±0' : `UTC${off > 0 ? '+' : '−'}${Math.abs(off)}`;
}

function lightZone(z: ZoneDay, announce: boolean) {
  if (z.day > today) rollDay(z.day); // the server is already in the new day
  if (z.day !== today || zonesLit.has(z.zone)) return;
  zonesLit.set(z.zone, z);
  renderRing(announce);
  if (announce && entered) {
    audio.ringSegment(zonesLit.size - 1);
    if (z.zone === me.zone) feed(rich(z.place === me.city ? ['You lit ', { b: myZoneLabel() }, ' for the world today'] : ['Your zone, ', { b: myZoneLabel() }, ', is lit']));
    else feed(rich([{ b: zoneLabel(z.zone) }, ` is lit — first light from ${z.place}`]));
  }
}

// ───────────────────────── labels ─────────────────────────

const labelLayer = $('labels');
const selfLabel = h('div', { class: 'label self off' }, 'you');
const reticle = h('div', { class: 'reticle off' });
labelLayer.append(reticle, selfLabel);
const liveLabels = new Map<string, HTMLElement>();
const spotLabel = h('div', { class: 'label spot off' });
labelLayer.append(spotLabel);
let spot: { lat: number; lon: number; until: number } | null = null;

/** Tap empty Earth: what time is it there, and what is its sky doing? */
function showSpot(x: number, y: number) {
  const hit = globe.hit(x, y);
  if (!hit) { spot = null; return; }
  let best: Place | null = null, bd = 1e9;
  for (const p of PLACES) {
    const d = greatCircleKm(hit.lat, hit.lon, p.lat, p.lon);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best || bd > 2600) { spot = null; return; }
  spotLabel.replaceChildren(h('b', {}, best.city), ` ${localTimeString(best.tz)} · ${skyState(best.lat, best.lon, new Date())}`);
  spot = { lat: best.lat, lon: best.lon, until: performance.now() + 5200 };
  audio.uiTick();
}

function place(el: HTMLElement, s: { x: number; y: number; visible: boolean }, show: boolean) {
  el.classList.toggle('off', !(show && s.visible));
  el.style.transform = `translate(${s.x.toFixed(1)}px, ${(s.y - 8).toFixed(1)}px)`;
}

function updateLabels() {
  place(selfLabel, globe.project(me.lat, me.lon), entered);
  const people = others();
  const show = people.length <= 14;
  const seen = new Set<string>();
  if (!show || !entered) { for (const el of liveLabels.values()) el.classList.add('off'); }
  else for (const p of people) {
    seen.add(p.id);
    let el = liveLabels.get(p.id);
    if (!el) { el = h('div', { class: 'label off' }, p.city); liveLabels.set(p.id, el); labelLayer.append(el); }
    if (el.textContent !== p.city) el.textContent = p.city;
    place(el, globe.project(p.lat, p.lon), true);
  }
  if (show && entered) for (const [id, el] of liveLabels) if (!seen.has(id)) { el.remove(); liveLabels.delete(id); }
  if (liveLabels.size > 60) { for (const el of liveLabels.values()) el.remove(); liveLabels.clear(); }

  if (spot && performance.now() > spot.until) spot = null;
  if (spot) place(spotLabel, globe.project(spot.lat, spot.lon), true); else spotLabel.classList.add('off');

  const target = selectionPoint();
  if (target) {
    const s = globe.project(target.lat, target.lon, target.r);
    reticle.classList.toggle('off', !s.visible);
    reticle.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
  } else reticle.classList.add('off');
}

function selectionPoint(): { lat: number; lon: number; r?: number } | null {
  if (!selection) return null;
  if (selection.type === 'lantern') {
    const l = lanterns.get(selection.id);
    return l ? { lat: l.lat, lon: l.lon, r: globe.lanternRadius(l.id) } : null;
  }
  if (selection.id.startsWith('echo:')) return echoById(selection.id) ?? null;
  return sky.people.get(selection.id) ?? null;
}

// ───────────────────────── card ─────────────────────────

const card = $('card');
let repaintLantern: (() => void) | null = null;
function closeCard() { if (drift) stopDrift(); repaintLantern = null; selection = null; card.hidden = true; card.replaceChildren(); globe.autoRotate = true; }

function select(pick: Pick | null, fly = true) {
  if (!pick) { closeCard(); return; }
  selection = pick;
  globe.autoRotate = false;
  const pt = selectionPoint();
  if (!pt) { closeCard(); return; }
  if (fly) void globe.flyTo(pt.lat, pt.lon, undefined, 1100);
  audio.uiTick();
  renderCard();
}

function renderCard() {
  if (!selection) return;
  repaintLantern = null;
  const hadFocus = card.contains(document.activeElement);
  card.replaceChildren(h('button', { class: 'card-close', 'aria-label': 'Close', onclick: closeCard }, '×'));
  if (selection.type === 'lantern') renderLanternCard(selection.id);
  else if (selection.id.startsWith('echo:')) renderEchoCard(selection.id);
  else renderPersonCard(selection.id);
  card.hidden = false;
  // restart the entrance animation
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
  if (hadFocus) card.querySelector<HTMLElement>('.btn')?.focus();
}

function facts(rows: [string, string][]) {
  return h('dl', { class: 'facts' }, ...rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
}

function renderPersonCard(id: string) {
  const p = sky.people.get(id);
  if (!p) { closeCard(); return; }
  const km = greatCircleKm(me.lat, me.lon, p.lat, p.lon);
  const theyWaved = Date.now() - (wavedBy.get(id) ?? 0) < 10 * 60 * 1000;
  const cooling = Date.now() - (wavedAt.get(id) ?? 0) < 8000;
  const note = h('p', { class: 'note' }, theyWaved ? 'They waved at you. Wave back to tie a thread between you.' : 'If they wave back, a thread of light stays between you.');
  const btn = h('button', { class: 'btn primary', disabled: cooling }, cooling ? 'Wave sent' : theyWaved ? 'Wave back' : 'Wave');
  btn.addEventListener('click', () => { void doWave(p); });
  const sk = skyState(p.lat, p.lon, new Date());
  card.append(
    h('div', { class: `skybar sky-${sk.replace(' ', '-')}`, role: 'img', 'aria-label': `Their sky: ${sk}` }),
    h('p', { class: 'eyebrow' }, 'A light, awake right now'),
    h('h2', {}, p.city),
    h('p', { class: 'sub' }, p.country || ' '),
    facts([
      ['their time', localTimeString(p.tz)],
      ['their sky', skyState(p.lat, p.lon, new Date())],
      ['from you', km < 30 ? 'right beside you' : formatKm(km)],
      ['here for', relativeTime(new Date(p.since)).replace(' ago', '').replace('just now', 'a moment')],
    ]),
    h('div', { class: 'actions' }, btn),
    note,
  );
}

function renderEchoCard(id: string) {
  const e = echoById(id);
  if (!e) { closeCard(); return; }
  const left = store.get('onesky.echoWaved') ?? '';
  const already = !!e.eid && left.includes(e.eid);
  const note = h('p', { class: 'note' }, already
    ? 'Your wave is waiting for them. They will see it the next time they arrive.'
    : e.eid ? 'They have gone — but you can leave a wave. It reaches them the next time they arrive.'
      : 'They have just gone. Their light lingers here for two days.');
  const actions = h('div', { class: 'actions' });
  if (e.eid) {
    const btn = h('button', { class: 'btn primary', disabled: already }, already ? 'Wave left' : 'Leave a wave');
    btn.addEventListener('click', async () => {
      if (!sky.online) { toast(rich(['The sky is out of reach right now. Try again in a moment.']), { plain: true }); return; }
      btn.disabled = true; btn.textContent = 'Wave left';
      const { seconds } = globe.wave(me, e);
      audio.waveOut(me.lon, e.lon, seconds);
      try {
        await sky.waveEcho(e.eid!);
        store.set('onesky.echoWaved', (left + ',' + e.eid).slice(-2000));
        note.textContent = 'Your wave is waiting for them. They will see it the next time they arrive.';
        feed(rich(['You left a wave in ', { b: e.place }]));
      } catch (err: any) {
        btn.disabled = false; btn.textContent = 'Leave a wave';
        note.textContent = String(err?.message).includes('rate_limited') ? 'That’s a lot of waves for one hour. Try again later.' : 'That wave didn’t get through. Try again in a moment.';
      }
    });
    actions.append(btn);
  }
  card.append(
    h('p', { class: 'eyebrow' }, 'An echo'),
    h('h2', {}, e.place),
    h('p', { class: 'sub' }, `Someone was here ${relativeTime(e.last_seen)}.`),
    facts([['their time', (() => { const pl = PLACES.find((x) => x.city === e.place); return pl ? localTimeString(pl.tz) : '—'; })()], ['from you', formatKm(greatCircleKm(me.lat, me.lon, e.lat, e.lon))]]),
    actions,
    note,
  );
}

function renderLanternCard(id: string) {
  const l = lanterns.get(id);
  if (!l) { closeCard(); return; }
  const mine = marks.lanterns.has(id);
  const q = QUESTIONS.find((x) => x.id === l.question_id);
  const warmed = marks.warmed.has(id);
  const warmBtn = h('button', { class: 'btn ghost small warm-btn' + (warmed ? ' is-warm' : ''), 'aria-pressed': String(warmed) });
  const paintWarm = () => {
    const on = marks.warmed.has(id);
    const cur = lanterns.get(id)?.warmth ?? 0;
    warmBtn.className = 'btn ghost small warm-btn' + (on ? ' is-warm' : '');
    warmBtn.setAttribute('aria-pressed', String(on));
    warmBtn.replaceChildren(
      h('span', { html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c-4.2-1.2-6.6-4-6.6-7.4 0-2.6 1.6-4.6 3-6.3.4 1.5 1.1 2.4 2 2.9C10.200 7 11.300 4.300 13.300 3c0 2.800 1.300 4.300 2.700 5.900 1.400 1.600 2.600 3.300 2.600 5.300 0 3.200-2.500 5.800-6.600 6.800Z"/></svg>' }),
      on ? `Warmed · ${cur}` : cur > 0 ? `Warm it · ${cur}` : 'Warm it',
    );
  };
  paintWarm();
  repaintLantern = paintWarm;
  warmBtn.addEventListener('click', async () => {
    if (marks.warmed.has(id)) return;
    marks.warmed.add(id);
    const cur = lanterns.get(id);
    if (cur) cur.warmth += 1;
    paintWarm(); refreshLanterns(); audio.warm();
    try { const w = await sky.warm(id); const c = lanterns.get(id); if (c) { c.warmth = Math.max(c.warmth, w); paintWarm(); refreshLanterns(); } }
    catch { /* keep the optimistic glow; it is harmless */ }
  });

  const body = h('blockquote', { class: l.body.length > 90 ? 'long' : '' }, `“${l.body}”`);
  const actions = h('div', { class: 'actions' }, warmBtn);
  const translated = h('p', { class: 'translated', hidden: true });
  if ('Translator' in self && 'LanguageDetector' in self) {
    void lanternLanguage(l.body).then((src) => {
      if (!src || !actions.isConnected) return;
      const tb = h('button', { class: 'btn ghost small' }, 'Translate');
      tb.addEventListener('click', async () => {
        tb.setAttribute('disabled', ''); tb.textContent = 'Translating…';
        const out = await translate(l.body, src);
        translated.hidden = false;
        translated.textContent = out ?? 'No translation is available on this device.';
        tb.remove();
      });
      actions.append(tb);
    });
  }
  const tiny = h('div', { class: 'tiny' }, h('span', {}, l.seeded ? 'A welcome note from the makers' : `Released ${relativeTime(l.created_at)}`));
  if (!l.seeded && !mine) {
    const rb = h('button', {}, 'Report');
    rb.addEventListener('click', async () => {
      rb.setAttribute('disabled', ''); rb.textContent = 'Reported — thank you';
      try { await sky.report(id); } catch { /* nothing useful to tell them */ }
    });
    tiny.append(rb);
  }
  card.append(
    h('p', { class: 'eyebrow' }, (mine ? 'Your lantern' : l.seeded ? 'A lantern from One Sky' : 'A lantern') + (drift ? ` · ${((drift.i - 1) % drift.order.length) + 1} / ${drift.order.length}` : '')),
    h('p', { class: 'sub' }, `over ${l.place} · ${localTimeString(l.tz)} there now`),
    ...(q ? [h('p', { class: 'q', style: 'margin-top:14px' }, q.text)] : []),
    body, translated, actions, tiny,
  );
  audio.lanternOpen();
}

const myLang = (navigator.language || 'en').split('-')[0];
/** The lantern's language, if it is confidently not the reader's own. */
async function lanternLanguage(text: string): Promise<string | null> {
  try {
    const det = await (self as any).LanguageDetector.create();
    const top = (await det.detect(text))?.[0];
    const src = top?.detectedLanguage;
    if (!src || src === 'und' || src === myLang || (top.confidence ?? 0) < 0.6) return null;
    return src;
  } catch { return null; }
}
async function translate(text: string, src: string): Promise<string | null> {
  try {
    const tr = await (self as any).Translator.create({ sourceLanguage: src, targetLanguage: myLang });
    return await tr.translate(text);
  } catch { return null; }
}

// ───────────────────────── waves and threads ─────────────────────────

async function doWave(p: Person) {
  if (!entered) return;
  if (!sky.online) { toast(rich(['The sky is out of reach right now. Try again in a moment.']), { plain: true }); return; }
  if (Date.now() - (wavedAt.get(p.id) ?? 0) < 8000) return;
  wavedAt.set(p.id, Date.now());
  const { seconds, landed } = globe.wave(me, p);
  audio.waveOut(me.lon, p.lon, seconds);
  const btn = selection?.id === p.id ? card.querySelector<HTMLButtonElement>('.actions .btn.primary') : null;
  if (btn) {
    btn.disabled = true; btn.textContent = 'Wave sent';
    setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = Date.now() - (wavedBy.get(p.id) ?? 0) < 600000 ? 'Wave back' : 'Wave again'; } }, 8100);
  }
  try {
    const t = await sky.wave(p);
    await landed;
    if (t) { marks.threads.add(t.id); addThread(t, true, { mine: true, other: p.city }); }
    else feed(rich(['Your wave reached ', { b: p.city }]));
  } catch (e: any) {
    toast(rich([String(e?.message).includes('rate_limited') ? 'That’s a lot of waving. Give it a minute.' : 'That wave didn’t get through. Try again in a moment.']), { plain: true });
  }
}

function addThread(t: Thread, animate: boolean, opts: { mine?: boolean; other?: string } = {}) {
  if (threads.has(t.id)) return;
  threads.set(t.id, t);
  globe.addThread(t.id, { lat: t.a_lat, lon: t.a_lon }, { lat: t.b_lat, lon: t.b_lon }, animate);
  if (!animate) return;
  stats.threads_total += 1; stats.km_total += t.km; renderStats();
  if (opts.mine) {
    audio.thread(t.km);
    toast(rich([{ b: `A thread now joins you and someone in ${opts.other}.` }, { small: `${formatKm(t.km)} of light between you. It stays on the Earth for everyone to see.` }]), { ms: 9000 });
  } else if (entered) {
    feed(rich([{ b: t.a_place }, ' and ', { b: t.b_place }, ` are threaded · ${formatKm(t.km)}`]));
  }
}

// ───────────────────────── ripples ─────────────────────────

let lastRipple = 0;
function doRipple() {
  if (!entered) return;
  const now = Date.now();
  if (now - lastRipple < 4000) return;
  lastRipple = now;
  globe.ripple(me.lat, me.lon);
  audio.ringSegment(Math.round(((me.lon + 180) / 360) * 23));
  sky.sendRipple();
  const btn = $('btn-ripple');
  btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse');
  btn.setAttribute('disabled', '');
  setTimeout(() => btn.removeAttribute('disabled'), 4000);
  const n = others().length;
  feed(rich([n > 0 ? `Your ripple is crossing the Earth — ${n} ${n === 1 ? 'person' : 'people'} can see it` : 'Your ripple is crossing the Earth']));
  // five seconds later the ring closes on the exact opposite side of the planet
  const anti = { lat: -me.lat, lon: me.lon > 0 ? me.lon - 180 : me.lon + 180 };
  let near: Place | null = null, bd = 1e9;
  for (const p of PLACES) { const d = greatCircleKm(anti.lat, anti.lon, p.lat, p.lon); if (d < bd) { bd = d; near = p; } }
  const closing = near;
  setTimeout(() => { if (closing) feed(rich(['Your ripple met itself on the far side of the Earth, ', { b: bd < 600 ? `near ${closing.city}` : `${formatKm(bd)} from ${closing.city}` }]), true); }, 5200);
}

// ───────────────────────── drift (a slow tour of the lanterns) ─────────────────────────

let drift: { timer: number; order: string[]; i: number } | null = null;
function stopDrift() {
  if (!drift) return;
  clearTimeout(drift.timer);
  drift = null;
  $('btn-drift').setAttribute('aria-pressed', 'false');
  $('app').classList.remove('is-drifting');
}
function startDrift() {
  if (!entered) return;
  const order = [...lanterns.values()].sort((a, b) => a.lon - b.lon).map((l) => l.id);
  if (!order.length) { toast(rich(['No lanterns are aloft yet. Release the first one.']), { plain: true }); return; }
  // begin with the lantern nearest to where the visitor is looking
  const here = globe.gaze();
  let start = 0, bd = 1e9;
  order.forEach((id, i) => { const l = lanterns.get(id)!; const d = greatCircleKm(here.lat, here.lon, l.lat, l.lon); if (d < bd) { bd = d; start = i; } });
  drift = { timer: 0, order, i: start };
  $('btn-drift').setAttribute('aria-pressed', 'true');
  $('app').classList.add('is-drifting');
  const step = () => {
    if (!drift) return;
    let tries = 0;
    while (tries++ < drift.order.length && !lanterns.has(drift.order[drift.i % drift.order.length])) drift.i++;
    const id = drift.order[drift.i % drift.order.length];
    if (!lanterns.has(id)) { stopDrift(); return; }
    drift.i++;
    selection = { type: 'lantern', id };
    globe.autoRotate = false;
    const l = lanterns.get(id)!;
    void globe.flyTo(l.lat - 6, l.lon, Math.min(globe.homeDist(), 2.9), 2600);
    renderCard();
    drift.timer = window.setTimeout(step, 8500);
  };
  step();
}

// ───────────────────────── watch a day pass ─────────────────────────

let dayRun = 0;
function watchDay() {
  if (!entered) return;
  const btn = $('btn-day'), label = $('daypass');
  if (dayRun) { cancelAnimationFrame(dayRun); dayRun = 0; globe.sunOffset = 0; globe.setSun(new Date()); label.hidden = true; btn.setAttribute('aria-pressed', 'false'); return; }
  stopDrift();
  btn.setAttribute('aria-pressed', 'true');
  label.hidden = false;
  const t0 = performance.now(), ms = reducedMotion ? 4000 : 11000, DAY = 86400000;
  const tick = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    globe.sunOffset = e * DAY || 1;
    const when = new Date(Date.now() + e * DAY);
    const hours = Math.round(e * 24);
    label.replaceChildren(
      `${localTimeString(me.tz, when)} in ${me.city}`,
      h('small', {}, hours >= 24 ? 'and back to now' : hours === 0 ? 'now' : `${hours} ${hours === 1 ? 'hour' : 'hours'} from now`),
    );
    if (k < 1) { dayRun = requestAnimationFrame(tick); return; }
    dayRun = 0; globe.sunOffset = 0; globe.setSun(new Date());
    btn.setAttribute('aria-pressed', 'false');
    setTimeout(() => { if (!dayRun) label.hidden = true; }, 1400);
  };
  dayRun = requestAnimationFrame(tick);
}

// ───────────────────────── the sun, as news ─────────────────────────

const sunTold = new Map<string, number>();
function sunNews() {
  if (!entered || document.hidden || drift) return;
  const now = new Date(), soon = new Date(now.getTime() + 6 * 60000);
  const rising: Place[] = [], setting: Place[] = [];
  for (const p of PLACES) {
    const e = solarElevation(p.lat, p.lon, now);
    if (Math.abs(e) > 0.9) continue;
    if (Date.now() - (sunTold.get(p.tz) ?? 0) < 6 * 3600 * 1000) continue;
    (solarElevation(p.lat, p.lon, soon) > e ? rising : setting).push(p);
  }
  const pool = rising.length && (Math.random() < 0.6 || !setting.length) ? rising : setting;
  if (!pool.length) return;
  const p = pool[Math.floor(Math.random() * pool.length)];
  sunTold.set(p.tz, Date.now());
  feed(rich([pool === rising ? 'The sun is rising over ' : 'Night is falling in ', { b: p.city }]), true);
}

// ───────────────────────── lanterns ─────────────────────────

const LANTERN_ERRORS: Record<string, string> = {
  rate_limited: 'One lantern every 30 seconds, five a day. Let this one drift a while.',
  contact: 'Lanterns can’t carry handles, emails or phone numbers. Keep it to the moment.',
  not_authenticated: 'The sky is out of reach right now. Try again in a moment.',
};

function openComposer() {
  if (!entered) return;
  modal((close) => {
    const ta = h('textarea', { rows: 3, maxlength: MAX_LANTERN_LENGTH, placeholder: 'One or two sentences…', 'aria-label': 'Your answer', 'data-autofocus': true });
    const count = h('span', { class: 'count' }, `${MAX_LANTERN_LENGTH} left`);
    const err = h('p', { class: 'err', role: 'alert' });
    const send = h('button', { class: 'btn primary', disabled: true }, 'Release');
    const sync = () => {
      const left = MAX_LANTERN_LENGTH - [...ta.value].length;
      count.textContent = `${left} left`;
      count.classList.toggle('warn', left <= 20);
      if (ta.value.trim()) send.removeAttribute('disabled'); else send.setAttribute('disabled', '');
      err.textContent = '';
    };
    ta.addEventListener('input', sync);
    const submit = async () => {
      const res = cleanLantern(ta.value);
      if (!res.ok) { err.textContent = reasonMessage(res.reason); return; }
      send.setAttribute('disabled', ''); send.textContent = 'Releasing…';
      try {
        const l = await sky.releaseLantern(res.text, question.id);
        marks.lanterns.add(l.id);
        lanterns.set(l.id, l);
        refreshLanterns();
        close();
        audio.lantern();
        void globe.flyTo(me.lat, me.lon, undefined, 1200);
        toast(rich([{ b: `Your lantern is aloft over ${me.city}.` }, { small: 'It stays for 48 hours. Anyone on Earth can read it and warm it.' }]), { ms: 8000 });
      } catch (e: any) {
        const code = String(e?.message ?? '');
        err.textContent = LANTERN_ERRORS[code] ?? (['empty', 'too_long', 'link', 'blocked'].includes(code) ? reasonMessage(code as any) : 'The sky didn’t take it. Try again in a moment.');
        send.removeAttribute('disabled'); send.textContent = 'Release';
      }
    };
    send.addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } });
    return h('div', {},
      h('p', { class: 'eyebrow' }, 'Today’s question'),
      h('h2', {}, question.text),
      ta, err,
      h('div', { class: 'row' }, h('span', { class: 'fine' }, `Rises over ${me.city} · stays 48 hours`), h('span', { style: 'display:flex;align-items:center;gap:14px' }, count, send)),
    );
  }, { label: 'Release a lantern' });
}

// ───────────────────────── move my light ─────────────────────────

function openMove() {
  stopDrift();
  modal((close) => {
    const input = h('input', { type: 'search', placeholder: 'Search a city or country', 'aria-label': 'Search places', autocomplete: 'off', 'data-autofocus': true });
    const list = h('div', { class: 'places', role: 'listbox' });
    const choose = (p: Place) => {
      store.set('onesky.tz', p.tz);
      me = buildMe(p);
      sunCache = null;
      renderYou(); refreshLights(); renderRing(false);
      void sky.move(me);
      void globe.flyTo(me.lat, me.lon, undefined, 1600);
      close();
      feed(rich(['Your light moved to ', { b: p.city }]));
    };
    const paint = () => {
      const q = input.value.trim();
      const home = placeForTimeZone(browserTz);
      const res = q ? searchPlaces(q, 8) : [home, ...['Asia/Tokyo', 'Africa/Nairobi', 'America/Sao_Paulo', 'Europe/Paris', 'Australia/Sydney', 'America/Chicago'].map((t) => placeForTimeZone(t)).filter((x) => x.tz !== home.tz).slice(0, 5)];
      list.classList.toggle('has-query', !!q);
      list.replaceChildren(...res.map((p, i) => {
        const b = h('button', { role: 'option' }, h('span', {}, p.city), h('small', {}, !q && i === 0 ? 'where your clock says you are' : p.country));
        b.addEventListener('click', () => choose(p));
        return b;
      }));
      if (!res.length) list.append(h('p', { class: 'fine', style: 'padding:12px' }, 'No place by that name among the world’s time zones.'));
    };
    input.addEventListener('input', paint);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') (list.querySelector('button') as HTMLElement | null)?.click(); });
    paint();
    return h('div', {},
      h('p', { class: 'eyebrow' }, 'Move my light'),
      h('h2', {}, 'Where on Earth are you?'),
      h('p', {}, `One Sky placed you from your clock, near ${me.city}. It never asks for your real location. Choose another of ${PLACES.length} places if that’s wrong.`),
      input, list,
    );
  }, { label: 'Move my light' });
}

// ───────────────────────── about ─────────────────────────

function openAbout() {
  stopDrift();
  modal(() => h('div', {},
    h('p', { class: 'eyebrow' }, 'About'),
    h('h2', {}, 'Everyone under one sky'),
    h('p', {}, 'This is the Earth as it is this minute: the sun is where the sun is, the night is where the night is. Every bright light is a person with this page open right now.'),
    h('div', { class: 'about-list' },
      h('div', {}, h('i', { class: 'a' }), h('p', {}, h('strong', {}, 'A light'), ' is someone here now. Tap one to see their time and sky, and wave.')),
      h('div', {}, h('i', { class: 'd' }), h('p', {}, h('strong', {}, 'A thread'), ' appears when two people wave at each other. It stays for everyone to see.')),
      h('div', {}, h('i', { class: 'c' }), h('p', {}, h('strong', {}, 'A lantern'), ' is one answer to today’s question. It floats over where it was written for 48 hours. Warm the ones you like.')),
      h('div', {}, h('i', { class: 'e' }), h('p', {}, h('strong', {}, 'The ring'), ' has 24 parts, one per time zone. Each lights when someone from there arrives. It resets at midnight UTC.')),
      h('div', {}, h('i', { class: 'b' }), h('p', {}, h('strong', {}, 'An echo'), ' is someone who was here in the last two days and has gone. Leave them a wave; they get it when they come back. ', h('strong', {}, 'A soft ring'), ' on the ground is where someone else is looking right now.')),
    ),
    h('p', {}, h('strong', {}, 'Privacy.'), ' No account, no name, no tracking. Your light sits near the main city of your time zone — taken from your device’s clock, not your location — and you can move it. Lanterns are public and anonymous.'),
    h('p', { class: 'fine' }, 'Nobody on this globe is simulated. Earth imagery: NASA Blue Marble and Black Marble. Drag to turn, scroll or pinch to zoom. Keyboard: arrows turn, + and − zoom, [ and ] step through lights and lanterns, Enter acts, R sends a ripple, D watches a day pass.'),
  ), { label: 'About One Sky' });
}

// ───────────────────────── postcard ─────────────────────────

async function openPostcard() {
  stopDrift();
  const shot = globe.capture();
  const url = await makePostcard(shot, {
    place: me.city, lights: liveCount(), zones: zonesLit.size, threads: stats.threads_total, km: stats.km_total, question: question.text,
  });
  modal(() => {
    const img = h('img', { class: 'postcard-img', src: url, alt: 'A postcard of the Earth as you see it now' });
    const save = h('a', { class: 'btn primary', href: url, download: `one-sky-${today}.png` }, 'Save image');
    const row = h('div', { class: 'row' }, h('span', { class: 'fine' }, 'The Earth as you saw it, just now.'), h('div', { class: 'actions', style: 'display:flex;gap:8px' }));
    const actions = row.lastElementChild!;
    const link = location.href.split('#')[0];
    const copy = h('button', { class: 'btn ghost' }, 'Copy invite link');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); copy.textContent = 'Link copied'; } catch { copy.textContent = link; }
    });
    actions.append(copy, save);
    return h('div', {}, h('p', { class: 'eyebrow' }, 'Postcard'), h('h2', {}, 'Send someone the sky'), img, row);
  }, { label: 'Postcard' });
}

// ───────────────────────── net events ─────────────────────────

function wireSky() {
  sky.knownLantern = (id) => lanterns.has(id);
  sky.on('status', (online) => {
    $('offline').hidden = online || !entered;
    if (online && droppedOnce && worldLoaded) void resync();
    if (!online) droppedOnce = true;
  });

  sky.on('people', (_all, joined, left) => {
    refreshLights();
    if (entered) {
      for (const p of joined.slice(0, 4)) {
        if (p.id === sky.uid) continue;
        audio.lightJoined(p.lon);
        feed(rich(['A light appeared in ', { b: p.city }, ` · ${localTimeString(p.tz)} there`]));
      }
      left.forEach((p, i) => {
        if (p.id === sky.uid) return;
        globe.dropGaze(p.id);
        if (i < 4) feed(rich(['The light in ', { b: p.city }, ' went out']), true);
        // they become an echo straight away
        const known = echoes.find((x) => Math.abs(x.lat - p.lat) < 0.002 && Math.abs(x.lon - p.lon) < 0.002);
        if (known) known.last_seen = new Date().toISOString();
        else echoes.unshift({ lat: p.lat, lon: p.lon, place: p.city, last_seen: new Date().toISOString() });
      });
      if (echoes.length > 400) echoes.length = 400;
      if (left.length) refreshLights();
    }
    for (const p of left) { wavedBy.delete(p.id); wavedAt.delete(p.id); }
    if (selection?.type === 'light' && !selection.id.startsWith('echo:') && !sky.people.has(selection.id)) closeCard();
    updateArrivalCount();
  });

  sky.on('gaze', (g) => { if (g.id !== sky.uid && sky.people.has(g.id)) globe.setGazes([g]); });

  sky.on('wave', (w) => {
    const toMe = w.to === sky.uid && entered;
    if (!toMe && !w.target) return;
    const from = w.from;
    const { landed } = globe.wave({ lat: from.lat, lon: from.lon }, toMe ? me : w.target!);
    if (!toMe) return;
    wavedBy.set(from.id, Date.now());
    // if this tab is in the background, say so in the tab title until they come back
    if (document.hidden) document.title = `● Someone in ${from.city} waved at you`;
    void landed.then(() => {
      audio.waveIn(from.lon);
      if (selection?.id === from.id) renderCard();
      toast(
        rich([{ b: `Someone in ${from.city} waved at you.` }, { small: `It is ${localTimeString(from.tz)} there · ${formatKm(greatCircleKm(me.lat, me.lon, from.lat, from.lon))} away` }]),
        { ms: 14000, action: { label: 'Wave back', run: () => { const p = sky.people.get(from.id); if (p) { select({ type: 'light', id: p.id }); void doWave(p); } else toast(rich([`The light in ${from.city} has gone out. Their echo stays for two days.`]), { plain: true }); } } },
      );
    });
  });

  // Threads only ever come from the database. If one ends where I am, ask the server whether it is mine.
  sky.on('thread', (t) => {
    if (threads.has(t.id)) return;
    const near = (lat: number, lon: number) => Math.abs(lat - me.lat) < 0.005 && Math.abs(lon - me.lon) < 0.005;
    const maybeMine = entered && (near(t.a_lat, t.a_lon) || near(t.b_lat, t.b_lon));
    setTimeout(async () => {
      if (threads.has(t.id)) return;
      if (maybeMine) {
        const mk = await sky.marks().catch(() => null);
        if (threads.has(t.id)) return;
        if (mk?.threads.includes(t.id)) {
          marks.threads.add(t.id);
          addThread(t, true, { mine: true, other: near(t.a_lat, t.a_lon) ? t.b_place : t.a_place });
          return;
        }
      }
      addThread(t, true);
    }, 2000);
  });

  sky.on('ripple', (from) => {
    if (!entered) return;
    globe.ripple(from.lat, from.lon);
    audio.ringSegment(Math.round(((from.lon + 180) / 360) * 23));
    feed(rich(['A ripple from ', { b: from.city }]));
  });

  sky.on('lantern', (l, fresh) => {
    const known = lanterns.has(l.id);
    const before = lanterns.get(l.id)?.warmth ?? 0;
    lanterns.set(l.id, l);
    if (!fresh && entered && marks.lanterns.has(l.id) && l.warmth > before) {
      // someone, somewhere, just warmed what I wrote
      audio.warm();
      feed(rich(['Someone just warmed ', { b: 'your lantern' }]));
      store.set('onesky.warmthSeen', String(Number(store.get('onesky.warmthSeen') ?? 0) + (l.warmth - before)));
    }
    refreshLanterns();
    if (fresh && !known && entered && !marks.lanterns.has(l.id)) feed(rich(['A lantern rose over ', { b: l.place }]));
    if (selection?.type === 'lantern' && selection.id === l.id && !fresh) repaintLantern?.();
  });
  sky.on('lanternHidden', (id) => {
    lanterns.delete(id); refreshLanterns();
    if (selection?.type === 'lantern' && selection.id === id) closeCard();
  });
  sky.on('zone', (z) => lightZone(z, true));
}

async function loadWorld() {
  const [ls, ts, es, zs, st, mk] = await Promise.all([sky.lanterns(), sky.threads(), sky.echoes(), sky.zones(today), sky.stats(), sky.marks()]);
  mk.lanterns.forEach((x) => marks.lanterns.add(x)); mk.warmed.forEach((x) => marks.warmed.add(x)); mk.threads.forEach((x) => marks.threads.add(x));
  for (const l of ls) lanterns.set(l.id, l);
  for (const t of ts.reverse()) { if (!threads.has(t.id)) { threads.set(t.id, t); globe.addThread(t.id, { lat: t.a_lat, lon: t.a_lon }, { lat: t.b_lat, lon: t.b_lon }, false); } }
  if (es) echoes = es;
  if (st) stats = st;
  for (const z of zs) zonesLit.set(z.zone, z);
  ringWasComplete = zonesLit.size === 24;
  refreshLanterns(); refreshLights(); renderStats(); renderRing(false);
}

let worldLoaded = false;
let droppedOnce = false;
/** After a reconnect or a long sleep, fetch whatever happened while we were away. */
async function resync() {
  try {
    const [ls, ts, zs] = await Promise.all([sky.lanterns(), sky.threads(), sky.zones(today)]);
    for (const l of ls) lanterns.set(l.id, l);
    for (const t of ts.reverse()) addThread(t, false);
    for (const z of zs) lightZone(z, false);
    refreshLanterns();
    void refreshWorld();
  } catch { /* still offline; the next reconnect tries again */ }
}

/** Connect and load the world; keep trying with backoff if the network or sign-in fails. */
async function bringUp(attempt = 0): Promise<void> {
  try {
    await sky.connect();
    if (!worldLoaded) { await loadWorld(); worldLoaded = true; }
    updateArrivalCount(); renderCensus();
  } catch (e) {
    console.warn('One Sky is offline', e);
    if (!entered) $('arrival-eyebrow').textContent = 'The sky is out of reach right now — you can still look.';
    setTimeout(() => void bringUp(attempt + 1), Math.min(30000, 2000 * 2 ** attempt));
  }
}

async function refreshWorld() {
  if (!sky.uid || document.hidden) return;
  const [st, es] = await Promise.all([sky.stats(), sky.echoes()]).catch(() => [null, null] as const);
  if (st) { stats = st; renderStats(); }
  if (es) { echoes = es; if (selection?.id.startsWith('echo:') && !echoById(selection.id)) closeCard(); refreshLights(); }
  // drop lanterns that have drifted past 48 hours
  const cutoff = Date.now() - 48 * 3600 * 1000;
  let dropped = false;
  for (const [id, l] of lanterns) if (!l.seeded && Date.parse(l.created_at) < cutoff) { lanterns.delete(id); dropped = true; if (selection?.id === id) closeCard(); }
  if (dropped) refreshLanterns();
}

function rollDay(force?: string) {
  const d = force ?? utcDay();
  if (d <= today) return;
  today = d; question = questionForDay(d);
  $('ask-q').textContent = question.text;
  zonesLit.clear(); ringWasComplete = false; renderRing(false);
  // whoever rolled over before us may already have lit zones for the new day
  void sky.zones(today).then((zs) => zs.forEach((z) => lightZone(z, false))).catch(() => {});
  if (entered) { void sky.checkIn(); feed(rich(['A new day began in UTC. The ring starts again.']), true); }
}

/** On arrival: play back the waves people left for my echo while I was away. */
async function receiveEchoWaves() {
  const waves = await sky.collectEchoWaves().catch(() => []);
  if (!waves.length) return;
  waves.slice(0, 6).forEach((w, i) => setTimeout(() => {
    const { landed } = globe.wave({ lat: w.lat, lon: w.lon }, me);
    void landed.then(() => audio.waveIn(w.lon));
  }, i * 700));
  const first = waves[0];
  const others2 = waves.length - 1;
  toast(rich([
    { b: waves.length === 1 ? `While you were away, someone in ${first.place} waved at you.` : `While you were away, ${waves.length} people waved at you.` },
    { small: waves.length === 1 ? `${relativeTime(first.created_at)} · they left it with your echo` : `${first.place}${others2 === 1 ? ' and one other place' : ` and ${others2} other places`} · left with your echo` },
  ]), { ms: 14000 });
}

/** On return: has anyone warmed my lanterns since I last looked? */
function tellWarmthSinceLastVisit() {
  let total = 0, n = 0, where = '';
  for (const id of marks.lanterns) { const l = lanterns.get(id); if (l) { total += l.warmth; n++; where = l.place; } }
  const seen = Number(store.get('onesky.warmthSeen') ?? 0);
  store.set('onesky.warmthSeen', String(total));
  const gained = total - seen;
  if (n === 0 || gained <= 0) return;
  toast(rich([
    { b: n === 1 ? `Your lantern over ${where} was warmed ${gained === 1 ? 'once' : `${gained} times`} while you were away.` : `Your lanterns were warmed ${gained === 1 ? 'once' : `${gained} times`} while you were away.` },
    { small: 'Someone, somewhere, read what you wrote.' },
  ]), { ms: 10000 });
}

// ───────────────────────── arrival ─────────────────────────

function updateArrivalCount() {
  const el = $('arrival-eyebrow');
  if (entered) return;
  const n = others().length;
  el.replaceChildren();
  if (!sky.uid) { el.textContent = 'Looking for the others…'; return; }
  if (n > 0) { el.append(h('b', {}, `${n} ${n === 1 ? 'person is' : 'people are'}`), ' here right now'); return; }
  if (stats.lights_48h >= 25) { el.append(h('b', {}, `${stats.lights_48h.toLocaleString('en-US')} people`), ' have been here in the last two days'); return; }
  // a quiet sky: say something true about the planet instead of a small number
  const hz = horizonPlace();
  el.append(`It is ${localTimeString(me.tz)} in ${me.city}`);
  if (hz) el.append(' · ', h('b', {}, hz.rising ? `the sun is rising over ${hz.place.city}` : `night is falling in ${hz.place.city}`));
}

function interlude(node: Node) {
  const box = h('div', { class: 'interlude' }, h('p', {}, node));
  document.body.append(box);
  setTimeout(() => box.remove(), 5400);
}

async function enter() {
  if (entered) return;
  $('btn-enter').setAttribute('disabled', '');
  void audio.start();
  audio.muted = store.get('onesky.muted') === '1';
  $('btn-sound').setAttribute('aria-pressed', String(!audio.muted));
  $('arrival').classList.add('is-gone');
  globe.revealAll();
  const flight = globe.flyTo(Math.max(-70, Math.min(70, me.lat + (me.lat >= 0 ? 9 : -9))), me.lon, globe.homeDist(), reducedMotion ? 300 : 5600);

  const settled = Promise.race([(window as any).__onesky.firstContact as Promise<void>, new Promise((r) => setTimeout(r, 2500))]);
  setTimeout(() => void settled.then(() => {
    const n = others().length + 1;
    const before = stats.lights_48h;
    if (n > 1) interlude(rich(['You are one of ', { em: `${n} lights` }, ' under one sky.']));
    else if (!sky.uid) interlude(rich(['The Earth, ', { em: 'as it is right now.' }]));
    else if (before >= 25) interlude(rich(['Right now, yours is ', { em: 'the only light.' }, ` ${before.toLocaleString('en-US')} have passed through in two days.`]));
    else interlude(rich(['Right now, yours is ', { em: 'the only light' }, ' under this sky.']));
  }), reducedMotion ? 0 : 900);

  setTimeout(() => {
    entered = true;
    refreshLights();
    audio.arrive();
    void sky.appear(me).catch(() => {});
    $('offline').hidden = sky.online;
  }, reducedMotion ? 0 : 3000);

  await flight;
  $('app').classList.remove('is-hidden');
  globe.canvas.focus({ preventScroll: true });
  setTimeout(tellWarmthSinceLastVisit, 4200);
  setTimeout(() => void receiveEchoWaves(), 2200);
  if (!store.get('onesky.seen')) {
    store.set('onesky.seen', '1');
    setTimeout(() => {
      const n = others().length;
      toast(
        rich([n > 0 ? 'Tap a light to see who is awake — and wave.' : echoes.length ? 'The blue lights are echoes of earlier visitors. Tap one to leave a wave.' : 'Tap anywhere on Earth for its time and sky.', { small: 'Drag to turn. Scroll or pinch to come closer.' }]),
        { plain: true, ms: 12000, action: lanterns.size ? { label: 'Drift through the lanterns', run: startDrift } : undefined },
      );
    }, 1600);
  }
}

// ───────────────────────── boot ─────────────────────────

function boot() {
  const canvas = $('sky') as unknown as HTMLCanvasElement;
  try {
    globe = new Globe(canvas, { lowPower, reducedMotion, fixedQuality: /[?&]hq/.test(location.search) });
  } catch (e) {
    console.error(e);
    document.body.append(h('div', { class: 'fallback' }, h('div', {}, h('h1', {}, 'One Sky'), h('p', {}, 'This device couldn’t draw the Earth (WebGL is unavailable). Try another browser, or turn on hardware acceleration.'))));
    $('arrival').remove();
    return;
  }
  (window as any).__onesky = { globe, sky, get me() { return me; }, get entered() { return entered; }, get echoes() { return echoes; }, echoKey, lanterns, threads, select };
  canvas.tabIndex = 0;
  globe.prepareIntro(me.lat, me.lon);
  const fitMobile = () => globe.setYShift(Math.round(innerHeight * (innerWidth <= 1000 ? 0.075 : 0.035)));
  fitMobile(); addEventListener('resize', fitMobile);

  $('arrival-place').textContent = me.city;
  $('ask-q').textContent = question.text;
  buildRingStrip(); renderYou(); renderCensus(); updateArrivalCount();

  globe.onFrame(updateLabels);
  globe.onTap = (pick, ev) => {
    if (!entered || isModalOpen()) return;
    const hadSelection = !!selection;
    select(pick);
    if (!pick && !hadSelection) {
      const mine = globe.project(me.lat, me.lon);
      if (mine.visible && Math.hypot(mine.x - ev.x, mine.y - ev.y) < 30) doRipple(); else showSpot(ev.x, ev.y);
    } else spot = null;
  };
  globe.onHover = (pick, ev) => {
    const tip = $('tip');
    canvas.classList.toggle('is-point', !!pick && entered);
    if (!pick || !entered) { tip.hidden = true; return; }
    tip.replaceChildren();
    if (pick.type === 'lantern') {
      const l = lanterns.get(pick.id); if (!l) { tip.hidden = true; return; }
      tip.append(`“${l.body}”`, h('small', {}, `a lantern over ${l.place}`));
    } else if (pick.id.startsWith('echo:')) {
      const e = echoById(pick.id); if (!e) { tip.hidden = true; return; }
      tip.append(e.place, h('small', {}, `an echo · here ${relativeTime(e.last_seen)}`));
    } else {
      const p = sky.people.get(pick.id); if (!p) { tip.hidden = true; return; }
      tip.append(placeLine(p.city, p.country), h('small', {}, `${skyLine(p.lat, p.lon, p.tz)} · click to wave`));
    }
    tip.style.left = `${ev.x}px`; tip.style.top = `${ev.y}px`; tip.hidden = false;
  };
  canvas.addEventListener('pointerdown', () => { canvas.classList.add('is-drag'); $('tip').hidden = true; });
  addEventListener('pointerup', () => canvas.classList.remove('is-drag'));
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') globe.nudge(-6, 0); else if (k === 'ArrowRight') globe.nudge(6, 0);
    else if (k === 'ArrowUp') globe.nudge(0, 5); else if (k === 'ArrowDown') globe.nudge(0, -5);
    else if (k === '+' || k === '=') globe.zoom(0.88); else if (k === '-' || k === '_') globe.zoom(1.14);
    else if (k === 'r' || k === 'R') doRipple();
    else if (k === 'd' || k === 'D') watchDay();
    else if (k === ']' || k === '[') {
      if (!entered) return;
      const stops: Pick[] = [
        ...others().sort((a, b) => a.lon - b.lon).map((p) => ({ type: 'light' as const, id: p.id })),
        ...[...lanterns.values()].sort((a, b) => a.lon - b.lon).map((l) => ({ type: 'lantern' as const, id: l.id })),
      ];
      if (!stops.length) return;
      const at = stops.findIndex((x) => x.id === selection?.id);
      const next = at < 0 ? 0 : (at + (k === ']' ? 1 : -1) + stops.length) % stops.length;
      stopDrift();
      select(stops[next]);
    }
    else if (k === 'Enter') { const b = card.querySelector<HTMLElement>('.btn'); if (!card.hidden && b) b.focus(); else return; }
    else if (k === 'Escape') { stopDrift(); closeCard(); } else return;
    e.preventDefault();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !isModalOpen()) closeCard(); });

  $('btn-enter').addEventListener('click', () => void enter());
  $('btn-lantern').addEventListener('click', () => { stopDrift(); openComposer(); });
  $('btn-ripple').addEventListener('click', doRipple);
  $('btn-day').addEventListener('click', watchDay);
  $('btn-drift').addEventListener('click', () => { if (drift) { stopDrift(); closeCard(); } else startDrift(); });
  canvas.addEventListener('pointerdown', stopDrift);
  canvas.addEventListener('wheel', stopDrift, { passive: true });
  setInterval(sunNews, 70000);
  setTimeout(sunNews, 26000);
  $('btn-move').addEventListener('click', openMove);
  $('btn-about').addEventListener('click', openAbout);
  $('btn-postcard').addEventListener('click', () => void openPostcard());
  $('btn-sound').addEventListener('click', () => {
    audio.muted = !audio.muted;
    store.set('onesky.muted', audio.muted ? '1' : '0');
    $('btn-sound').setAttribute('aria-pressed', String(!audio.muted));
  });
  const baseTitle = document.title;
  document.addEventListener('visibilitychange', () => { if (document.hidden) audio.suspend(); else { document.title = baseTitle; audio.resume(); if (worldLoaded) void resync(); } });

  // The button unlocks as soon as the Earth can be drawn; the network may still be arriving.
  void globe.ready.then(() => $('btn-enter').removeAttribute('disabled'), () => $('btn-enter').removeAttribute('disabled'));

  wireSky();
  const firstContact = bringUp();
  addEventListener('online', () => { if (!sky.uid) void bringUp(); });
  (window as any).__onesky.firstContact = firstContact;

  // slow clocks
  setInterval(() => { renderYou(); rollDay(); if (selection && selection.type === 'light' && !selection.id.startsWith('echo:')) { /* keep their time fresh */ const b = card.querySelector('.facts dd'); const p = sky.people.get(selection.id); if (b && p) { const t = localTimeString(p.tz); if (b.textContent !== t) b.textContent = t; } } }, 15000);
  setInterval(() => void refreshWorld(), 90000);
  setInterval(() => { if (entered) void sky.checkIn().catch(() => {}); }, 10 * 60 * 1000);

  // share where I am looking, a few times a second, only when it changes
  let lastGaze = { lat: 999, lon: 999 };
  setInterval(() => {
    if (!entered || document.hidden || others().length === 0) return;
    const g = globe.gaze();
    if (Math.abs(g.lat - lastGaze.lat) + Math.abs(g.lon - lastGaze.lon) < 0.6) return;
    lastGaze = g;
    sky.sendGaze(g.lat, g.lon);
  }, 280);
}

boot();

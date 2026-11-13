import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/hanken-grotesk';
import './styles.css';

import { Globe, type LightDot, type Pick } from './globe/globe';
import { Sky, type Person, type Lantern, type Thread, type Echo, type ZoneDay, type Stats, type Me } from './net/sky';
import { AudioEngine } from './audio/engine';
import { placeForTimeZone, placeForOffset, searchPlaces, jitter, PLACES, type Place } from './lib/tz';
import { localTimeString, zoneIndex, zoneLabel, utcDay, relativeTime } from './lib/time';
import { skyState } from './lib/sun';
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
  echoes.forEach((e, i) => {
    if (taken.some((t) => Math.abs(t.lat - e.lat) < 0.02 && Math.abs(t.lon - e.lon) < 0.02)) return;
    dots.push({ id: `echo:${i}`, lat: e.lat, lon: e.lon, kind: 'echo', age: (now - Date.parse(e.last_seen)) / 3600000 });
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
  el.replaceChildren();
  if (!sky.uid) { el.textContent = 'Finding the others…'; return; }
  const live = n === 0 ? 'No lights awake yet' : n === 1 ? (entered ? 'You are the only light awake' : '1 light awake') : `${n} lights awake`;
  el.append(h('b', {}, live));
  if (stats.lights_48h > 0) el.append(` · ${stats.lights_48h.toLocaleString('en-US')} in the last two days`);
}

function renderYou() {
  $('you-place').textContent = placeLine(me.city, me.country);
  $('you-time').textContent = skyLine(me.lat, me.lon, me.tz);
}

function renderStats() {
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
      ? `${zoneLabel(z)} · lit by ${lit.place}${z === me.zone ? ' — your zone' : ''}`
      : `${zoneLabel(z)} · still dark. Know someone near ${zoneCity(z)}?`;
    return;
  }
  const dark = RING_ORDER.filter((x) => !zonesLit.has(x));
  if (dark.length === 0) el.textContent = 'The ring is closed. Every time zone showed up today.';
  else if (dark.length === 24) el.textContent = 'A new day. Nobody has lit the ring yet.';
  else {
    const names = dark.sort((a, b) => Math.abs(a - 12) - Math.abs(b - 12)).slice(0, 3).map(zoneCity);
    el.textContent = `Still dark near ${names.join(', ')}`;
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

function lightZone(z: ZoneDay, announce: boolean) {
  if (z.day !== today || zonesLit.has(z.zone)) return;
  zonesLit.set(z.zone, z);
  renderRing(announce);
  if (announce && entered) {
    audio.ringSegment(zonesLit.size - 1);
    if (z.zone === me.zone) feed(rich(['You lit ', { b: zoneLabel(z.zone) }, ' for the world today']));
    else feed(rich([{ b: zoneLabel(z.zone) }, ` is lit — first light from ${z.place}`]));
  }
}

// ───────────────────────── labels ─────────────────────────

const labelLayer = $('labels');
const selfLabel = h('div', { class: 'label self off' }, 'you');
const reticle = h('div', { class: 'reticle off' });
labelLayer.append(reticle, selfLabel);
const liveLabels = new Map<string, HTMLElement>();

function place(el: HTMLElement, s: { x: number; y: number; visible: boolean }, show: boolean) {
  el.classList.toggle('off', !(show && s.visible));
  el.style.transform = `translate(${s.x.toFixed(1)}px, ${(s.y - 8).toFixed(1)}px)`;
}

function updateLabels() {
  place(selfLabel, globe.project(me.lat, me.lon), entered);
  const people = others();
  const show = people.length <= 14;
  const seen = new Set<string>();
  for (const p of people) {
    seen.add(p.id);
    let el = liveLabels.get(p.id);
    if (!el) { el = h('div', { class: 'label off' }, p.city); liveLabels.set(p.id, el); labelLayer.append(el); }
    if (el.textContent !== p.city) el.textContent = p.city;
    place(el, globe.project(p.lat, p.lon), show && entered);
  }
  for (const [id, el] of liveLabels) if (!seen.has(id)) { el.remove(); liveLabels.delete(id); }

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
  if (selection.id.startsWith('echo:')) return echoes[Number(selection.id.slice(5))] ?? null;
  return sky.people.get(selection.id) ?? null;
}

// ───────────────────────── card ─────────────────────────

const card = $('card');
function closeCard() { selection = null; card.hidden = true; card.replaceChildren(); globe.autoRotate = true; }

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
  card.replaceChildren(h('button', { class: 'card-close', 'aria-label': 'Close', onclick: closeCard }, '×'));
  if (selection.type === 'lantern') renderLanternCard(selection.id);
  else if (selection.id.startsWith('echo:')) renderEchoCard(Number(selection.id.slice(5)));
  else renderPersonCard(selection.id);
  card.hidden = false;
  // restart the entrance animation
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
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
  card.append(
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

function renderEchoCard(i: number) {
  const e = echoes[i];
  if (!e) { closeCard(); return; }
  card.append(
    h('p', { class: 'eyebrow' }, 'An echo'),
    h('h2', {}, e.place),
    h('p', { class: 'sub' }, `Someone was here ${relativeTime(e.last_seen)}.`),
    h('p', { class: 'note' }, 'They have gone, so you can’t wave. Their light lingers for two days — a lantern you release now may be here when they come back.'),
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
    const tb = h('button', { class: 'btn ghost small' }, 'Translate');
    tb.addEventListener('click', async () => {
      tb.setAttribute('disabled', ''); tb.textContent = 'Translating…';
      const out = await translate(l.body);
      translated.hidden = false;
      translated.textContent = out ?? 'Already in your language, or no translation is available on this device.';
      tb.remove();
    });
    actions.append(tb);
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
    h('p', { class: 'eyebrow' }, mine ? 'Your lantern' : l.seeded ? 'A lantern from One Sky' : 'A lantern'),
    h('p', { class: 'sub' }, `over ${l.place} · ${localTimeString(l.tz)} there now`),
    ...(q ? [h('p', { class: 'q', style: 'margin-top:14px' }, q.text)] : []),
    body, translated, actions, tiny,
  );
  audio.lanternOpen();
}

async function translate(text: string): Promise<string | null> {
  try {
    const T = (self as any).Translator, D = (self as any).LanguageDetector;
    const det = await D.create();
    const res = await det.detect(text);
    const src = res?.[0]?.detectedLanguage;
    const tgt = (navigator.language || 'en').split('-')[0];
    if (!src || src === 'und' || src === tgt) return null;
    const tr = await T.create({ sourceLanguage: src, targetLanguage: tgt });
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
  if (selection?.id === p.id) { renderCard(); setTimeout(() => { if (selection?.id === p.id) renderCard(); }, 8100); }
  try {
    const t = await sky.wave(p);
    await landed;
    if (t) { marks.threads.add(t.id); addThread(t, true, { mine: true, other: p.city }); }
    else feed(rich(['Your wave reached ', { b: p.city }]));
  } catch (e: any) {
    if (String(e?.message).includes('rate_limited')) toast(rich(['That’s a lot of waving. Give it a minute.']), { plain: true });
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
    toast(rich([{ b: `You and someone in ${opts.other} are threaded.` }, { small: `${formatKm(t.km)} of light between you. It stays on the Earth for everyone to see.` }]), { ms: 9000 });
  } else if (entered) {
    feed(rich([{ b: t.a_place }, ' and ', { b: t.b_place }, ` are threaded · ${formatKm(t.km)}`]));
  }
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
    const count = h('span', { class: 'count' }, String(MAX_LANTERN_LENGTH));
    const err = h('p', { class: 'err', role: 'alert' });
    const send = h('button', { class: 'btn primary', disabled: true }, 'Release');
    const sync = () => {
      const left = MAX_LANTERN_LENGTH - [...ta.value].length;
      count.textContent = String(left);
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
      h('div', { class: 'row' }, h('span', { class: 'fine' }, `Rises over ${me.city} · stays 48 hours · `, count), send),
    );
  }, { label: 'Release a lantern' });
}

// ───────────────────────── move my light ─────────────────────────

function openMove() {
  modal((close) => {
    const input = h('input', { type: 'search', placeholder: 'Search a city or country', 'aria-label': 'Search places', autocomplete: 'off', 'data-autofocus': true });
    const list = h('div', { class: 'places', role: 'listbox' });
    const choose = (p: Place) => {
      store.set('onesky.tz', p.tz);
      me = buildMe(p);
      renderYou(); refreshLights(); renderRing(false);
      void sky.move(me);
      void globe.flyTo(me.lat, me.lon, undefined, 1600);
      close();
      feed(rich(['Your light moved to ', { b: p.city }]));
    };
    const paint = () => {
      const q = input.value.trim();
      const res = q ? searchPlaces(q, 8) : [placeForTimeZone(browserTz), ...['Asia/Tokyo', 'Africa/Nairobi', 'America/Sao_Paulo', 'Europe/Paris', 'Australia/Sydney'].map((t) => placeForTimeZone(t))];
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
  modal(() => h('div', {},
    h('p', { class: 'eyebrow' }, 'About'),
    h('h2', {}, 'Everyone under one sky'),
    h('p', {}, 'This is the Earth as it is this minute: the sun is where the sun is, the night is where the night is. Every bright light is a person with this page open right now.'),
    h('div', { class: 'about-list' },
      h('div', {}, h('i', { class: 'a' }), h('p', {}, h('strong', {}, 'A light'), ' is someone here now. Tap one to see their time and sky, and wave.')),
      h('div', {}, h('i', { class: 'd' }), h('p', {}, h('strong', {}, 'A thread'), ' appears when two people wave at each other. It stays for everyone to see.')),
      h('div', {}, h('i', { class: 'c' }), h('p', {}, h('strong', {}, 'A lantern'), ' is one answer to today’s question. It floats over where it was written for 48 hours. Warm the ones you like.')),
      h('div', {}, h('i', { class: 'e' }), h('p', {}, h('strong', {}, 'The ring'), ' has 24 parts, one per time zone. Each lights when someone from there arrives. It resets at midnight UTC.')),
      h('div', {}, h('i', { class: 'b' }), h('p', {}, h('strong', {}, 'An echo'), ' is someone who was here in the last two days and has gone.')),
    ),
    h('p', {}, h('strong', {}, 'Privacy.'), ' No account, no name, no tracking. Your light sits near the main city of your time zone — taken from your device’s clock, not your location — and you can move it. Lanterns are public and anonymous.'),
    h('p', { class: 'fine' }, 'Nobody on this globe is simulated. Earth imagery: NASA Blue Marble and Black Marble. Drag to turn, scroll or pinch to zoom, arrow keys work too.'),
  ), { label: 'About One Sky' });
}

// ───────────────────────── postcard ─────────────────────────

async function openPostcard() {
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
  sky.on('status', (online) => { $('offline').hidden = online || !entered; });

  sky.on('people', (_all, joined, left) => {
    refreshLights();
    if (entered) {
      for (const p of joined) {
        if (p.id === sky.uid) continue;
        audio.lightJoined(p.lon);
        feed(rich(['A light appeared in ', { b: p.city }, ` · ${localTimeString(p.tz)} there`]));
      }
      for (const p of left) {
        if (p.id === sky.uid) continue;
        globe.dropGaze(p.id);
        feed(rich(['The light in ', { b: p.city }, ' went out']), true);
        // they become an echo straight away
        echoes.unshift({ lat: p.lat, lon: p.lon, place: p.city, last_seen: new Date().toISOString() });
      }
      if (left.length) { if (selection?.id.startsWith('echo:')) closeCard(); refreshLights(); }
    }
    if (selection?.type === 'light' && !selection.id.startsWith('echo:') && !sky.people.has(selection.id)) closeCard();
    updateArrivalCount();
  });

  sky.on('gaze', (g) => { if (g.id !== sky.uid && sky.people.has(g.id)) globe.setGazes([g]); });

  sky.on('wave', (w) => {
    if (w.from === sky.uid) return;
    const toMe = w.to === sky.uid && entered;
    const { landed } = globe.wave({ lat: w.lat, lon: w.lon }, toMe ? me : { lat: w.tlat, lon: w.tlon });
    if (!toMe) return;
    wavedBy.set(w.from, Date.now());
    void landed.then(() => {
      audio.waveIn(w.lon);
      const p = sky.people.get(w.from);
      if (selection?.id === w.from) renderCard();
      toast(
        rich([{ b: `Someone in ${w.city} waved at you.` }, { small: `It is ${localTimeString(w.tz)} there · ${formatKm(greatCircleKm(me.lat, me.lon, w.lat, w.lon))} away` }]),
        { ms: 14000, action: p ? { label: 'Wave back', run: () => { select({ type: 'light', id: p.id }); void doWave(p); } } : undefined },
      );
    });
  });

  sky.on('thread', (t, msg) => {
    if (msg && sky.uid && (msg.a === sky.uid || msg.b === sky.uid)) {
      if (msg.b === sky.uid) return; // I created it; handled where the wave resolved
      marks.threads.add(t.id);
      // let the other person's arc land first
      setTimeout(() => addThread(t, true, { mine: true, other: t.b_place }), 1800);
      return;
    }
    setTimeout(() => addThread(t, true), msg ? 1800 : 2400);
  });

  sky.on('lantern', (l, fresh) => {
    const known = lanterns.has(l.id);
    lanterns.set(l.id, l);
    refreshLanterns();
    if (fresh && !known && entered && !marks.lanterns.has(l.id)) feed(rich(['A lantern rose over ', { b: l.place }]));
    if (selection?.type === 'lantern' && selection.id === l.id && !fresh) renderCard();
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
  echoes = es;
  if (st) stats = st;
  for (const z of zs) zonesLit.set(z.zone, z);
  ringWasComplete = zonesLit.size === 24;
  refreshLanterns(); refreshLights(); renderStats(); renderRing(false);
}

async function refreshWorld() {
  if (!sky.uid || document.hidden) return;
  const [st, es] = await Promise.all([sky.stats(), sky.echoes()]).catch(() => [null, null] as const);
  if (st) { stats = st; renderStats(); }
  if (es) { echoes = es; if (selection?.id.startsWith('echo:')) closeCard(); refreshLights(); }
  // drop lanterns that have drifted past 48 hours
  const cutoff = Date.now() - 48 * 3600 * 1000;
  let dropped = false;
  for (const [id, l] of lanterns) if (!l.seeded && Date.parse(l.created_at) < cutoff) { lanterns.delete(id); dropped = true; }
  if (dropped) refreshLanterns();
}

function rollDay() {
  const d = utcDay();
  if (d === today) return;
  today = d; question = questionForDay(d);
  $('ask-q').textContent = question.text;
  zonesLit.clear(); ringWasComplete = false; renderRing(false);
  if (entered) { void sky.checkIn(); feed(rich(['A new day began in UTC. The ring starts again.']), true); }
}

// ───────────────────────── arrival ─────────────────────────

function updateArrivalCount() {
  const el = $('arrival-eyebrow');
  if (entered) return;
  const n = others().length;
  el.replaceChildren();
  if (!sky.uid) { el.textContent = 'Looking for the others…'; return; }
  if (n > 0) el.append(h('b', {}, `${n} ${n === 1 ? 'person is' : 'people are'}`), ' here right now');
  else if (stats.lights_48h > 0) el.append(h('b', {}, `${stats.lights_48h.toLocaleString('en-US')} ${stats.lights_48h === 1 ? 'person has' : 'people have'}`), ' been here in the last two days');
  else el.textContent = 'The sky is quiet. Be its first light.';
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
  const flight = globe.flyTo(me.lat, me.lon, globe.homeDist(), reducedMotion ? 300 : 5600);

  setTimeout(() => {
    const n = others().length + 1;
    if (n > 1) interlude(rich(['You are one of ', { em: `${n} lights` }, ' under one sky.']));
    else if (stats.lights_48h > 0) interlude(rich(['Right now, yours is ', { em: 'the only light.' }, ` ${stats.lights_48h.toLocaleString('en-US')} were here before you.`]));
    else interlude(rich(['Yours is ', { em: 'the first light' }, ' under this sky.']));
  }, reducedMotion ? 0 : 900);

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
  if (!store.get('onesky.seen')) {
    store.set('onesky.seen', '1');
    setTimeout(() => {
      const n = others().length;
      toast(rich([n > 0 ? 'Tap a light to see who is awake — and wave.' : 'Tap a lantern to read it. Release your own below.', { small: 'Drag to turn the Earth. Scroll or pinch to come closer.' }]), { plain: true, ms: 9000 });
    }, 1600);
  }
}

// ───────────────────────── boot ─────────────────────────

function boot() {
  const canvas = $('sky') as unknown as HTMLCanvasElement;
  try {
    globe = new Globe(canvas, { lowPower, reducedMotion });
  } catch (e) {
    console.error(e);
    document.body.append(h('div', { class: 'fallback' }, h('div', {}, h('h1', {}, 'One Sky'), h('p', {}, 'This device couldn’t draw the Earth (WebGL is unavailable). Try another browser, or turn on hardware acceleration.'))));
    $('arrival').remove();
    return;
  }
  (window as any).__onesky = { globe, sky, get me() { return me; }, get entered() { return entered; }, lanterns, threads, select };
  canvas.tabIndex = 0;
  globe.prepareIntro(me.lat, me.lon);
  const fitMobile = () => globe.setYShift(Math.round(innerHeight * (innerWidth < 820 ? 0.075 : 0.035)));
  fitMobile(); addEventListener('resize', fitMobile);

  $('arrival-place').textContent = me.city;
  $('ask-q').textContent = question.text;
  buildRingStrip(); renderYou(); renderCensus(); updateArrivalCount();

  globe.onFrame(updateLabels);
  globe.onTap = (pick) => { if (!entered || isModalOpen()) return; select(pick); };
  globe.onHover = (pick, ev) => {
    const tip = $('tip');
    canvas.classList.toggle('is-point', !!pick && entered);
    if (!pick || !entered) { tip.hidden = true; return; }
    tip.replaceChildren();
    if (pick.type === 'lantern') {
      const l = lanterns.get(pick.id); if (!l) { tip.hidden = true; return; }
      tip.append(l.body.length > 64 ? `“${l.body.slice(0, 62)}…”` : `“${l.body}”`, h('small', {}, `a lantern over ${l.place}`));
    } else if (pick.id.startsWith('echo:')) {
      const e = echoes[Number(pick.id.slice(5))]; if (!e) { tip.hidden = true; return; }
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
    else if (k === 'Escape') closeCard(); else return;
    e.preventDefault();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !isModalOpen()) closeCard(); });

  $('btn-enter').addEventListener('click', () => void enter());
  $('btn-lantern').addEventListener('click', openComposer);
  $('btn-move').addEventListener('click', openMove);
  $('btn-about').addEventListener('click', openAbout);
  $('btn-postcard').addEventListener('click', () => void openPostcard());
  $('btn-sound').addEventListener('click', () => {
    audio.muted = !audio.muted;
    store.set('onesky.muted', audio.muted ? '1' : '0');
    $('btn-sound').setAttribute('aria-pressed', String(!audio.muted));
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) audio.suspend(); else { audio.resume(); void refreshWorld(); } });

  // The button unlocks as soon as the Earth can be drawn; the network may still be arriving.
  void globe.ready.then(() => $('btn-enter').removeAttribute('disabled'), () => $('btn-enter').removeAttribute('disabled'));

  wireSky();
  sky.connect().then(loadWorld).then(() => { updateArrivalCount(); renderCensus(); }).catch((e) => {
    console.warn('One Sky is offline', e);
    $('arrival-eyebrow').textContent = 'The sky is out of reach right now — you can still look.';
  });

  // slow clocks
  setInterval(() => { renderYou(); rollDay(); if (selection && selection.type === 'light' && !selection.id.startsWith('echo:')) { /* keep their time fresh */ const b = card.querySelector('.facts dd'); const p = sky.people.get(selection.id); if (b && p) b.textContent = localTimeString(p.tz); } }, 15000);
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

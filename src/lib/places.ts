// Every place a light can sit: the 418 time-zone cities (key = IANA zone name) plus
// 11,585 cities of 50,000 people or more (key = "g" + GeoNames id).
//
// A visitor starts at their time zone's city. They can pick any city here by search, or let the
// browser tell this page where they are so it can pick the NEAREST city for them. Only the chosen
// city (plus a small fixed scatter) is ever sent anywhere; exact coordinates stay on the device.
import { PLACES, jitter as zoneJitter, JITTER_DEGREES, type Place } from './tz';
import { RAW_CITIES, CITY_TZS } from './cities';
import { COUNTRIES } from './tzdata';

/** How far (degrees per axis) a light may sit from its city's centre. */
export const CITY_JITTER = 0.12;

export const placeKey = (p: Place): string => p.key ?? p.tz;
export const isCity = (p: Place): boolean => !!p.key;

let cities: Place[] | null = null;
let byKey: Map<string, Place> | null = null;

export function allCities(): Place[] {
  cities ??= RAW_CITIES.map(([id, name, cc, region, lat, lon, tzi]) => ({
    key: `g${id}`, tz: CITY_TZS[tzi], lat, lon, city: name, region: region || undefined, country: COUNTRIES[cc] ?? cc, cc,
  }));
  return cities;
}

/** Exact lookup by place key. For validating remote data: no aliases, no fallback. */
export function placeByKey(key: unknown): Place | undefined {
  if (typeof key !== 'string') return undefined;
  if (!byKey) {
    byKey = new Map();
    for (const p of PLACES) byKey.set(p.tz, p);
    for (const c of allCities()) byKey.set(c.key!, c);
  }
  return byKey.get(key);
}

/** The largest allowed distance, per axis, between a light and its place's centre. */
export const maxJitter = (p: Place): number => (isCity(p) ? CITY_JITTER : JITTER_DEGREES);

/** A fixed small scatter per browser, so people in one city don't stack on one point. */
export function scatter(place: Place, seed: string): { lat: number; lon: number } {
  const j = zoneJitter(place, seed + (place.key ?? ''));
  if (!isCity(place)) return j;
  const k = CITY_JITTER / JITTER_DEGREES;
  let dLon = j.lon - place.lon;
  if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
  const lat = Math.max(-89.5, Math.min(89.5, place.lat + (j.lat - place.lat) * k));
  let lon = place.lon + dLon * k;
  if (lon > 180) lon -= 360; else if (lon < -180) lon += 360;
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

/** "Madison, WI" for places whose names repeat within a country; otherwise just the city. */
export const cityLabel = (p: Place): string => (p.region ? `${p.city}, ${p.region}` : p.city);
export const fullLabel = (p: Place): string => (p.country && p.country !== p.city ? `${cityLabel(p)}, ${p.country}` : cityLabel(p));

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
let folded: { name: string; country: string; place: Place }[] | null = null;
function index() {
  if (!folded) {
    // cities first (largest first), then zone places that are not already covered by a city of the same name
    const seen = new Set<string>();
    folded = [];
    for (const c of allCities()) { const name = fold(c.city); seen.add(`${name}|${c.cc}`); folded.push({ name, country: fold(c.country), place: c }); }
    for (const p of PLACES) { const name = fold(p.city); if (!seen.has(`${name}|${p.cc}`)) folded.push({ name, country: fold(p.country), place: p }); }
  }
  return folded;
}

/** Search every place by city name (prefix first), then by words inside the name, then by country. */
export function searchAll(q: string, limit = 8): Place[] {
  const query = typeof q === 'string' ? fold(q) : '';
  if (!query) return [];
  const ranks: Place[][] = [[], [], [], []];
  for (const e of index()) {
    let r = -1;
    if (e.name === query) r = 0;
    else if (e.name.startsWith(query)) r = 1;
    else if (e.name.includes(' ' + query)) r = 2;
    else if (query.length >= 3 && e.country.startsWith(query)) r = 3;
    if (r >= 0 && ranks[r].length < limit) ranks[r].push(e.place);
  }
  return ranks.flat().slice(0, limit);
}

/** The place nearest a point (great-circle), among all cities and zone places. Never null. */
export function nearestPlace(lat: number, lon: number): Place {
  const rad = Math.PI / 180;
  const cosLat = Math.cos(lat * rad);
  let best: Place = PLACES[0], bd = Infinity;
  const test = (p: Place) => {
    let dLon = Math.abs(p.lon - lon); if (dLon > 180) dLon = 360 - dLon;
    const dLat = p.lat - lat;
    const d = dLat * dLat + dLon * dLon * cosLat * cosLat; // fine for ranking nearby candidates
    if (d < bd) { bd = d; best = p; }
  };
  for (const c of allCities()) test(c);
  for (const p of PLACES) test(p);
  return best;
}

/** First place with this city name, for showing the local time of a name that came from the database. */
export function placeByCityName(name: string): Place | undefined {
  const n = fold(name);
  return index().find((e) => e.name === n)?.place;
}

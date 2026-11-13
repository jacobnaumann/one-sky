import { describe, expect, it } from 'vitest';
import { JITTER_DEGREES, PLACES, jitter, placeForOffset, placeForTimeZone, searchPlaces } from '../../src/lib/tz';
import { ALIASES, COUNTRIES, RAW_PLACES } from '../../src/lib/tzdata';
import { isValidTimeZone, utcOffsetMinutes } from '../../src/lib/time';

const winter = new Date('2026-01-15T12:00:00Z');
const summer = new Date('2026-07-15T12:00:00Z');
const byTz = (tz: string) => PLACES.find((p) => p.tz === tz);

describe('PLACES', () => {
  it('covers zone1970.tab and the per-country zones of zone.tab', () => {
    expect(PLACES.length).toBe(RAW_PLACES.length);
    expect(PLACES.length).toBeGreaterThanOrEqual(400);
    expect(PLACES.length).toBeLessThan(480);
  });

  it('has unique zones and well-formed rows', () => {
    expect(new Set(PLACES.map((p) => p.tz)).size).toBe(PLACES.length);
    for (const p of PLACES) {
      expect(p.tz, p.tz).toMatch(/^[A-Z][A-Za-z]+\/[A-Za-z_\-+0-9/]+$/);
      expect(p.lat, p.tz).toBeGreaterThanOrEqual(-90);
      expect(p.lat, p.tz).toBeLessThanOrEqual(90);
      expect(p.lon, p.tz).toBeGreaterThanOrEqual(-180);
      expect(p.lon, p.tz).toBeLessThanOrEqual(180);
      expect(Math.round(p.lat * 100) / 100, p.tz).toBe(p.lat); // 2 decimals
      expect(Math.round(p.lon * 100) / 100, p.tz).toBe(p.lon);
      expect(p.cc, p.tz).toMatch(/^[A-Z]{2}$/);
      expect(p.country, p.tz).toBe(COUNTRIES[p.cc]);
      expect(p.country.length, p.tz).toBeGreaterThan(2);
      expect(p.city.length, p.tz).toBeGreaterThan(1);
      expect(p.city, p.tz).not.toMatch(/[_/]/);
    }
  });

  it('parses ISO 6709 coordinates to decimal degrees', () => {
    // zone1970.tab: America/New_York +404251-0740023, Asia/Kolkata +2232+08822,
    // Australia/Sydney -3352+15113, America/Sao_Paulo -2332-04637
    expect(byTz('America/New_York')).toMatchObject({ lat: 40.71, lon: -74.01 });
    expect(byTz('Asia/Kolkata')).toMatchObject({ lat: 22.53, lon: 88.37 });
    expect(byTz('Australia/Sydney')).toMatchObject({ lat: -33.87, lon: 151.22 });
    expect(byTz('America/Sao_Paulo')).toMatchObject({ lat: -23.53, lon: -46.62 });
  });

  it('names cities and countries nicely', () => {
    const city = (tz: string) => byTz(tz)?.city;
    expect(city('Asia/Kolkata')).toBe('Kolkata');
    expect(city('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(city('Asia/Ho_Chi_Minh')).toBe('Ho Chi Minh City');
    expect(city('America/Indiana/Indianapolis')).toBe('Indianapolis');
    expect(city('America/Kentucky/Louisville')).toBe('Louisville');
    expect(city('Asia/Yangon')).toBe('Yangon');
    expect(city('America/New_York')).toBe('New York');
    expect(city('America/Port-au-Prince')).toBe('Port-au-Prince');
    expect(city('America/Sao_Paulo')).toBe('São Paulo');
    expect(city('America/St_Johns')).toBe("St. John's");
    expect(city('Africa/Dar_es_Salaam')).toBe('Dar es Salaam');
    expect(city('Asia/Qatar')).toBe('Doha');

    expect(byTz('Europe/London')).toMatchObject({ cc: 'GB', country: 'United Kingdom' });
    expect(byTz('Asia/Seoul')).toMatchObject({ cc: 'KR', country: 'South Korea' });
    expect(byTz('America/Chicago')).toMatchObject({ cc: 'US', country: 'United States' });
    expect(byTz('Asia/Kolkata')).toMatchObject({ cc: 'IN', country: 'India' });
    // first country code on a multi-country zone1970 line
    expect(byTz('Europe/Berlin')?.cc).toBe('DE');
    expect(byTz('Africa/Lagos')?.cc).toBe('NG');
    expect(byTz('Asia/Dubai')?.cc).toBe('AE');
  });

  it('keeps merged link zones as their own places', () => {
    const own: [string, string, string, number, number][] = [
      ['Europe/Amsterdam', 'NL', 'Netherlands', 52.37, 4.9],
      ['Europe/Stockholm', 'SE', 'Sweden', 59.33, 18.05],
      ['Europe/Oslo', 'NO', 'Norway', 59.92, 10.75],
      ['Europe/Copenhagen', 'DK', 'Denmark', 55.67, 12.58],
      ['Asia/Kuwait', 'KW', 'Kuwait', 29.33, 47.98],
      ['Africa/Accra', 'GH', 'Ghana', 5.55, -0.22],
      ['Atlantic/Reykjavik', 'IS', 'Iceland', 64.15, -21.85],
      ['Asia/Kuala_Lumpur', 'MY', 'Malaysia', 3.17, 101.7],
      ['Africa/Addis_Ababa', 'ET', 'Ethiopia', 9.03, 38.7],
      ['Europe/Zagreb', 'HR', 'Croatia', 45.8, 15.97],
    ];
    for (const [tz, cc, country, lat, lon] of own) {
      const p = placeForTimeZone(tz);
      expect(p, tz).toMatchObject({ tz, cc, country, lat, lon });
      expect(ALIASES[tz], tz).toBeUndefined();
    }
    expect(placeForTimeZone('Europe/Amsterdam').city).toBe('Amsterdam');
    expect(placeForTimeZone('Europe/Amsterdam')).not.toBe(placeForTimeZone('Europe/Brussels'));
  });

  it('only lists zones this runtime knows (bar a few very new ones)', () => {
    const unknown = PLACES.filter((p) => !isValidTimeZone(p.tz)).map((p) => p.tz);
    expect(unknown.length, unknown.join(', ')).toBeLessThanOrEqual(3);
  });
});

describe('ALIASES', () => {
  it('always point at a real place and never shadow one', () => {
    const zones = new Set(PLACES.map((p) => p.tz));
    const names = Object.keys(ALIASES);
    expect(names.length).toBeGreaterThan(80);
    for (const name of names) {
      expect(zones.has(ALIASES[name]), name).toBe(true);
      expect(zones.has(name), name).toBe(false);
    }
  });
});

describe('placeForTimeZone', () => {
  it('finds exact zones', () => {
    expect(placeForTimeZone('America/Chicago')).toMatchObject({
      tz: 'America/Chicago', city: 'Chicago', cc: 'US', country: 'United States', lat: 41.85, lon: -87.65,
    });
    expect(placeForTimeZone('Asia/Tokyo').city).toBe('Tokyo');
    expect(placeForTimeZone('  Europe/Paris ').city).toBe('Paris');
    expect(placeForTimeZone('europe/paris').city).toBe('Paris');
    for (const p of PLACES) expect(placeForTimeZone(p.tz)).toBe(p);
  });

  it('follows old and link names', () => {
    const via = (tz: string) => placeForTimeZone(tz).tz;
    expect(via('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(via('US/Pacific')).toBe('America/Los_Angeles');
    expect(via('US/Eastern')).toBe('America/New_York');
    expect(via('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(via('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    expect(via('Asia/Rangoon')).toBe('Asia/Yangon');
    expect(via('Asia/Katmandu')).toBe('Asia/Kathmandu');
    expect(via('America/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(via('America/Indianapolis')).toBe('America/Indiana/Indianapolis');
    expect(via('Australia/NSW')).toBe('Australia/Sydney');
    expect(via('Japan')).toBe('Asia/Tokyo');
    expect(via('asia/calcutta')).toBe('Asia/Kolkata');
  });

  it('falls back on the UTC offset for zones without a place', () => {
    for (const date of [winter, summer]) {
      for (const tz of ['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/GMT+5', 'Etc/GMT-3', 'Etc/GMT-10', 'Etc/GMT+8']) {
        const p = placeForTimeZone(tz, date);
        expect(PLACES, tz).toContain(p);
        // same clock time as the zone asked for
        expect(utcOffsetMinutes(p.tz, date), tz).toBe(utcOffsetMinutes(tz, date));
        // and near that offset's meridian (UTC-8 in northern summer has only
        // Pitcairn, 10 degrees off, so the bound is one hour band wide)
        const meridian = utcOffsetMinutes(tz, date) / 4;
        expect(Math.abs(p.lon - meridian), `${tz} -> ${p.tz}`).toBeLessThan(15);
      }
    }
  });

  it('puts UTC on the Greenwich meridian', () => {
    expect(placeForTimeZone('Etc/UTC', winter).tz).toBe('Europe/London');
    expect(placeForTimeZone('UTC', winter).tz).toBe('Europe/London');
    expect(Math.abs(placeForTimeZone('Etc/UTC', summer).lon)).toBeLessThan(2);
    expect(placeForTimeZone('Etc/UTC', summer).cc).not.toBe('AQ');
  });

  it('is deterministic', () => {
    expect(placeForTimeZone('Etc/GMT+5', winter)).toBe(placeForTimeZone('Etc/GMT+5', winter));
    expect(placeForTimeZone('Etc/GMT+5', winter)).toBe(placeForTimeZone('Etc/GMT+5', new Date(winter.getTime())));
  });

  it('never throws and uses the device offset for garbage', () => {
    const local = placeForOffset(-winter.getTimezoneOffset(), winter);
    for (const bad of [undefined, '', '   ', 'Not/AZone', 'garbage', '../../etc/passwd', '<script>', 'Europe/', 'x'.repeat(500)]) {
      expect(placeForTimeZone(bad, winter), String(bad)).toBe(local);
    }
    expect(PLACES).toContain(placeForTimeZone(null as unknown as string));
    expect(PLACES).toContain(placeForTimeZone(42 as unknown as string));
    expect(PLACES).toContain(placeForTimeZone({} as unknown as string));
    expect(PLACES).toContain(placeForTimeZone('UTC', new Date(NaN)));
    expect(PLACES).toContain(placeForTimeZone(undefined));
  });
});

describe('placeForOffset', () => {
  it('picks a place with that offset on the nearest meridian', () => {
    for (const offset of [-720, -660, -600, -570, -480, -300, -210, -180, 0, 60, 120, 210, 330, 345, 480, 525, 540, 570, 765, 780, 840]) {
      const p = placeForOffset(offset, winter);
      const matching = PLACES.filter((q) => utcOffsetMinutes(q.tz, winter) === offset && q.cc !== 'AQ');
      if (!matching.length) continue;
      expect(matching, String(offset)).toContain(p);
      const dist = (lon: number) => Math.abs(((lon - offset / 4 + 540) % 360) - 180);
      for (const q of matching) expect(dist(p.lon)).toBeLessThanOrEqual(dist(q.lon));
    }
  });

  it('gives sensible answers for common offsets', () => {
    // UTC+5:30 -> meridian 82.5 E: Colombo (79.85) is nearer than Kolkata (88.37)
    expect(placeForOffset(330, winter).tz).toBe('Asia/Colombo');
    expect(placeForOffset(-300, winter).tz).toBe('America/Bogota');
    expect(placeForOffset(60, winter).cc).not.toBe('AQ');
    expect(placeForOffset(345, winter).tz).toBe('Asia/Kathmandu');
    expect(placeForOffset(540, winter).cc).toMatch(/^(JP|KR|KP|ID|RU|PW|TL)$/);
  });

  it('still answers for offsets no zone uses, and for nonsense', () => {
    expect(PLACES).toContain(placeForOffset(17, winter));
    expect(Math.abs(placeForOffset(-720, winter).lon)).toBeGreaterThan(160);
    expect(PLACES).toContain(placeForOffset(NaN, winter));
    expect(PLACES).toContain(placeForOffset(99999, winter));
    expect(PLACES).toContain(placeForOffset(0, new Date(NaN)));
  });
});

describe('searchPlaces', () => {
  const cities = (q: string, limit?: number) => searchPlaces(q, limit).map((p) => p.city);

  it('matches city prefixes first, case-insensitively', () => {
    expect(cities('lon')[0]).toBe('London');
    expect(cities('LONDON')).toEqual(['London']);
    expect(cities('tok')[0]).toBe('Tokyo');
    expect(cities('new y')[0]).toBe('New York');
    expect(cities('  Paris ')[0]).toBe('Paris');
  });

  it('ignores diacritics and punctuation both ways', () => {
    expect(cities('sao paulo')[0]).toBe('São Paulo');
    expect(cities('São')).toContain('São Paulo');
    expect(cities('zurich')[0]).toBe('Zürich');
    expect(cities('reykjavik')[0]).toBe('Reykjavík');
    expect(cities('bogotá')[0]).toBe('Bogotá');
    expect(cities('st johns')).toContain("St. John's");
    expect(cities('port au prince')[0]).toBe('Port-au-Prince');
  });

  it('matches countries', () => {
    const jp = searchPlaces('japan');
    expect(jp.map((p) => p.city)).toEqual(['Tokyo']);
    expect(searchPlaces('nether')[0].city).toBe('Amsterdam');
    expect(searchPlaces('united kingdom')[0].city).toBe('London');
    const india = searchPlaces('india');
    expect(india.some((p) => p.cc === 'IN')).toBe(true);
    // city prefix (Indianapolis) ranks above the country match
    expect(india[0].city).toBe('Indianapolis');
  });

  it('falls back to substrings and to the zone name', () => {
    expect(cities('dam')).toContain('Amsterdam');
    expect(cities('aires')[0]).toBe('Buenos Aires');
    expect(cities('tahiti')).toContain('Papeete');
    expect(cities('fiji')).toContain('Suva');
  });

  it('puts prefix matches before substring matches', () => {
    const r = cities('ba', 50);
    const firstNonPrefix = r.findIndex((c) => !c.toLowerCase().startsWith('ba'));
    const lastPrefix = r.map((c) => c.toLowerCase().startsWith('ba')).lastIndexOf(true);
    expect(lastPrefix).toBeGreaterThanOrEqual(0);
    if (firstNonPrefix >= 0) expect(firstNonPrefix).toBeGreaterThan(lastPrefix);
  });

  it('respects the limit and returns nothing for nothing', () => {
    expect(searchPlaces('a')).toHaveLength(8);
    expect(searchPlaces('a', 3)).toHaveLength(3);
    expect(searchPlaces('a', 0)).toEqual([]);
    expect(searchPlaces('')).toEqual([]);
    expect(searchPlaces('   ')).toEqual([]);
    expect(searchPlaces('zzzzqq')).toEqual([]);
    expect(searchPlaces(undefined as unknown as string)).toEqual([]);
    expect(new Set(searchPlaces('s', 100)).size).toBe(searchPlaces('s', 100).length);
  });
});

describe('jitter', () => {
  const place = placeForTimeZone('Europe/Amsterdam');

  it('is deterministic per seed', () => {
    expect(jitter(place, 'abc')).toEqual(jitter(place, 'abc'));
    expect(jitter(place, 'abc')).not.toEqual(jitter(place, 'abd'));
  });

  it('stays within about 0.6 degrees and spreads out', () => {
    const seen = new Set<string>();
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < 500; i++) {
      const j = jitter(place, `visitor-${i}`);
      expect(Math.abs(j.lat - place.lat)).toBeLessThanOrEqual(JITTER_DEGREES + 0.001);
      expect(Math.abs(j.lon - place.lon)).toBeLessThanOrEqual(JITTER_DEGREES + 0.001);
      seen.add(`${j.lat},${j.lon}`);
      minLat = Math.min(minLat, j.lat); maxLat = Math.max(maxLat, j.lat);
      minLon = Math.min(minLon, j.lon); maxLon = Math.max(maxLon, j.lon);
    }
    expect(seen.size).toBeGreaterThan(490);
    expect(maxLat - minLat).toBeGreaterThan(1);
    expect(maxLon - minLon).toBeGreaterThan(1);
  });

  it('differs between places for one seed, and does not mutate the place', () => {
    const other = placeForTimeZone('Europe/Brussels');
    const a = jitter(place, 'same');
    const b = jitter(other, 'same');
    expect(a.lat - place.lat).not.toBeCloseTo(b.lat - other.lat, 6);
    expect(place).toMatchObject({ lat: 52.37, lon: 4.9 });
  });

  it('stays on the globe near the poles and the antimeridian', () => {
    const pole = { tz: 'Test/Pole', lat: 89.9, lon: 179.9, city: 'x', country: 'x', cc: 'XX' };
    for (let i = 0; i < 200; i++) {
      const j = jitter(pole, String(i));
      expect(j.lat).toBeLessThanOrEqual(89.5);
      expect(j.lon).toBeGreaterThanOrEqual(-180);
      expect(j.lon).toBeLessThan(180);
    }
    expect(Number.isFinite(jitter(place, '').lat)).toBe(true);
  });
});

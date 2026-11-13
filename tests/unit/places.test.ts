import { describe, it, expect } from 'vitest';
import { allCities, placeByKey, placeKey, nearestPlace, searchAll, scatter, maxJitter, cityLabel, fullLabel, isCity, CITY_JITTER } from '../../src/lib/places';
import { PLACES, JITTER_DEGREES } from '../../src/lib/tz';

describe('places', () => {
  it('has the generated cities with unique keys and valid coordinates and zones', () => {
    const cs = allCities();
    expect(cs.length).toBeGreaterThan(10000);
    expect(new Set(cs.map((c) => c.key)).size).toBe(cs.length);
    for (const c of cs) {
      expect(c.key).toMatch(/^g\d+$/);
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
      expect(c.tz).toMatch(/^[A-Za-z_]+\/[A-Za-z_/+-]+$/);
    }
  });

  it('looks places up by exact key only', () => {
    expect(placeByKey('America/Chicago')?.city).toBe('Chicago');
    const madison = allCities().find((c) => c.city === 'Madison' && c.region === 'WI')!;
    expect(placeByKey(madison.key)).toBe(madison);
    expect(placeKey(madison)).toBe(madison.key);
    expect(placeKey(PLACES[0])).toBe(PLACES[0].tz);
    for (const bad of ['g1', 'america/chicago', 'US/Central', '', null, 42, undefined]) expect(placeByKey(bad)).toBeUndefined();
  });

  it('finds the nearest city to a point', () => {
    expect(cityLabel(nearestPlace(43.07, -89.40))).toBe('Madison, WI');
    expect(nearestPlace(48.86, 2.35).city).toBe('Paris');
    expect(nearestPlace(-33.87, 151.21).city).toBe('Sydney');
    expect(nearestPlace(35.68, 139.69).cc).toBe('JP');
    // across the date line and at the poles it still answers
    expect(nearestPlace(-17, 179.9)).toBeTruthy();
    expect(nearestPlace(89.9, 0)).toBeTruthy();
    expect(nearestPlace(-89.9, 120)).toBeTruthy();
  });

  it('searches by name, largest first, ignoring accents', () => {
    expect(searchAll('madison').map(cityLabel)).toContain('Madison, WI');
    expect(searchAll('sao paulo')[0].city).toBe('São Paulo');
    expect(searchAll('london')[0].cc).toBe('GB');
    expect(searchAll('')).toEqual([]);
    expect(searchAll('zzzzqq')).toEqual([]);
    expect(searchAll('new', 5).length).toBe(5);
  });

  it('scatters a light a little, deterministically, and inside the allowed box', () => {
    const madison = allCities().find((c) => c.city === 'Madison' && c.region === 'WI')!;
    const a = scatter(madison, 'seed-1'), b = scatter(madison, 'seed-1'), c = scatter(madison, 'seed-2');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(maxJitter(madison)).toBe(CITY_JITTER);
    for (const city of allCities().slice(0, 400)) {
      const j = scatter(city, 'x' + city.key);
      expect(Math.abs(j.lat - city.lat)).toBeLessThanOrEqual(CITY_JITTER + 0.001);
      let d = Math.abs(j.lon - city.lon); if (d > 180) d = 360 - d;
      expect(d).toBeLessThanOrEqual(CITY_JITTER + 0.001);
    }
    const zone = PLACES.find((p) => p.tz === 'America/Chicago')!;
    expect(isCity(zone)).toBe(false);
    expect(maxJitter(zone)).toBe(JITTER_DEGREES);
    const z = scatter(zone, 'seed-1');
    expect(Math.abs(z.lat - zone.lat)).toBeLessThanOrEqual(JITTER_DEGREES + 0.001);
  });

  it('labels places', () => {
    const madison = allCities().find((c) => c.city === 'Madison' && c.region === 'WI')!;
    expect(fullLabel(madison)).toBe('Madison, WI, United States');
    expect(fullLabel(PLACES.find((p) => p.tz === 'Asia/Singapore')!)).toBe('Singapore');
  });
});

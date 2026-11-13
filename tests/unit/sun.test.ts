import { describe, expect, it } from 'vitest';
import { latLonToVec3 } from '../../src/lib/geo';
import { skyState, solarElevation, subsolarPoint, sunDirection } from '../../src/lib/sun';

const utc = (s: string) => new Date(s + 'Z');

describe('subsolarPoint', () => {
  it('sits on the equator at the equinoxes', () => {
    expect(Math.abs(subsolarPoint(utc('2024-03-20T03:06:00')).lat)).toBeLessThan(0.05);
    expect(Math.abs(subsolarPoint(utc('2024-09-22T12:44:00')).lat)).toBeLessThan(0.05);
    expect(Math.abs(subsolarPoint(utc('2026-03-20T14:46:00')).lat)).toBeLessThan(0.05);
  });

  it('reaches the tropics at the solstices', () => {
    expect(subsolarPoint(utc('2024-06-20T20:51:00')).lat).toBeCloseTo(23.44, 1);
    expect(subsolarPoint(utc('2024-12-21T09:21:00')).lat).toBeCloseTo(-23.44, 1);
    expect(subsolarPoint(utc('2026-06-21T08:25:00')).lat).toBeCloseTo(23.44, 1);
  });

  it('never leaves the tropics and stays near Greenwich at 12:00 UTC', () => {
    for (let d = 0; d < 366; d += 3) {
      const p = subsolarPoint(new Date(Date.UTC(2025, 0, 1 + d, 12)));
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(23.45);
      // the equation of time is at most ~16.5 min, i.e. ~4.1 degrees
      expect(Math.abs(p.lon)).toBeLessThan(4.2);
    }
  });

  it('reproduces the equation of time', () => {
    // lon at 12:00 UTC = -EoT / (4 min per degree)
    expect(subsolarPoint(utc('2024-11-03T12:00:00')).lon).toBeCloseTo(-16.47 / 4, 1); // sun 16.5 min fast
    expect(subsolarPoint(utc('2024-02-11T12:00:00')).lon).toBeCloseTo(14.23 / 4, 1); // sun 14.2 min slow
    expect(Math.abs(subsolarPoint(utc('2024-04-15T12:00:00')).lon)).toBeLessThan(0.2); // EoT ~ 0
    expect(Math.abs(subsolarPoint(utc('2024-06-13T12:00:00')).lon)).toBeLessThan(0.2);
  });

  it('moves west 15 degrees an hour and stays in [-180, 180)', () => {
    const base = utc('2025-05-05T00:00:00').getTime();
    for (let h = 0; h < 48; h++) {
      const a = subsolarPoint(new Date(base + h * 3600000)).lon;
      const b = subsolarPoint(new Date(base + (h + 1) * 3600000)).lon;
      expect(a).toBeGreaterThanOrEqual(-180);
      expect(a).toBeLessThan(180);
      expect((((a - b) % 360) + 360) % 360).toBeCloseTo(15, 1);
    }
    // midnight UTC: the sun is over the antimeridian
    expect(Math.abs(subsolarPoint(utc('2025-04-15T00:00:00')).lon)).toBeGreaterThan(179);
  });

  it('survives an invalid date', () => {
    expect(subsolarPoint(new Date(NaN))).toEqual({ lat: 0, lon: 0 });
  });
});

describe('sunDirection', () => {
  it('is the unit vector of the subsolar point', () => {
    const d = utc('2026-11-13T07:30:00');
    const v = sunDirection(d);
    expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    const p = subsolarPoint(d);
    const w = latLonToVec3(p.lat, p.lon);
    v.forEach((x, i) => expect(x).toBeCloseTo(w[i], 12));
  });

  it('points along +X at noon UTC on an equinox, north in June, south in December', () => {
    const v = sunDirection(utc('2024-03-20T12:07:00')); // EoT is about -7.5 min that day
    expect(v[0]).toBeGreaterThan(0.999);
    expect(sunDirection(utc('2024-06-21T12:00:00'))[1]).toBeCloseTo(Math.sin((23.44 * Math.PI) / 180), 2);
    expect(sunDirection(utc('2024-12-21T12:00:00'))[1]).toBeLessThan(-0.39);
  });
});

describe('solarElevation', () => {
  it('is 90 at the subsolar point and -90 at its antipode', () => {
    const d = utc('2025-08-08T15:00:00');
    const p = subsolarPoint(d);
    expect(solarElevation(p.lat, p.lon, d)).toBeGreaterThan(89.99);
    expect(solarElevation(-p.lat, p.lon + 180, d)).toBeLessThan(-89.99);
  });

  it('matches noon altitudes: 90 - |lat - declination|', () => {
    // Greenwich, June solstice, local apparent noon ~12:02 UTC
    expect(solarElevation(51.48, 0, utc('2024-06-21T12:02:00'))).toBeCloseTo(90 - 51.48 + 23.44, 1);
    // and in December
    expect(solarElevation(51.48, 0, utc('2024-12-21T11:58:00'))).toBeCloseTo(90 - 51.48 - 23.44, 1);
  });

  it('is near the horizon at published sunrise and sunset times', () => {
    // Published times put the sun's upper limb on a refracted horizon, i.e. the
    // centre about 0.83 degrees below the geometric one.
    const cases: [number, number, string][] = [
      [51.5074, -0.1278, '2024-06-21T03:43:00'], // London sunrise
      [51.5074, -0.1278, '2024-06-21T20:21:00'], // London sunset
      [51.5074, -0.1278, '2024-12-21T08:04:00'], // London winter sunrise
      [40.7128, -74.006, '2024-03-20T10:59:00'], // New York equinox sunrise (06:59 EDT)
      [-33.8688, 151.2093, '2024-12-20T18:41:00'], // Sydney sunrise 05:41 AEDT on the 21st
      [-1.2921, 36.8219, '2024-09-22T03:23:00'], // Nairobi sunrise 06:23 EAT
    ];
    for (const [lat, lon, when] of cases) {
      const el = solarElevation(lat, lon, utc(when));
      expect(Math.abs(el + 0.83), `${when} gave ${el}`).toBeLessThan(0.6);
    }
  });

  it('knows polar day and polar night', () => {
    for (let h = 0; h < 24; h += 2) {
      expect(solarElevation(78.22, 15.65, new Date(Date.UTC(2024, 5, 21, h)))).toBeGreaterThan(0); // Svalbard, June
      expect(solarElevation(78.22, 15.65, new Date(Date.UTC(2024, 11, 21, h)))).toBeLessThan(-6); // December
    }
  });
});

describe('skyState', () => {
  it('walks through a London summer day', () => {
    const at = (t: string) => skyState(51.5074, -0.1278, utc('2024-06-21T' + t));
    expect(at('12:00:00')).toBe('day');
    expect(at('04:00:00')).toBe('golden hour'); // just after sunrise
    expect(at('20:00:00')).toBe('golden hour'); // just before sunset
    expect(at('03:00:00')).toBe('dawn');
    expect(at('21:00:00')).toBe('dusk');
    expect(at('00:00:00')).toBe('night'); // it never gets properly dark there in June
  });

  it('reaches deep night in winter and at the equator', () => {
    expect(skyState(51.5074, -0.1278, utc('2024-12-21T00:00:00'))).toBe('deep night');
    expect(skyState(0, 0, utc('2024-03-20T00:00:00'))).toBe('deep night');
    expect(skyState(0, 0, utc('2024-03-20T12:00:00'))).toBe('day');
  });

  it('tells dawn from dusk on both sides of the world', () => {
    expect(skyState(0, 0, utc('2024-03-20T05:40:00'))).toBe('dawn');
    expect(skyState(0, 0, utc('2024-03-20T18:30:00'))).toBe('dusk');
    expect(skyState(0, 180, utc('2024-03-20T17:40:00'))).toBe('dawn');
    expect(skyState(0, 180, utc('2024-03-20T06:30:00'))).toBe('dusk');
  });

  it('uses the documented thresholds and produces every state', () => {
    const base = utc('2024-03-20T00:00:00').getTime();
    const seen = new Set<string>();
    for (let m = 0; m < 1440; m += 2) {
      const d = new Date(base + m * 60000);
      const el = solarElevation(0, 0, d);
      const s = skyState(0, 0, d);
      seen.add(s);
      if (el > 6) expect(s).toBe('day');
      else if (el >= 0) expect(s).toBe('golden hour');
      else if (el >= -12) expect(s).toBe(m < 720 ? 'dawn' : 'dusk');
      else if (el >= -30) expect(s).toBe('night');
      else expect(s).toBe('deep night');
    }
    expect([...seen].sort()).toEqual(['dawn', 'day', 'deep night', 'dusk', 'golden hour', 'night']);
  });
});

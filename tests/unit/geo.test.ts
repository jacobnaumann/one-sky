import { describe, expect, it } from 'vitest';
import { arcPoints, formatKm, greatCircleKm, latLonToVec3, vec3ToLatLon, type Vec3 } from '../../src/lib/geo';

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const close = (a: Vec3, b: Vec3, digits = 9) => {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], digits);
};

describe('latLonToVec3', () => {
  it('follows the Three.js equirectangular convention', () => {
    close(latLonToVec3(0, 0), [1, 0, 0]);
    close(latLonToVec3(0, 90), [0, 0, -1]);
    close(latLonToVec3(0, -90), [0, 0, 1]);
    close(latLonToVec3(0, 180), [-1, 0, 0]);
    close(latLonToVec3(90, 0), [0, 1, 0]);
    close(latLonToVec3(-90, 123), [0, -1, 0]);
  });

  it('matches the literal formula from the spec', () => {
    const lat = 37.2, lon = -122.4, r = 2.5;
    const phi = ((90 - lat) * Math.PI) / 180;
    const theta = ((lon + 180) * Math.PI) / 180;
    close(latLonToVec3(lat, lon, r), [
      -r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    ]);
  });

  it('scales with r and defaults to the unit sphere', () => {
    expect(len(latLonToVec3(12, 34))).toBeCloseTo(1, 12);
    expect(len(latLonToVec3(-48, 170, 3))).toBeCloseTo(3, 12);
  });
});

describe('vec3ToLatLon', () => {
  it('inverts latLonToVec3 at any radius', () => {
    for (const lat of [-89, -45, -0.5, 0, 12.34, 60, 89]) {
      for (const lon of [-179.5, -120, -45, 0, 0.01, 77.7, 135, 179.5]) {
        for (const r of [1, 0.2, 7]) {
          const back = vec3ToLatLon(latLonToVec3(lat, lon, r));
          expect(back.lat).toBeCloseTo(lat, 8);
          expect(back.lon).toBeCloseTo(lon, 8);
        }
      }
    }
  });

  it('handles the poles, the antimeridian and the zero vector', () => {
    expect(vec3ToLatLon([0, 1, 0]).lat).toBeCloseTo(90, 9);
    expect(vec3ToLatLon([0, -2, 0]).lat).toBeCloseTo(-90, 9);
    expect(Math.abs(vec3ToLatLon(latLonToVec3(0, 180)).lon)).toBeCloseTo(180, 9);
    expect(vec3ToLatLon([0, 0, 0])).toEqual({ lat: 0, lon: 0 });
  });
});

describe('greatCircleKm', () => {
  it('is zero for the same point and symmetric', () => {
    expect(greatCircleKm(10, 20, 10, 20)).toBe(0);
    expect(greatCircleKm(51.5, -0.13, 40.7, -74)).toBeCloseTo(greatCircleKm(40.7, -74, 51.5, -0.13), 9);
  });

  it('matches known distances', () => {
    expect(greatCircleKm(0, 0, 0, 180)).toBeCloseTo(Math.PI * 6371, 6); // half the equator
    expect(greatCircleKm(90, 0, -90, 0)).toBeCloseTo(Math.PI * 6371, 6);
    expect(greatCircleKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2); // one degree
    const londonNewYork = greatCircleKm(51.5074, -0.1278, 40.7128, -74.006);
    expect(londonNewYork).toBeGreaterThan(5540);
    expect(londonNewYork).toBeLessThan(5600);
    const sydneyTokyo = greatCircleKm(-33.8688, 151.2093, 35.6762, 139.6503);
    expect(sydneyTokyo).toBeGreaterThan(7780);
    expect(sydneyTokyo).toBeLessThan(7860);
  });

  it('crosses the antimeridian the short way', () => {
    expect(greatCircleKm(0, 179, 0, -179)).toBeCloseTo(2 * 111.195, 1);
  });
});

describe('arcPoints', () => {
  const finite = (pts: Vec3[]) => pts.every((p) => p.every(Number.isFinite));

  it('returns segments + 1 points from A to B', () => {
    const pts = arcPoints(51.5, -0.13, 35.68, 139.69, 32, 0.3);
    expect(pts).toHaveLength(33);
    close(pts[0], latLonToVec3(51.5, -0.13));
    close(pts[32], latLonToVec3(35.68, 139.69));
  });

  it('with no lift every point is on the unit sphere and on the great circle', () => {
    const a = latLonToVec3(10, 20);
    const b = latLonToVec3(-30, 100);
    const normal: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    for (const p of arcPoints(10, 20, -30, 100, 16, 0)) {
      expect(len(p)).toBeCloseTo(1, 12);
      expect(p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2]).toBeCloseTo(0, 12);
    }
  });

  it('is evenly spaced in angle (slerp) and takes the short way round', () => {
    const pts = arcPoints(0, 0, 0, 90, 9, 0);
    pts.forEach((p, i) => {
      const { lat, lon } = vec3ToLatLon(p);
      expect(lat).toBeCloseTo(0, 9);
      expect(lon).toBeCloseTo(i * 10, 9);
    });
    const over = arcPoints(0, 170, 0, -170, 2, 0);
    expect(Math.abs(vec3ToLatLon(over[1]).lon)).toBeCloseTo(180, 9);
  });

  it('lifts by lift * (omega / PI) * sin(PI t)', () => {
    const lift = 0.4;
    const quarter = arcPoints(0, 0, 0, 90, 10, lift); // omega = PI/2
    expect(len(quarter[0])).toBeCloseTo(1, 12);
    expect(len(quarter[10])).toBeCloseTo(1, 12);
    expect(len(quarter[5])).toBeCloseTo(1 + lift * 0.5, 12);
    expect(len(quarter[2])).toBeCloseTo(1 + lift * 0.5 * Math.sin(Math.PI * 0.2), 12);
  });

  it('keeps short hops low and raises long ones', () => {
    const peak = (pts: Vec3[]) => Math.max(...pts.map(len));
    const short = peak(arcPoints(48.85, 2.35, 50.85, 4.35, 20, 0.5));
    const medium = peak(arcPoints(48.85, 2.35, 40.71, -74.0, 20, 0.5));
    const long = peak(arcPoints(48.85, 2.35, -33.87, 151.2, 20, 0.5));
    expect(short).toBeLessThan(1.01);
    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
    expect(long).toBeLessThanOrEqual(1.5);
  });

  it('handles identical and nearly identical points', () => {
    const same = arcPoints(12, 34, 12, 34, 8, 0.5);
    expect(same).toHaveLength(9);
    expect(finite(same)).toBe(true);
    for (const p of same) close(p, latLonToVec3(12, 34));
    const near = arcPoints(12, 34, 12 + 1e-12, 34 - 1e-12, 8, 0.5);
    expect(finite(near)).toBe(true);
    for (const p of near) close(p, latLonToVec3(12, 34), 6);
  });

  it('handles antipodal and nearly antipodal points', () => {
    const cases: [number, number, number, number][] = [
      [0, 0, 0, 180],
      [30, 40, -30, -140],
      [90, 0, -90, 0],
      [-90, 10, 90, 99],
      [30, 40, -30 + 1e-10, -140],
      [30, 40, -30.0001, -139.9999],
    ];
    for (const [la1, lo1, la2, lo2] of cases) {
      const pts = arcPoints(la1, lo1, la2, lo2, 12, 0.5);
      expect(pts).toHaveLength(13);
      expect(finite(pts)).toBe(true);
      close(pts[0], latLonToVec3(la1, lo1));
      close(pts[12], latLonToVec3(la2, lo2), 5);
      expect(len(pts[6])).toBeCloseTo(1.5, 5); // antipodal hops rise the full lift
    }
    // the ambiguous case is routed over the north pole
    expect(vec3ToLatLon(arcPoints(0, 0, 0, 180, 2, 0)[1]).lat).toBeCloseTo(90, 9);
  });

  it('tolerates silly segment counts', () => {
    expect(arcPoints(0, 0, 10, 10, 0, 0.1)).toHaveLength(2);
    expect(arcPoints(0, 0, 10, 10, -5, 0.1)).toHaveLength(2);
    expect(arcPoints(0, 0, 10, 10, NaN, 0.1)).toHaveLength(2);
    expect(arcPoints(0, 0, 10, 10, 3.9, 0.1)).toHaveLength(4);
  });
});

describe('formatKm', () => {
  it('rounds and groups thousands', () => {
    expect(formatKm(9412)).toBe('9,412 km');
    expect(formatKm(9412.4)).toBe('9,412 km');
    expect(formatKm(999.5)).toBe('1,000 km');
    expect(formatKm(0)).toBe('0 km');
    expect(formatKm(42)).toBe('42 km');
    expect(formatKm(20015.09)).toBe('20,015 km');
    expect(formatKm(1234567)).toBe('1,234,567 km');
  });

  it('never prints nonsense', () => {
    expect(formatKm(NaN)).toBe('0 km');
    expect(formatKm(-5)).toBe('0 km');
    expect(formatKm(Infinity)).toBe('0 km');
  });
});

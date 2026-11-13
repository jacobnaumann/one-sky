/**
 * Where the sun is. Low-precision solar position (Astronomical Almanac
 * formulas, good to about 0.01 degrees between 1950 and 2050), which is far
 * finer than a day/night terminator on a globe needs.
 */
import { latLonToVec3, type Vec3 } from './geo';

const DEG = Math.PI / 180;

export type Sky = 'day' | 'golden hour' | 'dusk' | 'dawn' | 'night' | 'deep night';

/** The point on Earth where the sun is directly overhead. lon is in [-180, 180). */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return { lat: 0, lon: 0 };
  // Days (and fractions) since J2000.0 = 2000-01-01 12:00 TT, taken as UTC.
  const n = ms / 86400000 - 10957.5;

  const meanLon = 280.46 + 0.9856474 * n; // mean longitude of the sun
  const g = (357.528 + 0.9856003 * n) * DEG; // mean anomaly
  const lambda = (meanLon + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * DEG; // obliquity of the ecliptic

  const declination = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const rightAscension = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));

  // Greenwich mean sidereal time, in degrees. The sun is overhead where the
  // local sidereal time equals its right ascension. (RA - GMST is where the
  // equation of time comes in.)
  const gmst = 280.46061837 + 360.98564736629 * n;
  const lon = wrap180(rightAscension / DEG - gmst);

  return { lat: declination / DEG, lon };
}

/** Unit vector from Earth's centre toward the sun, in the frame of latLonToVec3. */
export function sunDirection(date: Date): Vec3 {
  const { lat, lon } = subsolarPoint(date);
  return latLonToVec3(lat, lon, 1);
}

/**
 * Elevation of the sun's centre above the horizon, in degrees (-90..90).
 * Geometric: no atmospheric refraction, no observer height.
 */
export function solarElevation(lat: number, lon: number, date: Date): number {
  const s = sunDirection(date);
  const p = latLonToVec3(lat, lon, 1);
  const d = s[0] * p[0] + s[1] * p[1] + s[2] * p[2];
  return Math.asin(Math.max(-1, Math.min(1, d))) / DEG;
}

/**
 * A word for the sky at a place.
 *
 *   elevation >   6       day
 *   0   .. 6              golden hour
 *   -12 .. 0              dawn if the sun is rising, dusk if it is setting
 *                         (civil + nautical twilight)
 *   -30 .. -12            night
 *   below -30             deep night
 *
 * "Rising" compares the elevation five minutes from now with the current one.
 */
export function skyState(lat: number, lon: number, date: Date): Sky {
  const el = solarElevation(lat, lon, date);
  if (el > 6) return 'day';
  if (el >= 0) return 'golden hour';
  if (el >= -12) {
    const later = solarElevation(lat, lon, new Date(date.getTime() + 5 * 60000));
    return later > el ? 'dawn' : 'dusk';
  }
  if (el >= -30) return 'night';
  return 'deep night';
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

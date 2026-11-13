/** Sphere geometry helpers. Pure functions, no dependencies. */

export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;

/**
 * Latitude/longitude (degrees) to a point on a sphere of radius `r`.
 *
 * Matches a Three.js SphereGeometry wrapped with an equirectangular texture:
 *   lat  0, lon   0   -> ( r, 0,  0)   (+X: Gulf of Guinea)
 *   lat  0, lon  90 E -> ( 0, 0, -r)   (-Z: Indian Ocean)
 *   lat  0, lon  90 W -> ( 0, 0,  r)   (+Z: Galapagos)
 *   lat  0, lon 180   -> (-r, 0,  0)
 *   lat 90 (north pole) -> (0, r, 0)   (+Y)
 */
export function latLonToVec3(lat: number, lon: number, r = 1): Vec3 {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  const x = -r * Math.sin(phi) * Math.cos(theta);
  const y = r * Math.cos(phi);
  const z = r * Math.sin(phi) * Math.sin(theta);
  return [x, y, z];
}

/** Inverse of latLonToVec3 for a vector of any non-zero length. lon is in [-180, 180]. */
export function vec3ToLatLon(v: Vec3): { lat: number; lon: number } {
  const [x, y, z] = v;
  const len = Math.hypot(x, y, z);
  if (!(len > 0)) return { lat: 0, lon: 0 };
  const lat = Math.asin(clamp(y / len, -1, 1)) / DEG;
  // x = cos(lat)cos(lon), z = -cos(lat)sin(lon)  =>  lon = atan2(-z, x)
  const lon = Math.atan2(-z, x) / DEG;
  return { lat, lon: lon === 0 ? 0 : lon };
}

/** Great-circle distance in kilometres (haversine, mean Earth radius 6371 km). */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(clamp(a, 0, 1)));
}

/**
 * `segments + 1` points along the great circle from A to B (slerp), lifted off
 * the unit sphere into an arc.
 *
 * With `omega` the angle between A and B (0..PI) and `t` in 0..1, the radius is
 *
 *   radius(t) = 1 + lift * (omega / PI) * sin(PI * t)
 *
 * so both ends sit on the surface, the peak is at the midpoint, a short hop
 * stays low and an antipodal hop peaks at exactly `1 + lift`.
 *
 * Identical points give a flat run of the same point. For antipodal points the
 * great circle is ambiguous; the arc is routed over the north pole (or along
 * the prime meridian when A is itself a pole). Never returns NaN.
 */
export function arcPoints(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  segments: number,
  lift: number,
): Vec3[] {
  const n = Math.max(1, Math.floor(Number.isFinite(segments) ? segments : 1));
  const a = latLonToVec3(lat1, lon1);
  const b = latLonToVec3(lat2, lon2);
  const d = clamp(dot(a, b), -1, 1);

  // q: unit vector perpendicular to a, in the plane of the great circle, on b's side.
  let q: Vec3 = [b[0] - d * a[0], b[1] - d * a[1], b[2] - d * a[2]];
  let qLen = Math.hypot(q[0], q[1], q[2]);
  // atan2 stays accurate for tiny and near-PI angles, where acos(d) loses precision.
  const omega = Math.atan2(qLen, d);

  if (qLen < 1e-9) {
    // a and b are (anti)parallel: any perpendicular will do. Prefer "towards north".
    const up: Vec3 = Math.abs(a[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
    const k = dot(up, a);
    q = [up[0] - k * a[0], up[1] - k * a[1], up[2] - k * a[2]];
    qLen = Math.hypot(q[0], q[1], q[2]);
  }
  q = [q[0] / qLen, q[1] / qLen, q[2] / qLen];

  const peak = lift * (omega / Math.PI);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const c = Math.cos(omega * t);
    const s = Math.sin(omega * t);
    const radius = 1 + peak * Math.sin(Math.PI * t);
    out.push([
      (a[0] * c + q[0] * s) * radius,
      (a[1] * c + q[1] * s) * radius,
      (a[2] * c + q[2] * s) * radius,
    ]);
  }
  return out;
}

/** 9412.3 -> "9,412 km". Negative, NaN and infinite inputs read as "0 km". */
export function formatKm(km: number): string {
  const n = Number.isFinite(km) && km > 0 ? Math.round(km) : 0;
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} km`;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

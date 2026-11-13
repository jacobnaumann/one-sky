// Regenerates the city seed inside the places migration from the client's own tables, so the
// server's places and the client's city list cannot drift.
//
//   node scripts/gen-places-sql.mjs [path/to/migration.sql]
//
// Reads RAW_CITIES + CITY_TZS (src/lib/cities.ts) and COUNTRIES (src/lib/tzdata.ts) and rewrites
// everything between the two marker lines in the migration:
//
//   -- BEGIN GENERATED CITIES
//   -- END GENERATED CITIES
//
// Each city becomes one places row: key 'g' || geonameid, city = plain name, country = English
// country name (the country code if unknown), lat, lon, zone_tz = its IANA zone, jitter 0.21.
// A migration that has already been pushed must not be regenerated: write a new one instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(process.argv[2] ?? join(ROOT, 'supabase', 'migrations', '20261113090000_city_places.sql'));
const BEGIN = '-- BEGIN GENERATED CITIES';
const END = '-- END GENERATED CITIES';
const CITY_JITTER = 0.21;
const CHUNK = 500;

function arrayLiteral(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`${decl} not found`);
  const start = src.indexOf('[', at + decl.length);
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return JSON.parse(src.slice(start, i + 1).replace(/,\s*\]$/, ']'));
  }
  throw new Error(`${decl}: unterminated array`);
}

const citiesSrc = readFileSync(join(ROOT, 'src', 'lib', 'cities.ts'), 'utf8');
const CITY_TZS = arrayLiteral(citiesSrc, 'CITY_TZS: string[] =');
const RAW_CITIES = arrayLiteral(citiesSrc, 'RAW_CITIES: RawCity[] =');

const tzSrc = readFileSync(join(ROOT, 'src', 'lib', 'tzdata.ts'), 'utf8');
const cStart = tzSrc.indexOf('{', tzSrc.indexOf('COUNTRIES: Record<string, string> ='));
const COUNTRIES = Object.fromEntries(
  [...tzSrc.slice(cStart, tzSrc.indexOf('};', cStart)).matchAll(/([A-Z]{2})\s*:\s*("(?:[^"\\]|\\.)*")/g)]
    .map((m) => [m[1], JSON.parse(m[2])]),
);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const seen = new Set();
const missingCountry = new Set();
const rows = RAW_CITIES.map(([id, name, cc, , lat, lon, tzIndex]) => {
  const zone = CITY_TZS[tzIndex];
  if (!Number.isInteger(id) || id <= 0 || seen.has(id)) throw new Error(`bad or duplicate geonameid ${id}`);
  seen.add(id);
  if (!name || !zone || !/^[A-Za-z0-9_+/-]{1,64}$/.test(zone)) throw new Error(`bad row for ${id}`);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw new Error(`bad position for ${id}`);
  if (!COUNTRIES[cc]) missingCountry.add(cc);
  return `(${q(`g${id}`)}, ${q(name)}, ${q(COUNTRIES[cc] ?? cc)}, ${lat}, ${lon}, ${q(zone)}, ${CITY_JITTER})`;
});

const out = [`-- ${rows.length} cities from src/lib/cities.ts (GeoNames, CC BY 4.0). Written by scripts/gen-places-sql.mjs.`];
for (let i = 0; i < rows.length; i += CHUNK) {
  out.push('insert into public.places (tz, city, country, lat, lon, zone_tz, jitter) values');
  out.push(`  ${rows.slice(i, i + CHUNK).join(',\n  ')};`);
}

const sqlSrc = readFileSync(TARGET, 'utf8');
const b = sqlSrc.indexOf(BEGIN);
const e = sqlSrc.indexOf(END);
if (b < 0 || e < b) throw new Error(`markers not found in ${TARGET}`);
writeFileSync(TARGET, `${sqlSrc.slice(0, b + BEGIN.length)}\n${out.join('\n')}\n${sqlSrc.slice(e)}`);

console.log(`${rows.length} cities, ${CITY_TZS.length} zones -> ${TARGET}`);
if (missingCountry.size) console.log(`country code used as the name for: ${[...missingCountry].sort().join(', ')}`);

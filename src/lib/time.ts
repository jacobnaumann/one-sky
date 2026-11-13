/** Clock and calendar helpers built on Intl only. Nothing here throws. */

const MINUS = '−'; // typographic minus, as in "UTC−5"

const offsetFormatters = new Map<string, Intl.DateTimeFormat | null>();
const clockFormatters = new Map<string, Intl.DateTimeFormat | null>();

function cached(
  cache: Map<string, Intl.DateTimeFormat | null>,
  tz: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat | null {
  let f = cache.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz });
    } catch {
      f = null; // unknown zone
    }
    cache.set(tz, f);
  }
  return f;
}

/** True when the runtime's Intl knows this zone name. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  return (
    cached(offsetFormatters, tz, OFFSET_OPTIONS) !== null
  );
}

const OFFSET_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};

/**
 * Minutes east of UTC for a zone at a moment (Asia/Kolkata -> 330,
 * America/New_York -> -300 in winter, -240 in summer). 0 if the zone or the
 * date is invalid.
 */
export function utcOffsetMinutes(tz: string, date: Date = new Date()): number {
  const ms = date.getTime();
  if (!Number.isFinite(ms) || typeof tz !== 'string' || tz === '') return 0;
  const f = cached(offsetFormatters, tz, OFFSET_OPTIONS);
  if (!f) return 0;
  try {
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(date)) {
      if (part.type !== 'literal') p[part.type] = Number(part.value);
    }
    // Read the zone's wall clock as if it were UTC; the difference is the offset.
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    const offset = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
    return Number.isFinite(offset) ? offset : 0;
  } catch {
    return 0;
  }
}

/**
 * Wall-clock time in a zone, like "3:12 am" (en-US, lowercase am/pm).
 * If the zone is invalid, falls back to this device's own local time, then to
 * UTC arithmetic; an invalid date gives "".
 */
export function localTimeString(tz: string, date: Date = new Date()): string {
  if (!Number.isFinite(date.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  const tidy = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ').toLowerCase();
  try {
    const f = typeof tz === 'string' && tz !== '' ? cached(clockFormatters, tz, options) : null;
    if (f) return tidy(f.format(date));
    return tidy(new Intl.DateTimeFormat('en-US', options).format(date));
  } catch {
    const h = date.getUTCHours();
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'am' : 'pm'}`;
  }
}

/**
 * Which of the 24 whole-hour bands a zone is in right now: an integer 0..23,
 *
 *   ((round(offsetMinutes / 60) % 24) + 24) % 24
 *
 * UTC+0 -> 0, UTC+3 -> 3, UTC-5 -> 19, UTC-11 -> 13.
 * Half-hour zones round half UP (Math.round): UTC+5:30 -> 6, UTC+5:45 -> 6,
 * UTC-3:30 -> -3 -> 21, UTC-9:30 -> -9 -> 15.
 * UTC+13 and UTC+14 land on 13 and 14, sharing a band with UTC-11 and UTC-10
 * (same clock time, different calendar day).
 */
export function zoneIndex(tz: string, date: Date = new Date()): number {
  const hours = Math.round(utcOffsetMinutes(tz, date) / 60);
  return ((hours % 24) + 24) % 24;
}

/**
 * Label for a band from zoneIndex: 0 -> "UTC±0", 3 -> "UTC+3", 12 -> "UTC+12",
 * 19 -> "UTC−5" (indices above 12 read as negative offsets; the minus is U+2212).
 */
export function zoneLabel(i: number): string {
  const n = Number.isFinite(i) ? (((Math.round(i) % 24) + 24) % 24) : 0;
  if (n === 0) return 'UTC±0';
  return n > 12 ? `UTC${MINUS}${24 - n}` : `UTC+${n}`;
}

/** The UTC calendar day, "YYYY-MM-DD". An invalid date gives today's. */
export function utcDay(date: Date = new Date()): string {
  const d = Number.isFinite(date.getTime()) ? date : new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * "just now" (under a minute, or in the future), "12 min ago", "3 h ago",
 * "yesterday" (24-48 h), "2 days ago". An unparseable input gives "".
 */
export function relativeTime(iso: string | Date, now: Date = new Date()): string {
  const then = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  const diff = now.getTime() - then;
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

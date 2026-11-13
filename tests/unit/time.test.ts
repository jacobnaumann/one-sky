import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  localTimeString,
  relativeTime,
  utcDay,
  utcOffsetMinutes,
  zoneIndex,
  zoneLabel,
} from '../../src/lib/time';

const winter = new Date('2026-01-15T12:00:00Z');
const summer = new Date('2026-07-15T12:00:00Z');

describe('utcOffsetMinutes', () => {
  it('reads fixed offsets', () => {
    expect(utcOffsetMinutes('UTC', winter)).toBe(0);
    expect(utcOffsetMinutes('Asia/Kolkata', winter)).toBe(330);
    expect(utcOffsetMinutes('Asia/Kathmandu', winter)).toBe(345);
    expect(utcOffsetMinutes('Asia/Tokyo', summer)).toBe(540);
    expect(utcOffsetMinutes('America/Phoenix', summer)).toBe(-420);
    expect(utcOffsetMinutes('Pacific/Kiritimati', winter)).toBe(840);
    expect(utcOffsetMinutes('Pacific/Pago_Pago', winter)).toBe(-660);
    expect(utcOffsetMinutes('Pacific/Marquesas', winter)).toBe(-570);
  });

  it('follows daylight saving time in both hemispheres', () => {
    expect(utcOffsetMinutes('America/New_York', winter)).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', summer)).toBe(-240);
    expect(utcOffsetMinutes('Europe/London', winter)).toBe(0);
    expect(utcOffsetMinutes('Europe/London', summer)).toBe(60);
    expect(utcOffsetMinutes('Australia/Sydney', winter)).toBe(660);
    expect(utcOffsetMinutes('Australia/Sydney', summer)).toBe(600);
    expect(utcOffsetMinutes('America/St_Johns', summer)).toBe(-150);
  });

  it('is right on either side of a transition and near midnight', () => {
    // US spring forward 2026-03-08 07:00 UTC
    expect(utcOffsetMinutes('America/New_York', new Date('2026-03-08T06:59:59Z'))).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', new Date('2026-03-08T07:00:00Z'))).toBe(-240);
    expect(utcOffsetMinutes('Asia/Tokyo', new Date('2026-12-31T23:59:59.900Z'))).toBe(540);
    expect(utcOffsetMinutes('America/Los_Angeles', new Date('2026-01-01T00:00:00.500Z'))).toBe(-480);
  });

  it('falls back to 0', () => {
    expect(utcOffsetMinutes('Not/AZone', winter)).toBe(0);
    expect(utcOffsetMinutes('', winter)).toBe(0);
    expect(utcOffsetMinutes(undefined as unknown as string, winter)).toBe(0);
    expect(utcOffsetMinutes('Asia/Tokyo', new Date(NaN))).toBe(0);
  });
});

describe('isValidTimeZone', () => {
  it('accepts real zones and rejects the rest', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe('localTimeString', () => {
  it('formats like "3:12 am"', () => {
    expect(localTimeString('UTC', new Date('2026-05-01T03:12:00Z'))).toBe('3:12 am');
    expect(localTimeString('UTC', new Date('2026-05-01T15:05:00Z'))).toBe('3:05 pm');
    expect(localTimeString('UTC', new Date('2026-05-01T00:00:00Z'))).toBe('12:00 am');
    expect(localTimeString('UTC', new Date('2026-05-01T12:30:00Z'))).toBe('12:30 pm');
  });

  it('uses the zone', () => {
    const d = new Date('2026-01-15T12:00:00Z');
    expect(localTimeString('Asia/Kolkata', d)).toBe('5:30 pm');
    expect(localTimeString('America/New_York', d)).toBe('7:00 am');
    expect(localTimeString('Asia/Tokyo', d)).toBe('9:00 pm');
  });

  it('falls back safely', () => {
    expect(localTimeString('Not/AZone', winter)).toMatch(/^\d{1,2}:\d{2} [ap]m$/);
    expect(localTimeString('', winter)).toMatch(/^\d{1,2}:\d{2} [ap]m$/);
    expect(localTimeString(undefined as unknown as string, winter)).toMatch(/^\d{1,2}:\d{2} [ap]m$/);
    expect(localTimeString('UTC', new Date(NaN))).toBe('');
    expect(localTimeString('UTC')).toMatch(/^\d{1,2}:\d{2} [ap]m$/);
  });
});

describe('zoneIndex', () => {
  it('maps offsets onto 0..23', () => {
    expect(zoneIndex('UTC', winter)).toBe(0);
    expect(zoneIndex('Europe/London', winter)).toBe(0);
    expect(zoneIndex('Europe/London', summer)).toBe(1);
    expect(zoneIndex('Europe/Moscow', winter)).toBe(3);
    expect(zoneIndex('America/New_York', winter)).toBe(19); // UTC-5
    expect(zoneIndex('America/New_York', summer)).toBe(20); // UTC-4
    expect(zoneIndex('Pacific/Auckland', summer)).toBe(12);
    expect(zoneIndex('Pacific/Pago_Pago', winter)).toBe(13); // UTC-11
  });

  it('rounds half-hour zones half up', () => {
    expect(zoneIndex('Asia/Kolkata', winter)).toBe(6); // +5:30 -> 6
    expect(zoneIndex('Asia/Kathmandu', winter)).toBe(6); // +5:45 -> 6
    expect(zoneIndex('Asia/Kabul', winter)).toBe(5); // +4:30 -> 5
    expect(zoneIndex('America/St_Johns', winter)).toBe(21); // -3:30 -> -3
    expect(zoneIndex('Pacific/Marquesas', winter)).toBe(15); // -9:30 -> -9
  });

  it('wraps UTC+13 and UTC+14', () => {
    expect(zoneIndex('Pacific/Tongatapu', winter)).toBe(13);
    expect(zoneIndex('Pacific/Kiritimati', winter)).toBe(14);
  });

  it('is 0 for an invalid zone and always an integer in range', () => {
    expect(zoneIndex('Nope/Nope', winter)).toBe(0);
    for (const tz of ['Asia/Tokyo', 'America/Adak', 'Australia/Eucla', 'Pacific/Chatham']) {
      const i = zoneIndex(tz, summer);
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThanOrEqual(23);
    }
  });
});

describe('zoneLabel', () => {
  it('labels each band', () => {
    expect(zoneLabel(0)).toBe('UTC±0');
    expect(zoneLabel(1)).toBe('UTC+1');
    expect(zoneLabel(3)).toBe('UTC+3');
    expect(zoneLabel(12)).toBe('UTC+12');
    expect(zoneLabel(13)).toBe('UTC−11');
    expect(zoneLabel(19)).toBe('UTC−5');
    expect(zoneLabel(23)).toBe('UTC−1');
  });

  it('uses a real minus sign and tolerates odd input', () => {
    expect(zoneLabel(19)).toContain('−');
    expect(zoneLabel(24)).toBe('UTC±0');
    expect(zoneLabel(-5)).toBe('UTC−5');
    expect(zoneLabel(NaN)).toBe('UTC±0');
  });

  it('gives 24 distinct labels', () => {
    expect(new Set(Array.from({ length: 24 }, (_, i) => zoneLabel(i))).size).toBe(24);
  });
});

describe('utcDay', () => {
  it('is the UTC calendar date', () => {
    expect(utcDay(new Date('2026-11-13T00:00:00Z'))).toBe('2026-11-13');
    expect(utcDay(new Date('2026-11-13T23:59:59.999Z'))).toBe('2026-11-13');
    expect(utcDay(new Date('2026-11-14T00:00:00+05:30'))).toBe('2026-11-13');
    expect(utcDay(new Date('2024-02-29T12:00:00Z'))).toBe('2024-02-29');
  });

  it('defaults to today and survives an invalid date', () => {
    expect(utcDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(utcDay(new Date(NaN))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

  it('steps through the units', () => {
    expect(relativeTime(ago(0), now)).toBe('just now');
    expect(relativeTime(ago(59 * S), now)).toBe('just now');
    expect(relativeTime(ago(60 * S), now)).toBe('1 min ago');
    expect(relativeTime(ago(12 * M + 40 * S), now)).toBe('12 min ago');
    expect(relativeTime(ago(59 * M + 59 * S), now)).toBe('59 min ago');
    expect(relativeTime(ago(H), now)).toBe('1 h ago');
    expect(relativeTime(ago(3 * H + 20 * M), now)).toBe('3 h ago');
    expect(relativeTime(ago(23 * H + 59 * M), now)).toBe('23 h ago');
    expect(relativeTime(ago(D), now)).toBe('yesterday');
    expect(relativeTime(ago(47 * H), now)).toBe('yesterday');
    expect(relativeTime(ago(2 * D), now)).toBe('2 days ago');
    expect(relativeTime(ago(40 * D), now)).toBe('40 days ago');
  });

  it('accepts ISO strings', () => {
    expect(relativeTime('2026-11-13T11:48:00Z', now)).toBe('12 min ago');
    expect(relativeTime('2026-11-13T09:00:00.000+00:00', now)).toBe('3 h ago');
  });

  it('treats the future as just now and bad input as empty', () => {
    expect(relativeTime(new Date(now.getTime() + 5 * M), now)).toBe('just now');
    expect(relativeTime('not a date', now)).toBe('');
    expect(relativeTime(new Date(NaN), now)).toBe('');
  });
});

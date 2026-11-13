import { describe, expect, it } from 'vitest';
import { QUESTIONS, questionForDay } from '../../src/lib/questions';

describe('QUESTIONS', () => {
  it('has 70 questions with ids 1..70 in order', () => {
    expect(QUESTIONS).toHaveLength(70);
    QUESTIONS.forEach((q, i) => expect(q.id).toBe(i + 1));
  });

  it('has no duplicates', () => {
    expect(new Set(QUESTIONS.map((q) => q.text.toLowerCase())).size).toBe(70);
  });

  it('keeps every question short, tidy and a question', () => {
    for (const q of QUESTIONS) {
      expect(q.text, q.text).toMatch(/^[A-Z]/);
      expect(q.text, q.text).toMatch(/\?$/);
      expect(q.text.length, q.text).toBeGreaterThanOrEqual(20);
      expect(q.text.length, q.text).toBeLessThanOrEqual(90);
      expect(q.text, q.text).toBe(q.text.trim());
      expect(q.text, q.text).not.toMatch(/\s{2}/);
    }
  });

  it('stays away from identifying details, religion and politics', () => {
    const avoid =
      /\b(your name|address|phone|e-?mail|school|employer|surname|password|birthday|god|pray|church|mosque|temple|religio|vote|election|president|government|party|war)\b/i;
    for (const q of QUESTIONS) expect(q.text, q.text).not.toMatch(avoid);
  });
});

describe('questionForDay', () => {
  it('is days-since-epoch mod 70', () => {
    expect(questionForDay('1970-01-01').id).toBe(1);
    expect(questionForDay('1970-01-02').id).toBe(2);
    expect(questionForDay('1970-03-11').id).toBe(70); // day 69
    expect(questionForDay('1970-03-12').id).toBe(1); // day 70
    const dayNumber = Math.floor(Date.UTC(2026, 10, 13) / 86400000);
    expect(questionForDay('2026-11-13').id).toBe((dayNumber % 70) + 1);
  });

  it('gives the same answer for a string and for any instant of that UTC day', () => {
    const q = questionForDay('2026-11-13');
    expect(questionForDay(new Date('2026-11-13T00:00:00Z'))).toBe(q);
    expect(questionForDay(new Date('2026-11-13T23:59:59.999Z'))).toBe(q);
    expect(questionForDay('2026-11-13T18:30:00Z')).toBe(q);
    // 01:00 on the 14th in Kolkata is still the 13th in UTC
    expect(questionForDay(new Date('2026-11-14T01:00:00+05:30'))).toBe(q);
  });

  it('changes at 00:00 UTC and cycles through all 70 without repeats', () => {
    expect(questionForDay(new Date('2026-11-14T00:00:00Z'))).not.toBe(questionForDay('2026-11-13'));
    const start = Date.UTC(2026, 0, 1);
    const ids = Array.from({ length: 70 }, (_, i) => questionForDay(new Date(start + i * 86400000)).id);
    expect(new Set(ids).size).toBe(70);
    expect(questionForDay(new Date(start + 70 * 86400000)).id).toBe(ids[0]);
    for (let i = 1; i < 70; i++) expect(ids[i]).toBe((ids[i - 1] % 70) + 1);
  });

  it('works before the epoch and with bad input', () => {
    expect(questionForDay('1969-12-31').id).toBe(70);
    expect(QUESTIONS).toContain(questionForDay('not a day'));
    expect(QUESTIONS).toContain(questionForDay(new Date(NaN)));
    expect(QUESTIONS).toContain(questionForDay(undefined as unknown as string));
  });
});

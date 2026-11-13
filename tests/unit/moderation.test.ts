import { describe, expect, it } from 'vitest';
import { MAX_LANTERN_LENGTH, cleanLantern, reasonMessage, type LanternRejection } from '../../src/lib/moderation';

const ok = (raw: string) => {
  const r = cleanLantern(raw);
  expect(r, raw).toMatchObject({ ok: true });
  return r.ok ? r.text : '';
};
const rejected = (raw: string, reason: LanternRejection) =>
  expect(cleanLantern(raw), raw).toEqual({ ok: false, reason });

describe('cleanLantern: tidying', () => {
  it('trims and collapses whitespace and newlines', () => {
    expect(ok('  hello   world  ')).toBe('hello world');
    expect(ok('rain\n\non the\ttin roof\r\n')).toBe('rain on the tin roof');
    expect(ok('one\u00a0\u2003two')).toBe('one two');
  });

  it('strips zero-width and other invisible characters', () => {
    expect(ok('he\u200bllo\ufeff wor\u200cld\u2060')).toBe('hello world');
    expect(ok('\u202ehello\u202c')).toBe('hello');
    expect(ok('soft\u00adhyphen')).toBe('softhyphen');
    expect(ok('a\u200db')).toBe('ab');
  });

  it('keeps emoji, including joined sequences, and other scripts', () => {
    expect(ok('morning 🌅')).toBe('morning 🌅');
    expect(ok('👩\u200d👩\u200d👧 at the table')).toBe('👩\u200d👩\u200d👧 at the table');
    expect(ok('🏳\ufe0f\u200d🌈')).toBe('🏳\ufe0f\u200d🌈');
    expect(ok('朝の音は鳥の声です')).toBe('朝の音は鳥の声です');
    expect(ok('صباح الخير')).toBe('صباح الخير');
    expect(ok('Доброе утро')).toBe('Доброе утро');
    expect(ok('café au lait, s’il vous plaît')).toBe('café au lait, s’il vous plaît');
  });
});

describe('cleanLantern: empty and too long', () => {
  it('rejects nothing-at-all', () => {
    rejected('', 'empty');
    rejected('   \n\t ', 'empty');
    rejected('\u200b\u200b\ufeff', 'empty');
    rejected(undefined as unknown as string, 'empty');
    rejected(null as unknown as string, 'empty');
    rejected(42 as unknown as string, 'empty');
  });

  it('allows exactly 140 characters and rejects 141', () => {
    expect(MAX_LANTERN_LENGTH).toBe(140);
    expect(ok('a'.repeat(140))).toHaveLength(140);
    rejected('a'.repeat(141), 'too_long');
    rejected('word '.repeat(60), 'too_long');
  });

  it('counts code points, not UTF-16 units, after tidying', () => {
    expect(ok('🌙'.repeat(140))).toBe('🌙'.repeat(140)); // 280 UTF-16 units
    rejected('🌙'.repeat(141), 'too_long');
    expect(ok('  ' + 'a'.repeat(140) + '  \n')).toHaveLength(140);
    expect(ok('a'.repeat(70) + '     ' + 'b'.repeat(69))).toHaveLength(140);
  });
});

describe('cleanLantern: links and contact details', () => {
  it('rejects URLs and bare domains', () => {
    for (const s of [
      'see https://example.com',
      'http://x.y',
      'HTTPS://EXAMPLE.COM/page',
      'ftp://files.example',
      'go to www.example.org now',
      'visit example.com',
      'my site is cool-site.io ok',
      'check bit.ly/abc123',
      'youtu.be/dQw4w9WgXcQ',
      't.me/somechannel',
      'find me at example dot com',
      'example.co.uk',
    ]) rejected(s, 'link');
  });

  it('rejects e-mail addresses and @handles', () => {
    for (const s of ['write to me@example.com', 'a.b+c@mail.example.org', 'follow @some_one', '@handle', 'insta: @me.here', 'hi(@user)']) {
      rejected(s, 'link');
    }
  });

  it('rejects phone-like runs of 7 or more digits', () => {
    for (const s of ['call 5551234567', 'call 555-123-4567', '+44 20 7946 0958', '(555) 123-4567', '555.123.4567', '1234567']) {
      rejected(s, 'link');
    }
  });

  it('lets ordinary numbers, times, prices and punctuation through', () => {
    for (const s of [
      'It is 3:12 am and 24 degrees',
      'Up since 5.30 this morning',
      'I walked 12,000 steps in 2026',
      'between 1990 and 2020',
      'bread costs 2.50 here',
      '123456 is not long enough',
      'Rain. Then sun. Then rain again.',
      'It is quiet...really quiet',
      'meet me @ the market',
      'coffee @ 7',
      'e.g. the bakery, i.e. the good one',
      'Mr. Tumnus lives nearby',
      'the U.S.A. is far from here',
      'half past 10. Net result: tired but happy',
    ]) ok(s);
  });
});

describe('cleanLantern: blocked language', () => {
  it('rejects strong profanity and slurs, whatever the case', () => {
    for (const s of ['fuck', 'FUCK this', 'what the Fuck', 'oh shit', 'Shit.', 'you bitch', 'total asshole', 'stupid cunt', 'bullshit', 'motherfucker', 'you fucking idiot', 'shits', 'bitches', 'what a slut', 'kill yourself', 'kys']) {
      rejected(s, 'blocked');
    }
    // slurs: built at runtime so this file does not spell them out
    const slurs = [['n', 'igger'], ['n', 'igga'], ['f', 'aggot'], ['k', 'ike'], ['ch', 'ink'], ['sp', 'ic'], ['ret', 'ard'], ['tr', 'anny']];
    for (const [a, b] of slurs) {
      rejected(`you ${a}${b}`, 'blocked');
      rejected(`${(a + b).toUpperCase()}S!`, 'blocked');
    }
  });

  it('sees through basic leetspeak and symbols', () => {
    for (const s of ['sh1t', '5hit', '$hit', 'b1tch', 'fuck3r', 'a55hole', '@sshole!', 'a$$hole', 'n1gg3r', 'f4gg0t', 'c0ck', 'wh0re']) {
      const r = cleanLantern(s);
      expect(r.ok, s).toBe(false);
    }
    rejected('sh1t', 'blocked');
    rejected('b1tch please', 'blocked');
    rejected('n1gg3r', 'blocked');
    rejected('a55hole', 'blocked');
  });

  it('sees through stretching, spacing, stars and accents', () => {
    for (const s of ['fuuuuuck', 'shiiiit', 'f u c k', 'f.u.c.k', 's-h-i-t', 'f**k', 'sh*t', 'b*tch', 'fück', 'ＦＵＣＫ', 'fu\u200bck']) {
      rejected(s, 'blocked');
    }
  });

  it('does not have the Scunthorpe problem', () => {
    for (const s of [
      'Greetings from Scunthorpe',
      'I need to assess the damage',
      'a classic afternoon',
      'a cocktail on the balcony',
      'the peacock next door is loud',
      'shuttlecock over the fence',
      'Essex, Sussex and Middlesex',
      'reading Dickens by the window',
      'Hancock Street smells of bread',
      'a bass guitar and a glass of water',
      'grass, brass, class, pass, mass',
      'the analyst assembled the cassette',
      'shiitake mushrooms for dinner',
      'Mishima and Matsushita',
      'spice market, spicy soup',
      'a chinking sound of glasses',
      'therapist, title, button, hello',
      'raccoons in the bins again',
      'kumquat and cucumber',
      'I am pushing the pushchair',
      'Shitamachi is the old town',
      'Penistone in Yorkshire',
      'the fire retardant curtains',
      'my hen and a cockerel',
      'so many sunsets',
    ]) ok(s);
  });

  it('does not read plain numbers or prices as leetspeak', () => {
    for (const s of ['bus 455 every morning', 'page 5417', 'costs $5', '$$$ for coffee here', '100% happy', 'I have 455 books and 1 cat', 'a 4x4 and a 5k run']) {
      ok(s);
    }
  });

  it('lets gentle and everyday words through', () => {
    for (const s of ['Damn, that sunset.', 'It is hot as hell today', 'a crappy little kettle that I love', 'I miss my dog', 'the kids are killing time by the river', 'yourself, be kind to it']) ok(s);
  });

  it('checks links before language and length before both', () => {
    rejected('fuck https://example.com', 'link');
    rejected('fuck '.repeat(40), 'too_long');
  });

  it('returns the tidied text on success', () => {
    expect(cleanLantern('  The call of a koel,\n then traffic.  ')).toEqual({ ok: true, text: 'The call of a koel, then traffic.' });
  });
});

describe('reasonMessage', () => {
  const reasons: LanternRejection[] = ['empty', 'too_long', 'link', 'blocked'];

  it('has distinct, kind, human copy for every reason', () => {
    const messages = reasons.map(reasonMessage);
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(15);
      expect(m.length).toBeLessThan(110);
      expect(m).toMatch(/^[A-Z]/);
      expect(m).toMatch(/[.!]$/);
      expect(m).not.toMatch(/error|invalid|forbidden|violat|illegal|!/i);
    }
  });

  it('mentions what matters', () => {
    expect(reasonMessage('too_long')).toContain('140');
    expect(reasonMessage('link')).toMatch(/link/i);
    expect(reasonMessage('empty')).toMatch(/word/i);
  });

  it('never returns undefined', () => {
    expect(typeof reasonMessage('nope' as LanternRejection)).toBe('string');
  });
});

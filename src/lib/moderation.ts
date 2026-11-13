/**
 * Client-side tidy-up and first-line filter for lantern text (the short
 * answers people leave on the globe). This is a courtesy filter, not a
 * security boundary: anything that matters must also be enforced server-side.
 */

export const MAX_LANTERN_LENGTH = 140;

export type LanternRejection = 'empty' | 'too_long' | 'link' | 'blocked';

export type LanternResult =
  | { ok: true; text: string }
  | { ok: false; reason: LanternRejection };

// Invisible characters: zero-width space/non-joiner, word joiner, BOM, soft
// hyphen, bidi marks/embeddings/isolates and other Unicode "format" controls.
const INVISIBLE = /[\u00ad\u034f\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
// A zero-width joiner is kept only where it glues an emoji sequence together.
const STRAY_ZWJ = /(?<![\p{Extended_Pictographic}\ufe0f\u{1f3fb}-\u{1f3ff}])\u200d|\u200d(?!\p{Extended_Pictographic})/gu;
// C0/C1 control characters (tabs and newlines included) become spaces.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Endings that are not also everyday words, so "Fine.It was good" (a missing
// space) is not mistaken for a domain. Anything followed by a path is caught
// by the separate "name.tld/…" pattern.
const TLDS =
  'com|net|org|edu|gov|info|biz|io|ai|co|ly|gg|tv|cc|xyz|app|dev|link|site|online|shop|store|top|club|page|blog|ru|cn|uk|fr|eu|onion';

const LINK_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // scheme://
  /\bwww\s*\./i, // www.
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, // e-mail
  /(?:^|[^\p{L}\p{N}])@[\p{L}\p{N}_.]{2,}/u, // @handle
  new RegExp(`[a-z0-9-]+\\.(?:${TLDS})(?![a-z0-9])`, 'i'), // bare domain
  /[a-z0-9-]+\.[a-z]{2,}\/\S/i, // name.tld/path
  /\bdot\s+(?:com|net|org|io)\b/i, // "example dot com"
  /\d(?:[\s().\-]{0,2}\d){6,}/, // 7+ digits, phone-like
];

/**
 * Whole words (after normalisation). A plural "s"/"es" is also caught.
 * Deliberately compact: strong profanity and the most common English slurs.
 */
const BLOCKED_WORDS = new Set<string>([
  'shit', 'shitty', 'shithead', 'shithole', 'bullshit', 'dipshit', 'horseshit',
  'cunt', 'cock', 'cocksucker', 'pussy', 'pussies', 'whore', 'slut', 'twat', 'wanker',
  'fuk', 'fuking', 'fck', 'fcking', 'fking', 'phuck', 'stfu',
  'fag', 'faggy', 'dyke', 'tranny', 'trannies', 'retard', 'retarded',
  'kike', 'spic', 'chink', 'gook', 'wetback', 'paki', 'raghead', 'towelhead', 'beaner',
  'kys',
]);

/** Blocked wherever they appear inside a word (no innocent English word contains them). */
const BLOCKED_STEMS = ['fuck', 'nigger', 'nigga', 'faggot', 'bitch', 'asshole', 'arsehole'];

const BLOCKED_PHRASES = ['kill yourself', 'kill urself', 'go die'];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', $: 's', '@': 'a' };

function isBlockedWord(word: string): boolean {
  if (!word) return false;
  if (BLOCKED_WORDS.has(word)) return true;
  if (word.endsWith('es') && BLOCKED_WORDS.has(word.slice(0, -2))) return true;
  if (word.endsWith('s') && BLOCKED_WORDS.has(word.slice(0, -1))) return true;
  return BLOCKED_STEMS.some((stem) => word.includes(stem));
}

/** "f**k" style: every literal letter matches a blocked word of the same length. */
function matchesStarred(token: string): boolean {
  const letters = token.replace(/\*/g, '');
  if (letters.length < 2 || token[0] === '*') return false;
  const candidates = [...BLOCKED_WORDS, ...BLOCKED_STEMS];
  return candidates.some(
    (w) => w.length === token.length && [...token].every((ch, i) => ch === '*' || ch === w[i]),
  );
}

function hasBlockedLanguage(text: string): boolean {
  const folded = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const words: string[] = [];
  for (const raw of folded.split(/[^a-z0-9$@*]+/)) {
    if (!raw) continue;
    if (raw.includes('*')) {
      if (matchesStarred(raw)) return true;
      continue;
    }
    // Leetspeak only counts inside something word-like: "455" stays a number.
    const word = /[a-z]/.test(raw)
      ? raw.replace(/[01345$@]/g, (ch) => LEET[ch])
      : raw.replace(/[$@]/g, '');
    if (word) words.push(word);
  }

  // Letters spelled out one at a time ("f u c k", "s.h.i.t") are read as one word.
  const joined: string[] = [];
  let run = '';
  for (const w of [...words, '--']) {
    if (w.length === 1 && /[a-z]/.test(w)) {
      run += w;
    } else {
      if (run.length >= 3) joined.push(run);
      run = '';
    }
  }

  for (const w of [...words, ...joined]) {
    if (isBlockedWord(w)) return true;
    // Stretched letters: "fuuuuck", "shiiit". Only runs of 3+ are squeezed, so
    // ordinary double letters are left alone.
    if (/(.)\1\1/.test(w)) {
      if (isBlockedWord(w.replace(/(.)\1{2,}/g, '$1$1'))) return true;
      if (isBlockedWord(w.replace(/(.)\1{2,}/g, '$1'))) return true;
    }
  }

  const sentence = ` ${words.join(' ')} `;
  return BLOCKED_PHRASES.some((p) => sentence.includes(` ${p} `));
}

/**
 * Tidy and check a lantern.
 *
 * Cleaning: Unicode NFC, invisible characters removed, every run of
 * whitespace (newlines included) collapsed to one space, ends trimmed.
 *
 * Checks, in order:
 *   'empty'    nothing left;
 *   'too_long' more than 140 characters, counted in code points (an emoji is 1+);
 *   'link'     URL, bare domain, e-mail, @handle, or a phone-like run of 7+ digits;
 *   'blocked'  slur or strong profanity, matched on word boundaries after
 *              lowercasing, stripping accents and undoing basic leetspeak
 *              (0→o 1→i 3→e 4→a 5→s $→s @→a).
 */
export function cleanLantern(raw: string): LanternResult {
  const text = (typeof raw === 'string' ? raw : '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(STRAY_ZWJ, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (!text) return { ok: false, reason: 'empty' };
  if ([...text].length > MAX_LANTERN_LENGTH) return { ok: false, reason: 'too_long' };
  if (LINK_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'link' };
  if (hasBlockedLanguage(text)) return { ok: false, reason: 'blocked' };
  return { ok: true, text };
}

const MESSAGES: Record<LanternRejection, string> = {
  empty: 'Write a few words first. Even one is enough.',
  too_long: `That is a little long for a lantern. Try ${MAX_LANTERN_LENGTH} characters or fewer.`,
  link: 'Lanterns carry words only: no links, handles, e-mail addresses or phone numbers.',
  blocked: 'Those words cannot go on a lantern. Try saying it more gently.',
};

/** Kind, plain copy to show next to the input for each rejection reason. */
export function reasonMessage(reason: LanternRejection): string {
  return MESSAGES[reason] ?? 'That could not be sent. Try different words.';
}

/**
 * The daily question. One per UTC day, the same for everyone on Earth.
 *
 * Writing rules for this list: short; warm; concrete; answerable in a sentence
 * by anyone, anywhere, of any age; invites what can be seen, heard, smelled or
 * tasted where the person is. Nothing about religion or politics, nothing that
 * assumes a climate, a season, a kind of home or a kind of work, and nothing
 * that invites a name, an address or other identifying detail.
 *
 * Ids are permanent. Add new questions at the end; never renumber.
 */

export interface Question {
  id: number;
  text: string;
}

const TEXTS: string[] = [
  'What does morning sound like where you are?',
  'What can you see from the nearest window?',
  "What did you eat today that you'd share with a stranger?",
  'What is one small thing the place you live does well?',
  'What is the sky doing right now?',
  'What was the first thing you smelled when you stepped outside today?',
  'What is the nearest tree like?',
  "What sound tells you it's evening where you live?",
  'What food from where you live should everyone taste once?',
  'What colour is the light where you are right now?',
  'What small thing made today better?',
  'What is the weather doing, and how do you feel about it?',
  'What does the air smell like after rain where you live?',
  'What is on the table nearest to you?',
  'How do people greet each other where you live?',
  'Where is the quietest place you know nearby?',
  'What are you drinking right now, or what did you drink last?',
  'What sound would you miss if you moved far away?',
  'What bird, insect or animal did you last notice?',
  'What does the street outside look like at this hour?',
  'What is growing near you right now?',
  'What was the last thing that made you laugh?',
  'What are you looking forward to this week?',
  'What does a good day off look like where you live?',
  'What word in your language do you wish everyone knew, and what does it mean?',
  'Where is the best seat in your home, and what can you see from it?',
  'What is the nicest thing a stranger has said to you lately?',
  'What do people buy to eat on the street where you live?',
  'What happens around you when it gets dark?',
  'What music did you hear recently without choosing it?',
  'What do the clouds look like today, if there are any?',
  'What is the oldest thing you can see from where you are?',
  "What do you do when you can't sleep?",
  'What can you smell cooking, in your kitchen or drifting in from somewhere else?',
  'What does the air feel like on your skin today?',
  'What would a visitor notice first about where you live?',
  'What do you hear if you stop and listen for ten seconds?',
  'What is the kindest thing you saw someone do lately?',
  'What do your hands spend most of the day doing?',
  'What small ritual starts your day?',
  'What was the moon doing the last time you looked?',
  'What games do children play where you live?',
  'What is the best thing to do where you are when it rains?',
  'What is the water nearest to you: a river, the sea, a tap, a puddle?',
  'What did you learn recently that surprised you?',
  'What does almost everyone carry with them where you live?',
  'How did you get around today?',
  'What taste takes you straight back to being small?',
  'What colour do you see most of when you look around right now?',
  'What does the end of the working day sound like where you are?',
  'What are you wearing on your feet right now?',
  'What did you fix, make or finish lately?',
  'What do you wish you could show someone on the other side of the world?',
  'What is a market, shop or stall near you known for?',
  'What do you pass on a walk or ride you take often?',
  'Where is the warmest spot near you right now?',
  'What question have you been turning over lately?',
  'What do people where you live do to cool down, or to warm up?',
  'What is the last thing you read that stayed with you?',
  "What did the day's first light land on where you are?",
  'What do neighbours share with each other where you live?',
  'What would you pack in a picnic for someone visiting from far away?',
  'What is the furthest thing you can see from where you are?',
  'What is one thing you hope tomorrow holds?',
  'What does your home sound like when everyone is asleep?',
  'What did you notice today that you usually walk past?',
  'What plant, animal or kind of weather is your part of the world known for?',
  'What small comfort would you recommend to anyone?',
  'What would you say to someone who is awake while you are asleep?',
  'What is the night like where you are, or what will it be like when it comes?',
];

export const QUESTIONS: Question[] = TEXTS.map((text, i) => ({ id: i + 1, text }));

const DAY_MS = 86400000;

/** Whole days since 1970-01-01 UTC for a Date or a "YYYY-MM-DD" string; NaN if unparseable. */
function utcDayNumber(day: string | Date): number {
  if (day instanceof Date) return Math.floor(day.getTime() / DAY_MS);
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(String(day));
  if (m) return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
  return Math.floor(Date.parse(String(day)) / DAY_MS);
}

/**
 * The question for a UTC day: QUESTIONS[daysSinceEpoch mod 70]. Accepts a Date
 * (its UTC day is used) or a "YYYY-MM-DD" string such as utcDay() returns.
 * Everyone in the world gets the same question, and it changes at 00:00 UTC.
 * An unparseable day falls back to today's question.
 */
export function questionForDay(day: string | Date): Question {
  let n = utcDayNumber(day);
  if (!Number.isFinite(n)) n = Math.floor(Date.now() / DAY_MS);
  const len = QUESTIONS.length;
  return QUESTIONS[((n % len) + len) % len];
}

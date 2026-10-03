/**
 * Threadboner quote-of-the-day engine.
 *
 * The dataset is 70 curated lines drawn verbatim from the Threadborn
 * manuscripts held in this repo. It is embedded as a literal rather than read
 * from disk so the serverless function has no filesystem dependency at
 * runtime and cannot fail to boot because a manuscript moved.
 */

"use strict";

const QUOTES = [
  { id: "q001", text: "Maybe because he had died alone on wet asphalt and did not want his second life to begin by assuming everyone would leave.", source: "Vol 1 · Ch 1", tag: "worth" },
  { id: "q002", text: "The seal that broke without a reason does not reseal. That is not how this works.", source: "EX · 21.2 — Critical Decision Points", tag: "worth" },
  { id: "q003", text: "The door from the forest was never going to stay quiet once it learned who was standing in front of it.", source: "Vol 2 · Ch 1", tag: "door" },
  { id: "q004", text: "\"Mercy,\" Velkor whispered, \"is only another door. Open it and I will use it.\"", source: "Vol 2 · Ch 2", tag: "door" },
  { id: "q005", text: "Threadborn is about a boy who keeps choosing people even when the world keeps proving that power alone is not enough.", source: "EX · The Goal of Threadborn", tag: "worth" },
  { id: "q006", text: "The power that comes back with each broken seal is not a new tool.", source: "EX · 7.4 — What Breaking Feels Like", tag: "power" },
  { id: "q007", text: "Violet is not powerful because flowers are pretty. She is powerful because flowers remember growth, death, patience, and return.", source: "EX · Violet's Concepts and Divine…", tag: "death" },
  { id: "q008", text: "\"Back in my world, I was not brave. I was not special. I bought cheap food, walked home, and imagined being important while doing nothing important.\"", source: "Vol 1 · Ch 4", tag: "world" },
  { id: "q009", text: "Her hidden truth is that she is terrified every time someone arrives at her door.", source: "EX · 14.3 — Her Hidden Truth", tag: "door" },
  { id: "q010", text: "She puts warm stored breaths in the jar she keeps in the spot that was always empty.", source: "EX · 21.2 — Critical Decision Points", tag: "world" },
  { id: "q011", text: "The easy answer was yes. The heroic answer was never.", source: "Vol 1 · Ch 3", tag: "world" },
  { id: "q012", text: "A seal opens because pain demands it, and everyone learns that a miracle can still arrive as an injury.", source: "EX · Choosing Power Before Consent", tag: "world" },
  { id: "q013", text: "\"If you were not scared, you would be broken or stupid.\"", source: "Vol 1 · Ch 2", tag: "world" },
  { id: "q014", text: "He had been the most powerful thing in every room he occupied and the most alone, and eventually those two facts had become the same fact.", source: "Vol 2 · Ch 3", tag: "worth" },
  { id: "q015", text: "She updates and moves on and the thing she is trying to outrun with perfect precision is the memory of when precision was not enough.", source: "EX · 16.2 — Her Hidden Truth", tag: "memory" },
  { id: "q016", text: "In the early years after the Unraveling, they were called other things. Most of those other names were not kind.", source: "EX · 1.2 — The Rise of Thread Seers and…", tag: "world" },
  { id: "q017", text: "The Thread network is not simply a feature of Asteria.", source: "EX · 1.2 — The Rise of Thread Seers and…", tag: "thread" },
  { id: "q018", text: "What comes back through a cord that breaks without a reason is not a recovered ability.", source: "EX · 21.2 — Critical Decision Points", tag: "power" },
  { id: "q019", text: "Something witnessed is not the same as something remembered alone.", source: "EX · 21.2 — Critical Decision Points", tag: "worth" },
  { id: "q020", text: "The pressure it exerts on the Thread membrane is not aggression.", source: "EX · 5.1 — The Unnamed Presence", tag: "thread" },
  { id: "q021", text: "Because being vast and alone is not the same as being strong.", source: "EX · 7.2 — The Crown That Was Buried", tag: "worth" },
  { id: "q022", text: "Power she had been choosing not to look at, in the way that a person sometimes does not open a drawer because they are not ready for what is in it.", source: "EX · 8.1 — What Concepts Are", tag: "power" },
  { id: "q023", text: "The door opened more because the person standing next to her was not frightened of what was behind it.", source: "EX · 8.2 — Why Violet Was Smaller Than She…", tag: "door" },
  { id: "q024", text: "This door will not use children is not a wish. It is a declaration of a new operating parameter.", source: "EX · 9.2 — The Limits of Rule Maker", tag: "door" },
  { id: "q025", text: "This was not how heroes usually arrived in another world.", source: "Vol 1 · Ch 2", tag: "world" },
  { id: "q026", text: "This was the skill balance the world kept forcing on them. Horror at the door. Warmth in the room. One bad choice between them.", source: "Vol 1 · Ch 4", tag: "door" },
  { id: "q027", text: "A stone door standing alone between dead trees.", source: "Vol 1 · Ch 5", tag: "worth" },
  { id: "q028", text: "The second break in the seal sounded like old law snapping.", source: "Vol 2 · Ch 2", tag: "time" },
  { id: "q029", text: "The first seal did not crack that time. It broke. Completely. Cleanly. The way something breaks when it has done its job and is ready to be done.", source: "Vol 2 · Ch 3", tag: "time" },
  { id: "q030", text: "What came through was not a power with a name yet.", source: "Vol 2 · Ch 5", tag: "power" },
  { id: "q031", text: "When Mirika asks what it is like to break a seal, Yono says: something that was always yours coming back. Not new. Just returned.", source: "EX · 7.4 — What Breaking Feels Like", tag: "time" },
  { id: "q032", text: "In which the seal finally gets its reason, someone loses their shirt, and the source stops recalculating.", source: "Vol 1 · Codex", tag: "worth" },
  { id: "q033", text: "It was already broken. It broke the first time Violet chose to be present beside him instead of above him.", source: "EX · 21.2 — Critical Decision Points", tag: "time" },
  { id: "q034", text: "Yono's reason was that being vast and alone was not the same as being strong. He wanted something worth growing for.", source: "EX · 8.2 — Why Violet Was Smaller Than She…", tag: "worth" },
  { id: "q035", text: "\"That is the most suspicious sentence in every world.\"", source: "Vol 1 · Ch 1", tag: "world" },
  { id: "q036", text: "\"Many people need help. You have one child on your back and one city in front of you. Choose the next step, not every step.\"", source: "Vol 1 · Ch 2", tag: "worth" },
  { id: "q037", text: "\"It took his hands first. Then his voice. Then every memory of him from everyone in the room except me.\"", source: "Vol 2 · Ch 3", tag: "memory" },
  { id: "q038", text: "\"And every time he does, the gap between what he is and what I am \"", source: "Vol 2 · Ch 6", tag: "time" },
  { id: "q039", text: "Nobody who was born in the current age of Asteria knows what the world felt like during the Age of First Weaving.", source: "EX · 1.1 — The Age of First Weaving", tag: "world" },
  { id: "q040", text: "The sudden absence of every Thread they had ever taken for granted.", source: "EX · 1.1 — The Age of First Weaving", tag: "thread" },
  { id: "q041", text: "She updates her assumptions every time she is wrong.", source: "EX · Side Story — Lyra's First Wrong…", tag: "time" },
  { id: "q042", text: "Every gold cord hanging in the hall is a sealed version of something he used to be able to do.", source: "EX · 7.1 — What the Black Hall Is", tag: "world" },
  { id: "q043", text: "Because the convenience store was a choice nobody else made for him.", source: "EX · 7.2 — The Crown That Was Buried", tag: "world" },
  { id: "q044", text: "The slowed world made the wound worse. It let him see every drop leave him slowly, like his body was explaining the problem in detail.", source: "Vol 1 · Ch 2", tag: "world" },
  { id: "q045", text: "\"It was,\" Mirika replied. \"Until he decided every living thing was born owing a debt.\"", source: "Vol 2 · Ch 1", tag: "debt" },
  { id: "q046", text: "No one spoke until the door was far behind them.", source: "Vol 2 · Ch 1", tag: "door" },
  { id: "q047", text: "The white of something that had been every color long enough to forget the individual ones.", source: "Vol 2 · Ch 4", tag: "memory" },
  { id: "q048", text: "\"Velkor fell,\" the figure said. His voice was not loud. It was simply the only voice in the room. \"I came to collect the file.\"", source: "Vol 2 · Ch 4", tag: "world" },
  { id: "q049", text: "Damage Denial: Active. Hits register only by his choice.", source: "Vol 1 · Codex", tag: "world" },
  { id: "q050", text: "It was small, wet, and proud in the way only cats can be proud while looking like a soaked towel. One paw hung over the edge.", source: "Vol 1 · Ch 1", tag: "world" },
  { id: "q051", text: "\"Do not waste the second life I am giving you.\"", source: "Vol 1 · Ch 1", tag: "worth" },
  { id: "q052", text: "\"I promise I will try with everything I have.\"", source: "Vol 1 · Ch 2", tag: "promise" },
  { id: "q053", text: "\"Then I died because I tried to help a cat and a goddess made it worse.\"", source: "Vol 1 · Ch 4", tag: "death" },
  { id: "q054", text: "\"Please do not become nice right before a death door.\"", source: "Vol 1 · Ch 5", tag: "death" },
  { id: "q055", text: "\"Thread echo. If the door has him, it can pull true words from him and place them inside a lie.\"", source: "Vol 1 · Ch 5", tag: "thread" },
  { id: "q056", text: "\"No. Take it when you go. Bring it back when the door cannot say my name anymore.\"", source: "Vol 1 · Ch 5", tag: "time" },
  { id: "q057", text: "\"He started collecting from people who had promised nothing.\"", source: "Vol 2 · Ch 1", tag: "promise" },
  { id: "q058", text: "\"Touched means something tried to reach you. Owned means it gets to keep you. We are not letting that happen.\"", source: "Vol 2 · Ch 1", tag: "world" },
  { id: "q059", text: "\"I'm not I don't \" She stopped. \"This is not a conversation I'm having.\"", source: "Vol 2 · Ch 6", tag: "world" },
  { id: "q060", text: "\"Yes. And now he knows about Thread Edict. He won't underestimate the Edict next time.\"", source: "Vol 1 · Codex", tag: "thread" },
  { id: "q061", text: "The latest Yono is always the strongest Yono.", source: "Vol 2 · Ch 3", tag: "world" },
  { id: "q062", text: "The permanent seal was in the archive as evidence that the entity who owned Thread Cut had placed it themselves.", source: "EX · 10.2 — Why It Was Sealed", tag: "thread" },
  { id: "q063", text: "That instinct is not something the black hall gave him.", source: "EX · 11.1 — Before the Bridge", tag: "world" },
  { id: "q064", text: "The anger, if she examined it, was not entirely about Cadreth.", source: "EX · 12.2 — What She Was Before the Bridge", tag: "world" },
  { id: "q065", text: "She allows herself, occasionally, to feel something that is not professional.", source: "EX · 16.2 — Her Hidden Truth", tag: "world" },
  { id: "q066", text: "Your file is not keeping up with you, he says.", source: "EX · 18.2 — The White Eyes", tag: "world" },
  { id: "q067", text: "Then it was not a solution to a problem. It was the problem.", source: "EX · 19.1 — What He Was", tag: "world" },
  { id: "q068", text: "Asteria in the Age of First Weaving was not a different place.", source: "EX · 1.1 — The Age of First Weaving", tag: "world" },
  { id: "q069", text: "That the world simply reached a point where the weight of all that accumulated emotional resonance became more than the Thread network could hold.", source: "EX · 1.1 — The Age of First Weaving", tag: "thread" },
  { id: "q070", text: "Not gone. Silent. Like a voice that has been shouting all its life suddenly losing the ability to speak above a whisper.", source: "EX · 1.1 — The Age of First Weaving", tag: "worth" },
];

// djb2 — small, stable, and identical in every JS runtime. This is NOT
// Math.random on purpose: every visitor on a given date must resolve to the
// same quote, otherwise the page would flicker on refresh and the response
// could never be cached at the edge until midnight.
function stableHash(input) {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getQuotes() {
  return QUOTES;
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function pickForDate(isoDate, offset) {
  const pool = QUOTES;
  if (!pool.length) return null;
  const step = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const base = stableHash(String(isoDate));
  // positive modulo so a negative offset can never index below zero
  const index = ((base + step) % pool.length + pool.length) % pool.length;
  return pool[index];
}

function getTags() {
  const seen = Object.create(null);
  for (let i = 0; i < QUOTES.length; i++) seen[QUOTES[i].tag] = true;
  return Object.keys(seen).sort();
}

function filterQuotes(options) {
  const opts = options || {};
  const tag = opts.tag ? String(opts.tag).toLowerCase() : null;
  let out = QUOTES;
  if (tag) out = out.filter((q) => String(q.tag).toLowerCase() === tag);
  const limit = Number(opts.limit);
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, Math.trunc(limit));
  return out;
}

module.exports = { getQuotes, isValidIsoDate, pickForDate, getTags, filterQuotes, stableHash };

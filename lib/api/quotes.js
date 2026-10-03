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
  { id: "q001", text: "\"Back in my world, I was not brave. I was not special. I bought cheap food, walked home, and imagined being important while doing nothing important.\"", source: "Vol 1 · Ch 4", tag: "memory" },
  { id: "q002", text: "Every chapter. Every choice. Every moment he decides to stay human instead of becoming something that cannot be spoken to over a breakfast table.", source: "EX · The Crown That Was Buried", tag: "worth" },
  { id: "q003", text: "He had been the most powerful thing in every room he occupied and the most alone, and eventually those two facts had become the same fact.", source: "Vol 2 · Ch 3", tag: "power" },
  { id: "q004", text: "Maybe because he had died alone on wet asphalt and did not want his second life to begin by assuming everyone would leave.", source: "Vol 1 · Ch 1", tag: "death" },
  { id: "q005", text: "The first seal did not crack that time. It broke. Completely. Cleanly. The way something breaks when it has done its job and is ready to be done.", source: "Vol 2 · Ch 3", tag: "power" },
  { id: "q006", text: "The seal that broke without a reason does not reseal. That is not how this works.", source: "EX · Route FRACTURE", tag: "power" },
  { id: "q007", text: "This was the skill balance the world kept forcing on them. Horror at the door. Warmth in the room. One bad choice between them.", source: "Vol 1 · Ch 4", tag: "door" },
  { id: "q008", text: "Violet is not powerful because flowers are pretty. She is powerful because flowers remember growth, death, patience, and return.", source: "EX · Violet, Explained", tag: "power" },
  { id: "q009", text: "Threadborn is about a boy who keeps choosing people even when the world keeps proving that power alone is not enough.", source: "EX · The Goal of Threadborn", tag: "worth" },
  { id: "q010", text: "The easy answer was yes. The heroic answer was never.", source: "Vol 1 · Ch 3", tag: "worth" },
  { id: "q011", text: "\"It took his hands first. Then his voice. Then every memory of him from everyone in the room except me.\"", source: "Vol 2 · Ch 3", tag: "memory" },
  { id: "q012", text: "She updates and moves on and the thing she is trying to outrun with perfect precision is the memory of when precision was not enough.", source: "EX · Her Hidden Truth", tag: "memory" },
  { id: "q013", text: "He had been in a bed with his girlfriend and the lamp burning low and he had not brought everyone home.", source: "Vol 2 · Ch 5", tag: "memory" },
  { id: "q014", text: "The black hall opened in his mind, and the next cords waited. So many of them. Too many to count. Power beyond power, sealed behind decisions he had made before he had a name.", source: "Vol 2 · Ch 2", tag: "power" },
  { id: "q015", text: "She watched him put the bag down and hold out his hands to a cat he did not know in a way that contained everything the Thread had promised her was real about him.", source: "EX · The Night Violet Chose the Bridge", tag: "thread" },
  { id: "q016", text: "A Thread is a bond made visible.", source: "EX · What Threads Actually Are", tag: "thread" },
  { id: "q017", text: "\"This is why old seals are feared. They do not only trap bodies. They learn what a person means to other people.\"", source: "Vol 1 · Ch 5", tag: "memory" },
  { id: "q018", text: "\"Mercy,\" Velkor whispered, \"is only another door. Open it and I will use it.\"", source: "Vol 2 · Ch 2", tag: "door" },
  { id: "q019", text: "The door from the forest was never going to stay quiet once it learned who was standing in front of it.", source: "Vol 2 · Ch 1", tag: "door" },
  { id: "q020", text: "He had not had a name then. Names are for things that need to be called. He had simply been.", source: "Vol 2 · Ch 3", tag: "worth" },
  { id: "q021", text: "Not gone. Silent. Like a voice that has been shouting all its life suddenly losing the ability to speak above a whisper.", source: "EX · The Age of First Weaving", tag: "thread" },
  { id: "q022", text: "Some clapped hands over their ears. Some cried. One guard curled on the ground and whispered an apology to someone who was not there.", source: "Vol 1 · Ch 3", tag: "memory" },
  { id: "q023", text: "He was not miserable. He was not in despair. He was not the kind of person with a tragic backstory that makes death feel like destiny.", source: "EX · Before the Bridge", tag: "death" },
  { id: "q024", text: "\"When I heard Liri scream, I thought if I ran away, then my second life would start with me proving I had learned nothing from the first one.\"", source: "Vol 1 · Ch 4", tag: "death" },
  { id: "q025", text: "\"Then I died because I tried to help a cat and a goddess made it worse.\"", source: "Vol 1 · Ch 4", tag: "death" },
  { id: "q026", text: "It was small, wet, and proud in the way only cats can be proud while looking like a soaked towel. One paw hung over the edge.", source: "Vol 1 · Ch 1", tag: "world" },
  { id: "q027", text: "He does not have a manifesto. He does not have a plan to destroy Asteria. He is not aligned with any cosmic force or working toward any ideological goal.", source: "EX · What Velkor Was Doing", tag: "world" },
  { id: "q028", text: "In which a young man dies for a cat, meets a goddess, and learns that destiny has terrible timing.", source: "Vol 1 · Ch 1", tag: "death" },
  { id: "q029", text: "In which the seal finally gets its reason, someone loses their shirt, and the source stops recalculating.", source: "Vol 2 · Ch 7", tag: "thread" },
  { id: "q030", text: "\"I think the reason I'm growing is the same reason you are.\" She did not look at him. \"Because you exist. Because you need an anchor, and an anchor that can't keep up isn't one.\"", source: "Vol 2 · Ch 4", tag: "thread" },
  { id: "q031", text: "She puts warm stored breaths in the jar she keeps in the spot that was always empty.", source: "EX · Meryn and Rell", tag: "memory" },
  { id: "q032", text: "Something witnessed is not the same as something remembered alone.", source: "EX · Mirika Outside the Circle", tag: "memory" },
  { id: "q033", text: "Power she had been choosing not to look at, in the way that a person sometimes does not open a drawer because they are not ready for what is in it.", source: "EX · What Concepts Are", tag: "power" },
  { id: "q034", text: "The door opened more because the person standing next to her was not frightened of what was behind it.", source: "EX · Why Violet Was Smaller Than She Is", tag: "door" },
  { id: "q035", text: "It was already broken. It broke the first time Violet chose to be present beside him instead of above him.", source: "EX · Route VIOLET", tag: "door" },
  { id: "q036", text: "A seal opens because pain demands it, and everyone learns that a miracle can still arrive as an injury.", source: "EX · Route FRACTURE: Choosing Power Before Consent", tag: "power" },
  { id: "q037", text: "\"I do not want to become someone who only notices damage when it happens to me.\"", source: "Vol 2 · Ch 2", tag: "worth" },
  { id: "q038", text: "The slowed world made the wound worse. It let him see every drop leave him slowly, like his body was explaining the problem in detail.", source: "Vol 1 · Ch 2", tag: "death" },
  { id: "q039", text: "\"Many people need help. You have one child on your back and one city in front of you. Choose the next step, not every step.\"", source: "Vol 1 · Ch 2", tag: "promise" },
  { id: "q040", text: "\"No. Take it when you go. Bring it back when the door cannot say my name anymore.\"", source: "Vol 1 · Ch 5", tag: "promise" },
  { id: "q041", text: "\"Touched means something tried to reach you. Owned means it gets to keep you. We are not letting that happen.\"", source: "Vol 2 · Ch 1", tag: "thread" },
  { id: "q042", text: "\"It was,\" Mirika replied. \"Until he decided every living thing was born owing a debt.\"", source: "Vol 2 · Ch 1", tag: "debt" },
  { id: "q043", text: "\"Do not waste the second life I am giving you.\"", source: "Vol 1 · Ch 1", tag: "debt" },
  { id: "q044", text: "\"You mean the second life you owe me.\"", source: "Vol 1 · Ch 1", tag: "debt" },
  { id: "q045", text: "\"He started collecting from people who had promised nothing.\"", source: "Vol 2 · Ch 1", tag: "debt" },
  { id: "q046", text: "\"Please do not become nice right before a death door.\"", source: "Vol 1 · Ch 5", tag: "door" },
  { id: "q047", text: "\"Thread echo. If the door has him, it can pull true words from him and place them inside a lie.\"", source: "Vol 1 · Ch 5", tag: "door" },
  { id: "q048", text: "The other landed in his body like something that had been waiting outside a locked door for a very long time and had finally been let in.", source: "Vol 2 · Ch 7", tag: "door" },
  { id: "q049", text: "The way something leaves when the room has decided it is not staying.", source: "Vol 2 · Ch 7", tag: "door" },
  { id: "q050", text: "\"If you were not scared, you would be broken or stupid.\"", source: "Vol 1 · Ch 2", tag: "worth" },
  { id: "q051", text: "\"That is the most suspicious sentence in every world.\"", source: "Vol 1 · Ch 1", tag: "world" },
  { id: "q052", text: "This was not how heroes usually arrived in another world.", source: "Vol 1 · Ch 2", tag: "world" },
  { id: "q053", text: "In which a safehouse is not as safe as it wants to be, and Yono learns why people keep choosing each other anyway.", source: "Vol 1 · Ch 4", tag: "thread" },
  { id: "q054", text: "In which one night holds everything good, and morning takes it.", source: "Vol 2 · Ch 5", tag: "time" },
  { id: "q055", text: "Silence hit the clearing. Then the seal failed to heal.", source: "Vol 2 · Ch 1", tag: "time" },
  { id: "q056", text: "\"I think so. Being stronger does not mean arriving sooner. It does not mean knowing where every strike lands. It does not mean no one gets hurt.\"", source: "Vol 2 · Ch 2", tag: "power" },
  { id: "q057", text: "\"Velkor fell,\" the figure said. His voice was not loud. It was simply the only voice in the room. \"I came to collect the file.\"", source: "Vol 2 · Ch 4", tag: "debt" },
  { id: "q058", text: "The white of something that had been every color long enough to forget the individual ones.", source: "Vol 2 · Ch 4", tag: "world" },
  { id: "q059", text: "The second break in the seal sounded like old law snapping.", source: "Vol 2 · Ch 2", tag: "power" },
  { id: "q060", text: "The power that comes back with each broken seal is not a new tool.", source: "EX · What Breaking Feels Like", tag: "power" },
  { id: "q061", text: "\"This time we open the door together.\"", source: "Vol 1 · Ch 4", tag: "door" },
  { id: "q062", text: "Yono's reason was that being vast and alone was not the same as being strong. He wanted something worth growing for.", source: "EX · Why Violet Was Smaller", tag: "worth" },
  { id: "q063", text: "Because being vast and alone is not the same as being strong.", source: "EX · The Crown That Was Buried", tag: "power" },
  { id: "q064", text: "What comes back through a cord that breaks without a reason is not a recovered ability.", source: "EX · Route FRACTURE", tag: "power" },
  { id: "q065", text: "She updates her assumptions every time she is wrong.", source: "EX · Lyra, First Wrong Assumption", tag: "worth" },
  { id: "q066", text: "She has already decided that the people in her current memories are more than a price.", source: "EX · Route MIRIKA", tag: "memory" },
  { id: "q067", text: "She is not sure it feels like debt anymore.", source: "EX · The Night Violet Chose the Bridge", tag: "debt" },
  { id: "q068", text: "He had been knowing it for a very long time on the other side of the seal.", source: "EX · The Black Hall Before Yono", tag: "time" },
  { id: "q069", text: "In the early years after the Unraveling, they were called other things. Most of those other names were not kind.", source: "EX · The Rise of Thread Seers", tag: "world" },
  { id: "q070", text: "He keeps her honest about what she is not looking at.", source: "EX · Route LYRA", tag: "worth" },
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

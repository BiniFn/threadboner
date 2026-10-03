/**
 * Threadboner line-of-the-day engine.
 *
 * The dataset is 70 original teaser lines written for the countdown page.
 * They are deliberately NOT excerpts from the manuscripts in this repo: those
 * contain unreleased Volume 2 and EX material, and the whole point of the page
 * is that it stays sealed until 31 December. Quoting the book one line a day
 * was leaking the reveal.
 *
 * Every line also carries a second, encoded meaning in `cryptic`. The form is
 * not recorded — the reader has to identify it, the same way the rest of the
 * hunt on the page works. All five ciphers in use here (rot13, caesar+3,
 * base64, reversed, morse) decode back to plain English.
 *
 * The array is embedded as a literal so the serverless function has no
 * filesystem dependency and cannot fail to boot because a file moved.
 */

"use strict";

const QUOTES = [
  { id: "l001", text: "The thread does not care who pulled it. Only that it was pulled, and who is owed for it.", source: "Threadboner", tag: "thread", cryptic: "pbhag gur xabgf" },
  { id: "l002", text: "I counted the doors in the eastern wall. The building remembers five.", source: "Threadboner", tag: "door", cryptic: "erzrzoref svir" },
  { id: "l003", text: "Every seal I opened cost the same, and I have not paid the first one.", source: "Threadboner", tag: "power", cryptic: "qrw sdlg bhw" },
  { id: "l004", text: "I owe nothing. That is what everyone here says before the first door opens.", source: "Threadboner", tag: "debt", cryptic: "orsber gur svefg" },
  { id: "l005", text: "I remember the bridge. I do not remember deciding to step onto it.", source: "Threadboner", tag: "memory", cryptic: "-... .-. .. -.. --. ." },
  { id: "l006", text: "Dying here is cheap. The paperwork for dying twice is not.", source: "Threadboner", tag: "death", cryptic: "eloo iru gblqj" },
  { id: "l007", text: "I made a promise to someone who does not remember making it. Keeping it is the whole job.", source: "Threadboner", tag: "promise", cryptic: "a2VlcGluZyBpdA==" },
  { id: "l008", text: "I can lift the wall with one hand. What I cannot lift is the conversation after.", source: "Threadboner", tag: "power", cryptic: "gur pbairefngvba" },
  { id: "l009", text: "A door opened from the wrong side is still a door. That is the problem.", source: "Threadboner", tag: "door", cryptic: "d3Jvbmcgc2lkZQ==" },
  { id: "l010", text: "I tied a thread to a door handle in a city that no longer exists. The door remembers me.", source: "Threadboner", tag: "thread", cryptic: "gur qbbe vf jnvgvat" },
  { id: "l011", text: "The dead keep better accounts than the living. Nobody will give you the itemised bill.", source: "Threadboner", tag: "death", cryptic: "YXNrIGZvciB0aGUgYmlsbA==" },
  { id: "l012", text: "Nobody here asks where you are from. They ask who you owe.", source: "Threadboner", tag: "world", cryptic: "jub lbh bjr" },
  { id: "l013", text: "Memory in this world has a seam. Pull the wrong thread and the panel comes loose.", source: "Threadboner", tag: "memory", cryptic: "c2VhbQ==" },
  { id: "l014", text: "Threads fray. That is how you know they were real and not decoration.", source: "Threadboner", tag: "thread", cryptic: "laer dna daol" },
  { id: "l015", text: "Promises here are knots. Pull the wrong one and the whole rope remembers it.", source: "Threadboner", tag: "promise", cryptic: "gur jubyr ebcr" },
  { id: "l016", text: "He died twice and paid once. Nobody in this world audits that.", source: "Threadboner", tag: "death", cryptic: "abobql nhqvgf" },
  { id: "l017", text: "Power here is a loan. The interest is paid in things you did not know you had.", source: "Threadboner", tag: "power", cryptic: "aW50ZXJlc3QgaXMgcGFpZA==" },
  { id: "l018", text: "The door was warm. Doors in this country are either freezing or on fire, so I noticed.", source: "Threadboner", tag: "door", cryptic: ".-- .- .-. --" },
  { id: "l019", text: "Time here runs on a lean. It gives you less than you asked and charges for the difference.", source: "Threadboner", tag: "time", cryptic: "yrff guna" },
  { id: "l020", text: "Worth in this world is measured in what you can still afford to lose.", source: "Threadboner", tag: "worth", cryptic: "nssbeq gb ybfr" },
  { id: "l021", text: "Everyone here remembers me slightly wrong. I keep the correct version in a drawer with no handle.", source: "Threadboner", tag: "memory", cryptic: "ab unaqyr ba guvf" },
  { id: "l022", text: "Cut the wrong thread and you will meet the person who was holding the other end.", source: "Threadboner", tag: "thread", cryptic: "krog wkh rwkhu hqg" },
  { id: "l023", text: "The debt was inherited. I did not know the person who took it on my behalf.", source: "Threadboner", tag: "debt", cryptic: "qrw wkh shuvrq" },
  { id: "l024", text: "The dead do not haunt. They check again.", source: "Threadboner", tag: "death", cryptic: ".- --. .- .. -." },
  { id: "l025", text: "The world here has rules. I have read them. I intend to disagree with about a third of them.", source: "Threadboner", tag: "world", cryptic: "n guveq bs gurz" },
  { id: "l026", text: "I said I would come back. I said it to a wall. The wall is still waiting and now so is everyone else.", source: "Threadboner", tag: "promise", cryptic: "frph edfn" },
  { id: "l027", text: "Lumera keeps its promises. It keeps them the way a river keeps a stone. It goes around.", source: "Threadboner", tag: "world", cryptic: "lw jrhv durxqg" },
  { id: "l028", text: "Nobody here remembers the dead. The dead remember each other, and they are thorough.", source: "Threadboner", tag: "memory", cryptic: "su rebmemer yeht" },
  { id: "l029", text: "Everyone asks what I can do. Nobody asks what it costs. I prefer the second crowd.", source: "Threadboner", tag: "power", cryptic: "gur frpbaq pebjq" },
  { id: "l030", text: "Every door wants something. The expensive ones ask twice.", source: "Threadboner", tag: "door", cryptic: "eciwt ksa" },
  { id: "l031", text: "She offered me a thread. It came with a debt already sewn into it.", source: "Threadboner", tag: "thread", cryptic: "ZGVidCB3YXMgc2V3biBpbg==" },
  { id: "l032", text: "Interest in this world is charged daily and never itemised.", source: "Threadboner", tag: "debt", cryptic: "Y2hhcmdlZCBkYWlseQ==" },
  { id: "l033", text: "I have written my own death three times. Twice it was wrong.", source: "Threadboner", tag: "death", cryptic: "gnorw saw ti" },
  { id: "l034", text: "I traded a memory for a door. Fair price. I still cannot say which memory.", source: "Threadboner", tag: "memory", cryptic: "zklfk phprub" },
  { id: "l035", text: "The promise I keep is the one nobody asked me to make.", source: "Threadboner", tag: "promise", cryptic: "deksa ydobon" },
  { id: "l036", text: "I broke a door open with my bare hands. The door was not impressed. It never is.", source: "Threadboner", tag: "power", cryptic: "si reven ti" },
  { id: "l037", text: "I will meet you in a week. Out here a week is a rumour, and rumours are late.", source: "Threadboner", tag: "time", cryptic: "uxprxuv duh odwh" },
  { id: "l038", text: "Nothing here is impossible. Plenty of things are simply expensive, badly arranged, or both.", source: "Threadboner", tag: "world", cryptic: "YmFkbHkgYXJyYW5nZWQ=" },
  { id: "l039", text: "Four threads, one per person who refused to let go of me.", source: "Threadboner", tag: "thread", cryptic: "yrg tb bs zr" },
  { id: "l040", text: "Someone paid for me once. I have been repaying interest on a debt I did not sign.", source: "Threadboner", tag: "debt", cryptic: "ngis ton did" },
  { id: "l041", text: "Grief in this place has a weight to it. Grief anywhere else is just weather.", source: "Threadboner", tag: "death", cryptic: "whfg jrngure" },
  { id: "l042", text: "Memory is the cheapest thing they take and the hardest thing to give back.", source: "Threadboner", tag: "memory", cryptic: "uneq gb erghea" },
  { id: "l043", text: "A promise is a thread you can cut but not unpick.", source: "Threadboner", tag: "promise", cryptic: "-.-. .- -. -. --- -" },
  { id: "l044", text: "I have never seen the last door. I have seen the corridor that leads up to it.", source: "Threadboner", tag: "door", cryptic: "qr odvw grru" },
  { id: "l045", text: "They told me I was worth more dead than alive. The number was embarrassingly precise.", source: "Threadboner", tag: "worth", cryptic: "pruh ghdg wkdq" },
  { id: "l046", text: "The clock in the east corridor runs backwards. It is the only one that tells the truth.", source: "Threadboner", tag: "time", cryptic: "hturt eht sllet" },
  { id: "l047", text: "The thread between us is the only wall in this house that I trust.", source: "Threadboner", tag: "thread", cryptic: ".- / .-- .- .-.. .-.." },
  { id: "l048", text: "The ledger is three hundred pages. My handwriting gets worse near the end.", source: "Threadboner", tag: "debt", cryptic: "trgf jbefr" },
  { id: "l049", text: "The power was never mine. I was just the one holding it while it decided.", source: "Threadboner", tag: "power", cryptic: "kroglqj lw" },
  { id: "l050", text: "I did not survive. I am told that is a technicality in this country.", source: "Threadboner", tag: "death", cryptic: "dGVjaG5pY2FsaXR5" },
  { id: "l051", text: "The country is small. The debt is not.", source: "Threadboner", tag: "world", cryptic: "yrtnuoc a ton" },
  { id: "l052", text: "I have forgotten three people. I remember the forgetting. The bookkeeping is off.", source: "Threadboner", tag: "memory", cryptic: "gnittegrof eht" },
  { id: "l053", text: "I would have told you the truth if you had asked before the door closed.", source: "Threadboner", tag: "promise", cryptic: "orsber gur qbbe" },
  { id: "l054", text: "Yesterday was longer. I have the receipts.", source: "Threadboner", tag: "time", cryptic: "-. --- - / -.-- . -" },
  { id: "l055", text: "Do not knock. The door in the east corridor knocks back, and it is never polite about it.", source: "Threadboner", tag: "door", cryptic: "xabpxf onpx" },
  { id: "l056", text: "Debt is the only currency in this city that cannot be stolen. Only transferred.", source: "Threadboner", tag: "debt", cryptic: "Y2Fubm90IGJlIHN0b2xlbg==" },
  { id: "l057", text: "I decided I was worth saving. That was the expensive part.", source: "Threadboner", tag: "worth", cryptic: "ZXhwZW5zaXZlIHBhcnQ=" },
  { id: "l058", text: "Strength, a door, a favour, a name. Ask for too many in one afternoon and the ledger closes.", source: "Threadboner", tag: "power", cryptic: "gur yrqtre pybfrf" },
  { id: "l059", text: "The stars here are in the wrong order and everyone grew up apologising for them.", source: "Threadboner", tag: "world", cryptic: "zurqj rughu" },
  { id: "l060", text: "An hour is a decision. I have spent most of mine badly.", source: "Threadboner", tag: "time", cryptic: "c3BlbnQgYmFkbHk=" },
  { id: "l061", text: "That door has been open since the day I was born. Roughly my doing.", source: "Threadboner", tag: "door", cryptic: "--- .--. . -." },
  { id: "l062", text: "Your worth is not a number. It is a thread count. Fewer threads, fewer options, same building.", source: "Threadboner", tag: "worth", cryptic: "gnidliub emas" },
  { id: "l063", text: "I broke two of my own promises on purpose. The third one I am still pretending to keep.", source: "Threadboner", tag: "promise", cryptic: "b24gcHVycG9zZQ==" },
  { id: "l064", text: "I paid. Then I paid again. The second payment went to somebody else's account.", source: "Threadboner", tag: "debt", cryptic: "- .-- .. -.-. ." },
  { id: "l065", text: "Time is the one debt here that can be spent without the lender noticing.", source: "Threadboner", tag: "time", cryptic: "jvgubhg gur yraqre" },
  { id: "l066", text: "The most valuable thing I own is a name nobody here has had to say out loud.", source: "Threadboner", tag: "worth", cryptic: "fnl bhg ybhq" },
  { id: "l067", text: "They built these walls to keep something out. The something is very good at doors.", source: "Threadboner", tag: "world", cryptic: "Z29vZCBhdCBkb29ycw==" },
  { id: "l068", text: "Eleven years here. The calendar says four. The calendar is not wrong, it is early.", source: "Threadboner", tag: "time", cryptic: "lw lv hduob" },
  { id: "l069", text: "Nobody here can tell me what I am worth. They can tell me what it costs them to keep me.", source: "Threadboner", tag: "worth", cryptic: "zkdw lw frvwv" },
  { id: "l070", text: "Worth is what the thread still says after everyone who read it is gone.", source: "Threadboner", tag: "worth", cryptic: "c3RpbGwgc2F5cw==" },
];

// djb2 — small, stable, identical in every JS runtime. Deliberately not
// Math.random: every visitor on a given date must resolve to the same line,
// otherwise the page would flicker on reload and the response could never be
// cached at the edge until midnight.
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
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
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

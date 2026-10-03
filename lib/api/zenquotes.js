/**
 * ZenQuotes client for the Threadboner teaser page.
 *
 * Fetched over the serverless function, never from the browser: the free tier
 * sends no Access-Control-Allow-Origin header, so a direct client fetch would be
 * CORS-blocked anyway.
 *
 * Everything here follows ZenQuotes' own usage guidance (docs.zenquotes.io):
 *   - "Requests are restricted by IP to 5 per 30 second period by default."
 *   - "cache a batch of quotes that you can loop locally rather than calling
 *      the server each time" and refresh "after an hour or so"
 *   - "In the event the API service is unavailable, you will still have an
 *      available data set in your app to pull from."
 * So: one batch, refreshed on an interval, held in the warm instance, with the
 * curated Threadboner lines as the fallback pool.
 *
 * One nasty detail worth knowing: when ZenQuotes is rate-limited it returns
 * HTTP 429 whose BODY is still a well-formed quote array —
 *   [{"q":"Too many requests. Obtain an auth key...","a":"zenquotes.io",...}]
 * A naive parse would happily render "Too many requests. Obtain an auth key
 * for unlimited access." — zenquotes.io as the line of the day. sanitizeQuote()
 * exists specifically to refuse that payload.
 */

"use strict";

const crypto = require("crypto");

const BATCH_URL = "https://zenquotes.io/api/quotes";
const BATCH_SIZE = 50;
const TTL_MS = 60 * 60 * 1000; // "refresh after an hour or so"
const FETCH_TIMEOUT_MS = 4000;
const ATTRIBUTION = "https://zenquotes.io/";

// Warm-instance cache. Vercel reuses a function instance across requests, so
// this survives between hits; the edge (s-maxage) absorbs the traffic in
// between so a cold start only happens rarely.
if (!global.__zenCache) {
  global.__zenCache = { quotes: [], fetchedAt: 0, inflight: null };
}

// The curated local pool doubles as the offline fallback.
const curated = require("./quotes");

function nowMs() {
  return Date.now();
}

function isRateLimitQuote(q) {
  // the 429 payload is shaped exactly like a real quote; detect and refuse it
  if (!q || typeof q !== "object") return true;
  const a = String(q.a || "").toLowerCase();
  const t = String(q.q || "").toLowerCase();
  return (
    a === "zenquotes.io" ||
    a === "zenquotes" ||
    t.includes("too many requests") ||
    t.includes("auth key") ||
    t.includes("obtain an auth")
  );
}

function sanitizeQuote(q, idx) {
  if (!q || typeof q !== "object") return null;
  const text = String(q.q || "").trim();
  const author = String(q.a || "").trim();
  if (!text || !author) return null;
  if (isRateLimitQuote(q)) return null;
  // drop junk the feed occasionally carries
  if (text.length < 12 || text.length > 400) return null;
  if (/\s{3,}/.test(text)) return null;
  return {
    // deterministic id so the page and cache agree across invocations
    id: "zq-" + crypto.createHash("sha1").update(author + "|" + text).digest("hex").slice(0, 8),
    text: text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " "),
    author: author,
    image: typeof q.i === "string" && /^https:\/\/zenquotes\.io\//.test(q.i) ? q.i : null,
    external: true,
    source: "ZenQuotes",
    attribution: ATTRIBUTION,
    tag: "external",
    _i: idx,
  };
}

async function fetchBatch() {
  const cache = global.__zenCache;
  // single-flight: many concurrent edge misses must not each hit ZenQuotes
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    let parsed = [];
    try {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
      const res = await fetch(BATCH_URL, {
        headers: { Accept: "application/json" },
        signal: ctl ? ctl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (res && res.ok) {
        const body = await res.json();
        if (Array.isArray(body)) {
          parsed = body
            .slice(0, BATCH_SIZE)
            .map((q, i) => sanitizeQuote(q, i))
            .filter(Boolean);
        }
      }
      // non-OK (429 etc.): parsed stays [], stale cache is kept below
    } catch (e) {
      // network/timeout/AbortError: fall through to stale-or-empty
    }
    if (parsed.length) {
      cache.quotes = parsed;
      cache.fetchedAt = nowMs();
    }
    cache.inflight = null;
    return cache.quotes;
  })();

  return cache.inflight;
}

function isFresh() {
  return global.__zenCache.quotes.length > 0 &&
    nowMs() - global.__zenCache.fetchedAt < TTL_MS;
}

/**
 * Return up to `count` external quotes for a deterministic slice of the day,
 * starting at `offset`. `count` defaults to 1.
 *
 * offset is a real offset: pickForDate(day, 0), (day, 1), (day, 2) walk the
 * batch, so the page's "another line" control always lands somewhere new.
 * Falls back to the curated Threadboner pool whenever ZenQuotes is unavailable,
 * rate-limited, or returns nothing usable.
 */
async function getDailyQuotes(dateKey, offset, count) {
  const start = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0;
  const n = Math.max(1, Math.min(Number(count) || 1, 10));

  if (!isFresh()) {
    try {
      await fetchBatch();
    } catch (e) {
      /* handled below by the empty check */
    }
  }
  const pool = global.__zenCache.quotes;
  if (!pool.length) return null; // caller decides to use the curated fallback

  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = curated.stableHash(String(dateKey) + "|" + (start + i)) % pool.length;
    out.push(pool[idx]);
  }
  return out;
}

function curatedFallback(dateKey, offset) {
  return curated.pickForDate(dateKey, offset);
}

function getAttribution() {
  return ATTRIBUTION;
}

module.exports = { getDailyQuotes, curatedFallback, getAttribution, ATTRIBUTION };
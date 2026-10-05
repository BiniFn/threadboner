const crypto = require("crypto");
const { put, del } = require("@vercel/blob");
const { issueSignedToken, presignUrl } = require("@vercel/blob");
const { handleUploadPresigned } = require("@vercel/blob/client");
const pool = require("../lib/api/db");
const { allowCors, success, fail } = require("../lib/api/http");
const { parseJsonBody, getClientIp } = require("../lib/api/request");
const { takeRateLimitToken } = require("../lib/api/rate-limit");
const {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  makeCookie,
  getSessionCookieOptions,
  makePasswordHash,
  verifyPassword,
  createSession,
  destroySession,
  getSession,
  refreshSession,
  requireSession,
  validateCsrf,
  shouldExposeSessionToken,
} = require("../lib/api/auth");
const { sendPushToUser, sendPushBroadcast } = require("../lib/api/push");

const GOOGLE_OAUTH_STATE_COOKIE = "tb_google_oauth_state";
const GOOGLE_OAUTH_RETURN_COOKIE = "tb_google_oauth_return";
const GOOGLE_OAUTH_APP_MODE_COOKIE = "tb_google_oauth_app_mode";

function getRequestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  return `${proto || "https"}://${host}`;
}

function getGoogleRedirectUri(req) {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    `${getRequestOrigin(req)}/api/auth/google/callback`
  );
}

function parseSimpleCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .reduce((cookies, pair) => {
      const [key, ...rest] = pair.trim().split("=");
      if (!key) return cookies;
      try {
        cookies[key] = decodeURIComponent(rest.join("="));
      } catch {
        cookies[key] = rest.join("=");
      }
      return cookies;
    }, {});
}

function sanitizeOAuthReturnTo(value) {
  const fallback = "/";
  const raw = String(value || fallback).trim();
  if (!raw || raw.startsWith("//")) return fallback;
  try {
    const parsed = new URL(raw, "https://threadborn.local");
    if (parsed.origin !== "https://threadborn.local") return fallback;
    if (parsed.pathname.includes("/api/")) return fallback;
    return `${parsed.pathname}${parsed.search || ""}${parsed.hash || ""}`;
  } catch {
    return fallback;
  }
}

function redirectTo(res, location, statusCode = 302) {
  res.statusCode = statusCode;
  res.setHeader("Location", location);
  res.end("");
}

function isTrustedImageBytes(contentType, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return false;
  if (contentType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (contentType === "image/gif") {
    const header = bytes.slice(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (contentType === "image/webp") {
    return bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function googleAuthPayload(user, session, req) {
  const payload = {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      avatarUrl: user.avatar_url || "",
      verified: user.verified,
      role: user.role,
    },
    csrfToken: session.csrfToken,
  };
  if (shouldExposeSessionToken(req)) {
    payload.sessionToken = session.token;
  }
  return payload;
}

function appModeFromValue(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "android" || mode === "desktop" ? mode : "";
}

function googleAppRedirectPayload(user, session) {
  return new URLSearchParams({
    google_session: session.token,
    google_csrf: session.csrfToken,
    google_user: JSON.stringify({
      id: user.id,
      email: user.email,
      username: user.username,
      avatarUrl: user.avatar_url || "",
      verified: user.verified,
      role: user.role,
    }),
  }).toString();
}

function isAllowedCommunityImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:") return false;
    return (
      parsed.hostname === "blob.vercel-storage.com" ||
      parsed.hostname.endsWith(".public.blob.vercel-storage.com") ||
      parsed.hostname === "media.tenor.com" ||
      parsed.hostname.endsWith(".tenor.com")
    );
  } catch {
    return false;
  }
}

function normalizeGoogleUsername(profile) {
  const source =
    profile.name ||
    (profile.email ? profile.email.split("@")[0] : "") ||
    "reader";
  const cleaned = source
    .normalize("NFKD")
    .replace(/[^\w\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 18)
    .toLowerCase();
  return /^[a-zA-Z0-9_]{3,24}$/.test(cleaned) ? cleaned : "reader";
}

async function makeUniqueGoogleUsername(profile) {
  const base = normalizeGoogleUsername(profile);
  for (let index = 0; index < 12; index += 1) {
    const suffix = index === 0 ? "" : `_${crypto.randomBytes(2).toString("hex")}`;
    const username = `${base}${suffix}`.slice(0, 24);
    const { rows } = await pool.query(
      "select id from users where lower(username) = lower($1) limit 1",
      [username],
    );
    if (!rows.length) return username;
  }
  return `reader_${crypto.randomBytes(4).toString("hex")}`.slice(0, 24);
}

function isAdminSession(session) {
  return Boolean(session && (session.role === "owner" || session.role === "admin"));
}

function normalizeModerationPayload(value, maxLength = 200000) {
  const text = JSON.stringify(value || {});
  if (text.length > maxLength) {
    throw new Error("Moderation payload too large");
  }
  return text;
}

function moderationSignals(text) {
  const value = String(text || "").toLowerCase();
  const patterns = [
    { key: "slur_or_hate", re: /\b(kill all|gas the|race war|nazi salute|white power)\b/i },
    { key: "threat", re: /\b(i will kill|i'm going to kill|i will hurt|bomb threat|doxx)\b/i },
    { key: "self_harm", re: /\b(kill myself|suicide|self harm|cut myself)\b/i },
    { key: "sexual_minors", re: /\b(loli|shota|minor sex|underage)\b/i },
    { key: "spam", re: /(https?:\/\/|discord\.gg|t\.me\/|free money|crypto pump)/i },
    { key: "profanity", re: /\b(fuck|shit|bitch|asshole|cunt|dick)\b/i },
  ];
  const matches = patterns.filter((item) => item.re.test(value)).map((item) => item.key);
  return {
    needsReview: matches.length > 0,
    matches,
  };
}

function withModerationSignals(payload, fields = []) {
  const text = fields.map((field) => payload?.[field] || "").join("\n");
  const signals = moderationSignals(text);
  return {
    ...payload,
    moderation: {
      filtered: signals.needsReview,
      reasons: signals.matches,
    },
  };
}

async function createModerationRequest(userId, requestType, payload, options = {}) {
  const { rows } = await pool.query(
    `insert into moderation_requests
       (user_id, request_type, payload, target_table, target_id, updated_at)
     values ($1, $2, $3::jsonb, $4, $5, now())
     returning id, created_at`,
    [
      userId,
      requestType,
      normalizeModerationPayload(payload),
      options.targetTable || null,
      options.targetId || null,
    ],
  );
  return rows[0];
}

function moderationRow(row) {
  return {
    id: row.id,
    type: row.request_type,
    status: row.status,
    payload: row.payload || {},
    targetTable: row.target_table || "",
    targetId: row.target_id || "",
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || "",
    user: {
      id: row.user_id,
      username: row.username || "Reader",
      email: row.email || "",
      avatarUrl: row.avatar_url || "",
      verified: !!row.verified,
      role: row.role || "user",
    },
    reviewer: row.reviewer_username || "",
  };
}

async function getModerationRequest(id) {
  const { rows } = await pool.query(
    `select mr.*, u.username, u.email, u.avatar_url, u.verified, u.role,
            reviewer.username as reviewer_username
     from moderation_requests mr
     join users u on u.id = mr.user_id
     left join users reviewer on reviewer.id = mr.reviewed_by
     where mr.id = $1
     limit 1`,
    [id],
  );
  return rows[0] || null;
}

async function approveModerationRequest(request) {
  const payload = request.payload || {};
  if (request.request_type === "profile_update") {
    const username = String(payload.username || "").trim();
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      throw new Error("Invalid username in request");
    }
    const duplicate = await pool.query(
      "select id from users where lower(username) = lower($1) and id <> $2 limit 1",
      [username, request.user_id],
    );
    if (duplicate.rows.length) {
      throw new Error("duplicate username");
    }
    await pool.query(
      `update users set username = $1, updated_at = now() where id = $2`,
      [username, request.user_id],
    );
    return;
  }

  if (request.request_type === "avatar_update") {
    const avatarUrl = String(payload.avatarUrl || "").trim();
    const crop = payload.crop && typeof payload.crop === "object" ? payload.crop : {};
    if (!avatarUrl.startsWith("https://")) {
      throw new Error("Invalid avatar URL in request");
    }
    const existing = await pool.query(
      "select avatar_url from users where id = $1",
      [request.user_id],
    );
    const oldUrl = existing.rows[0]?.avatar_url || "";
    await pool.query(
      "update users set avatar_url = $1, avatar_crop = $2::jsonb, updated_at = now() where id = $3",
      [avatarUrl, normalizeModerationPayload(crop, 2000), request.user_id],
    );
    if (
      oldUrl &&
      oldUrl !== avatarUrl &&
      oldUrl.includes("blob.vercel-storage.com") &&
      process.env.BLOB_READ_WRITE_TOKEN
    ) {
      try {
        await del(oldUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch (error) {
        console.error("[moderation] old avatar delete failed:", error);
      }
    }
    return;
  }

  if (request.request_type === "banner_update") {
    const bannerUrl = String(payload.bannerUrl || "").trim();
    const crop = payload.crop && typeof payload.crop === "object" ? payload.crop : {};
    if (!bannerUrl.startsWith("https://")) {
      throw new Error("Invalid banner URL in request");
    }
    const existing = await pool.query(
      "select banner_url from users where id = $1",
      [request.user_id],
    );
    const oldUrl = existing.rows[0]?.banner_url || "";
    await pool.query(
      "update users set banner_url = $1, banner_crop = $2::jsonb, updated_at = now() where id = $3",
      [bannerUrl, normalizeModerationPayload(crop, 2000), request.user_id],
    );
    if (
      oldUrl &&
      oldUrl !== bannerUrl &&
      oldUrl.includes("blob.vercel-storage.com") &&
      process.env.BLOB_READ_WRITE_TOKEN
    ) {
      try {
        await del(oldUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch (error) {
        console.error("[moderation] old banner delete failed:", error);
      }
    }
    return;
  }

  if (request.request_type === "reader_reaction") {
    await pool.query(
      `insert into reader_reactions
         (user_id, novel_id, target_type, volume_id, chapter_id, rating, category, content, updated_at)
       values ($1, 'threadborn', $2, $3, $4, $5, $6, $7, now())`,
      [
        request.user_id,
        payload.targetType,
        payload.volumeId,
        payload.chapterId || null,
        payload.rating === undefined ? null : payload.rating,
        payload.category || "comment",
        payload.content || "",
      ],
    );
    return;
  }

  if (request.request_type === "community_post") {
    if (payload.imageUrl && !isAllowedCommunityImageUrl(payload.imageUrl)) {
      throw new Error("Invalid community image URL in request");
    }
    await pool.query(
      `insert into posts (user_id, title, content, image_url, category, created_at, updated_at)
       values ($1,$2,$3,$4,$5,now(),now())`,
      [
        request.user_id,
        payload.title,
        payload.content,
        payload.imageUrl || null,
        payload.category,
      ],
    );
    return;
  }

  if (request.request_type === "community_post_image") {
    if (payload.imageUrl && !isAllowedCommunityImageUrl(payload.imageUrl)) {
      throw new Error("Invalid community image URL in request");
    }
    await pool.query(
      `update posts set image_url = $1, updated_at = now() where id = $2`,
      [payload.imageUrl, request.target_id]
    );
    // Notification for approval
    await pool.query(
      `insert into notifications (user_id, type, title, body) values ($1, 'system', 'Image Approved', 'Your image attached to a community post was approved.')`,
      [request.user_id]
    );
    return;
  }

  if (request.request_type === "community_comment") {
    await pool.query(
      `insert into comments (post_id, user_id, content, created_at, updated_at)
       values ($1,$2,$3,now(),now())`,
      [payload.postId, request.user_id, payload.content],
    );
    return;
  }

  if (request.request_type === "community_comment_image") {
    if (payload.imageUrl && !isAllowedCommunityImageUrl(payload.imageUrl)) {
      throw new Error("Invalid community image URL in request");
    }
    await pool.query(
      `update comments set image_url = $1, updated_at = now() where id = $2`,
      [payload.imageUrl, request.target_id]
    );
    await pool.query(
      `insert into notifications (user_id, type, title, body) values ($1, 'system', 'Image Approved', 'Your image attached to a community reply was approved.')`,
      [request.user_id]
    );
    return;
  }
}

async function moderateRequest(requestId, reviewer, decision, note = "") {
  if (!isAdminSession(reviewer)) {
    throw new Error("Only owner/admin can review moderation requests");
  }
  const request = await getModerationRequest(requestId);
  if (!request) {
    throw new Error("Moderation request not found");
  }
  if (request.status !== "pending") {
    throw new Error("Moderation request was already reviewed");
  }
  if (decision === "approved") {
    await approveModerationRequest(request);
  } else if (decision === "rejected") {
    if (request.request_type === "community_post_image") {
      await pool.query(
        `update posts set image_url = null, updated_at = now() where id = $1`,
        [request.target_id]
      );
      await pool.query(
        `insert into notifications (user_id, type, title, body) values ($1, 'system', 'Image Declined', 'Your image attached to a community post was declined.')`,
        [request.user_id]
      );
    } else if (request.request_type === "community_comment_image") {
      await pool.query(
        `update comments set image_url = null, updated_at = now() where id = $1`,
        [request.target_id]
      );
      await pool.query(
        `insert into notifications (user_id, type, title, body) values ($1, 'system', 'Image Declined', 'Your image attached to a community reply was declined.')`,
        [request.user_id]
      );
    }
    const pendingUrl = String(
      request.request_type === "avatar_update"
        ? request.payload?.avatarUrl || ""
        : request.request_type === "community_post" || request.request_type === "community_post_image" || request.request_type === "community_comment" || request.request_type === "community_comment_image"
          ? request.payload?.imageUrl || ""
          : "",
    );
    if (pendingUrl.includes("blob.vercel-storage.com") && process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        await del(pendingUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch (error) {
        console.error("[moderation] rejected upload delete failed:", error);
      }
    }
  }
  await pool.query(
    `update moderation_requests
     set status = $1, reviewed_by = $2, review_note = $3, reviewed_at = now(), updated_at = now()
     where id = $4`,
    [decision, reviewer.user_id, String(note || "").slice(0, 500), requestId],
  );
}

exports.handleLogin = (() => {

function authPayload(user, session, req) {
  const payload = {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      avatarUrl: user.avatar_url || "",
      verified: user.verified,
      role: user.role,
    },
    csrfToken: session.csrfToken,
  };
  if (shouldExposeSessionToken(req)) {
    payload.sessionToken = session.token;
  }
  return payload;
}

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!takeRateLimitToken(`login:${getClientIp(req)}`, 20, 60_000)) {
    fail(res, 429, "Too many attempts, please retry shortly");
    return;
  }
  if (!process.env.DATABASE_URL) {
    fail(res, 503, "Missing DATABASE_URL environment variable");
    return;
  }

  try {
    await pool.ensureMigrations();
    const body = await parseJsonBody(req);
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) {
      fail(res, 400, "Email and password are required");
      return;
    }

    if (
      process.env.OWNER_EMAIL &&
      process.env.OWNER_PASSWORD &&
      email === process.env.OWNER_EMAIL.trim().toLowerCase()
    ) {
      const existing = await pool.query(
        "select id from users where role = 'owner'::user_role limit 1",
      );
      if (!existing.rows.length) {
        const ownerUsername =
          email
            .split("@")[0]
            .replace(/[^a-zA-Z0-9_]/g, "_")
            .slice(0, 24) || "owner";
        const emailConflict = await pool.query(
          "select id, role from users where lower(email) = $1 limit 1",
          [email],
        );
        if (!emailConflict.rows.length) {
          await pool.query(
            `insert into users (email, username, password_hash, role, verified, updated_at)
             values ($1, $2, $3, 'owner'::user_role, true, now())`,
            [
              email,
              ownerUsername,
              makePasswordHash(process.env.OWNER_PASSWORD),
            ],
          );
        } else if (emailConflict.rows[0].role !== "owner") {
          const submittedPassword = Buffer.from(password);
          const configuredOwnerPassword = Buffer.from(
            process.env.OWNER_PASSWORD,
          );
          const isConfiguredOwnerPassword =
            submittedPassword.length === configuredOwnerPassword.length &&
            crypto.timingSafeEqual(submittedPassword, configuredOwnerPassword);

          if (
            emailConflict.rows[0].role !== "user" ||
            !isConfiguredOwnerPassword
          ) {
            fail(res, 401, "Invalid credentials");
            return;
          }

          await pool.query(
            `update users
             set role = 'owner'::user_role,
                 password_hash = $2,
                 verified = true,
                 updated_at = now()
             where id = $1 and role = 'user'::user_role`,
            [
              emailConflict.rows[0].id,
              makePasswordHash(process.env.OWNER_PASSWORD),
            ],
          );
        }
      }
    }

    const { rows } = await pool.query(
      "select id, email, username, password_hash, avatar_url, verified, role from users where lower(email)= $1 limit 1",
      [email],
    );
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      fail(res, 401, "Invalid credentials");
      return;
    }

    const user = rows[0];
    const session = await createSession(user.id);
    res.setHeader(
      "Set-Cookie",
      makeCookie(
        SESSION_COOKIE,
        session.token,
        Math.floor(SESSION_TTL_MS / 1000),
        getSessionCookieOptions(req),
      ),
    );
    success(res, authPayload(user, session, req));
  } catch (error) {
    fail(res, 500, "Login failed");
  }
};

})();

exports.handleLogout = (() => {

return async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!takeRateLimitToken(`logout:${getClientIp(req)}`, 10, 60_000)) {
    fail(res, 429, "Too many requests");
    return;
  }
  let session;
  try {
    session = await getSession(req);
  } catch (error) {
    fail(res, 503, "Could not verify the current session");
    return;
  }
  if (session && !validateCsrf(req, session)) {
    fail(res, 403, "Invalid CSRF token");
    return;
  }
  // Clear cookie immediately — do this before the DB call so the user
  // is always logged out in the browser even if the DB is unavailable
  res.setHeader(
    "Set-Cookie",
    makeCookie(
      SESSION_COOKIE,
      "",
      0,
      getSessionCookieOptions(req, { clear: true }),
    ),
  );
  try {
    await destroySession(req, res);
  } catch (error) {
    // Cookie is already cleared — log but don't surface to client
    console.error("[logout] DB delete failed:", error);
  }
  success(res, { loggedOut: true });
};

})();

exports.handleMe = (() => {

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!takeRateLimitToken(`me:${getClientIp(req)}`, 60, 60_000)) {
    fail(res, 429, "Too many requests");
    return;
  }
  try {
    const session = await getSession(req);
    if (!session) {
      fail(res, 401, "Unauthorized");
      return;
    }
    const expiresAt = await refreshSession(session.session_id).catch(
      () => session.expires_at,
    );
    success(res, {
      user: {
        id: session.user_id,
        email: session.email,
        username: session.username,
        avatarUrl: session.avatar_url || "",
        verified: session.verified,
        role: session.role,
      },
      csrfToken: session.csrf_token,
      expiresAt,
    });
  } catch (error) {
    fail(res, 500, "Service unavailable");
  }
};

})();

exports.handleSignup = (() => {

function validUsername(value) {
  return /^[a-zA-Z0-9_]{3,24}$/.test(value);
}

function authPayload(user, session, req) {
  const payload = {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      avatarUrl: user.avatar_url || "",
      verified: user.verified,
      role: user.role,
    },
    csrfToken: session.csrfToken,
  };
  if (shouldExposeSessionToken(req)) {
    payload.sessionToken = session.token;
  }
  return payload;
}

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!takeRateLimitToken(`signup:${getClientIp(req)}`, 10, 60_000)) {
    fail(res, 429, "Too many signup attempts");
    return;
  }
  if (!process.env.DATABASE_URL) {
    fail(res, 503, "Missing DATABASE_URL environment variable");
    return;
  }

  try {
    await pool.ensureMigrations();
    const body = await parseJsonBody(req);
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    let avatarUrl = null;
    const rawAvatarUrl = String(body.avatarUrl || "").trim();
    if (rawAvatarUrl) {
      try {
        const parsed = new URL(rawAvatarUrl);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          avatarUrl = parsed.href;
        }
      } catch (e) {
        /* invalid URL — ignore */
      }
    }

    if (!email || !password || !username) {
      fail(res, 400, "Email, username and password are required");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fail(res, 400, "Invalid email address");
      return;
    }
    if (!validUsername(username)) {
      fail(
        res,
        400,
        "Username must be 3-24 chars (letters, numbers, underscore)",
      );
      return;
    }
    if (password.length < 8) {
      fail(res, 400, "Password must be at least 8 characters");
      return;
    }
    if (password.length > 1024) {
      fail(res, 400, "Password too long (max 1024 characters)");
      return;
    }
    if (
      process.env.OWNER_EMAIL &&
      email === process.env.OWNER_EMAIL.trim().toLowerCase()
    ) {
      fail(
        res,
        409,
        "This e-mail is reserved for the owner. Sign in with the configured owner credentials.",
      );
      return;
    }

    const duplicate = await pool.query(
      "select id from users where lower(email) = $1 or lower(username) = lower($2) limit 1",
      [email, username],
    );
    if (duplicate.rows.length) {
      fail(res, 409, "Email or username is already in use");
      return;
    }

    const passwordHash = makePasswordHash(password);
    const { rows } = await pool.query(
      "insert into users (email, username, password_hash, avatar_url, role, verified, updated_at) values ($1,$2,$3,$4,'user',false,now()) returning id, email, username, avatar_url, verified, role",
      [email, username, passwordHash, avatarUrl],
    );

    const user = rows[0];
    const session = await createSession(user.id);
    res.setHeader(
      "Set-Cookie",
      makeCookie(
        SESSION_COOKIE,
        session.token,
        Math.floor(SESSION_TTL_MS / 1000),
        getSessionCookieOptions(req),
      ),
    );
    success(res, authPayload(user, session, req), 201);
  } catch (error) {
    if (
      String(error.code) === "23505" ||
      String(error.message || "").includes("duplicate")
    ) {
      fail(res, 409, "Email or username is already in use");
      return;
    }
    fail(res, 500, "Signup failed");
  }
};

})();

exports.handleGoogleAuthStart = (() => {

return async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!takeRateLimitToken(`google-start:${getClientIp(req)}`, 20, 60_000)) {
    fail(res, 429, "Too many Google sign-in attempts");
    return;
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    fail(res, 503, "Google sign-in is not configured");
    return;
  }

  const requestUrl = new URL(req.url || "/", getRequestOrigin(req));
  const state = crypto.randomBytes(24).toString("hex");
  const returnTo = sanitizeOAuthReturnTo(requestUrl.searchParams.get("returnTo"));
  const appMode = appModeFromValue(requestUrl.searchParams.get("appMode"));
  const redirectUri = getGoogleRedirectUri(req);
  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri", redirectUri);
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", "openid email profile");
  googleUrl.searchParams.set("state", state);
  googleUrl.searchParams.set("prompt", "select_account");

  res.setHeader("Set-Cookie", [
    makeCookie(GOOGLE_OAUTH_STATE_COOKIE, state, 600, getSessionCookieOptions(req)),
    makeCookie(
      GOOGLE_OAUTH_RETURN_COOKIE,
      returnTo,
      600,
      getSessionCookieOptions(req),
    ),
    makeCookie(
      GOOGLE_OAUTH_APP_MODE_COOKIE,
      appMode,
      appMode ? 600 : 0,
      getSessionCookieOptions(req, appMode ? {} : { clear: true }),
    ),
  ]);
  redirectTo(res, googleUrl.toString());
};

})();

exports.handleGoogleAuthCallback = (() => {

async function exchangeGoogleCode(req, code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: getGoogleRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || "Google token exchange failed");
  }
  return data.access_token;
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const profile = await response.json().catch(() => ({}));
  if (!response.ok || !profile.sub || !profile.email) {
    throw new Error("Google profile request failed");
  }
  if (profile.email_verified === false) {
    throw new Error("Google email is not verified");
  }
  return {
    googleId: String(profile.sub),
    email: String(profile.email).trim().toLowerCase(),
    name: String(profile.name || "").trim(),
    avatarUrl: String(profile.picture || "").trim(),
  };
}

async function findOrCreateGoogleUser(profile) {
  const existing = await pool.query(
    `select id, email, username, avatar_url, verified, role
     from users
     where google_id = $1 or lower(email) = $2
     order by google_id nulls last
     limit 1`,
    [profile.googleId, profile.email],
  );
  if (existing.rows.length) {
    const user = existing.rows[0];
    const avatarUrl = user.avatar_url || profile.avatarUrl || null;
    const updated = await pool.query(
      `update users
       set google_id = coalesce(google_id, $1),
           avatar_url = coalesce(nullif(avatar_url, ''), $2),
           verified = true,
           updated_at = now()
       where id = $3
       returning id, email, username, avatar_url, verified, role`,
      [profile.googleId, avatarUrl, user.id],
    );
    return updated.rows[0];
  }

  const username = await makeUniqueGoogleUsername(profile);
  const passwordHash = makePasswordHash(
    `google:${profile.googleId}:${crypto.randomBytes(24).toString("hex")}`,
  );
  const { rows } = await pool.query(
    `insert into users
       (email, username, password_hash, avatar_url, role, verified, google_id, updated_at)
     values ($1, $2, $3, $4, 'user', true, $5, now())
     returning id, email, username, avatar_url, verified, role`,
    [profile.email, username, passwordHash, profile.avatarUrl || null, profile.googleId],
  );
  return rows[0];
}

return async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") {
    fail(res, 405, "Method not allowed");
    return;
  }
  const requestUrl = new URL(req.url || "/", getRequestOrigin(req));
  const cookies = parseSimpleCookies(req);
  const returnTo = sanitizeOAuthReturnTo(cookies[GOOGLE_OAUTH_RETURN_COOKIE]);
  const appMode = appModeFromValue(cookies[GOOGLE_OAUTH_APP_MODE_COOKIE]);
  const clearOAuthCookies = [
    makeCookie(
      GOOGLE_OAUTH_STATE_COOKIE,
      "",
      0,
      getSessionCookieOptions(req, { clear: true }),
    ),
    makeCookie(
      GOOGLE_OAUTH_RETURN_COOKIE,
      "",
      0,
      getSessionCookieOptions(req, { clear: true }),
    ),
    makeCookie(
      GOOGLE_OAUTH_APP_MODE_COOKIE,
      "",
      0,
      getSessionCookieOptions(req, { clear: true }),
    ),
  ];

  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new Error("Google sign-in is not configured");
    }
    const code = requestUrl.searchParams.get("code") || "";
    const state = requestUrl.searchParams.get("state") || "";
    if (!code || !state || state !== cookies[GOOGLE_OAUTH_STATE_COOKIE]) {
      throw new Error("Invalid Google sign-in state");
    }
    await pool.ensureMigrations();
    const accessToken = await exchangeGoogleCode(req, code);
    const profile = await fetchGoogleProfile(accessToken);
    const user = await findOrCreateGoogleUser(profile);
    const session = await createSession(user.id);
    res.setHeader("Set-Cookie", [
      ...clearOAuthCookies,
      makeCookie(
        SESSION_COOKIE,
        session.token,
        Math.floor(SESSION_TTL_MS / 1000),
        getSessionCookieOptions(req),
      ),
    ]);
    if (requestUrl.searchParams.get("mode") === "json") {
      success(res, googleAuthPayload(user, session, req));
      return;
    }
    if (appMode) {
      redirectTo(res, `${returnTo}#${googleAppRedirectPayload(user, session)}`);
      return;
    }
    redirectTo(res, returnTo);
  } catch (error) {
    res.setHeader("Set-Cookie", clearOAuthCookies);
    const loginPath = returnTo.includes("-jp") ? "/login-jp.html" : "/login.html";
    redirectTo(
      res,
      `${loginPath}?google_error=${encodeURIComponent(error.message || "Google sign-in failed")}`,
    );
  }
};

})();

exports.handleAnalytics = (() => {

// ── Badge definitions ─────────────────────────────────────────────────────────
const BADGES = {
  first_chapter: {
    label: "First Steps",
    icon: "📖",
    desc: "Read your first chapter",
  },
  volume1_complete: {
    label: "Volume I Complete",
    icon: "⚔️",
    desc: "Finished Volume 1",
  },
  volume2_started: {
    label: "Into the Door",
    icon: "🚪",
    desc: "Started Volume 2",
  },
  ex_reader: { label: "Lore Seeker", icon: "📜", desc: "Read the EX Novel" },
  streak_3: { label: "3-Day Streak", icon: "🔥", desc: "Read 3 days in a row" },
  streak_7: { label: "Week Warrior", icon: "🗡️", desc: "Read 7 days in a row" },
  streak_30: {
    label: "Devoted Reader",
    icon: "👑",
    desc: "Read 30 days in a row",
  },
  bookmarker: {
    label: "Bookmarker",
    icon: "🔖",
    desc: "Created your first bookmark",
  },
  reactor: {
    label: "First Reaction",
    icon: "❤️",
    desc: "Left your first reaction",
  },
  commenter: {
    label: "Community Voice",
    icon: "💬",
    desc: "Posted in the community",
  },
  all_volumes: {
    label: "Chronicle Complete",
    icon: "🌟",
    desc: "Read all available volumes",
  },
};

return async (req, res) => {
  if (allowCors(req, res)) return;

  const action = req.query?.action || "";

  // ── Badges + Streaks ────────────────────────────────────────────────────────
  if (action === "badges") {
    if (!takeRateLimitToken(`badges:${getClientIp(req)}`, 30, 60_000))
      return fail(res, 429, "Too many requests");
    const session = await requireSession(req, res, fail);
    if (!session) return;
    if (!process.env.DATABASE_URL)
      return fail(res, 503, "Missing DATABASE_URL");
    try {
      await pool.ensureMigrations();
      if (req.method === "GET") {
        const [br, sr] = await Promise.all([
          pool.query(
            "SELECT badge_key, earned_at FROM reader_badges WHERE user_id=$1 ORDER BY earned_at DESC",
            [session.user_id],
          ),
          pool.query(
            "SELECT current_streak, longest_streak, last_read_date, total_days_read FROM reader_streaks WHERE user_id=$1",
            [session.user_id],
          ),
        ]);
        const earned = new Set(br.rows.map((r) => r.badge_key));
        const badges = Object.entries(BADGES).map(([key, meta]) => ({
          key,
          ...meta,
          earned: earned.has(key),
          earned_at:
            br.rows.find((r) => r.badge_key === key)?.earned_at || null,
        }));
        const streak = sr.rows[0] || {
          current_streak: 0,
          longest_streak: 0,
          last_read_date: null,
          total_days_read: 0,
        };
        return success(res, { badges, streak });
      }
      if (req.method === "POST") {
        const body = await parseJsonBody(req);
        const { activity } = body;
        if (!activity) return fail(res, 400, "Missing activity");
        const today = new Date().toISOString().slice(0, 10);
        const sr = await pool.query(
          "SELECT * FROM reader_streaks WHERE user_id=$1",
          [session.user_id],
        );
        let cs = 1,
          ls = 1,
          td = 1;
        if (sr.rows.length) {
          const s = sr.rows[0];
          const last = s.last_read_date
            ? new Date(s.last_read_date).toISOString().slice(0, 10)
            : null;
          if (last === today) {
            cs = s.current_streak;
            ls = s.longest_streak;
            td = s.total_days_read;
          } else {
            const yest = new Date(Date.now() - 86400000)
              .toISOString()
              .slice(0, 10);
            cs = last === yest ? s.current_streak + 1 : 1;
            ls = Math.max(s.longest_streak, cs);
            td = s.total_days_read + 1;
          }
        }
        await pool.query(
          `INSERT INTO reader_streaks (user_id,current_streak,longest_streak,last_read_date,total_days_read,updated_at)
           VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (user_id) DO UPDATE SET
             current_streak=$2, longest_streak=$3, last_read_date=$4, total_days_read=$5, updated_at=now()`,
          [session.user_id, cs, ls, today, td],
        );
        const toAward = [];
        if (activity === "chapter_read") toAward.push("first_chapter");
        if (activity === "volume1_complete") toAward.push("volume1_complete");
        if (activity === "volume2_started") toAward.push("volume2_started");
        if (activity === "ex_read") toAward.push("ex_reader");
        if (activity === "bookmark_created") toAward.push("bookmarker");
        if (activity === "reaction_posted") toAward.push("reactor");
        if (activity === "community_post") toAward.push("commenter");
        if (activity === "all_volumes") toAward.push("all_volumes");
        if (cs >= 3) toAward.push("streak_3");
        if (cs >= 7) toAward.push("streak_7");
        if (cs >= 30) toAward.push("streak_30");
        const newBadges = [];
        for (const key of toAward) {
          try {
            const result = await pool.query(
              "INSERT INTO reader_badges (user_id,badge_key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING badge_key",
              [session.user_id, key],
            );
            if (result.rowCount > 0) {
              newBadges.push({ key, ...BADGES[key] });
              // Create in-app notification for the newly earned badge
              pool
                .query(
                  "INSERT INTO notifications (user_id,type,title,body) VALUES ($1,'badge',$2,$3)",
                  [
                    session.user_id,
                    `🏅 Badge Earned: ${BADGES[key].label}`,
                    BADGES[key].desc,
                  ],
                )
                .catch(() => {});
              // Send OS-level push notification
              sendPushToUser(pool, session.user_id, {
                title: `🏅 ${BADGES[key].label}`,
                body: BADGES[key].desc,
                tag: `badge-${key}`,
                url: "/?view=stats",
              }).catch(() => {});
            }
          } catch (_) {}
        }
        return success(res, {
          newBadges,
          streak: {
            current_streak: cs,
            longest_streak: ls,
            total_days_read: td,
          },
        });
      }
      return fail(res, 405, "Method not allowed");
    } catch (error) {
      return fail(res, 500, "Badges unavailable");
    }
  }

  // ── Reading Analytics (original handler) ────────────────────────────────────
  if (!takeRateLimitToken(`analytics:${getClientIp(req)}`, 30, 60_000)) {
    fail(res, 429, "Too many requests");
    return;
  }
  const session = await requireSession(req, res, fail);
  if (!session) {
    return;
  }

  if (req.method === "GET") {
    const { rows } = await pool.query(
      `select volume_id, sum(time_spent)::int as total_time, max(last_read_at) as last_read_at
       from reading_analytics
       where user_id = $1
       group by volume_id
       order by total_time desc`,
      [session.user_id],
    );
    success(res, { volumes: rows });
    return;
  }

  if (req.method !== "POST") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!validateCsrf(req, session)) {
    fail(res, 403, "Invalid CSRF token");
    return;
  }
  const body = await parseJsonBody(req);
  const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  let accepted = 0;
  try {
    for (const event of events) {
      const novelId = String(event.novelId || "threadborn");
      const volumeId = String(event.volumeId || "");
      const chapterId = String(event.chapterId || "");
      const timeSpent = Math.max(
        0,
        Math.min(3600, Number(event.timeSpent || 0)),
      );
      if (!volumeId || !chapterId || timeSpent <= 0) {
        continue;
      }
      await pool.query(
        `insert into reading_analytics (user_id, novel_id, volume_id, chapter_id, time_spent, last_read_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,now(),now(),now())
         on conflict (user_id, novel_id, volume_id, chapter_id)
         do update set
           time_spent = reading_analytics.time_spent + excluded.time_spent,
           last_read_at = now(),
           updated_at = now()`,
        [session.user_id, novelId, volumeId, chapterId, timeSpent],
      );
      accepted++;
    }
    success(res, { accepted });
  } catch (error) {
    fail(res, 500, "Analytics unavailable");
  }
};

})();

exports.handleBookmarks = (() => {

return async (req, res) => {
  if (allowCors(req, res)) return;

  const action = req.query?.action || "";

  // ── Follows ─────────────────────────────────────────────────────────────────
  if (action === "follows") {
    if (!takeRateLimitToken(`follows:${getClientIp(req)}`, 30, 60_000))
      return fail(res, 429, "Too many requests");
    const session = await requireSession(req, res, fail);
    if (!session) return;
    if (!process.env.DATABASE_URL)
      return fail(res, 503, "Missing DATABASE_URL");
    try {
      await pool.ensureMigrations();
      if (req.method === "GET") {
        const { rows } = await pool.query(
          "SELECT follow_type, follow_key, created_at FROM reader_follows WHERE user_id=$1 ORDER BY created_at DESC",
          [session.user_id],
        );
        return success(res, { follows: rows });
      }
      if (!validateCsrf(req, session))
        return fail(res, 403, "Invalid CSRF token");
      const body = await parseJsonBody(req);
      const followType = String(body.follow_type || "").trim();
      const followKey = String(body.follow_key || "").trim();
      if (!followType || !followKey)
        return fail(res, 400, "follow_type and follow_key required");
      if (!["character", "volume", "arc", "tag"].includes(followType))
        return fail(res, 400, "Invalid follow_type");
      if (req.method === "POST") {
        await pool.query(
          "INSERT INTO reader_follows (user_id,follow_type,follow_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [session.user_id, followType, followKey],
        );
        return success(res, { followed: true });
      }
      if (req.method === "DELETE") {
        await pool.query(
          "DELETE FROM reader_follows WHERE user_id=$1 AND follow_type=$2 AND follow_key=$3",
          [session.user_id, followType, followKey],
        );
        return success(res, { unfollowed: true });
      }
      return fail(res, 405, "Method not allowed");
    } catch (error) {
      return fail(res, 500, "Follows unavailable");
    }
  }

  // ── Bookmarks (original handler) ─────────────────────────────────────────────
  try {
    if (!takeRateLimitToken(`bookmarks:${getClientIp(req)}`, 60, 60_000)) {
      fail(res, 429, "Too many requests");
      return;
    }
    const session = await requireSession(req, res, fail);
    if (!session) {
      return;
    }

    if (req.method === "GET") {
      const novelId = String(req.query?.novelId || "threadborn");
      const { rows } = await pool.query(
        "select id, novel_id, volume_id, chapter_id, scroll_position, label, created_at, updated_at from bookmarks where user_id = $1 and novel_id = $2 order by created_at desc",
        [session.user_id, novelId],
      );
      success(res, { bookmarks: rows });
      return;
    }

    if (req.method === "POST") {
      if (!validateCsrf(req, session)) {
        fail(res, 403, "Invalid CSRF token");
        return;
      }
      const body = await parseJsonBody(req);
      const novelId = String(body.novelId || "threadborn");
      const volumeId = String(body.volumeId || "");
      const chapterId = String(body.chapterId || "");
      const label = String(body.label || "").slice(0, 90);
      const scrollPosition = Math.max(0, Number(body.scrollPosition || 0));
      if (!volumeId || !chapterId) {
        fail(res, 400, "volumeId and chapterId are required");
        return;
      }
      const countResult = await pool.query(
        "select count(*) from bookmarks where user_id = $1",
        [session.user_id],
      );
      if (parseInt(countResult.rows[0].count) >= 500) {
        fail(res, 409, "Bookmark limit reached (max 500)");
        return;
      }
      const { rows } = await pool.query(
        `insert into bookmarks (user_id, novel_id, volume_id, chapter_id, scroll_position, label, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,now(),now())
       returning id, novel_id, volume_id, chapter_id, scroll_position, label, created_at, updated_at`,
        [
          session.user_id,
          novelId,
          volumeId,
          chapterId,
          scrollPosition,
          label || null,
        ],
      );
      success(res, { bookmark: rows[0] }, 201);
      return;
    }

    if (req.method === "DELETE") {
      if (!validateCsrf(req, session)) {
        fail(res, 403, "Invalid CSRF token");
        return;
      }
      const body = await parseJsonBody(req);
      const id = String(body.id || "");
      if (!id) {
        fail(res, 400, "id is required");
        return;
      }
      await pool.query("delete from bookmarks where id = $1 and user_id = $2", [
        id,
        session.user_id,
      ]);
      success(res, { deleted: true });
      return;
    }

    fail(res, 405, "Method not allowed");
  } catch (error) {
    fail(res, 500, "Bookmarks unavailable");
  }
};

})();

exports.handleCommunity = (() => {

function cleanText(value, max = 2000) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

let communityCompatibilityReady = false;

async function ensureCommunityCompatibility() {
  if (communityCompatibilityReady) {
    return;
  }
  try {
    await pool.query(`
      alter table users
        add column if not exists community_banned_until timestamptz,
        add column if not exists community_ban_reason text
    `);
    await pool.query(`
      alter table posts
        drop constraint if exists posts_category_check
    `);
    await pool.query(`
      alter table posts
        add constraint posts_category_check
        check (category in ('chat', 'fan_art', 'theory', 'spoiler')) not valid
    `);
    await pool.query(`
      create table if not exists comments (
        id uuid primary key default gen_random_uuid(),
        post_id uuid not null references posts(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        content text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(`
      alter table comments add column if not exists image_url text;
    `);
    await pool.query(`
      create table if not exists likes (
        user_id uuid not null references users(id) on delete cascade,
        post_id uuid not null references posts(id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (user_id, post_id)
      )
    `);
    await pool.query(
      "create index if not exists idx_comments_post_created on comments(post_id, created_at asc)",
    );
    await pool.query("create index if not exists idx_likes_post on likes(post_id)");
  } catch (compatError) {
    console.error("[community] compatibility migration warning:", compatError.message);
  }
  communityCompatibilityReady = true;
}

return async (req, res) => {
  try {
    if (allowCors(req, res)) {
      return;
    }
    if (!takeRateLimitToken(`community:${getClientIp(req)}`, 30, 60_000)) {
      fail(res, 429, "Too many requests");
      return;
    }
    const session =
      req.method === "GET"
        ? await getSession(req).catch(() => null)
        : await requireSession(req, res, fail);
    if (!session && req.method !== "GET") {
      return;
    }
    await pool.ensureMigrations();
    await ensureCommunityCompatibility();

  const meResult = session
    ? await pool.query(
        "select role, coalesce(verified, false) as verified, community_banned_until, community_ban_reason from users where id = $1 limit 1",
        [session.user_id],
      )
    : { rows: [] };
  const me = meResult.rows[0] || null;
  const isModerator = !!me && (me.role === "owner" || me.role === "admin");
  const isCommunityBanned = !!(
    me &&
    me.community_banned_until &&
    new Date(me.community_banned_until).getTime() > Date.now()
  );

  if (req.method === "GET") {
    const limit = Math.max(1, Math.min(30, Number(req.query?.limit || 12)));
    const offset = Math.max(0, Number(req.query?.offset || 0));
    const chatOnly = String(req.query?.feed || "") === "chat";
    const postsResult = await pool.query(
      `
      select
        p.id, p.user_id, p.title, p.content, p.image_url, p.category, p.created_at, p.is_edited, p.is_deleted,
        u.username, u.avatar_url, u.verified, u.role,
        coalesce(l.like_count, 0)::int as like_count,
        coalesce(c.comment_count, 0)::int as comment_count,
        exists(select 1 from likes ul where ul.post_id = p.id and ul.user_id = $1) as liked_by_me
      from posts p
      join users u on u.id = p.user_id
      left join (
        select post_id, count(*) as like_count from likes group by post_id
      ) l on l.post_id = p.id
      left join (
        select post_id, count(*) as comment_count from comments group by post_id
      ) c on c.post_id = p.id
      ${chatOnly ? "where p.category in ('chat', 'theory', 'spoiler')" : ""}
      order by p.created_at desc
      limit $2 offset $3
      `,
      [session?.user_id || null, limit, offset],
    );

    const ids = postsResult.rows.map((post) => post.id);
    let commentsByPost = {};
    if (ids.length) {
      const commentsResult = await pool.query(
        `
        select c.id, c.post_id, c.content, c.image_url, c.created_at, c.user_id, c.is_edited, c.is_deleted, u.username, u.avatar_url, u.verified, u.role
        from comments c
        join users u on u.id = c.user_id
        where c.post_id = any($1::uuid[])
        order by c.created_at asc
        limit 200
        `,
        [ids],
      );
      commentsByPost = commentsResult.rows.reduce((acc, row) => {
        if (!acc[row.post_id]) {
          acc[row.post_id] = [];
        }
        acc[row.post_id].push(row);
        return acc;
      }, {});
    }

    success(res, {
      moderation: {
        isModerator,
        isCommunityBanned,
        bannedUntil: me?.community_banned_until || null,
        banReason: me?.community_ban_reason || "",
      },
      posts: postsResult.rows.map((post) => ({
        ...post,
        comments: commentsByPost[post.id] || [],
      })),
    });
    return;
  }

  if (!validateCsrf(req, session)) {
    fail(res, 403, "Invalid CSRF token");
    return;
  }

  const body = await parseJsonBody(req);
  const action = cleanText(body.action, 40).toLowerCase();

  if (req.method === "POST" && action === "ban_user") {
    if (!isModerator) {
      fail(res, 403, "Only owner/admin can ban users");
      return;
    }
    const username = cleanText(body.username, 64).toLowerCase();
    const reason = cleanText(body.reason, 220) || "Community rules violation";
    const hours = Math.max(1, Math.min(24 * 365, Number(body.hours) || 24));
    if (!username) {
      fail(res, 400, "username is required");
      return;
    }
    const target = await pool.query(
      "select id, role from users where lower(username) = $1 limit 1",
      [username],
    );
    if (!target.rowCount) {
      fail(res, 404, "User not found");
      return;
    }
    const targetUser = target.rows[0];
    if (targetUser.role === "owner") {
      fail(res, 403, "Owner cannot be banned");
      return;
    }
    await pool.query(
      `update users
       set community_banned_until = now() + ($2 || ' hour')::interval,
           community_ban_reason = $3,
           updated_at = now()
       where id = $1`,
      [targetUser.id, String(hours), reason],
    );
    success(res, { ok: true });
    return;
  }

  if (req.method === "POST" && action === "unban_user") {
    if (!isModerator) {
      fail(res, 403, "Only owner/admin can unban users");
      return;
    }
    const username = cleanText(body.username, 64).toLowerCase();
    if (!username) {
      fail(res, 400, "username is required");
      return;
    }
    await pool.query(
      `update users
       set community_banned_until = null,
           community_ban_reason = null,
           updated_at = now()
       where lower(username) = $1`,
      [username],
    );
    success(res, { ok: true });
    return;
  }

  if (
    isCommunityBanned &&
    (action === "create_post" ||
      action === "toggle_like" ||
      action === "add_comment")
  ) {
    fail(
      res,
      403,
      `You are banned from community interactions until ${new Date(me.community_banned_until).toLocaleString()}`,
    );
    return;
  }

  if (req.method === "POST" && action === "create_post") {
    const title = cleanText(body.title, 120);
    const content = cleanText(body.content, 3000);
    const imageUrl = cleanText(body.imageUrl, 800);
    const category = cleanText(body.category, 30);
    if (imageUrl && !isAllowedCommunityImageUrl(imageUrl)) {
      fail(res, 400, "Community images must be uploaded through Threadborn.");
      return;
    }
    if (
      !title ||
      (!content && !imageUrl) ||
      !["chat", "fan_art", "theory", "spoiler"].includes(category)
    ) {
      fail(res, 400, "Invalid post payload");
      return;
    }
    const payloadWithSignals = withModerationSignals(
      { title, content, imageUrl: imageUrl || "", category },
      ["title", "content"],
    );

    if (payloadWithSignals.moderation.filtered) {
      const request = await createModerationRequest(
        session.user_id,
        "community_post",
        payloadWithSignals
      );
      success(
        res,
        {
          pending: true,
          requestId: request.id,
          message: "Message held for review due to inappropriate language.",
        },
        202,
      );
    } else {
      const postImageUrl = imageUrl ? "https://threadborn.app/assets/pending.svg" : null;
      const { rows } = await pool.query(
        `insert into posts (user_id, title, content, image_url, category, created_at, updated_at)
         values ($1,$2,$3,$4,$5,now(),now()) returning id, created_at`,
        [session.user_id, title, content, postImageUrl, category]
      );
      const newPost = rows[0];

      if (imageUrl) {
        await createModerationRequest(
          session.user_id,
          "community_post_image",
          { imageUrl },
          { targetTable: "posts", targetId: newPost.id }
        );
      }

      success(
        res,
        {
          pending: false,
          post: newPost,
          message: imageUrl ? "Message posted. Image is held for review." : "Posted successfully.",
        },
        201,
      );
    }
    return;
  }

  if (req.method === "POST" && action === "edit_post") {
    const postId = cleanText(body.postId, 80);
    const content = cleanText(body.content, 3000);
    if (!postId || !content) {
      fail(res, 400, "postId and content are required");
      return;
    }
    const existing = await pool.query("select user_id, title, category from posts where id = $1", [postId]);
    if (!existing.rowCount) {
      fail(res, 404, "Post not found");
      return;
    }
    if (existing.rows[0].user_id !== session.user_id) {
      fail(res, 403, "You can only edit your own posts");
      return;
    }
    
    const payloadWithSignals = withModerationSignals(
      { title: existing.rows[0].title, content, category: existing.rows[0].category },
      ["title", "content"]
    );

    if (payloadWithSignals.moderation.filtered) {
      fail(res, 400, "Message edit rejected due to inappropriate language.");
      return;
    }

    await pool.query(
      `update posts set content = $1, is_edited = true, updated_at = now() where id = $2`,
      [content, postId]
    );
    success(res, { ok: true });
    return;
  }

  if (req.method === "POST" && action === "delete_post") {
    const postId = cleanText(body.postId, 80);
    if (!postId) {
      fail(res, 400, "postId is required");
      return;
    }
    const existing = await pool.query("select user_id from posts where id = $1", [postId]);
    if (!existing.rowCount) {
      fail(res, 404, "Post not found");
      return;
    }
    if (existing.rows[0].user_id !== session.user_id && !isModerator) {
      fail(res, 403, "You can only delete your own posts");
      return;
    }
    if (isModerator) {
      await pool.query(`delete from posts where id = $1`, [postId]);
    } else {
      await pool.query(
        `update posts set content = '[Deleted message]', image_url = null, is_deleted = true, updated_at = now() where id = $1`,
        [postId]
      );
    }
    success(res, { ok: true });
    return;
  }

  if (req.method === "POST" && action === "toggle_like") {
    const postId = cleanText(body.postId, 80);
    if (!postId) {
      fail(res, 400, "postId is required");
      return;
    }
    const existing = await pool.query(
      "select 1 from likes where user_id = $1 and post_id = $2",
      [session.user_id, postId],
    );
    if (existing.rowCount) {
      await pool.query(
        "delete from likes where user_id = $1 and post_id = $2",
        [session.user_id, postId],
      );
      success(res, { liked: false });
    } else {
      await pool.query("insert into likes (user_id, post_id) values ($1, $2)", [
        session.user_id,
        postId,
      ]);
      success(res, { liked: true });
    }
    return;
  }

  if (req.method === "POST" && action === "add_comment") {
    const postId = cleanText(body.postId, 80);
    const content = cleanText(body.content, 1200);
    const imageUrl = cleanText(body.imageUrl, 800);
    
    if (imageUrl && !isAllowedCommunityImageUrl(imageUrl)) {
      fail(res, 400, "Community images must be uploaded through Threadborn.");
      return;
    }
    
    if (!postId || (!content && !imageUrl)) {
      fail(res, 400, "postId and content or image are required");
      return;
    }
    const exists = await pool.query("select 1 from posts where id = $1", [
      postId,
    ]);
    if (!exists.rows.length) {
      fail(res, 404, "Post not found");
      return;
    }
    const payloadWithSignals = withModerationSignals({ postId, content, imageUrl: imageUrl || "" }, ["content"]);
    if (payloadWithSignals.moderation.filtered) {
      const request = await createModerationRequest(
        session.user_id,
        "community_comment",
        payloadWithSignals,
        { targetTable: "posts", targetId: postId },
      );
      success(
        res,
        {
          pending: true,
          requestId: request.id,
          message: "Reply held for review due to inappropriate language.",
        },
        202,
      );
    } else {
      const commentImageUrl = imageUrl ? "https://threadborn.app/assets/pending.svg" : null;
      const { rows } = await pool.query(
        `insert into comments (post_id, user_id, content, image_url, created_at, updated_at)
         values ($1,$2,$3,$4,now(),now()) returning id, created_at`,
        [postId, session.user_id, content, commentImageUrl]
      );
      const newComment = rows[0];

      if (imageUrl) {
        await createModerationRequest(
          session.user_id,
          "community_comment_image",
          { imageUrl },
          { targetTable: "comments", targetId: newComment.id }
        );
      }

      success(
        res,
        {
          pending: false,
          comment: newComment,
          message: imageUrl ? "Reply posted. Image is held for review." : "Reply posted successfully.",
        },
        201,
      );
    }
    return;
  }

  if (req.method === "POST" && action === "edit_comment") {
    const commentId = cleanText(body.commentId, 80);
    const content = cleanText(body.content, 1200);
    if (!commentId || !content) {
      fail(res, 400, "commentId and content are required");
      return;
    }
    const existing = await pool.query("select user_id, post_id from comments where id = $1", [commentId]);
    if (!existing.rowCount) {
      fail(res, 404, "Comment not found");
      return;
    }
    if (existing.rows[0].user_id !== session.user_id) {
      fail(res, 403, "You can only edit your own comments");
      return;
    }
    const payloadWithSignals = withModerationSignals({ content, postId: existing.rows[0].post_id }, ["content"]);
    if (payloadWithSignals.moderation.filtered) {
      fail(res, 400, "Comment edit rejected due to inappropriate language.");
      return;
    }
    await pool.query(
      `update comments set content = $1, is_edited = true, updated_at = now() where id = $2`,
      [content, commentId]
    );
    success(res, { ok: true });
    return;
  }

  if (req.method === "POST" && action === "delete_comment") {
    const commentId = cleanText(body.commentId, 80);
    if (!commentId) {
      fail(res, 400, "commentId is required");
      return;
    }
    const existing = await pool.query("select user_id from comments where id = $1", [commentId]);
    if (!existing.rowCount) {
      fail(res, 404, "Comment not found");
      return;
    }
    if (existing.rows[0].user_id !== session.user_id && !isModerator) {
      fail(res, 403, "You can only delete your own comments");
      return;
    }
    if (isModerator) {
      await pool.query(`delete from comments where id = $1`, [commentId]);
    } else {
      await pool.query(
        `update comments set content = '[Deleted message]', image_url = null, is_deleted = true, updated_at = now() where id = $1`,
        [commentId]
      );
    }
    success(res, { ok: true });
    return;
  }

    fail(res, 405, "Method not allowed");
  } catch (error) {
    console.error("[community] request failed:", error.message, error.code || "", error.detail || "", error.hint || "");
    fail(res, 500, "Community chat is unavailable right now.");
  }
};

})();

exports.handleProgress = (() => {

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }
  if (!takeRateLimitToken(`progress:${getClientIp(req)}`, 60, 60_000)) {
    fail(res, 429, "Too many requests");
    return;
  }
  try {
    const session = await requireSession(req, res, fail);
    if (!session) {
      return;
    }

    if (req.method === "GET") {
      const novelId = String(req.query?.novelId || "threadborn");
      const { rows } = await pool.query(
        "select novel_id, volume_id, chapter_id, scroll_position, updated_at from reading_progress where user_id = $1 and novel_id = $2 limit 1",
        [session.user_id, novelId],
      );
      success(res, { progress: rows[0] || null });
      return;
    }

    if (req.method !== "PUT") {
      fail(res, 405, "Method not allowed");
      return;
    }
    if (!validateCsrf(req, session)) {
      fail(res, 403, "Invalid CSRF token");
      return;
    }
    const body = await parseJsonBody(req);
    const novelId = String(body.novelId || "threadborn");
    const volumeId = String(body.volumeId || "");
    const chapterId = String(body.chapterId || "");
    const scrollPosition = Math.max(0, Number(body.scrollPosition || 0));
    if (!volumeId || !chapterId) {
      fail(res, 400, "volumeId and chapterId are required");
      return;
    }
    const { rows } = await pool.query(
      `insert into reading_progress (user_id, novel_id, volume_id, chapter_id, scroll_position, updated_at)
     values ($1,$2,$3,$4,$5,now())
     on conflict (user_id, novel_id)
     do update set
       volume_id = excluded.volume_id,
       chapter_id = excluded.chapter_id,
       scroll_position = excluded.scroll_position,
       updated_at = now()
     returning novel_id, volume_id, chapter_id, scroll_position, updated_at`,
      [session.user_id, novelId, volumeId, chapterId, scrollPosition],
    );
    success(res, { progress: rows[0] });
  } catch (error) {
    fail(res, 500, "Progress unavailable");
  }
};

})();

exports.handleReactions = (() => {

const FREE_TTS_BASE_URL = "https://freetts.org/api";
const MAX_TTS_CHARS = 1000;
const FREE_TTS_VOICES = {
  en: "en-US-GuyNeural",
  ja: "ja-JP-KeitaNeural",
};

function getFreeTtsVoice(language) {
  const code = String(language || "").toLowerCase();
  return code.startsWith("ja") ? FREE_TTS_VOICES.ja : FREE_TTS_VOICES.en;
}

async function handleReaderTts(req, res) {
  if (req.method !== "POST") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!takeRateLimitToken(`tts:${getClientIp(req)}`, 20, 60_000)) {
    fail(res, 429, "Too many narration requests");
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const text = String(body.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TTS_CHARS);
    if (text.length < 3) {
      fail(res, 400, "Text is too short");
      return;
    }

    const voice = getFreeTtsVoice(body.language);
    if (process.env.TTS_SERVICE_URL) {
      const headers = { "Content-Type": "application/json", Accept: "audio/mpeg, audio/wav, audio/ogg" };
      if (process.env.TTS_SERVICE_TOKEN) {
        headers.Authorization = `Bearer ${process.env.TTS_SERVICE_TOKEN}`;
      }
      const localTtsResponse = await fetch(process.env.TTS_SERVICE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, language: body.language || "en", voice }),
        signal: AbortSignal.timeout(55_000),
      });
      if (!localTtsResponse.ok) {
        fail(res, 502, "Configured narration service failed");
        return;
      }
      const contentType = String(localTtsResponse.headers.get("content-type") || "audio/mpeg")
        .split(";")[0]
        .trim();
      if (!/^audio\/(mpeg|wav|ogg|webm|mp4)$/.test(contentType)) {
        fail(res, 502, "Narration service returned an unsupported audio type");
        return;
      }
      const audio = Buffer.from(await localTtsResponse.arrayBuffer());
      if (!audio.length || audio.length > 12 * 1024 * 1024) {
        fail(res, 502, "Narration service returned invalid audio");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Threadborn-Voice", voice);
      res.end(audio);
      return;
    }

    const ttsResponse = await fetch(`${FREE_TTS_BASE_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice,
        rate: "+0%",
        pitch: "+0Hz",
      }),
    });

    if (!ttsResponse.ok) {
      fail(res, ttsResponse.status, "Free TTS narration failed");
      return;
    }

    const payload = await ttsResponse.json();
    const fileId = payload.file_id || payload.fileId || payload.id;
    if (!fileId) {
      fail(res, 502, "Free TTS did not return audio");
      return;
    }

    const audioResponse = await fetch(`${FREE_TTS_BASE_URL}/audio/${fileId}`);
    if (!audioResponse.ok) {
      fail(res, audioResponse.status, "Free TTS audio failed");
      return;
    }

    const audio = Buffer.from(await audioResponse.arrayBuffer());
    res.statusCode = 200;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Threadborn-Voice", voice);
    res.end(audio);
  } catch (error) {
    fail(res, 500, "Narration unavailable");
  }
}

function cleanText(value, max = 2000) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function cleanTarget(input) {
  const targetType = cleanText(
    input.targetType || input.target_type,
    20,
  ).toLowerCase();
  const volumeId = cleanText(input.volumeId || input.volume_id, 120);
  const chapterId = cleanText(input.chapterId || input.chapter_id, 160);
  if (!["volume", "chapter"].includes(targetType) || !volumeId) {
    return null;
  }
  if (targetType === "chapter" && !chapterId) {
    return null;
  }
  return {
    targetType,
    volumeId,
    chapterId: targetType === "chapter" ? chapterId : null,
  };
}

function rowToReaction(row) {
  return {
    id: row.id,
    targetType: row.target_type,
    volumeId: row.volume_id,
    chapterId: row.chapter_id || "",
    rating:
      row.rating === null || row.rating === undefined
        ? null
        : Number(row.rating),
    category: row.category,
    content: row.content || "",
    createdAt: row.created_at,
    user: {
      id: row.user_id,
      username: row.username || "Reader",
      avatarUrl: row.avatar_url || "",
      verified: !!row.verified,
      role: row.role || "user",
    },
  };
}

function rowToSummary(row) {
  const avg =
    row.average_rating === null || row.average_rating === undefined
      ? null
      : Number(row.average_rating);
  return {
    targetType: row.target_type,
    volumeId: row.volume_id,
    chapterId: row.chapter_id || "",
    averageRating: avg === null ? null : Math.round(avg * 10) / 10,
    ratingCount: Number(row.rating_count || 0),
    commentCount: Number(row.comment_count || 0),
  };
}

async function loadSummaries() {
  const { rows } = await pool.query(`
    select target_type, volume_id, coalesce(chapter_id, '') as chapter_id,
           avg(rating) filter (where rating is not null) as average_rating,
           count(rating)::int as rating_count,
           count(*) filter (where content <> '')::int as comment_count
    from reader_reactions
    where novel_id = 'threadborn'
    group by target_type, volume_id, coalesce(chapter_id, '')
  `);
  return rows.map(rowToSummary);
}

async function loadTarget(target, limit) {
  const { rows } = await pool.query(
    `
    select rr.id, rr.user_id, rr.target_type, rr.volume_id, rr.chapter_id, rr.rating, rr.category, rr.content, rr.created_at,
           u.username, u.avatar_url, u.verified, u.role
    from reader_reactions rr
    join users u on u.id = rr.user_id
    where rr.novel_id = 'threadborn'
      and rr.target_type = $1
      and rr.volume_id = $2
      and coalesce(rr.chapter_id, '') = coalesce($3, '')
    order by rr.created_at desc
    limit $4
  `,
    [target.targetType, target.volumeId, target.chapterId || "", limit],
  );

  const summaryRows = await pool.query(
    `
    select target_type, volume_id, coalesce(chapter_id, '') as chapter_id,
           avg(rating) filter (where rating is not null) as average_rating,
           count(rating)::int as rating_count,
           count(*) filter (where content <> '')::int as comment_count
    from reader_reactions
    where novel_id = 'threadborn'
      and target_type = $1
      and volume_id = $2
      and coalesce(chapter_id, '') = coalesce($3, '')
    group by target_type, volume_id, coalesce(chapter_id, '')
  `,
    [target.targetType, target.volumeId, target.chapterId || ""],
  );

  return {
    summary: summaryRows.rows[0]
      ? rowToSummary(summaryRows.rows[0])
      : {
          targetType: target.targetType,
          volumeId: target.volumeId,
          chapterId: target.chapterId || "",
          averageRating: null,
          ratingCount: 0,
          commentCount: 0,
        },
    reactions: rows.map(rowToReaction),
  };
}

async function loadMine(session) {
  const { rows } = await pool.query(
    `
    select rr.id, rr.user_id, rr.target_type, rr.volume_id, rr.chapter_id, rr.rating, rr.category, rr.content, rr.created_at,
           u.username, u.avatar_url, u.verified, u.role
    from reader_reactions rr
    join users u on u.id = rr.user_id
    where rr.user_id = $1
      and rr.novel_id = 'threadborn'
    order by rr.created_at desc
    limit 50
  `,
    [session.user_id],
  );
  return rows.map(rowToReaction);
}

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }

  const action = req.query?.action || "";

  if (action === "tts") {
    await handleReaderTts(req, res);
    return;
  }

  // ── Paragraph reactions ──────────────────────────────────────────────────────
  if (action === "paragraph") {
    if (!takeRateLimitToken(`para_react:${getClientIp(req)}`, 60, 60_000))
      return fail(res, 429, "Too many requests");
    if (!process.env.DATABASE_URL)
      return fail(res, 503, "Missing DATABASE_URL");
    const ALLOWED_EMOJIS = new Set(["❤️", "😂", "😱", "🔥", "💀", "🤯", "👏"]);
    try {
      await pool.ensureMigrations();
      if (req.method === "GET") {
        const chapterKey = String(req.query?.chapter_key || "");
        if (!chapterKey) return fail(res, 400, "chapter_key required");
        const session = await getSession(req).catch(() => null);
        const { rows } = await pool.query(
          `SELECT paragraph_index, emoji, COUNT(*)::int as count FROM paragraph_reactions WHERE novel_id='threadborn' AND chapter_key=$1 GROUP BY paragraph_index, emoji ORDER BY paragraph_index, count DESC`,
          [chapterKey],
        );
        let mine = [];
        if (session) {
          const mr = await pool.query(
            "SELECT paragraph_index, emoji FROM paragraph_reactions WHERE user_id=$1 AND novel_id='threadborn' AND chapter_key=$2",
            [session.user_id, chapterKey],
          );
          mine = mr.rows;
        }
        return success(res, { reactions: rows, mine });
      }
      if (req.method === "POST") {
        const session = await requireSession(req, res, fail);
        if (!session) return;
        if (!validateCsrf(req, session))
          return fail(res, 403, "Invalid CSRF token");
        const body = await parseJsonBody(req);
        const chapterKey = String(body.chapter_key || "").trim();
        const paragraphIndex = Number(body.paragraph_index);
        const emoji = String(body.emoji || "");
        if (
          !chapterKey ||
          !Number.isInteger(paragraphIndex) ||
          paragraphIndex < 0
        )
          return fail(res, 400, "Invalid payload");
        if (!ALLOWED_EMOJIS.has(emoji)) return fail(res, 400, "Invalid emoji");
        const existing = await pool.query(
          "SELECT id FROM paragraph_reactions WHERE user_id=$1 AND chapter_key=$2 AND paragraph_index=$3 AND emoji=$4",
          [session.user_id, chapterKey, paragraphIndex, emoji],
        );
        if (existing.rows.length) {
          await pool.query("DELETE FROM paragraph_reactions WHERE id=$1", [
            existing.rows[0].id,
          ]);
          return success(res, { toggled: false });
        }
        await pool.query(
          "INSERT INTO paragraph_reactions (user_id,novel_id,chapter_key,paragraph_index,emoji) VALUES ($1,'threadborn',$2,$3,$4)",
          [session.user_id, chapterKey, paragraphIndex, emoji],
        );
        return success(res, { toggled: true });
      }
      return fail(res, 405, "Method not allowed");
    } catch (error) {
      return fail(res, 500, "Paragraph reactions unavailable");
    }
  }

  if (!takeRateLimitToken(`reactions:${getClientIp(req)}`, 30, 60_000)) {
    fail(res, 429, "Too many requests");
    return;
  }
  if (!process.env.DATABASE_URL) {
    if (req.method === "GET") {
      success(res, { summaries: [], reactions: [], summary: null, mine: [] });
      return;
    }
    fail(res, 503, "Missing DATABASE_URL environment variable");
    return;
  }

  try {
    await pool.ensureMigrations();

    if (req.method === "GET") {
      const query = req.query || {};
      const limit = Math.max(1, Math.min(50, Number(query.limit || 20)));
      const session = await getSession(req).catch(() => null);
      if (query.mine === "1" || query.mine === "true") {
        if (!session) {
          fail(res, 401, "Unauthorized");
          return;
        }
        success(res, { mine: await loadMine(session) });
        return;
      }
      if (query.summary === "1" || query.summary === "true") {
        success(res, { summaries: await loadSummaries() });
        return;
      }
      const target = cleanTarget(query);
      if (!target) {
        success(res, { summaries: await loadSummaries(), reactions: [] });
        return;
      }
      success(res, await loadTarget(target, limit));
      return;
    }

    if (req.method !== "POST" && req.method !== "DELETE") {
      fail(res, 405, "Method not allowed");
      return;
    }

    const session = await requireSession(req, res, fail);
    if (!session) {
      return;
    }
    if (!validateCsrf(req, session)) {
      fail(res, 403, "Invalid CSRF token");
      return;
    }

    const body = await parseJsonBody(req);
    if (req.method === "DELETE") {
      if (session.role !== "owner" && session.role !== "admin") {
        fail(res, 403, "Only owner/admin can delete reactions");
        return;
      }
      const reactionId = cleanText(body.reactionId, 80);
      if (!reactionId) {
        fail(res, 400, "reactionId is required");
        return;
      }
      await pool.query("delete from reader_reactions where id = $1", [
        reactionId,
      ]);
      success(res, { ok: true });
      return;
    }

    const target = cleanTarget(body);
    const category = cleanText(body.category, 20).toLowerCase() || "comment";
    const content = cleanText(body.content, 1600);
    const ratingRaw =
      body.rating === "" || body.rating === undefined || body.rating === null
        ? null
        : Number(body.rating);
    const rating = Number.isFinite(ratingRaw)
      ? Math.max(1, Math.min(5, Math.round(ratingRaw)))
      : null;

    if (!target || !["comment", "theory", "spoiler"].includes(category)) {
      fail(res, 400, "Invalid reaction target");
      return;
    }
    if (!content && rating === null) {
      fail(res, 400, "Write a comment or choose a rating");
      return;
    }

    const payloadWithSignals = withModerationSignals(
      {
        targetType: target.targetType,
        volumeId: target.volumeId,
        chapterId: target.chapterId,
        rating,
        category,
        content,
      },
      ["content"],
    );

    if (payloadWithSignals.moderation.filtered) {
      const request = await createModerationRequest(
        session.user_id,
        "reader_reaction",
        payloadWithSignals
      );
      success(
        res,
        {
          pending: true,
          requestId: request.id,
          message: "Reaction submitted for review due to inappropriate language.",
        },
        202,
      );
    } else {
      const { rows } = await pool.query(
        `insert into reader_reactions
           (user_id, novel_id, target_type, volume_id, chapter_id, rating, category, content, updated_at)
         values ($1, 'threadborn', $2, $3, $4, $5, $6, $7, now()) returning id, created_at`,
        [
          session.user_id,
          target.targetType,
          target.volumeId,
          target.chapterId || null,
          rating === null ? null : rating,
          category,
          content || "",
        ]
      );
      success(
        res,
        {
          pending: false,
          reaction: rows[0],
          message: "Reaction posted successfully.",
        },
        201,
      );
    }
  } catch (error) {
    fail(res, 500, "Reader reactions unavailable");
  }
};

})();

exports.handleAvatar = (() => {

function hasValidImageSignature(contentType, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) {
    return false;
  }
  if (contentType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (contentType === "image/gif") {
    return bytes.slice(0, 6).toString("ascii") === "GIF87a" || bytes.slice(0, 6).toString("ascii") === "GIF89a";
  }
  if (contentType === "image/webp") {
    return bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!takeRateLimitToken(`avatar_upload:${getClientIp(req)}`, 5, 60_000)) {
    fail(res, 429, "Too many upload attempts");
    return;
  }
  const session = await requireSession(req, res, fail);
  if (!session) {
    return;
  }
  if (!validateCsrf(req, session)) {
    fail(res, 403, "Invalid CSRF token");
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    fail(res, 503, "Missing BLOB_READ_WRITE_TOKEN");
    return;
  }

  try {
    await pool.ensureMigrations();
    const body = await parseJsonBody(req);
    const dataUrl = String(body.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) {
      fail(res, 400, "Invalid image payload");
      return;
    }
    const [meta, base64] = dataUrl.split(",");
    const ALLOWED_IMAGE_TYPES = new Set([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ]);
    const typeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64$/.exec(meta);
    if (!typeMatch || !base64) {
      fail(res, 400, "Invalid image format");
      return;
    }
    const contentType = typeMatch[1];
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      fail(res, 400, "Only JPEG, PNG, GIF, and WebP images are allowed");
      return;
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > 3 * 1024 * 1024) {
      fail(res, 400, "Image too large (max 3MB)");
      return;
    }
    if (!hasValidImageSignature(contentType, bytes)) {
      fail(res, 400, "Image file signature does not match its type");
      return;
    }

    const ext =
      contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
          ? "webp"
          : contentType === "image/gif"
            ? "gif"
            : "jpg";
    const purpose = String(body.purpose || "avatar").trim().toLowerCase();
    if (purpose === "community") {
      const fileName = `community/pending/${session.user_id}-${Date.now()}.${ext}`;
      const blob = await put(fileName, bytes, {
        access: "public",
        addRandomSuffix: false,
        contentType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      success(res, { url: blob.url, pending: true });
      return;
    }

    if (purpose === "banner") {
      const fileName = `banners/pending/${session.user_id}-${Date.now()}.${ext}`;
      const blob = await put(fileName, bytes, {
        access: "public",
        addRandomSuffix: false,
        contentType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      const crop = body.crop && typeof body.crop === "object" ? body.crop : {};
      const request = await createModerationRequest(
        session.user_id,
        "banner_update",
        {
          bannerUrl: blob.url,
          crop: {
            x: Math.max(-1, Math.min(1, Number(crop.x) || 0)),
            y: Math.max(-1, Math.min(1, Number(crop.y) || 0)),
            size: Math.max(0.1, Math.min(1, Number(crop.size) || 1)),
            rotate: Math.max(-180, Math.min(180, Number(crop.rotate) || 0)),
          },
        },
      );
      success(res, {
        url: blob.url,
        pending: true,
        requestId: request.id,
        message: "Banner submitted for review.",
      });
      return;
    }

    const fileName = `avatars/pending/${session.user_id}-${Date.now()}.${ext}`;
    const blob = await put(fileName, bytes, {
      access: "public",
      addRandomSuffix: false,
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const crop = body.crop && typeof body.crop === "object" ? body.crop : {};
    const request = await createModerationRequest(
      session.user_id,
      "avatar_update",
      {
        avatarUrl: blob.url,
        crop: {
          x: Math.max(-1, Math.min(1, Number(crop.x) || 0)),
          y: Math.max(-1, Math.min(1, Number(crop.y) || 0)),
          size: Math.max(0.1, Math.min(1, Number(crop.size) || 1)),
          rotate: Math.max(-180, Math.min(180, Number(crop.rotate) || 0)),
        },
      },
    );

    success(res, {
      url: blob.url,
      pending: true,
      requestId: request.id,
      message: "Avatar submitted for review.",
    });
  } catch (error) {
    fail(res, 500, "Upload failed");
  }
};

})();

exports.handleProfile = (() => {

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_url || "",
    bannerUrl: row.banner_url || "",
    bio: row.bio || "",
    verified: row.verified,
    role: row.role,
    createdAt: row.created_at || null,
  };
}

function reactionRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    volumeId: row.volume_id,
    chapterId: row.chapter_id || "",
    rating:
      row.rating === null || row.rating === undefined
        ? null
        : Number(row.rating),
    category: row.category,
    content: row.content || "",
    createdAt: row.created_at,
  }));
}

function postRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    title: row.title || "",
    content: row.content || "",
    category: row.category || "post",
    imageUrl: row.image_url || "",
    createdAt: row.created_at,
  }));
}

async function loadReactionsForUser(userId) {
  const result = await pool
    .query(
      `select id, target_type, volume_id, chapter_id, rating, category, content, created_at
     from reader_reactions
     where user_id = $1
     order by created_at desc
     limit 50`,
      [userId],
    )
    .catch(() => ({ rows: [] }));
  return reactionRows(result.rows);
}

async function loadPostsForUser(userId) {
  const result = await pool
    .query(
      `select id, title, content, image_url, category, created_at
       from posts
       where user_id = $1
       order by created_at desc
       limit 30`,
      [userId],
    )
    .catch(() => ({ rows: [] }));
  return postRows(result.rows);
}

async function loadReadingHistoryForUser(userId) {
  const result = await pool
    .query(
      `select volume_id, chapter_id, last_read_at
       from reading_analytics
       where user_id = $1 and novel_id = 'threadborn'
       order by last_read_at desc
       limit 50`,
      [userId],
    )
    .catch(() => ({ rows: [] }));
  return result.rows.map(row => ({
    volumeId: row.volume_id,
    chapterId: row.chapter_id,
    lastReadAt: row.last_read_at,
  }));
}

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }

  if (!takeRateLimitToken(`profile:${getClientIp(req)}`, 60, 60_000)) {
    fail(res, 429, "Too many requests");
    return;
  }

  if (req.method === "GET" && req.query?.username) {
    if (!process.env.DATABASE_URL) {
      fail(res, 503, "Missing DATABASE_URL environment variable");
      return;
    }
    await pool.ensureMigrations();
    const username = String(req.query.username || "").trim();
    const userResult = await pool.query(
      "select id, username, avatar_url, banner_url, bio, verified, role, created_at from users where lower(username) = lower($1) limit 1",
      [username],
    );
    if (!userResult.rowCount) {
      fail(res, 404, "User not found");
      return;
    }
    const user = userResult.rows[0];
    success(res, {
      user: publicUser(user),
      reactions: await loadReactionsForUser(user.id),
      posts: await loadPostsForUser(user.id),
      readingHistory: await loadReadingHistoryForUser(user.id),
    });
    return;
  }

  // ── Push VAPID public key (action=push-vapid) ───────────────────────────────
  if (req.query?.action === "push-vapid") {
    return success(res, { publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }

  // ── Save push subscription (action=push-subscribe) ─────────────────────────
  if (req.query?.action === "push-subscribe") {
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    const session = await requireSession(req, res, fail);
    if (!session) return;
    if (!validateCsrf(req, session)) return fail(res, 403, "Invalid CSRF token");
    if (!process.env.DATABASE_URL)
      return fail(res, 503, "Missing DATABASE_URL");
    try {
      await pool.ensureMigrations();
      const body = await parseJsonBody(req);
      const { endpoint, p256dh, auth } = body;
      if (!endpoint || !p256dh || !auth)
        return fail(res, 400, "Missing subscription fields");
      await pool.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh=$3, auth=$4`,
        [session.user_id, endpoint, p256dh, auth],
      );
      return success(res, { subscribed: true });
    } catch (e) {
      return fail(res, 500, "Could not save subscription");
    }
  }

  // ── Remove push subscription (action=push-unsubscribe) ─────────────────────
  if (req.query?.action === "push-unsubscribe") {
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    const session = await requireSession(req, res, fail);
    if (!session) return;
    if (!validateCsrf(req, session)) return fail(res, 403, "Invalid CSRF token");
    if (!process.env.DATABASE_URL)
      return fail(res, 503, "Missing DATABASE_URL");
    try {
      await pool.ensureMigrations();
      const body = await parseJsonBody(req);
      if (body.endpoint) {
        await pool.query(
          "DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2",
          [session.user_id, body.endpoint],
        );
      } else {
        await pool.query("DELETE FROM push_subscriptions WHERE user_id=$1", [
          session.user_id,
        ]);
      }
      return success(res, { unsubscribed: true });
    } catch (e) {
      return fail(res, 500, "Could not remove subscription");
    }
  }

  // ── Notifications (action=notifications) ────────────────────────────────────
  if (req.query?.action === "notifications") {
    if (!takeRateLimitToken(`notif:${getClientIp(req)}`, 30, 60_000))
      return fail(res, 429, "Too many requests");
    const session = await requireSession(req, res, fail);
    if (!session) return;
    if (!process.env.DATABASE_URL)
      return fail(res, 503, "Missing DATABASE_URL");
    try {
      await pool.ensureMigrations();
      if (req.method === "GET") {
        const { rows } = await pool.query(
          "SELECT id, type, title, body, link, read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",
          [session.user_id],
        );
        const unread = rows.filter((n) => !n.read).length;
        return success(res, { notifications: rows, unread });
      }
      if (req.method === "POST") {
        const body = await parseJsonBody(req);
        if (body.markAllRead) {
          await pool.query(
            "UPDATE notifications SET read=true WHERE user_id=$1",
            [session.user_id],
          );
        } else if (body.id) {
          await pool.query(
            "UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2",
            [body.id, session.user_id],
          );
        }
        return success(res, { updated: true });
      }
      return fail(res, 405, "Method not allowed");
    } catch (e) {
      return fail(res, 500, "Notifications unavailable");
    }
  }

  // ── Feedback (action=feedback) ────────────────────────────────────────────────────
  if (req.query?.action === "feedback") {
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    if (!takeRateLimitToken(`feedback:${getClientIp(req)}`, 5, 60_000))
      return fail(res, 429, "Too many feedback submissions");
    try {
      await pool.ensureMigrations();
      const fbSession = await getSession(req).catch(() => null);
      const feedbackBody = await parseJsonBody(req);
      const feedbackType = ["bug", "suggestion", "content", "other"].includes(
        feedbackBody.type,
      )
        ? feedbackBody.type
        : "other";
      const message = String(feedbackBody.message || "").trim();
      const pagePath = String(feedbackBody.page || "/").slice(0, 200);
      if (!message || message.length < 5)
        return fail(res, 400, "Message too short");
      if (message.length > 2000) return fail(res, 400, "Message too long");
      await pool.query(
        "INSERT INTO reader_feedback (user_id,page_path,feedback_type,message) VALUES ($1,$2,$3,$4)",
        [fbSession?.user_id || null, pagePath, feedbackType, message],
      );
      // Send to Discord webhook if configured
      const webhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK;
      if (webhookUrl) {
        try {
          const colorMap = {
            bug: 0xff4444,
            suggestion: 0x44cc88,
            content: 0x4488ff,
            other: 0x888888,
          };
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              embeds: [
                {
                  title: `📣 Threadborn Feedback — ${feedbackType}`,
                  description: message.slice(0, 4000),
                  color: colorMap[feedbackType] || 0x888888,
                  fields: [
                    { name: "Type", value: feedbackType, inline: true },
                    { name: "Page", value: pagePath, inline: true },
                    {
                      name: "User",
                      value: fbSession?.username || "Anonymous",
                      inline: true,
                    },
                  ],
                  timestamp: new Date().toISOString(),
                  footer: { text: "Threadborn Reader Feedback" },
                },
              ],
            }),
          });
        } catch (discordErr) {
          console.error(
            "[feedback] Discord webhook failed:",
            discordErr.message,
          );
        }
      }
      return success(res, { submitted: true });
    } catch (e) {
      return fail(res, 500, "Could not submit feedback");
    }
  }

  const session = await requireSession(req, res, fail);
  if (!session) {
    return;
  }

  // Handle settings routing
  if (req.query?.action === "settings") {
    if (req.method === "GET") {
      const { rows } = await pool.query(
        "select settings_json from user_settings where user_id = $1 limit 1",
        [session.user_id],
      );
      return success(res, { settings: rows[0]?.settings_json || {} });
    }

    if (req.method === "PUT") {
      if (!validateCsrf(req, session)) {
        return fail(res, 403, "Invalid CSRF token");
      }
      const body = await parseJsonBody(req);
      const settings =
        typeof body.settings === "object" && body.settings ? body.settings : {};
      if (JSON.stringify(settings).length > 65536) {
        return fail(res, 400, "Settings payload too large");
      }
      const { rows } = await pool.query(
        `insert into user_settings (user_id, settings_json, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (user_id)
         do update set settings_json = excluded.settings_json, updated_at = now()
         returning settings_json`,
        [session.user_id, JSON.stringify(settings)],
      );
      return success(res, { settings: rows[0].settings_json });
    }
    return fail(res, 405, "Method not allowed for settings");
  }

  if (req.method === "GET") {
    const postsResult = await pool
      .query(
        "select id, title, content, category, created_at from posts where user_id = $1 order by created_at desc limit 20",
        [session.user_id],
      )
      .catch(() => ({ rows: [] }));
    const pendingResult = await pool
      .query(
        `select id, request_type, status, payload, created_at
         from moderation_requests
         where user_id = $1 and status = 'pending'
         order by created_at desc
         limit 20`,
        [session.user_id],
      )
      .catch(() => ({ rows: [] }));
    const userRow = await pool.query(
      "select id, email, username, avatar_url, banner_url, bio, verified, role from users where id = $1",
      [session.user_id],
    ).catch(() => ({ rows: [session] }));
    const u = userRow.rows[0] || session;
    success(res, {
      user: {
        id: u.id || session.user_id,
        email: u.email || session.email,
        username: u.username || session.username,
        avatarUrl: u.avatar_url || "",
        bannerUrl: u.banner_url || "",
        bio: u.bio || "",
        verified: u.verified ?? session.verified,
        role: u.role || session.role,
      },
      posts: postsResult.rows,
      pending: pendingResult.rows.map((row) => ({
        id: row.id,
        type: row.request_type,
        status: row.status,
        payload: row.payload || {},
        createdAt: row.created_at,
      })),
      reactions: await loadReactionsForUser(session.user_id),
    });
    return;
  }

  if (req.method !== "PATCH") {
    fail(res, 405, "Method not allowed");
    return;
  }
  if (!validateCsrf(req, session)) {
    fail(res, 403, "Invalid CSRF token");
    return;
  }

  try {
    await pool.ensureMigrations();
    const body = await parseJsonBody(req);
    const username = String(body.username || "").trim();
    if (!username || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      fail(res, 400, "Username must be 3-24 chars (letters, numbers, underscore)");
      return;
    }
    const bio = String(body.bio ?? "").trim().slice(0, 280);

    const duplicate = await pool.query(
      "select id from users where lower(username) = lower($1) and id <> $2 limit 1",
      [username, session.user_id],
    );
    if (duplicate.rows.length) {
      fail(res, 409, "Username is already in use");
      return;
    }

    // Save bio immediately (no moderation needed for short bios)
    await pool.query(
      "update users set bio = $1, updated_at = now() where id = $2",
      [bio, session.user_id],
    );

    const request = await createModerationRequest(
      session.user_id,
      "profile_update",
      withModerationSignals(
        { username, bio, previousUsername: session.username },
        ["username", "bio"],
      ),
    );
    const { rows } = await pool.query(
      "select id, email, username, avatar_url, banner_url, bio, verified, role from users where id = $1",
      [session.user_id],
    );
    success(res, {
      pending: true,
      requestId: request.id,
      message: "Profile change submitted for review.",
      user: {
        id: rows[0].id,
        email: rows[0].email,
        username: rows[0].username,
        avatarUrl: rows[0].avatar_url || "",
        bannerUrl: rows[0].banner_url || "",
        bio: rows[0].bio || "",
        verified: rows[0].verified,
        role: rows[0].role,
      },
    });
  } catch (error) {
    if (String(error.message || "").includes("duplicate")) {
      fail(res, 409, "Username is already in use");
      return;
    }
    fail(res, 500, "Profile update failed");
  }
};

})();

exports.handleDashboard = (() => {

return async (req, res) => {
  if (allowCors(req, res)) {
    return;
  }

  if (!process.env.DATABASE_URL) {
    return fail(res, 503, "Missing DATABASE_URL environment variable");
  }

  try {
    await pool.ensureMigrations();

    // Parse action from query or default to config
    const action = req.query.action || "config";

    if (action === "moderation") {
      const session = await requireSession(req, res, fail);
      if (!session) return;
      if (!isAdminSession(session)) {
        return fail(res, 403, "Only owner/admin can review moderation requests");
      }

      if (req.method === "GET") {
        const status = String(req.query.status || "pending").toLowerCase();
        const params = [];
        let where = "";
        if (["pending", "approved", "rejected"].includes(status)) {
          params.push(status);
          where = "where mr.status = $1";
        }
        const { rows } = await pool.query(
          `select mr.*, u.username, u.email, u.avatar_url, u.verified, u.role,
                  reviewer.username as reviewer_username
           from moderation_requests mr
           join users u on u.id = mr.user_id
           left join users reviewer on reviewer.id = mr.reviewed_by
           ${where}
           order by
             case when mr.status = 'pending' then 0 else 1 end,
             mr.created_at desc
           limit 100`,
          params,
        );
        return success(res, { requests: rows.map(moderationRow) });
      }

      if (req.method === "POST") {
        if (!validateCsrf(req, session)) {
          return fail(res, 403, "Invalid CSRF token");
        }
        const body = await parseJsonBody(req);
        const requestId = String(body.requestId || "").trim();
        const decision =
          String(body.decision || "").toLowerCase() === "approved"
            ? "approved"
            : String(body.decision || "").toLowerCase() === "rejected"
              ? "rejected"
              : "";
        if (!requestId || !decision) {
          return fail(res, 400, "requestId and decision are required");
        }
        try {
          await moderateRequest(
            requestId,
            session,
            decision,
            String(body.note || ""),
          );
          return success(res, { reviewed: true, status: decision });
        } catch (error) {
          const message = String(error.message || "Moderation failed");
          if (message.includes("already")) return fail(res, 409, message);
          if (message.includes("Invalid")) return fail(res, 400, message);
          if (message.includes("not found")) return fail(res, 404, message);
          if (message.includes("duplicate")) {
            return fail(res, 409, "That username is already in use");
          }
          return fail(res, 500, message);
        }
      }

      return fail(res, 405, "Method not allowed");
    }

    if (action === "config") {
      const lang = req.query.lang || "en";
      const configKey =
        lang === "ja" ? "global_settings_jp" : "global_settings";

      if (req.method === "GET") {
        const { rows } = await pool.query(
          "select value from dashboard_config where key = $1",
          [configKey],
        );
        if (!rows.length) {
          return success(res, {
            notification: "",
            notifications: [],
            countdowns: [],
            countdown: { title: "", target_date: "" },
          });
        }
        return success(res, rows[0].value);
      }

      if (req.method === "POST" || req.method === "PUT") {
        const session = await requireSession(req, res, fail);
        if (!session) return;

        if (session.role !== "owner") {
          return fail(res, 403, "Only the owner can update dashboard config");
        }

        if (!validateCsrf(req, session)) {
          return fail(res, 403, "Invalid CSRF token");
        }

        const body = await parseJsonBody(req);
        const payload = {
          notification: String(body.notification || ""), // legacy fallback
          notifications: Array.isArray(body.notifications)
            ? body.notifications.map((n) => String(n))
            : [],
          countdowns: Array.isArray(body.countdowns)
            ? body.countdowns
            : body.countdown && body.countdown.title
              ? [body.countdown]
              : [],
          countdown: {
            title: String(body.countdown?.title || ""),
            target_date: String(body.countdown?.target_date || ""),
          },
        };

        await pool.query(
          `insert into dashboard_config (key, value, updated_at)
           values ($1, $2, now())
           on conflict (key) do update set value = $2, updated_at = now()`,
          [configKey, payload],
        );

        // Broadcast push notification to all subscribers when an announcement is saved
        if (
          Array.isArray(payload.notifications) &&
          payload.notifications.length > 0
        ) {
          sendPushBroadcast(pool, {
            title: "📢 Threadborn — New Announcement",
            body: String(payload.notifications[0]).slice(0, 100),
            tag: "announcement",
            url: "/?view=community",
          }).catch(() => {});
        }

        return success(res, payload);
      }
    }

    if (action === "art") {
      // GET: Publicly list all art
      if (req.method === "GET") {
        const { rows } = await pool.query(
          "select id, character_name, url, label from dashboard_art order by created_at desc",
        );
        return success(res, { art: rows });
      }

      // Must be logged in as owner for POST and DELETE
      const session = await requireSession(req, res, fail);
      if (!session) return;

      if (session.role !== "owner") {
        return fail(res, 403, "Only the owner can modify art");
      }

      if (!validateCsrf(req, session)) {
        return fail(res, 403, "Invalid CSRF token");
      }

      // POST: Upload new art
      if (req.method === "POST") {
        if (!process.env.BLOB_READ_WRITE_TOKEN) {
          return fail(res, 503, "Missing BLOB_READ_WRITE_TOKEN");
        }

        const body = await parseJsonBody(req);
        const characterName = String(body.characterName || "").trim();
        const label = String(body.label || "").trim();
        const dataUrl = String(body.dataUrl || "");

        if (!characterName) {
          return fail(res, 400, "Character name is required");
        }

        if (!dataUrl.startsWith("data:image/")) {
          return fail(res, 400, "Invalid image payload");
        }

        const [meta, base64] = dataUrl.split(",");
        const typeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64$/.exec(meta);
        if (!typeMatch || !base64) {
          return fail(res, 400, "Invalid image format");
        }

        const contentType = typeMatch[1];
        const allowedTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
        if (!allowedTypes.has(contentType)) {
          return fail(res, 400, "Only JPEG, PNG, GIF, and WebP images are allowed");
        }
        const bytes = Buffer.from(base64, "base64");

        if (bytes.length > 5 * 1024 * 1024) {
          return fail(res, 400, "Image too large (max 5MB)");
        }
        if (!isTrustedImageBytes(contentType, bytes)) {
          return fail(res, 400, "Image file signature does not match its type");
        }

        const ext =
          contentType === "image/png"
            ? "png"
            : contentType === "image/webp"
              ? "webp"
              : contentType === "image/gif"
                ? "gif"
                : "jpg";
        const fileName = `art/${characterName.toLowerCase().replace(/[^a-z0-9]/g, "_")}-${Date.now()}.${ext}`;

        const blob = await put(fileName, bytes, {
          access: "public",
          addRandomSuffix: true,
          contentType,
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });

        const { rows } = await pool.query(
          `insert into dashboard_art (character_name, url, label, created_at)
           values ($1, $2, $3, now()) returning id, character_name, url, label`,
          [characterName, blob.url, label],
        );

        return success(res, { art: rows[0] });
      }

      // DELETE: Remove art
      if (req.method === "DELETE") {
        const body = await parseJsonBody(req);
        const id = String(body.id || "");
        if (!id) return fail(res, 400, "Missing art ID");

        const { rows } = await pool.query(
          "select url from dashboard_art where id = $1",
          [id],
        );
        if (rows.length > 0) {
          try {
            if (process.env.BLOB_READ_WRITE_TOKEN) {
              await del(rows[0].url, {
                token: process.env.BLOB_READ_WRITE_TOKEN,
              });
            }
          } catch (e) {
            console.error("[dashboard] blob delete failed:", e);
          }
          await pool.query("delete from dashboard_art where id = $1", [id]);
        }
        return success(res, { deleted: true });
      }
    }

    if (action === "polls") {
      // GET: Fetch active polls for a given language
      if (req.method === "GET") {
        const lang = req.query.lang || "en";
        const { rows: polls } = await pool.query(
          "select id, question, created_at from polls where is_active = true and lang = $1 order by created_at desc",
          [lang],
        );

        if (polls.length > 0) {
          const pollIds = polls.map((p) => p.id);
          const { rows: allOptions } = await pool.query(
            "select id, poll_id, option_text, votes from poll_options where poll_id = any($1::uuid[]) order by id asc",
            [pollIds],
          );
          const optionsByPoll = allOptions.reduce((acc, opt) => {
            if (!acc[opt.poll_id]) acc[opt.poll_id] = [];
            acc[opt.poll_id].push({
              id: opt.id,
              option_text: opt.option_text,
              votes: opt.votes,
            });
            return acc;
          }, {});
          for (const poll of polls) {
            poll.options = optionsByPoll[poll.id] || [];
          }
        }

        return success(res, { polls });
      }

      // POST: Vote on a poll
      if (req.method === "POST") {
        const ip = getClientIp(req);
        if (!takeRateLimitToken(`poll_vote:${ip}`, 10, 60_000)) {
          return fail(res, 429, "Too many votes, please try again later");
        }
        const body = await parseJsonBody(req);
        const optionId = String(body.optionId || "");
        if (!optionId) return fail(res, 400, "Missing option ID");

        const result = await pool.query(
          "update poll_options set votes = votes + 1 where id = $1 and poll_id in (select id from polls where is_active = true)",
          [optionId],
        );
        if (result.rowCount === 0) {
          return fail(res, 404, "Poll option not found");
        }
        return success(res, { voted: true });
      }

      // Must be logged in as owner for PUT and DELETE
      const session = await requireSession(req, res, fail);
      if (!session) return;

      if (session.role !== "owner") {
        return fail(res, 403, "Only the owner can modify polls");
      }

      if (!validateCsrf(req, session)) {
        return fail(res, 403, "Invalid CSRF token");
      }

      // PUT: Create a new poll
      if (req.method === "PUT") {
        const body = await parseJsonBody(req);
        const question = String(body.question || "").trim();
        const lang = String(body.lang || "en").trim();
        const options = Array.isArray(body.options) ? body.options : [];

        if (!question || options.length < 2) {
          return fail(
            res,
            400,
            "Poll must have a question and at least 2 options",
          );
        }

        const client = await pool.connect();
        let pollId;
        try {
          await client.query("begin");
          const { rows } = await client.query(
            "insert into polls (question, lang, is_active) values ($1, $2, true) returning id",
            [question, lang],
          );
          pollId = rows[0].id;
          for (const opt of options) {
            await client.query(
              "insert into poll_options (poll_id, option_text, votes) values ($1, $2, 0)",
              [pollId, String(opt).trim()],
            );
          }
          await client.query("commit");
        } catch (txErr) {
          await client.query("rollback");
          throw txErr;
        } finally {
          client.release();
        }
        return success(res, { created: true, pollId });
      }

      // DELETE: Remove a poll
      if (req.method === "DELETE") {
        const body = await parseJsonBody(req);
        const id = String(body.id || "");
        if (!id) return fail(res, 400, "Missing poll ID");

        await pool.query("delete from polls where id = $1", [id]);
        return success(res, { deleted: true });
      }
    }

    if (action === "clear_all") {
      if (req.method === "POST") {
        const session = await requireSession(req, res, fail);
        if (!session || session.role !== "owner") {
          return fail(res, 403, "Only owner can clear data");
        }
        if (!validateCsrf(req, session)) {
          return fail(res, 403, "Invalid CSRF token");
        }
        const body2 = await parseJsonBody(req);
        if (body2.confirm !== "DELETE_ALL_DATA") {
          return fail(
            res,
            400,
            "Missing confirmation — send { confirm: 'DELETE_ALL_DATA' }",
          );
        }
        await pool.query("truncate dashboard_config");
        await pool.query("truncate dashboard_art");
        await pool.query("truncate polls cascade");
        return success(res, { cleared: true });
      }
    }

    if (action === "unlocks") {
      const lang = req.query.lang || "en";
      if (req.method === "GET") {
        const session = await getSession(req).catch(() => null);
        const { rows: milestones } = await pool.query(
          "SELECT id, title, description, unlock_type, target_votes, current_votes, is_unlocked, unlock_content FROM unlock_milestones WHERE lang=$1 ORDER BY created_at ASC",
          [lang],
        );
        let myVotes = new Set();
        if (session) {
          const vr = await pool.query(
            "SELECT milestone_id FROM unlock_votes WHERE user_id=$1",
            [session.user_id],
          );
          myVotes = new Set(vr.rows.map((r) => r.milestone_id));
        }
        return success(res, {
          milestones: milestones.map((m) => ({
            ...m,
            voted: myVotes.has(m.id),
          })),
        });
      }
      if (req.method === "POST") {
        const session = await requireSession(req, res, fail);
        if (!session) return;
        if (!validateCsrf(req, session))
          return fail(res, 403, "Invalid CSRF token");
        const body = await parseJsonBody(req);
        const milestoneId = String(body.milestoneId || "");
        if (!milestoneId) return fail(res, 400, "milestoneId required");
        const existing = await pool.query(
          "SELECT id FROM unlock_votes WHERE user_id=$1 AND milestone_id=$2",
          [session.user_id, milestoneId],
        );
        if (existing.rows.length) return fail(res, 409, "Already voted");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "INSERT INTO unlock_votes (user_id, milestone_id) VALUES ($1,$2)",
            [session.user_id, milestoneId],
          );
          const updated = await client.query(
            "UPDATE unlock_milestones SET current_votes=current_votes+1, updated_at=now(), is_unlocked=(current_votes+1 >= target_votes) WHERE id=$1 RETURNING current_votes, target_votes, is_unlocked",
            [milestoneId],
          );
          await client.query("COMMIT");
          return success(res, { voted: true, ...updated.rows[0] });
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
    }

    return fail(res, 405, "Method not allowed");
  } catch (error) {
    return fail(res, 500, "Failed to manage dashboard");
  }
};

})();

/*
 * GET /api/quote — quote of the day, drawn from the Threadboner manuscripts.
 *
 * Deliberately touches no database: this is a pure function of the date, so it
 * stays fast, cannot fail on a cold instance, and is safe to cache hard. The
 * selection is deterministic, so every visitor on a given day sees the same
 * line and the response can be held at the edge until midnight.
 *
 *   /api/quote                      today's quote
 *   /api/quote?date=2026-12-31      a specific day's quote
 *   /api/quote?offset=3             the 4th quote of that day
 *   /api/quote?tag=door&limit=5     quotes carrying one tag
 *   /api/quote?format=feed          RSS, for readers and bots
 */
const quoteRouteHandler = (() => {
  const quotes = require("../lib/api/quotes");

  function quoteEtag(dateKey, offset, tag) {
    return `W/"tbq-${dateKey}-${offset}-${tag || "all"}"`;
  }

  function cacheControl(req) {
    // Until midnight UTC the answer cannot change, so let the edge keep it.
    return "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400";
  }

  function localUtcDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function readParams(req) {
    // Vercel populates req.query; other hosts only give the raw string. Read the
    // query string properly and only fall back to req.query for keys it lacks —
    // feeding a bare value straight into URLSearchParams turns "2026-01-01" into
    // a *key* with an empty value, which silently ignores the date.
    const qs = String((req.url || "").split("?")[1] || "").replace(/^[?&]+/, "");
    const sp = new URLSearchParams(qs);
    const q = req.query || {};

    const pick = (key, alias) => {
      const fromUrl = sp.get(key);
      if (fromUrl !== null && fromUrl !== "") return fromUrl;
      const raw = q[key] !== undefined ? q[key] : alias ? q[alias] : undefined;
      if (raw === undefined || raw === null || raw === "") return null;
      return Array.isArray(raw) ? raw[0] : String(raw);
    };

    const date = pick("date", "d");
    const offsetRaw = pick("offset", "o");
    const tagRaw = pick("tag");
    const limitRaw = pick("limit");
    const formatRaw = pick("format");

    const offset = Number.parseInt(offsetRaw || "0", 10);
    const limit = Number.parseInt(limitRaw || "0", 10);

    return {
      date: date || localUtcDate(),
      offset: Number.isFinite(offset) ? offset : 0,
      tag: tagRaw ? String(tagRaw).toLowerCase() : null,
      limit: Number.isFinite(limit) ? limit : 0,
      format: formatRaw ? String(formatRaw).toLowerCase() : "json",
    };
  }

  function buildFeed(dateKey, all) {
    const items = all
      .slice(0, 30)
      .map(
        (q) =>
          `    <item>` +
          `<title>${escapeXml(q.source)}</title>` +
          `<description>${escapeXml(q.text)}</description>` +
          `<guid isPermaLink="false">tbq-${q.id}-${dateKey}</guid>` +
          `<category>${escapeXml(q.tag)}</category>` +
          `</item>`,
      )
      .join("\n");
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<rss version="2.0"><channel>\n` +
      `  <title>Threadboner — Quotes</title>\n` +
      `  <description>A line a day from the Threadborn manuscripts.</description>\n` +
      `  <link>/api/quote</link>\n` +
      `  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n` +
      items +
      `\n</channel></rss>`
    );
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  async function handleQuote(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (allowCors(req, res)) return;
      return fail(res, 405, "Method not allowed");
    }
    if (allowCors(req, res)) return;

    if (!takeRateLimitToken(`quote:${getClientIp(req)}`, 120, 60_000)) {
      return fail(res, 429, "Too many quote requests");
    }

    try {
      const params = readParams(req);

      // A requested date must be a real calendar date, and we never serve
      // future lore — a quote from tomorrow is a spoiler by construction.
      const today = localUtcDate();
      let dateKey = today;
      if (params.date !== today) {
        if (!quotes.isValidIsoDate(params.date)) {
          return fail(res, 400, "Date must be a real YYYY-MM-DD calendar date");
        }
        if (params.date > today) {
          return fail(res, 400, "That date has not happened yet");
        }
        dateKey = params.date;
      }

      const all = quotes.getQuotes();

      if (params.format === "feed" || params.format === "rss") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
        res.setHeader("Cache-Control", cacheControl(req));
        res.end(buildFeed(dateKey, all));
        return;
      }

      const scoped = params.tag
        ? quotes.filterQuotes({ tag: params.tag, limit: params.limit })
        : all;

      if (!scoped.length) {
        return fail(res, 404, `No quotes tagged "${params.tag}"`);
      }

      // A tag narrows the pool, so the day still has to land inside it.
      const pool = params.tag ? scoped : all;
      const picked = quotes.pickForDate(dateKey, params.offset);
      const index = pool.findIndex((q) => q.id === picked.id);
      const quote = index >= 0 ? picked : pool[0];

      res.setHeader("ETag", quoteEtag(dateKey, params.offset, params.tag));
      if (req.headers["if-none-match"] === quoteEtag(dateKey, params.offset, params.tag)) {
        res.statusCode = 304;
        res.end();
        return;
      }

      return success(
        res,
        {
          quote,
          date: dateKey,
          offset: params.offset,
          tag: params.tag,
          total: all.length,
          available: scoped.length,
          tags: quotes.getTags(),
          source: "Threadboner manuscripts",
        },
        200,
        { "Cache-Control": cacheControl(req), ETag: quoteEtag(dateKey, params.offset, params.tag) },
      );
    } catch (error) {
      return fail(res, 500, "Could not resolve a quote");
    }
  }

  return handleQuote;
})();

exports.handleQuote = quoteRouteHandler;

/*
 * GET /api/quote/daily — the line of the day, sourced from ZenQuotes.
 *
 * Deliberately separate from /api/quote. That route serves the curated
 * Threadboner pool, and its contract (deterministic date+offset pick, tag
 * filter, RSS, ETag) is covered by tests and must not start depending on a
 * third party. This route adds the external feed as a sibling and falls back to
 * the curated pool whenever ZenQuotes is down or rate-limited.
 *
 * Fetched here rather than in the browser because the free ZenQuotes tier sends
 * no Access-Control-Allow-Origin header. Cached for an hour behind a long
 * s-maxage, per ZenQuotes' own guidance to "cache a batch of quotes ... and
 * refresh after an hour or so" — their limit is 5 requests / 30s / IP, so an
 * uncached per-request call would throttle immediately.
 */
const quoteDailyHandler = (() => {
  const zen = require("../lib/api/zenquotes");
  const quotes = require("../lib/api/quotes");

  function readInt(v, dflt) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
  }

  function todayUtc() {
    return new Date().toISOString().slice(0, 10);
  }

  async function handleQuoteDaily(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (allowCors(req, res)) return;
      return fail(res, 405, "Method not allowed");
    }
    if (allowCors(req, res)) return;

    if (!takeRateLimitToken(`quote-daily:${getClientIp(req)}`, 120, 60_000)) {
      return fail(res, 429, "Too many requests");
    }

    try {
      const sp = new URLSearchParams(
        String((req.url || "").split("?")[1] || "").replace(/^[?&]+/, "")
      );
      const requested = sp.get("date");
      const today = todayUtc();
      const dateKey = requested ? String(requested) : today;
      if (dateKey !== today && !quotes.isValidIsoDate(dateKey)) {
        return fail(res, 400, "Date must be a real YYYY-MM-DD calendar date");
      }
      if (dateKey > today) {
        return fail(res, 400, "That date has not happened yet");
      }

      const offset = readInt(sp.get("offset"), 0);
      const external = await zen.getDailyQuotes(dateKey, offset, 1);

      if (external && external.length) {
        return success(
          res,
          {
            quote: external[0],
            date: dateKey,
            offset,
            source: "zenquotes",
            attribution: zen.ATTRIBUTION,
          },
          200,
          {
            "Cache-Control":
              "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400",
          }
        );
      }

      // External unavailable: serve a curated line so the block is never empty
      return success(
        res,
        {
          quote: zen.curatedFallback(dateKey, offset),
          date: dateKey,
          offset,
          source: "curated",
          fallback: true,
          attribution: null,
        },
        200,
        { "Cache-Control": "public, max-age=300, s-maxage=1800" }
      );
    } catch (error) {
      // last-ditch: never leave the block empty
      return success(
        res,
        { quote: zen.curatedFallback(todayUtc(), 0), date: todayUtc(), source: "curated", fallback: true },
        200
      );
    }
  }

  return handleQuoteDaily;
})();

exports.handleQuoteDaily = quoteDailyHandler;

function getPrivatePdfBlobAuthOptions() {
  const oidcToken = process.env.VERCEL_OIDC_TOKEN?.trim();
  const storeId = process.env.PRIVATE_BLOB_STORE_ID?.trim();
  if (oidcToken && storeId) return { oidcToken, storeId };

  const token = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN?.trim();
  return token ? { token } : null;
}

exports.handlePrivatePdfUpload = async (req, res) => {
  if (allowCors(req, res)) return;

  try {
    if (!getPrivatePdfBlobAuthOptions()) {
      return fail(res, 503, "Private PDF storage is not configured");
    }
    await pool.ensureMigrations();
    if (req.method === "GET") {
      const session = await requireSession(req, res, fail);
      if (!session) return;
      if (!isAdminSession(session)) return fail(res, 403, "Only owner/admin can view the archive");
      const { rows } = await pool.query(
        `select id, title, volume_number, premiere_at, uploaded_at, created_at
         from private_pdf_releases order by premiere_at desc, volume_number desc limit 100`,
      );
      return success(res, { releases: rows });
    }
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");

    const body = await parseJsonBody(req);
    const uploadResponse = await handleUploadPresigned({
      body,
      request: req,
      webhookPublicKey: process.env.PRIVATE_BLOB_WEBHOOK_PUBLIC_KEY,
      getSignedToken: async (pathname, clientPayload) => {
        const session = await requireSession(req, res, fail);
        if (!session) throw new Error("Unauthorized");
        if (!isAdminSession(session)) throw new Error("Only owner/admin can upload PDFs");

        let metadata;
        try {
          metadata = JSON.parse(String(clientPayload || ""));
        } catch {
          throw new Error("Upload details are invalid");
        }
        const csrfToken = String(metadata.csrfToken || "");
        if (
          csrfToken.length !== session.csrf_token.length ||
          !crypto.timingSafeEqual(Buffer.from(csrfToken), Buffer.from(session.csrf_token))
        ) {
          throw new Error("Invalid CSRF token");
        }

        const title = String(metadata.title || "")
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
          .slice(0, 160);
        const volumeNumber = Number(metadata.volumeNumber);
        const premiereAt = new Date(metadata.premiereAt);
        const requestedPath = String(pathname || "");
        if (!title || !Number.isInteger(volumeNumber) || volumeNumber < 1 || volumeNumber > 9999) {
          throw new Error("A title and valid volume number are required");
        }
        if (Number.isNaN(premiereAt.getTime())) throw new Error("Choose a valid premiere date and time");
        if (!/^threadborn-archive\/[a-f0-9-]{36}\.pdf$/i.test(requestedPath)) {
          throw new Error("Only PDF files are accepted");
        }

        const validUntil = Date.now() + 10 * 60 * 1000;
        const token = await issueSignedToken({
          ...getPrivatePdfBlobAuthOptions(),
          pathname: requestedPath,
          operations: ["put"],
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: 100 * 1024 * 1024,
          validUntil,
        });
        await pool.query(
          `insert into private_pdf_releases (title, volume_number, pathname, premiere_at, created_by)
           values ($1, $2, $3, $4, $5)`,
          [title, volumeNumber, requestedPath, premiereAt.toISOString(), session.user_id],
        );
        return {
          token,
          urlOptions: {
            allowedContentTypes: ["application/pdf"],
            maximumSizeInBytes: 100 * 1024 * 1024,
            validUntil,
            addRandomSuffix: false,
            allowOverwrite: false,
          },
        };
      },
      onUploadCompleted: async ({ blob }) => {
        if (!blob?.pathname || !/^threadborn-archive\/[a-f0-9-]{36}\.pdf$/i.test(blob.pathname)) {
          throw new Error("Invalid uploaded PDF path");
        }
        await pool.query(
          "update private_pdf_releases set uploaded_at = now() where pathname = $1",
          [blob.pathname],
        );
      },
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(uploadResponse));
  } catch (error) {
    if (!res.writableEnded) {
      const message = error?.message || "PDF upload failed";
      const statusCode = /unauthorized/i.test(message) ? 401 : /owner\/admin/i.test(message) ? 403 : 400;
      fail(res, statusCode, message);
    }
  }
};

exports.handlePublicPdfReleases = async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  if (!process.env.DATABASE_URL) return fail(res, 503, "PDF archive is unavailable");
  if (!getPrivatePdfBlobAuthOptions()) return fail(res, 503, "PDF archive storage is not configured");
  try {
    await pool.ensureMigrations();
    const id = String(req.query?.id || "").trim();
    if (id) {
      const { rows } = await pool.query(
        `select id, title, volume_number, pathname, premiere_at
         from private_pdf_releases
         where id = $1 and uploaded_at is not null and premiere_at <= now()
         limit 1`,
        [id],
      );
      if (!rows.length) return fail(res, 404, "This volume has not premiered");
      const item = rows[0];
      const validUntil = Date.now() + 60 * 60 * 1000;
      const token = await issueSignedToken({
        ...getPrivatePdfBlobAuthOptions(),
        pathname: item.pathname,
        operations: ["get"],
        validUntil,
      });
      const { presignedUrl } = await presignUrl(token, {
        pathname: item.pathname,
        operation: "get",
        access: "private",
        validUntil,
      });
      return success(res, {
        volume: {
          id: item.id,
          title: item.title,
          volumeNumber: item.volume_number,
          premiereAt: item.premiere_at,
          url: presignedUrl,
        },
      }, 200, { "Cache-Control": "no-store" });
    }

    const { rows } = await pool.query(
      `select id, title, volume_number, premiere_at,
              (premiere_at <= now()) as released
       from private_pdf_releases
       where uploaded_at is not null
       order by volume_number desc, premiere_at desc`,
    );
    success(res, {
      releases: rows.map((row) => ({
        id: row.id,
        title: row.title,
        volumeNumber: row.volume_number,
        premiereAt: row.premiere_at,
        released: row.released,
      })),
    }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    fail(res, 500, "Could not load the release archive");
  }
};

const routeHandlers = new Map([
  ["/api/auth/login", exports.handleLogin],
  ["/api/auth/logout", exports.handleLogout],
  ["/api/auth/me", exports.handleMe],
  ["/api/auth/signup", exports.handleSignup],
  ["/api/auth/google/start", exports.handleGoogleAuthStart],
  ["/api/auth/google/callback", exports.handleGoogleAuthCallback],
  ["/api/dashboard", exports.handleDashboard],
  ["/api/reader/analytics", exports.handleAnalytics],
  ["/api/reader/bookmarks", exports.handleBookmarks],
  ["/api/reader/community", exports.handleCommunity],
  ["/api/reader/progress", exports.handleProgress],
  ["/api/reader/reactions", exports.handleReactions],
  ["/api/upload/avatar", exports.handleAvatar],
  ["/api/upload/banner", exports.handleAvatar],
  ["/api/upload/pdf", exports.handlePrivatePdfUpload],
  ["/api/reader/volumes", exports.handlePublicPdfReleases],
  ["/api/user/profile", exports.handleProfile],
  ["/api/quote", quoteRouteHandler],
  ["/api/quote/daily", quoteDailyHandler],
]);

function getApiPath(req) {
  const requestUrl = new URL(
    req.url || "/",
    `https://${req.headers.host || "threadborn.local"}`,
  );
  const queryPath = req.query && (req.query.__threadborn_path || req.query.path);
  const rewrittenPath =
    requestUrl.searchParams.get("__threadborn_path") ||
    requestUrl.searchParams.get("path") ||
    (Array.isArray(queryPath) ? queryPath.join("/") : queryPath);
  if (rewrittenPath) {
    return `/api/${rewrittenPath}`.replace(/\/+$/, "");
  }
  return requestUrl.pathname.replace(/\/+$/, "") || "/api";
}

module.exports = async function handleApi(req, res) {
  const pathname = getApiPath(req);
  const handler = routeHandlers.get(pathname);

  if (!handler) {
    if (allowCors(req, res)) {
      return;
    }
    return fail(res, 404, "API route not found");
  }

  return handler(req, res);
};

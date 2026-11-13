// Drinking Buddies — swipe to find someone to drink with nearby.
// Express API + static PWA frontend, backed by PostgreSQL (DATABASE_URL).
//
// Account verification:
//   basic = phone (SMS OTP) + email (link)   → can use the app, go out, browse
//   full  = basic + selfie (admin-reviewed) + government ID (KYC)
//                                            → can like, match, chat, buy drinks, and appears in the feed

// Node 22+ (AWS SDK and other dependencies require it). `nvm use` picks the version from .nvmrc.
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Drinking Buddies needs Node 22 or newer (this is ${process.version}). Run: nvm install && nvm use`);
  process.exit(1);
}

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const sec = require('./lib/security');
const { sms, email: mailer, kyc, ageFrom, ID_TYPES } = require('./lib/providers');

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const PRODUCTION = env.NODE_ENV === 'production';
const DEMO = env.DEMO === '1';
const D = require('./lib/db'); // DATABASE_URL (dev default: the `npm run db:start` database)
const limiter = require('./lib/ratelimit'); // REDIS_URL (dev default: local Redis)
const storage = require('./lib/storage');   // S3_* / STORAGE_DRIVER (dev default: ./data/photos)
const { one, many, tx, updateUser, insertUser, getUser, getUsers } = D;
const partners = require('./lib/partners');
const billing = require('./lib/billing');
let P = null; // partner-venue hooks, set up once routes are registered

const DATA_DIR = env.DATA_DIR || (env.DB_FILE ? path.dirname(env.DB_FILE) : path.join(__dirname, 'data')); // dev secrets only
const APP_URL = (env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, ''); // never built from the Host header
const ADMIN_USERS = new Set((env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const MIN_AGE = 18; // legal drinking age (Kenya); change per market
// Registration consent (public/consent.html). Bump the version when the text changes in a way that
// affects users' data: everyone is asked to accept again on their next visit.
const CONSENT_VERSION = '2026-11-12';
const CONSENT_REQUIRED = ['age', 'terms', 'idCheck', 'location'];
const CONSENT_OPTIONAL = ['deals', 'notify'];
const ticked = (v) => v === true || v === 'on' || v === 'true';
function consentChoices(body) {
  const c = body && typeof body.consent === 'object' && body.consent ? body.consent : {};
  const choices = {};
  for (const k of [...CONSENT_REQUIRED, ...CONSENT_OPTIONAL]) choices[k] = ticked(c[k]);
  return { choices, ok: CONSENT_REQUIRED.every((k) => choices[k]) };
}
const FREE_LIKES = Number(env.FREE_LIKES_PER_DAY) || 25; // per rolling 24 h; Buddies Plus = unlimited
const FREE_RADIUS_KM = 10;
const PLUS_RADIUS_KM = 50;
const BOOST_MINUTES = 30;
const STATUS_HOURS_MAX = 12;
const SESSION_MAX_AGE = 30 * 24 * 3600e3; // absolute
const SESSION_IDLE = 7 * 24 * 3600e3;     // idle timeout
const COOKIE = PRODUCTION ? '__Host-sid' : 'sid';

// ---------- refuse to run insecurely in production ----------
if (PRODUCTION) {
  const missing = [];
  if (!env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!env.REDIS_URL) missing.push('REDIS_URL (shared rate limits)');
  if (storage.driver === 'none') missing.push('S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY (photo storage), or STORAGE_DRIVER=local');
  if (!env.APP_SECRET || env.APP_SECRET.length < 32) missing.push('APP_SECRET (32+ chars)');
  if (sms.name === 'console') missing.push('AT_API_KEY + AT_USERNAME (SMS)');
  if (mailer.name === 'console') missing.push('RESEND_API_KEY + EMAIL_FROM (email)');
  if (kyc.name === 'mock') missing.push('SMILE_PARTNER_ID + SMILE_API_KEY (ID checks)');
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) missing.push('VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (push)');
  if (!env.APP_URL || !env.APP_URL.startsWith('https://')) missing.push('APP_URL (https://…)');
  if (!ADMIN_USERS.size) missing.push('ADMIN_USERS');
  if (DEMO) missing.push('DEMO must be off');
  if (missing.length) {
    console.error('Refusing to start in production. Fix:\n  - ' + missing.join('\n  - '));
    process.exit(1);
  }
}

// ---------- dev secrets (production uses env vars) ----------
function readOrCreateJSON(file, make) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const v = make();
    fs.writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
    return v;
  }
}
// HMAC secret for OTPs and ID-number fingerprints.
const APP_SECRET = env.APP_SECRET || readOrCreateJSON(path.join(DATA_DIR, 'secret.json'), () => ({ secret: sec.randomToken(48) })).secret;
const hmac = sec.makeHmac(APP_SECRET);

// ---------- push notifications (Web Push / VAPID) ----------
const vapid = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
  ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
  : readOrCreateJSON(path.join(DATA_DIR, 'vapid.json'), () => webpush.generateVAPIDKeys());
try {
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
} catch (e) {
  console.error(`Invalid VAPID keys (${e.message}). Generate a pair with: npx web-push generate-vapid-keys`);
  process.exit(1);
}

// Remove a push endpoint from whoever holds it.
const dropPushEndpoint = (endpoint) => D.q(
  `UPDATE users SET push_subs = (SELECT coalesce(jsonb_agg(e), '[]') FROM jsonb_array_elements(push_subs) e WHERE e->>'endpoint' <> $1)
   WHERE push_subs @> jsonb_build_array(jsonb_build_object('endpoint', $1::text))`, [endpoint]);

async function pushTo(user, payload) {
  const subs = user.pushSubs || [];
  await Promise.all(subs.map((sub) => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 })
    .catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) return dropPushEndpoint(sub.endpoint); // expired / revoked
      console.warn('push failed:', err.statusCode || err.message);
    })));
}

// ---------- helpers ----------
const id = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isOut = (u) => !!(u?.status && u.status.until > now());
const isPlus = (u) => (u.plusUntil || 0) > now();
const isBoosted = (u) => (u.boostUntil || 0) > now() && isOut(u);
const isAdmin = (u) => !!u && !u.bot && ADMIN_USERS.has(u.username) && u.phoneVerified;
const ageOf = (u) => (u.dob ? ageFrom(u.dob) : null);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());
const pgUnique = (e) => e && e.code === '23505';

// ----- photos: up to 6; position 0 is the main photo (the one the verification selfie is checked against)
const MAX_PHOTOS = 6;
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s;
const validImage = (d) => typeof d === 'string' && DATA_URL_RE.test(d) && d.length < 500_000;
const decodeImage = (d) => { const [, mime, b64] = d.match(DATA_URL_RE); return { mime, data: Buffer.from(b64, 'base64') }; };
const mainPhoto = (u) => u.photos?.[0] || null;
const photoUrl = (u, ph) => `/api/photos/${u.id}/${ph.id}`; // served with access checks, never inlined

function distanceKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Lat/lng bounding box around a point (fast pre-filter for the index; exact distance done after).
function bbox(lat, lng, km) {
  const dLat = km / 111.32, dLng = km / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
}

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-().]/g, '');
  if (/^0[17]\d{8}$/.test(p)) p = '+254' + p.slice(1);       // 07xx / 01xx (Kenya)
  else if (/^254[17]\d{8}$/.test(p)) p = '+' + p;
  else if (/^[17]\d{8}$/.test(p)) p = '+254' + p;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
const normalizeEmail = (raw) => {
  const e = str(raw, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null;
};
const maskPhone = (p) => (p ? p.slice(0, 5) + '•••' + p.slice(-3) : null);
const maskEmail = (e) => (e ? e[0] + '•••@' + e.split('@')[1] : null);

function verification(u) {
  const basic = !!(u.phoneVerified && u.emailVerified);
  const selfie = u.selfie?.status || 'none';
  const idv = u.kyc?.status || 'none';
  return {
    phone: !!u.phoneVerified, email: !!u.emailVerified, basic,
    selfie, selfieNote: u.selfie?.note || null,
    id: idv, idNote: u.kyc?.note || null,
    full: basic && selfie === 'approved' && idv === 'verified',
  };
}
const fullyVerified = (u) => verification(u).full;
const visible = (u) => fullyVerified(u) && !u.banned && !u.underReview;
// The same "visible" rule as SQL, for feed queries.
const VISIBLE_SQL = `u.phone_verified AND u.email_verified AND u.selfie->>'status' = 'approved'
  AND u.kyc->>'status' = 'verified' AND u.banned IS NULL AND NOT u.under_review`;

function audit(action, { req, uid, meta } = {}) {
  return D.q('INSERT INTO audit (at, action, uid, ip, meta) VALUES ($1, $2, $3, $4, $5)',
    [now(), action, uid || req?.user?.id || null, req?.ip || null, meta ? JSON.stringify(meta) : null])
    .catch((e) => console.error('audit failed:', e.message));
}

// Keep a provable record of what the user agreed to and when (one row per consent version).
function recordConsent(uid, choices, client) {
  return client.query(
    `INSERT INTO user_consents (user_id, version, accepted_at, choices) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, version) DO UPDATE SET accepted_at = EXCLUDED.accepted_at, choices = EXCLUDED.choices`,
    [uid, CONSENT_VERSION, now(), JSON.stringify(choices)]);
}

// Attach photo ids and partner-venue info to user objects (one query each for the whole list).
async function hydrate(users) {
  const list = users.filter(Boolean);
  if (!list.length) return users;
  const rows = await many('SELECT user_id, id FROM photos WHERE user_id = ANY($1) ORDER BY position', [list.map((u) => u.id)]);
  const byUser = new Map();
  for (const r of rows) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push({ id: r.id }); }
  const vids = [...new Set(list.map((u) => isOut(u) && u.status.venueId).filter(Boolean))];
  const venues = vids.length ? await P.venuesByIds(vids) : new Map();
  for (const u of list) {
    u.photos = byUser.get(u.id) || [];
    u._venue = (isOut(u) && u.status.venueId && venues.get(u.status.venueId)) || null;
  }
  return users;
}

// Never expose exact coordinates, phone, email or ID details of other people.
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Same bar: same partner venue, or the same typed name.
const sameBar = (a, b) => isOut(a) && isOut(b)
  && ((a.status.venueId && a.status.venueId === b.status.venueId) || (norm(a.status.joint) && norm(a.status.joint) === norm(b.status.joint)));
const round15 = (ms) => Math.max(0, Math.round(ms / 60e3 / 15) * 15); // coarse times only

// Call hydrate() on u first.
function publicUser(u, viewer) {
  const out = isOut(u);
  const both = viewer && viewer.id !== u.id && isOut(viewer) && out;
  return {
    id: u.id, name: u.name, age: ageOf(u), bio: u.bio,
    photo: mainPhoto(u) ? photoUrl(u, mainPhoto(u)) : null,
    photos: (u.photos || []).map((ph) => photoUrl(u, ph)),
    verified: fullyVerified(u),
    out, joint: out ? u.status.joint : null, drink: out ? u.status.drink : null,
    venue: u._venue || null, // partner bar they're at (with its deal), if any
    distanceKm: viewer && isOut(viewer) && out ? Math.round(distanceKm(viewer.status, u.status) * 10) / 10 : null,
    // Rounded to 15 min so it can't be used to track someone.
    hereForMin: out && u.status.since ? round15(now() - u.status.since) : null,
    leavesInMin: out ? round15(u.status.until - now()) : null,
    // What you have in common (only relative to the viewer).
    sameBar: both ? sameBar(viewer, u) : false,
    sameDrink: both ? !!norm(u.status.drink) && norm(u.status.drink) === norm(viewer.status.drink) : false,
  };
}
const publicUsers = async (users, viewer) => (await hydrate(users)).map((u) => publicUser(u, viewer));

async function likeUsage(u) { // free plan: FREE_LIKES per rolling 24 h
  const r = await one('SELECT count(*)::int AS used, min(at) AS first FROM swipes WHERE from_id = $1 AND liked AND at > $2', [u.id, now() - 86400e3]);
  return { used: r.used, resetAt: r.first ? r.first + 86400e3 : null };
}

async function me(u) {
  await hydrate([u]);
  return {
    ...publicUser(u, u),
    username: u.username, dob: u.dob || null, status: isOut(u) ? u.status : null,
    phone: maskPhone(u.phone), email: maskEmail(u.email),
    verification: verification(u), nameLocked: !!u.nameLocked, isAdmin: isAdmin(u),
    promoOptIn: !!u.promoOptIn,
    consent: { version: CONSENT_VERSION, accepted: u.consentVersion === CONSENT_VERSION },
    photoList: u.photos.map((ph) => ({ id: ph.id, url: photoUrl(u, ph) })), maxPhotos: MAX_PHOTOS,
    plus: { active: isPlus(u), until: isPlus(u) ? u.plusUntil : null },
    boosts: u.boosts || 0, boostUntil: isBoosted(u) ? u.boostUntil : null,
    likes: isPlus(u) ? { limit: null } : { limit: FREE_LIKES, ...(await likeUsage(u)) },
    radiusMax: isPlus(u) ? PLUS_RADIUS_KM : FREE_RADIUS_KM,
  };
}
const meById = async (uid) => me(await getUser(uid));

// ---------- matches ----------
const toMatch = (r) => r && ({ id: r.id, users: [r.user_a, r.user_b], createdAt: r.created_at, ended: r.ended, endedBy: r.ended_by, seen: r.seen || {} });
function toMsg(r) {
  const m = { id: r.id, matchId: r.match_id, from: r.from_id, text: r.text, at: r.at };
  if (r.updated_at) m.updatedAt = r.updated_at;
  if (r.kind) Object.assign(m, { kind: r.kind, drink: r.drink, note: r.note || '', state: r.state });
  return m;
}
const otherId = (m, uid) => m.users.find((x) => x !== uid);

// Create a match (at most one live match per pair, enforced by a unique index).
// `by` completed it (sees the match screen right away); the other gets a push.
async function createMatch(by, other) {
  const r = await one(
    `INSERT INTO matches (id, user_a, user_b, created_at, seen) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ((LEAST(user_a, user_b)), (GREATEST(user_a, user_b))) WHERE NOT ended DO NOTHING RETURNING *`,
    [id(), by.id, other.id, now(), JSON.stringify({ [by.id]: true })]);
  if (!r) return null;
  const match = toMatch(r);
  await P.onMatch(match, by, other);
  if (!other.bot) {
    pushTo(other, {
      title: "It's a match! 🍻",
      body: isOut(by) ? `${by.name} is at ${by.status.joint} having ${by.status.drink}. Say hi!` : `You and ${by.name} matched. Say hi!`,
      url: `/#/chat/${match.id}`,
      tag: `match-${match.id}`,
    });
  }
  return match;
}

// ---------- demo bots (DEMO=1, never in production) ----------
const BOT_NAMES = ['Wanjiru', 'Otieno', 'Amani', 'Njeri', 'Kip', 'Zawadi', 'Brian', 'Achieng', 'Musa', 'Faith'];
const BOT_JOINTS = ['The Tipsy Tap', 'Rooftop 254', 'Hops & Barrels', 'The Velvet Lounge', 'Corner Pub', 'Sundowner Terrace'];
const BOT_DRINKS = ['Tusker', 'Gin & tonic', 'Whiskey sour', 'Mojito', 'Guinness', 'Red wine', 'Soda (not drinking tonight)', 'Cider'];
const BOT_BIOS = [
  'Here for good vibes and a game of pool.',
  'Just finished work, need someone to talk football with.',
  'New in town, show me the best spots!',
  'Karaoke later? I promise I can sing (I can\'t).',
  'Chill evening, one or two drinks max.',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const later = (ms, fn) => setTimeout(() => Promise.resolve().then(fn).catch((e) => console.error('demo bot:', e.message)), ms);

async function spawnBotsNear(lat, lng) {
  const [a, b, c, d] = bbox(lat, lng, 15);
  const n = await one(`SELECT count(*)::int AS n FROM users WHERE bot AND status_until > $1
    AND status_lat BETWEEN $2 AND $3 AND status_lng BETWEEN $4 AND $5`, [now(), a, b, c, d]);
  if (n.n >= 4) return;
  for (let i = 0; i < 8; i++) {
    const r = Math.random() * 0.045, t = Math.random() * 2 * Math.PI;
    const year = new Date().getUTCFullYear() - 21 - Math.floor(Math.random() * 15);
    await insertUser({
      id: id(), bot: true, username: `bot_${id()}`, pw: null,
      name: pick(BOT_NAMES), dob: `${year}-06-15`, bio: pick(BOT_BIOS), createdAt: now(),
      phoneVerified: true, emailVerified: true, selfie: { status: 'approved' }, kyc: { status: 'verified' },
      status: {
        joint: pick(BOT_JOINTS), drink: pick(BOT_DRINKS),
        lat: lat + r * Math.cos(t), lng: lng + r * Math.sin(t),
        until: Math.round(now() + (1 + Math.random() * 5) * 3600e3), since: now() - Math.floor(Math.random() * 120) * 60e3,
      },
    });
  }
}

// ---------- verification senders ----------
const devExtra = (o) => (PRODUCTION ? {} : o); // dev-only: echo codes/links so you can test without SMS/email

async function sendPhoneOtp(u) {
  const last = u.phoneOtp?.sentAt || 0;
  if (now() - last < 60e3) return { error: `Wait ${Math.ceil((60e3 - (now() - last)) / 1000)}s before requesting another code`, status: 429 };
  if (!(await sec.hit(`otp-phone:${u.phone}`, 5, 3600e3)).ok || !(await sec.hit(`otp-user:${u.id}`, 8, 3600e3)).ok) {
    return { error: 'Too many codes requested. Try again in an hour.', status: 429 };
  }
  const code = sec.otpCode();
  u.phoneOtp = { hash: hmac(`${u.id}:${u.phone}:${code}`), expires: now() + 10 * 60e3, attempts: 0, sentAt: now() };
  await updateUser(u.id, { phoneOtp: u.phoneOtp });
  try {
    await sms.send(u.phone, `Your Drinking Buddies code is ${code}. It expires in 10 minutes. Never share it with anyone.`);
  } catch (e) {
    console.error(e.message);
    return { error: 'Couldn\'t send the SMS. Check the number and try again.', status: 502 };
  }
  return { ok: true, ...(sms.name === 'console' ? devExtra({ dev: { code } }) : {}) };
}

async function sendEmailLink(u) {
  const last = u.emailToken?.sentAt || 0;
  if (now() - last < 60e3) return { error: `Wait ${Math.ceil((60e3 - (now() - last)) / 1000)}s before requesting another email`, status: 429 };
  if (!(await sec.hit(`email-verify:${u.email}`, 5, 3600e3)).ok) return { error: 'Too many emails requested. Try again in an hour.', status: 429 };
  const token = sec.randomToken();
  u.emailToken = { hash: sec.sha256(token), expires: now() + 24 * 3600e3, sentAt: now() };
  await updateUser(u.id, { emailToken: u.emailToken });
  // Token lives in the URL fragment: it isn't sent to servers/logs, and link-scanners can't trigger it.
  const link = `${APP_URL}/#/confirm-email/${token}`;
  try {
    await mailer.send(u.email, 'Confirm your email — Drinking Buddies',
      `Hi ${u.name},\n\nConfirm your email by opening this link (valid for 24 hours):\n${link}\n\nIf you didn't sign up, ignore this email.`);
  } catch (e) {
    console.error(e.message);
    return { error: 'Couldn\'t send the email. Check the address and try again.', status: 502 };
  }
  return { ok: true, ...(mailer.name === 'console' ? devExtra({ dev: { link } }) : {}) };
}

function notifySecurity(u, text) {
  if (u.phoneVerified) sms.send(u.phone, `Drinking Buddies: ${text}`).catch(() => {});
  if (u.emailVerified) mailer.send(u.email, 'Security alert — Drinking Buddies', `Hi ${u.name},\n\n${text}\n\nIf this wasn't you, reset your password now.`).catch(() => {});
}

// ---------- app ----------
const app = express();
// Express 4 doesn't catch rejected promises: route every async handler's errors to next().
for (const m of ['get', 'post', 'put', 'delete', 'use']) {
  const orig = app[m].bind(app);
  app[m] = (...args) => (m === 'get' && args.length === 1 ? orig(...args) : orig(...args.map((h) =>
    (typeof h === 'function' && h.length < 4 ? (req, res, next) => { try { const r = h(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } } : h))));
}
app.disable('x-powered-by');
if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY) || env.TRUST_PROXY);
const cspExtra = { imgOrigins: [] }; // storage origin is added at startup in redirect mode
app.use(sec.securityHeaders(PRODUCTION, cspExtra));
app.use(express.json({ limit: '800kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const apiLimit = sec.rateLimit('api', 600, 60e3);
const photoLimit = sec.rateLimit('photos', 1500, 60e3); // image loads get their own, larger budget
app.use('/api', (req, res, next) => (req.method === 'GET' && req.path.startsWith('/photos/') ? photoLimit : apiLimit)(req, res, next));

// CSRF: cookies are SameSite=Strict, and every state-changing call must carry a custom header
// (which cross-site forms can't send) and, when present, a same-origin Origin header.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.path.startsWith('/mpesa/callback/')) return next(); // server-to-server from Safaricom; verified in lib/billing.js
  if (req.get('x-csrf') !== '1') return res.status(403).json({ error: 'Bad request' });
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (_) { /* "null" or garbage */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
  }
  next();
});

// Liveness for load balancers. Rate limits degrade to per-instance memory without Redis, so that's reported, not fatal.
app.get('/api/health', async (req, res) => { await D.q('SELECT 1'); res.json({ ok: true, db: 'up', rateLimits: limiter.status(), photos: `${storage.driver}/${storage.delivery}` }); });

function setSessionCookie(req, res, token, maxAgeMs) {
  const secure = PRODUCTION || req.secure;
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`);
}

async function createSession(req, res, u) {
  const token = sec.randomToken();
  await D.q('INSERT INTO sessions (hash, user_id, created, last_seen, ip, ua) VALUES ($1, $2, $3, $3, $4, $5)',
    [sec.sha256(token), u.id, now(), req.ip, str(req.get('user-agent'), 200)]);
  setSessionCookie(req, res, token, SESSION_MAX_AGE);
}

const revokeSessions = (uid, exceptHash = '') => D.q('DELETE FROM sessions WHERE user_id = $1 AND hash <> $2', [uid, exceptHash]);

async function auth(req, res, next) {
  const token = sec.parseCookies(req.get('cookie'))[COOKIE];
  const h = token && sec.sha256(token);
  const s = h && await one('SELECT * FROM sessions WHERE hash = $1', [h]);
  const user = s && await getUser(s.user_id);
  if (!user || now() - s.created > SESSION_MAX_AGE || now() - s.last_seen > SESSION_IDLE) {
    if (s) await D.q('DELETE FROM sessions WHERE hash = $1', [h]);
    return res.status(401).json({ error: 'Not logged in' });
  }
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended.', code: 'BANNED' });
  if (now() - s.last_seen > 60e3) await D.q('UPDATE sessions SET last_seen = $2 WHERE hash = $1', [h, now()]);
  req.user = user;
  req.sessionHash = h;
  next();
}
const requireBasic = (req, res, next) => (verification(req.user).basic ? next()
  : res.status(403).json({ error: 'Verify your phone and email first', code: 'VERIFY_BASIC' }));
const requireFull = (req, res, next) => (fullyVerified(req.user) ? next()
  : res.status(403).json({ error: 'Verify your selfie and ID to like, match and chat', code: 'VERIFY_FULL' }));
const requireAdmin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only' }));
const perUser = (req) => req.user.id;
const exists = async (sql, params) => !!(await one(`SELECT EXISTS (${sql}) AS e`, params)).e;

// ----- sign up / log in -----
app.post('/api/signup', sec.rateLimit('signup', 5, 3600e3), async (req, res) => {
  const username = str(req.body.username, 30).toLowerCase();
  const password = req.body.password;
  const name = str(req.body.name, 40);
  const dob = str(req.body.dob, 10);
  const phone = normalizePhone(req.body.phone);
  const email = normalizeEmail(req.body.email);
  const age = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? ageFrom(dob) : null;

  if (!/^[a-z0-9_.]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username: 3–30 letters, numbers, _ or .' });
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (age == null || age > 110) return res.status(400).json({ error: 'Enter a valid date of birth' });
  if (age < MIN_AGE) return res.status(400).json({ error: `You must be ${MIN_AGE}+ to use this app` });
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number, e.g. 0712 345 678' });
  if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
  const pwErr = sec.passwordProblem(password, { username, phone, email });
  if (pwErr) return res.status(400).json({ error: pwErr });
  const consent = consentChoices(req.body);
  if (!consent.ok) return res.status(400).json({ error: 'Please tick the four required boxes to continue', code: 'CONSENT_REQUIRED' });
  if (await exists('SELECT 1 FROM users WHERE phone = $1 AND phone_verified', [phone])) return res.status(409).json({ error: 'That phone number is already registered' });
  if (await exists('SELECT 1 FROM users WHERE email = $1 AND email_verified', [email])) return res.status(409).json({ error: 'That email is already registered' });

  const user = {
    id: id(), username, name, dob, bio: '', createdAt: now(),
    pw: sec.hashPassword(password), phone, email, phoneVerified: false, emailVerified: false,
    selfie: { status: 'none' }, kyc: { status: 'none' },
    promoOptIn: consent.choices.deals, consentVersion: CONSENT_VERSION,
  };
  try {
    await tx(async (c) => {
      await insertUser(user, c);
      await recordConsent(user.id, consent.choices, c);
    });
  } catch (e) {
    if (pgUnique(e)) return res.status(409).json({ error: 'Username taken' });
    throw e;
  }
  await createSession(req, res, user);
  await audit('signup', { req, uid: user.id, meta: { consent: CONSENT_VERSION } });
  const [p, e] = await Promise.all([sendPhoneOtp(user), sendEmailLink(user)]);
  res.json({ user: await meById(user.id), dev: { ...p.dev, ...e.dev } });
});

app.post('/api/login',
  sec.rateLimit('login-ip', 20, 15 * 60e3),
  sec.rateLimit('login-user', 10, 15 * 60e3, (req) => str(req.body.username, 30).toLowerCase()),
  async (req, res) => {
    const username = str(req.body.username, 30).toLowerCase();
    const password = String(req.body.password || '');
    const user = D.toUser(await one('SELECT * FROM users WHERE username = $1 AND NOT bot', [username]));
    if (!user) { sec.fakeVerify(password); return res.status(401).json({ error: 'Wrong username or password' }); }
    if (user.lockedUntil > now()) {
      return res.status(423).json({ error: `Too many failed attempts. Try again in ${sec.fmtWait(Math.ceil((user.lockedUntil - now()) / 1000))} or reset your password.` });
    }
    if (!sec.verifyPassword(password, user.pw)) {
      // Atomic increment, so parallel guesses can't skip the lock.
      const r = await one('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = $1 RETURNING failed_logins', [user.id]);
      await audit('login_failed', { req, uid: user.id });
      if (r.failed_logins >= 5) {
        await updateUser(user.id, { lockedUntil: now() + 15 * 60e3, failedLogins: 0 });
        await audit('account_locked', { req, uid: user.id });
        notifySecurity(user, 'Your account was locked for 15 minutes after 5 wrong password attempts.');
      }
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    if (user.banned) return res.status(403).json({ error: 'This account has been suspended.', code: 'BANNED' });
    await updateUser(user.id, { failedLogins: 0 });
    await createSession(req, res, user);
    await audit('login', { req, uid: user.id });
    res.json({ user: await me(user) });
  });

app.post('/api/logout', auth, async (req, res) => {
  await D.q('DELETE FROM sessions WHERE hash = $1', [req.sessionHash]);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.post('/api/logout-all', auth, async (req, res) => {
  await revokeSessions(req.user.id);
  setSessionCookie(req, res, '', 0);
  await audit('logout_all', { req });
  res.json({ ok: true });
});

// ----- password reset (via verified email) -----
app.post('/api/password/forgot', sec.rateLimit('forgot', 5, 3600e3), async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const generic = { ok: true, message: 'If that email belongs to a verified account, we\'ve sent a reset link.' };
  if (!email || !(await sec.hit(`forgot:${email}`, 3, 3600e3)).ok) return res.json(generic);
  const user = D.toUser(await one('SELECT * FROM users WHERE email = $1 AND email_verified AND NOT bot', [email]));
  if (!user) return res.json(generic); // don't reveal whether an account exists
  const token = sec.randomToken();
  await updateUser(user.id, { resetToken: { hash: sec.sha256(token), expires: now() + 30 * 60e3 } });
  await audit('password_reset_requested', { req, uid: user.id });
  const link = `${APP_URL}/#/reset/${token}`;
  mailer.send(user.email, 'Reset your password — Drinking Buddies',
    `Hi ${user.name},\n\nReset your password with this link (valid for 30 minutes):\n${link}\n\nIf you didn't ask for this, ignore this email — your password won't change.`)
    .catch((e) => console.error(e.message));
  res.json({ ...generic, ...(mailer.name === 'console' ? devExtra({ dev: { link } }) : {}) });
});

app.post('/api/password/reset', sec.rateLimit('reset', 10, 3600e3), async (req, res) => {
  const hash = sec.sha256(str(req.body.token, 100));
  const user = D.toUser(await one(`SELECT * FROM users WHERE reset_token->>'hash' = $1`, [hash]));
  if (!user || user.resetToken.expires < now()) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  const pwErr = sec.passwordProblem(req.body.password, user);
  if (pwErr) return res.status(400).json({ error: pwErr });
  // Clearing the token in the same statement makes the link single-use even under races.
  const done = await one(`UPDATE users SET pw = $2, reset_token = NULL, locked_until = 0, failed_logins = 0
    WHERE id = $1 AND reset_token->>'hash' = $3 RETURNING id`, [user.id, JSON.stringify(sec.hashPassword(req.body.password)), hash]);
  if (!done) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  await revokeSessions(user.id);
  await audit('password_reset', { req, uid: user.id });
  notifySecurity(user, 'Your password was just reset and you were logged out everywhere.');
  res.json({ ok: true });
});

app.post('/api/me/password', auth, sec.rateLimit('pwchange', 5, 3600e3, perUser), async (req, res) => {
  if (!sec.verifyPassword(String(req.body.current || ''), req.user.pw)) return res.status(400).json({ error: 'Current password is wrong' });
  const pwErr = sec.passwordProblem(req.body.next, req.user);
  if (pwErr) return res.status(400).json({ error: pwErr });
  await updateUser(req.user.id, { pw: sec.hashPassword(req.body.next) });
  await revokeSessions(req.user.id, req.sessionHash); // keep this device, log out the rest
  await audit('password_changed', { req });
  notifySecurity(req.user, 'Your password was changed and your other devices were logged out.');
  res.json({ ok: true });
});

// ----- verification: phone -----
app.post('/api/verify/phone/send', auth, sec.rateLimit('otp-send', 10, 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (u.phoneVerified) return res.status(409).json({ error: 'Phone already verified' });
  if (req.body.phone !== undefined) {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid phone number, e.g. 0712 345 678' });
    if (await exists('SELECT 1 FROM users WHERE phone = $1 AND phone_verified', [phone])) return res.status(409).json({ error: 'That phone number is already registered' });
    if (phone !== u.phone) { u.phone = phone; u.phoneOtp = null; await updateUser(u.id, { phone, phoneOtp: null }); }
  }
  if (!u.phone) return res.status(400).json({ error: 'Enter your phone number' });
  const r = await sendPhoneOtp(u);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ...r, phone: maskPhone(u.phone) });
});

app.post('/api/verify/phone', auth, sec.rateLimit('otp-check', 20, 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (u.phoneVerified) return res.json(await me(u));
  const code = str(req.body.code, 6);
  const otp = u.phoneOtp;
  if (!otp || otp.expires < now()) return res.status(400).json({ error: 'Code expired. Request a new one.' });
  if (otp.attempts >= 5) { await updateUser(u.id, { phoneOtp: null }); return res.status(429).json({ error: 'Too many wrong codes. Request a new one.' }); }
  if (!/^\d{6}$/.test(code) || !sec.safeEqual(otp.hash, hmac(`${u.id}:${u.phone}:${code}`))) {
    // Count the attempt atomically so parallel guesses all count.
    const r = await one(`UPDATE users SET phone_otp = jsonb_set(phone_otp, '{attempts}', to_jsonb((phone_otp->>'attempts')::int + 1))
      WHERE id = $1 AND phone_otp IS NOT NULL RETURNING (phone_otp->>'attempts')::int AS attempts`, [u.id]);
    await audit('phone_otp_failed', { req });
    const left = Math.max(0, 5 - (r?.attempts ?? 5));
    return res.status(400).json({ error: `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` });
  }
  try { await updateUser(u.id, { phoneVerified: true, phoneOtp: null }); } catch (e) {
    if (pgUnique(e)) return res.status(409).json({ error: 'That phone number is already registered' });
    throw e;
  }
  await audit('phone_verified', { req });
  res.json(await meById(u.id));
});

// ----- verification: email -----
app.post('/api/verify/email/send', auth, sec.rateLimit('email-send', 10, 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (u.emailVerified) return res.status(409).json({ error: 'Email already verified' });
  if (req.body.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
    if (await exists('SELECT 1 FROM users WHERE email = $1 AND email_verified', [email])) return res.status(409).json({ error: 'That email is already registered' });
    if (email !== u.email) { u.email = email; u.emailToken = null; await updateUser(u.id, { email, emailToken: null }); }
  }
  if (!u.email) return res.status(400).json({ error: 'Enter your email address' });
  const r = await sendEmailLink(u);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ...r, email: maskEmail(u.email) });
});

// No login needed: the link may be opened on another device.
app.post('/api/verify/email/confirm', sec.rateLimit('email-confirm', 20, 3600e3), async (req, res) => {
  const hash = sec.sha256(str(req.body.token, 100));
  const u = D.toUser(await one(`SELECT * FROM users WHERE email_token->>'hash' = $1`, [hash]));
  if (!u || u.emailToken.expires < now()) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one from the app.' });
  try {
    const done = await one(`UPDATE users SET email_verified = true, email_token = NULL WHERE id = $1 AND email_token->>'hash' = $2 RETURNING id`, [u.id, hash]);
    if (!done) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one from the app.' });
  } catch (e) {
    if (pgUnique(e)) return res.status(409).json({ error: 'That email is already registered to another account' });
    throw e;
  }
  await audit('email_verified', { req, uid: u.id });
  res.json({ ok: true });
});

// ----- verification: selfie (live photo copying a random pose; reviewed by an admin) -----
const POSES = [
  'Hold up three fingers next to your face',
  'Give a thumbs-up with your left hand',
  'Touch your nose with one finger',
  'Cover one eye with your hand',
  'Make a peace sign ✌️ beside your cheek',
  'Point at the camera with your right hand',
];
const photoCount = async (uid) => (await one('SELECT count(*)::int AS n FROM photos WHERE user_id = $1', [uid])).n;

app.post('/api/verify/selfie/challenge', auth, requireBasic, async (req, res) => {
  const u = req.user;
  if (!(await photoCount(u.id))) return res.status(400).json({ error: 'Add a profile photo first — we compare your selfie to it.' });
  if (['pending', 'approved'].includes(u.selfie?.status)) return res.status(409).json({ error: 'Selfie already submitted' });
  const ch = { id: id(), pose: pick(POSES), expires: now() + 10 * 60e3 };
  await updateUser(u.id, { selfieChallenge: ch });
  res.json({ challengeId: ch.id, pose: ch.pose });
});

app.post('/api/verify/selfie', auth, requireBasic, sec.rateLimit('selfie', 5, 24 * 3600e3, perUser), async (req, res) => {
  const u = req.user;
  const ch = u.selfieChallenge;
  if (!ch || ch.id !== req.body.challengeId || ch.expires < now()) return res.status(400).json({ error: 'Challenge expired — start again' });
  const image = req.body.image;
  if (typeof image !== 'string' || !/^data:image\/jpeg;base64,/.test(image) || image.length > 700_000) {
    return res.status(400).json({ error: 'Selfie must be a JPEG photo from your camera' });
  }
  await updateUser(u.id, { selfie: { status: 'pending', image, pose: ch.pose, submittedAt: now() }, selfieChallenge: null });
  await audit('selfie_submitted', { req });
  res.json(await meById(u.id));
});

// ----- verification: government ID (KYC) -----
app.post('/api/verify/id', auth, requireBasic, sec.rateLimit('kyc', 3, 24 * 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (u.kyc?.status === 'verified') return res.status(409).json({ error: 'ID already verified' });
  const idType = str(req.body.idType, 20);
  const idNumber = str(req.body.idNumber, 20).toUpperCase().replace(/\s/g, '');
  const firstName = str(req.body.firstName, 40);
  const lastName = str(req.body.lastName, 40);
  const dob = str(req.body.dob, 10);
  if (!ID_TYPES[idType]) return res.status(400).json({ error: 'Choose an ID type' });
  if (!/^[A-Z0-9]{5,15}$/.test(idNumber)) return res.status(400).json({ error: 'Enter your ID number' });
  if (!firstName || !lastName) return res.status(400).json({ error: 'Enter your names exactly as on your ID' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || ageFrom(dob) == null) return res.status(400).json({ error: 'Enter your date of birth' });

  // One account per ID. We store only a keyed fingerprint, never the ID number itself.
  const idHash = hmac(`id:${idType}:${idNumber}`);
  const dup = async () => { await audit('kyc_duplicate_id', { req }); return res.status(409).json({ error: 'This ID is already linked to another account' }); };
  if (await exists('SELECT 1 FROM users WHERE id_hash = $1 AND id <> $2', [idHash, u.id])) return dup();

  let result;
  try { result = await kyc.verify({ idType, idNumber, firstName, lastName, dob, userId: u.id }); }
  catch (e) { console.error(e.message); return res.status(502).json({ error: 'ID check service is unavailable. Try again later.' }); }

  if (!result.ok) {
    await updateUser(u.id, { kyc: { status: 'failed', note: result.reason, at: now(), provider: kyc.name } });
    await audit('kyc_failed', { req, meta: { provider: kyc.name } });
    return res.status(400).json({ error: result.reason, user: await meById(u.id) });
  }
  if (ageFrom(result.dob) < MIN_AGE) {
    await updateUser(u.id, { banned: { reason: 'Under minimum age (ID check)', at: now(), by: 'system' } });
    await revokeSessions(u.id);
    await audit('banned_underage', { req });
    return res.status(403).json({ error: `You must be ${MIN_AGE}+ to use this app.`, code: 'BANNED' });
  }
  try {
    await updateUser(u.id, {
      kyc: { status: 'verified', provider: kyc.name, idType, last4: idNumber.slice(-4), at: now() },
      idHash, dob: result.dob,          // ID is the source of truth for age
      name: titleCase(firstName),        // and for the display name (anti-catfish)
      nameLocked: true,
    });
  } catch (e) { if (pgUnique(e)) return dup(); throw e; }
  await audit('kyc_verified', { req, meta: { provider: kyc.name, idType } });
  res.json(await meById(u.id));
});

// ----- profile -----
app.get('/api/me', auth, async (req, res) => res.json(await me(req.user)));

// The selfie is checked against the main photo, so a new main photo needs a new selfie check.
const mainPhotoId = async (uid, client = D.pool) => (await one('SELECT id FROM photos WHERE user_id = $1 ORDER BY position LIMIT 1', [uid], client))?.id || null;
async function mainPhotoChanged(uid, beforeId, req, client = D.pool) {
  if ((await mainPhotoId(uid, client)) === beforeId) return;
  const r = await one(`UPDATE users SET selfie = $2 WHERE id = $1 AND selfie->>'status' IN ('approved', 'pending') RETURNING id`,
    [uid, JSON.stringify({ status: 'none', note: 'Your main photo changed — please take a new verification selfie.' })], client);
  if (r) await audit('selfie_reset_photo_changed', { req, uid });
}
// Keep positions 0..n-1 after a delete.
const renumberPhotos = (uid, client) => client.query(
  `UPDATE photos p SET position = s.rn - 1 FROM (SELECT id, row_number() OVER (ORDER BY position) AS rn FROM photos WHERE user_id = $1) s
   WHERE p.id = s.id`, [uid]);

// ---------- photo storage ----------
// Upload the object first, then record it. If the row can't be written (limit reached, error),
// the object is deleted again, so storage never keeps photos the database doesn't know about.
async function storePhoto(dataUrl) {
  const img = decodeImage(dataUrl);
  const pid = id();
  const key = storage.newKey(pid, img.mime);
  await storage.put(key, img.data, img.mime);
  return { pid, key, mime: img.mime, size: img.data.length };
}
const discardObject = (key) => storage.del(key).catch(() => D.q(
  'INSERT INTO storage_deletions (key, queued_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, now()]).then(kickDeletions));
const photoUploadFailed = (res, e) => { console.error('photo storage put failed:', e.message); res.status(503).json({ error: 'Couldn\'t save your photo right now. Try again in a moment.' }); };

// Objects whose rows were deleted are queued by a DB trigger; delete them after commit.
// FOR UPDATE SKIP LOCKED lets several instances work the queue without doing the same key twice.
let deletionsRunning = false, deletionsAgain = false;
async function processDeletions() {
  if (deletionsRunning) { deletionsAgain = true; return; }
  deletionsRunning = true;
  try {
    do {
      deletionsAgain = false;
      await tx(async (c) => {
        const rows = await many('SELECT key FROM storage_deletions WHERE attempts < 50 ORDER BY queued_at LIMIT 100 FOR UPDATE SKIP LOCKED', [], c);
        for (const { key } of rows) {
          try { await storage.del(key); await c.query('DELETE FROM storage_deletions WHERE key = $1', [key]); }
          catch (e) { await c.query('UPDATE storage_deletions SET attempts = attempts + 1, last_error = $2 WHERE key = $1', [key, String(e.message).slice(0, 300)]); }
        }
      });
    } while (deletionsAgain);
  } catch (e) { console.error('storage deletions:', e.message); } finally { deletionsRunning = false; }
}
const kickDeletions = () => { setImmediate(() => processDeletions()); };

// Accept the current consent (existing accounts, or after the consent text changes).
app.post('/api/consent', auth, async (req, res) => {
  const consent = consentChoices(req.body);
  if (!consent.ok) return res.status(400).json({ error: 'Please tick the four required boxes to continue', code: 'CONSENT_REQUIRED' });
  await tx(async (c) => {
    await recordConsent(req.user.id, consent.choices, c);
    await updateUser(req.user.id, { consentVersion: CONSENT_VERSION, promoOptIn: consent.choices.deals }, c);
  });
  await audit('consent', { req, meta: { version: CONSENT_VERSION } });
  res.json(await meById(req.user.id));
});

app.put('/api/me', auth, async (req, res) => {
  const u = req.user;
  const patch = {};
  if (req.body.name !== undefined && !u.nameLocked) patch.name = str(req.body.name, 40) || u.name;
  if (req.body.bio !== undefined) patch.bio = str(req.body.bio, 300);
  if (req.body.promoOptIn !== undefined) patch.promoOptIn = req.body.promoOptIn === true; // marketing consent: explicit opt-in
  if (req.body.photo !== undefined && req.body.photo !== null && !validImage(req.body.photo)) {
    return res.status(400).json({ error: 'Photo must be a JPEG/PNG/WebP under ~350 KB' });
  }
  let obj = null;
  if (req.body.photo) { try { obj = await storePhoto(req.body.photo); } catch (e) { return photoUploadFailed(res, e); } }
  await updateUser(u.id, patch);
  if (req.body.photo !== undefined) { // older clients: replace (or remove) the main photo
    try {
      await tx(async (c) => {
        await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]); // serialize photo edits per user
        const before = await mainPhotoId(u.id, c);
        if (before) await c.query('DELETE FROM photos WHERE id = $1', [before]);
        if (!obj) await renumberPhotos(u.id, c);
        else {
          await c.query('INSERT INTO photos (id, user_id, position, mime, storage_key, size, created_at) VALUES ($1, $2, 0, $3, $4, $5, $6)',
            [obj.pid, u.id, obj.mime, obj.key, obj.size, now()]);
        }
        await mainPhotoChanged(u.id, before, req, c);
      });
    } catch (e) { if (obj) discardObject(obj.key); throw e; }
    kickDeletions();
  }
  res.json(await meById(u.id));
});

app.post('/api/me/photos', auth, sec.rateLimit('photo-up', 30, 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (!validImage(req.body.image)) return res.status(400).json({ error: 'Photo must be a JPEG/PNG/WebP under ~350 KB' });
  if ((await photoCount(u.id)) >= MAX_PHOTOS) return res.status(400).json({ error: `You can have up to ${MAX_PHOTOS} photos` }); // cheap early check
  let obj;
  try { obj = await storePhoto(req.body.image); } catch (e) { return photoUploadFailed(res, e); }
  let added = false;
  try {
    added = await tx(async (c) => {
      await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]);
      const n = (await one('SELECT count(*)::int AS n FROM photos WHERE user_id = $1', [u.id], c)).n;
      if (n >= MAX_PHOTOS) return false; // the real check, under the lock
      await c.query('INSERT INTO photos (id, user_id, position, mime, storage_key, size, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [obj.pid, u.id, n, obj.mime, obj.key, obj.size, now()]);
      return true;
    });
  } finally { if (!added) discardObject(obj.key); }
  if (!added) return res.status(400).json({ error: `You can have up to ${MAX_PHOTOS} photos` });
  res.json(await meById(u.id));
});

app.delete('/api/me/photos/:pid', auth, async (req, res) => {
  const u = req.user;
  const found = await tx(async (c) => {
    await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]);
    const before = await mainPhotoId(u.id, c);
    const del = await c.query('DELETE FROM photos WHERE id = $1 AND user_id = $2', [req.params.pid, u.id]);
    if (!del.rowCount) return false;
    await renumberPhotos(u.id, c);
    await mainPhotoChanged(u.id, before, req, c);
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Photo not found' });
  kickDeletions();
  res.json(await meById(u.id));
});

app.put('/api/me/photos/order', auth, async (req, res) => {
  const u = req.user;
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
  const ok = await tx(async (c) => {
    await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]);
    const have = (await many('SELECT id FROM photos WHERE user_id = $1', [u.id], c)).map((r) => r.id);
    if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((x) => have.includes(x))) return false;
    const before = await mainPhotoId(u.id, c);
    await c.query('UPDATE photos p SET position = o.pos - 1 FROM unnest($1::text[]) WITH ORDINALITY AS o(id, pos) WHERE p.id = o.id', [ids]);
    await mainPhotoChanged(u.id, before, req, c);
    return true;
  });
  if (!ok) return res.status(400).json({ error: 'Send every photo id exactly once' });
  res.json(await meById(u.id));
});

// Photos are only served to people allowed to see the profile: yourself, admins, and
// verified users looking at someone who is fully verified or matched with them.
app.get('/api/photos/:uid/:pid', auth, async (req, res) => {
  const viewer = req.user;
  const ph = await one('SELECT mime, storage_key, CASE WHEN storage_key IS NULL THEN data END AS data FROM photos WHERE id = $1 AND user_id = $2', [req.params.pid, req.params.uid]);
  const owner = ph && await getUser(req.params.uid);
  if (!owner) return res.status(404).json({ error: 'Not found' });
  const matched = () => exists('SELECT 1 FROM matches WHERE NOT ended AND ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1))', [viewer.id, owner.id]);
  const allowed = viewer.id === owner.id || isAdmin(viewer)
    || (!owner.banned && verification(viewer).basic && (fullyVerified(owner) || await matched()));
  if (!allowed) return res.status(404).json({ error: 'Not found' });
  if (ph.storage_key && storage.delivery === 'redirect') {
    // Short-lived signed URL, stable for the current hour so the browser can cache the image.
    const { url, cacheSeconds } = await storage.signedUrl(ph.storage_key, ph.mime);
    res.set('Cache-Control', `private, max-age=${cacheSeconds}`);
    return res.redirect(302, url);
  }
  let bytes = ph.data; // not yet migrated to storage
  if (ph.storage_key) {
    try { bytes = await storage.get(ph.storage_key); } catch (e) {
      console.error('photo storage get failed:', e.message);
      return res.status(503).json({ error: 'Photo temporarily unavailable' });
    }
  }
  // Photo ids change on every upload, so the browser can cache forever (privately).
  res.set({ 'Content-Type': ph.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.send(bytes);
});

// Permanently delete the account and personal data (Kenya Data Protection Act / GDPR).
app.delete('/api/me', auth, sec.rateLimit('delete', 5, 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (!sec.verifyPassword(String(req.body.password || ''), u.pw)) return res.status(400).json({ error: 'Password is wrong' });
  await tx(async (c) => {
    await c.query('UPDATE matches SET ended = true, ended_by = $1 WHERE (user_a = $1 OR user_b = $1) AND NOT ended', [u.id]);
    await c.query('DELETE FROM messages WHERE from_id = $1', [u.id]);
    // Venues this person solely owned get suspended (no one left to manage them).
    await c.query(`UPDATE venues SET status = 'suspended', note = 'Owner account deleted' WHERE id IN (
        SELECT venue_id FROM venue_members WHERE user_id = $1 AND role = 'owner'
        EXCEPT SELECT venue_id FROM venue_members WHERE user_id <> $1 AND role = 'owner')`, [u.id]);
    await c.query('DELETE FROM users WHERE id = $1', [u.id]); // cascades: photos, sessions, swipes, check-ins, memberships
  });
  kickDeletions(); // the photo files themselves
  await audit('account_deleted', { req, uid: u.id });
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

// "I'm out" — where you're drinking, what you're having, and where you are.
app.put('/api/me/status', auth, requireBasic, async (req, res) => {
  const u = req.user;
  const joint = str(req.body.joint, 60);
  const drink = str(req.body.drink, 40);
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  const hours = Math.min(Math.max(Number(req.body.hours) || 3, 1), STATUS_HOURS_MAX);
  if (!joint || !drink) return res.status(400).json({ error: 'Tell people where you are and what you\'re drinking' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Location is required' });
  }
  const prev = u.status;
  const stillHere = isOut(u) && norm(prev.joint) === norm(joint);
  const status = { joint, drink, lat, lng, until: Math.round(now() + hours * 3600e3), since: stillHere && prev.since ? prev.since : now() };
  // Picked a partner bar? Use its official name and count the check-in.
  const venue = await P.onCheckin(u, str(req.body.venueId, 40));
  if (venue) { status.joint = venue.name; status.venueId = venue.id; }
  await updateUser(u.id, { status });
  if (DEMO && !PRODUCTION) {
    await spawnBotsNear(lat, lng);
    // Some nearby bots already like you, so "Who liked you" has something to show.
    const [a, b, c, d] = bbox(lat, lng, 15);
    await D.q(`INSERT INTO swipes (from_id, to_id, liked, at)
      SELECT id, $1, true, $2 FROM users WHERE bot AND status_until > $2 AND random() < 0.35
        AND status_lat BETWEEN $3 AND $4 AND status_lng BETWEEN $5 AND $6
      ON CONFLICT DO NOTHING`, [u.id, now(), a, b, c, d]);
  }
  res.json(await meById(u.id));
});

app.delete('/api/me/status', auth, async (req, res) => {
  await updateUser(req.user.id, { status: null });
  res.json(await meById(req.user.id));
});

// ----- swiping -----
// Only fully verified, non-suspended people who are out now and nearby.
// Order: Boosted first, then people at your bar, then closest.
app.get('/api/feed', auth, requireBasic, async (req, res) => {
  const u = req.user;
  if (!isOut(u)) return res.status(409).json({ error: 'Set your status first', code: 'NOT_OUT' });
  const radius = Math.min(Math.max(Number(req.query.radius) || 10, 1), isPlus(u) ? PLUS_RADIUS_KM : FREE_RADIUS_KM);
  const [a, b, c, d] = bbox(u.status.lat, u.status.lng, radius);
  const rows = await many(`
    SELECT u.* FROM users u
    WHERE u.id <> $1 AND u.status_until > $2 AND ${VISIBLE_SQL}
      AND u.status_lat BETWEEN $3 AND $4 AND u.status_lng BETWEEN $5 AND $6
      AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.from_id = $1 AND s.to_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.ended AND ((m.user_a = $1 AND m.user_b = u.id) OR (m.user_b = $1 AND m.user_a = u.id)))
    LIMIT 1000`, [u.id, now(), a, b, c, d]);
  const people = rows.map(D.toUser)
    .map((o) => ({ o, dist: distanceKm(u.status, o.status) }))
    .filter((x) => x.dist <= radius)
    .sort((x, y) => (isBoosted(y.o) - isBoosted(x.o)) || (sameBar(u, y.o) - sameBar(u, x.o)) || (x.dist - y.dist))
    .slice(0, 50)
    .map((x) => x.o);
  res.json(await publicUsers(people, u));
});

app.post('/api/swipe', auth, requireBasic, sec.rateLimit('swipe', 120, 60e3, perUser), (req, res, next) => {
  if (req.body.dir === 'like') return requireFull(req, res, next);
  next();
}, async (req, res) => {
  const u = req.user;
  const target = await getUser(str(req.body.targetId, 40));
  const like = req.body.dir === 'like';
  if (!target || target.id === u.id || !visible(target)) return res.status(404).json({ error: 'User not found' });
  if (like && !isPlus(u)) {
    const usage = await likeUsage(u);
    if (usage.used >= FREE_LIKES) {
      return res.status(403).json({ error: `You've used your ${FREE_LIKES} likes for today.`, code: 'LIKE_LIMIT', resetAt: usage.resetAt });
    }
  }
  // Save the swipe first (committed), then look for their like: if both people like each other at
  // the same moment, at least one of them sees the other's swipe, and the unique index stops a double match.
  await D.q(`INSERT INTO swipes (from_id, to_id, liked, at) VALUES ($1, $2, $3, $4)
    ON CONFLICT (from_id, to_id) DO UPDATE SET liked = EXCLUDED.liked, at = EXCLUDED.at`, [u.id, target.id, like, now()]);

  // Demo bots "see" your like a few seconds later and like you back ~70% of the time.
  if (like && target.bot && !(await exists('SELECT 1 FROM swipes WHERE from_id = $1 AND to_id = $2', [target.id, u.id]))) {
    const likesBack = Math.random() < 0.7;
    later(5000 + Math.random() * 10000, async () => {
      const ins = await D.q('INSERT INTO swipes (from_id, to_id, liked, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [target.id, u.id, likesBack, now()]);
      if (!ins.rowCount || !likesBack) return;
      const fresh = await getUser(u.id);
      if (fresh && await exists('SELECT 1 FROM swipes WHERE from_id = $1 AND to_id = $2 AND liked', [u.id, target.id])) await createMatch(target, fresh);
    });
  }

  let match = null;
  if (like && await exists('SELECT 1 FROM swipes WHERE from_id = $1 AND to_id = $2 AND liked', [target.id, u.id])) match = await createMatch(u, target);
  res.json({ match: match ? { id: match.id, user: (await publicUsers([target], u))[0] } : null });
});

// ----- Buddies Plus & Boosts -----
// Who liked you: everyone sees the count; Plus members see the people.
app.get('/api/likes', auth, requireBasic, async (req, res) => {
  const u = req.user;
  const rows = await many(`
    SELECT u.* FROM swipes s JOIN users u ON u.id = s.from_id
    WHERE s.to_id = $1 AND s.liked AND ${VISIBLE_SQL}
      AND NOT EXISTS (SELECT 1 FROM swipes m WHERE m.from_id = $1 AND m.to_id = s.from_id)
      AND NOT EXISTS (SELECT 1 FROM matches mt WHERE (mt.user_a = $1 AND mt.user_b = s.from_id) OR (mt.user_b = $1 AND mt.user_a = s.from_id))
    ORDER BY s.at DESC`, [u.id]);
  const likers = rows.map(D.toUser);
  res.json({ count: likers.length, plus: isPlus(u), people: isPlus(u) ? await publicUsers(likers.slice(0, 50), u) : [] });
});

// Undo your last pass (within the hour).
app.post('/api/swipe/rewind', auth, requireFull, sec.rateLimit('rewind', 30, 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (!isPlus(u)) return res.status(403).json({ error: 'Rewind is a Buddies Plus feature', code: 'PLUS_ONLY' });
  const last = await one('SELECT * FROM swipes WHERE from_id = $1 AND at > $2 ORDER BY at DESC LIMIT 1', [u.id, now() - 3600e3]);
  if (!last || last.liked) return res.status(404).json({ error: 'Nothing to undo' });
  await D.q('DELETE FROM swipes WHERE from_id = $1 AND to_id = $2', [u.id, last.to_id]);
  const target = await getUser(last.to_id);
  if (!target || !visible(target)) return res.status(404).json({ error: 'That person isn\'t available any more' });
  res.json({ user: (await publicUsers([target], u))[0] });
});

// Boost: top of nearby feeds for 30 minutes while you're out. One atomic update, so a Boost can't be spent twice.
app.post('/api/boost', auth, requireFull, sec.rateLimit('boost', 10, 3600e3, perUser), async (req, res) => {
  const u = req.user;
  if (!isOut(u)) return res.status(409).json({ error: 'Set where you\'re drinking first — Boosts work while you\'re out' });
  if (isBoosted(u)) return res.status(409).json({ error: 'You\'re already boosted', boostUntil: u.boostUntil });
  const r = await one(`UPDATE users SET boosts = boosts - 1, boost_until = LEAST($2::bigint, status_until)
    WHERE id = $1 AND boosts > 0 AND boost_until <= $3 RETURNING id`, [u.id, now() + BOOST_MINUTES * 60e3, now()]);
  if (!r) return res.status(u.boosts > 0 ? 409 : 402).json(u.boosts > 0 ? { error: 'You\'re already boosted' } : { error: 'You have no Boosts left', code: 'NO_BOOSTS' });
  await audit('boost_used', { req });
  res.json(await meById(u.id));
});

// ----- matches & chat -----
// A live match the user is in, whose other person isn't banned.
async function liveMatchFor(matchId, uid) {
  const m = toMatch(await one('SELECT * FROM matches WHERE id = $1 AND NOT ended AND (user_a = $2 OR user_b = $2)', [matchId, uid]));
  if (!m) return null;
  const other = await getUser(otherId(m, uid));
  return other && !other.banned ? { m, other } : null;
}
async function ownMatch(req, res) {
  const r = await liveMatchFor(req.params.id, req.user.id);
  if (!r) res.status(404).json({ error: 'Match not found' });
  return r;
}

// All live matches for a user, with the other person loaded (banned people filtered out).
async function liveMatches(uid, extraWhere = '') {
  const rows = await many(`SELECT * FROM matches WHERE NOT ended AND (user_a = $1 OR user_b = $1) ${extraWhere}`, [uid]);
  const ms = rows.map(toMatch);
  const others = await getUsers(ms.map((m) => otherId(m, uid)));
  return ms.map((m) => ({ m, other: others.get(otherId(m, uid)) })).filter((x) => x.other && !x.other.banned);
}

app.get('/api/matches', auth, requireBasic, async (req, res) => {
  const u = req.user;
  const list = await liveMatches(u.id);
  await hydrate(list.map((x) => x.other));
  const lasts = list.length ? await many(`SELECT DISTINCT ON (match_id) * FROM messages WHERE match_id = ANY($1) ORDER BY match_id, at DESC`, [list.map((x) => x.m.id)]) : [];
  const lastBy = new Map(lasts.map((r) => [r.match_id, toMsg(r)]));
  res.json(list.map(({ m, other }) => ({ id: m.id, createdAt: m.createdAt, user: publicUser(other, u), last: lastBy.get(m.id) || null, unseen: !m.seen[u.id] }))
    .sort((a, b) => (b.last?.at || b.createdAt) - (a.last?.at || a.createdAt)));
});

app.get('/api/matches/:id', auth, requireBasic, async (req, res) => {
  const r = await ownMatch(req, res); if (!r) return;
  const after = Number(req.query.after) || 0;
  // Include messages that changed since `after` too (e.g. a drink offer got accepted).
  const messages = (await many('SELECT * FROM messages WHERE match_id = $1 AND GREATEST(at, coalesce(updated_at, 0)) > $2 ORDER BY at', [r.m.id, after])).map(toMsg);
  res.json({ id: r.m.id, user: (await publicUsers([r.other], req.user))[0], messages, deals: await P.dealsForMatch(r.m, req.user) });
});

async function insertMessage(m) {
  await D.q('INSERT INTO messages (id, match_id, from_id, text, at, kind, drink, note, state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [m.id, m.matchId, m.from, m.text, m.at, m.kind || null, m.drink || null, m.note ?? null, m.state || null]);
  return m;
}

app.post('/api/matches/:id/messages', auth, requireFull, sec.rateLimit('msg', 30, 60e3, perUser), async (req, res) => {
  const r = await ownMatch(req, res); if (!r) return;
  const text = str(req.body.text, 1000);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const msg = await insertMessage({ id: id(), matchId: r.m.id, from: req.user.id, text, at: now() });

  const other = r.other;
  if (other.bot && (await one('SELECT count(*)::int AS n FROM messages WHERE match_id = $1 AND from_id = $2', [r.m.id, other.id])).n < 3) {
    const replies = [`Cheers! 🍻 I'm at ${other.status?.joint || 'the bar'}, come through.`, 'Sounds good! I\'ll grab us a table.', 'Haha nice. What are you drinking?'];
    later(1500 + Math.random() * 2000, () => insertMessage({ id: id(), matchId: r.m.id, from: other.id, text: pick(replies), at: now() }));
  }
  res.json(msg);
});

// "Buy them a drink": a chat message the other person can accept or decline.
// Payment is settled at the bar for now (hook M-Pesa STK push in here later).
app.post('/api/matches/:id/drinks', auth, requireFull, sec.rateLimit('drink', 10, 3600e3, perUser), async (req, res) => {
  const r = await ownMatch(req, res); if (!r) return;
  const other = r.other;
  const drink = str(req.body.drink, 40) || (isOut(other) ? other.status.drink : '');
  const note = str(req.body.note, 140);
  if (!drink) return res.status(400).json({ error: 'Which drink?' });
  if (await exists(`SELECT 1 FROM messages WHERE match_id = $1 AND kind = 'drink' AND from_id = $2 AND state = 'pending'`, [r.m.id, req.user.id])) {
    return res.status(409).json({ error: 'You already have a drink offer waiting for an answer' });
  }
  const msg = await insertMessage({ id: id(), matchId: r.m.id, from: req.user.id, kind: 'drink', drink, note, state: 'pending', text: `🍺 Drink offer: ${drink}`, at: now() });
  if (other.bot) {
    later(2000 + Math.random() * 2000, () => {
      const state = Math.random() < 0.85 ? 'accepted' : 'declined';
      return D.q(`UPDATE messages SET state = $2, updated_at = $3, text = $4 WHERE id = $1 AND state = 'pending'`, [msg.id, state, now(), `🍺 ${drink} — ${state}`]);
    });
  }
  res.json(msg);
});

app.post('/api/matches/:id/drinks/:msgId', auth, requireFull, async (req, res) => {
  const r = await ownMatch(req, res); if (!r) return;
  const action = req.body.action;
  const msg = await one(`SELECT * FROM messages WHERE id = $1 AND match_id = $2 AND kind = 'drink'`, [req.params.msgId, r.m.id]);
  if (!msg) return res.status(404).json({ error: 'Offer not found' });
  if (msg.from_id === req.user.id) return res.status(403).json({ error: 'You can\'t answer your own offer' });
  if (action !== 'accept' && action !== 'decline') return res.status(400).json({ error: 'action must be accept or decline' });
  const state = action === 'accept' ? 'accepted' : 'declined';
  const done = await one(`UPDATE messages SET state = $2, updated_at = $3, text = $4 WHERE id = $1 AND state = 'pending' RETURNING *`,
    [msg.id, state, now(), `🍺 ${msg.drink} — ${state}`]);
  if (!done) return res.status(409).json({ error: 'Already answered' });
  res.json(toMsg(done));
});

// Unmatch = block: ends the chat and hides both people from each other.
app.delete('/api/matches/:id', auth, async (req, res) => {
  const r = await ownMatch(req, res); if (!r) return;
  await D.q('UPDATE matches SET ended = true, ended_by = $2 WHERE id = $1', [r.m.id, req.user.id]);
  res.json({ ok: true });
});

app.post('/api/matches/:id/seen', auth, async (req, res) => {
  const r = await ownMatch(req, res); if (!r) return;
  await D.q('UPDATE matches SET seen = seen || jsonb_build_object($2::text, true) WHERE id = $1', [r.m.id, req.user.id]);
  res.json({ ok: true });
});

app.get('/api/notifications', auth, requireBasic, async (req, res) => {
  const u = req.user;
  const list = await liveMatches(u.id, 'AND NOT (seen ? $1)');
  await hydrate(list.map((x) => x.other));
  res.json({ matches: list.map(({ m, other }) => ({ id: m.id, user: publicUser(other, u) })) });
});

// ----- reports: 3 different reporters → hidden from the feed until an admin reviews -----
app.post('/api/report', auth, sec.rateLimit('report', 10, 24 * 3600e3, perUser), async (req, res) => {
  const target = await getUser(str(req.body.userId, 40));
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'User not found' });
  await D.q('INSERT INTO reports (id, from_id, about_id, reason, at) VALUES ($1, $2, $3, $4, $5)', [id(), req.user.id, target.id, str(req.body.reason, 500), now()]);
  const n = (await one('SELECT count(DISTINCT from_id)::int AS n FROM reports WHERE about_id = $1 AND NOT resolved', [target.id])).n;
  if (n >= 3) {
    const flipped = await one('UPDATE users SET under_review = true WHERE id = $1 AND NOT under_review RETURNING id', [target.id]);
    if (flipped) await audit('auto_review', { uid: target.id, meta: { reporters: n } });
  }
  await audit('report', { req, meta: { about: target.id } });
  res.json({ ok: true });
});

// ----- push -----
app.get('/api/push/key', (req, res) => res.json({ publicKey: vapid.publicKey }));

app.post('/api/push/subscribe', auth, requireBasic, async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  const clean = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) } };
  // An endpoint belongs to one browser — move it to whoever is logged in there now.
  await dropPushEndpoint(clean.endpoint);
  const mine = ((await getUser(req.user.id)).pushSubs || []).filter((x) => x.endpoint !== clean.endpoint);
  await updateUser(req.user.id, { pushSubs: [...mine, clean].slice(-5) });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  await updateUser(req.user.id, { pushSubs: (req.user.pushSubs || []).filter((x) => x.endpoint !== endpoint) });
  res.json({ ok: true });
});

// ---------- admin ----------
async function adminViews(users) {
  await hydrate(users);
  return users.map((u) => ({
    id: u.id, username: u.username, name: u.name, age: ageOf(u),
    photo: mainPhoto(u) ? photoUrl(u, mainPhoto(u)) : null,
    photos: u.photos.map((ph) => ({ id: ph.id, url: photoUrl(u, ph) })),
    verification: verification(u), banned: u.banned || null, underReview: !!u.underReview, createdAt: u.createdAt,
  }));
}

app.get('/api/admin/selfies', auth, requireAdmin, async (req, res) => {
  const users = (await many(`SELECT * FROM users WHERE selfie->>'status' = 'pending' ORDER BY (selfie->>'submittedAt')::bigint`)).map(D.toUser);
  const views = await adminViews(users);
  res.json(users.map((u, i) => ({ ...views[i], selfie: u.selfie.image, pose: u.selfie.pose, submittedAt: u.selfie.submittedAt })));
});

app.post('/api/admin/selfies/:uid', auth, requireAdmin, async (req, res) => {
  const approve = req.body.decision === 'approve';
  const reason = str(req.body.reason, 200);
  if (!approve && !reason) {
    const u = await getUser(req.params.uid);
    if (!u || u.selfie?.status !== 'pending') return res.status(404).json({ error: 'No pending selfie' });
    return res.status(400).json({ error: 'Give a reason so the user can fix it' });
  }
  // Replacing the selfie object deletes the image — we only keep the outcome.
  const done = await one(`UPDATE users SET selfie = $2 WHERE id = $1 AND selfie->>'status' = 'pending' RETURNING id`,
    [req.params.uid, JSON.stringify({ status: approve ? 'approved' : 'rejected', note: approve ? null : reason, reviewedAt: now(), reviewedBy: req.user.id })]);
  if (!done) return res.status(404).json({ error: 'No pending selfie' });
  await audit(approve ? 'selfie_approved' : 'selfie_rejected', { req, meta: { user: req.params.uid, reason: reason || undefined } });
  res.json({ ok: true });
});

app.get('/api/admin/reports', auth, requireAdmin, async (req, res) => {
  const reports = await many(`SELECT r.*, f.username AS from_username FROM reports r LEFT JOIN users f ON f.id = r.from_id WHERE NOT r.resolved ORDER BY r.at`);
  const users = await getUsers(reports.map((r) => r.about_id));
  const list = [...users.values()];
  const views = new Map((await adminViews(list)).map((v) => [v.id, v]));
  const byUser = new Map();
  for (const r of reports) {
    if (!views.has(r.about_id)) continue;
    if (!byUser.has(r.about_id)) byUser.set(r.about_id, { user: views.get(r.about_id), reports: [] });
    byUser.get(r.about_id).reports.push({ id: r.id, reason: r.reason, at: r.at, from: r.from_username || '(deleted)' });
  }
  res.json([...byUser.values()].sort((a, b) => b.reports.length - a.reports.length));
});

// Moderation: remove one photo (e.g. after a report).
app.post('/api/admin/users/:uid/photos/:pid/remove', auth, requireAdmin, async (req, res) => {
  const uid = req.params.uid;
  const found = await tx(async (c) => {
    await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [uid]);
    const before = await mainPhotoId(uid, c);
    const del = await c.query('DELETE FROM photos WHERE id = $1 AND user_id = $2', [req.params.pid, uid]);
    if (!del.rowCount) return false;
    await renumberPhotos(uid, c);
    await mainPhotoChanged(uid, before, req, c);
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Photo not found' });
  kickDeletions();
  await audit('admin_photo_removed', { req, meta: { user: uid } });
  res.json({ ok: true, user: (await adminViews([await getUser(uid)]))[0] });
});

app.post('/api/admin/users/:uid/:action', auth, requireAdmin, async (req, res) => {
  const u = await getUser(req.params.uid);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You can\'t do that to your own account' });
  const { action } = req.params;
  const reason = str(req.body.reason, 200);
  if (action === 'ban') {
    if (!reason) return res.status(400).json({ error: 'Give a reason' });
    await updateUser(u.id, { banned: { reason, at: now(), by: req.user.id }, status: null });
    await revokeSessions(u.id);
  } else if (action === 'unban') {
    await updateUser(u.id, { banned: null });
  } else if (action === 'clear') { // reviewed reports, no action needed
    await updateUser(u.id, { underReview: false });
  } else return res.status(400).json({ error: 'Unknown action' });
  if (action !== 'unban') await D.q('UPDATE reports SET resolved = true WHERE about_id = $1', [u.id]);
  await audit(`admin_${action}`, { req, meta: { user: u.id, reason: reason || undefined } });
  res.json({ ok: true, user: (await adminViews([await getUser(u.id)]))[0] });
});

app.get('/api/admin/audit', auth, requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rows = await many('SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id = a.uid ORDER BY a.id DESC LIMIT $1', [limit]);
  res.json(rows.map((a) => ({ at: a.at, action: a.action, uid: a.uid, ip: a.ip, meta: a.meta || undefined, username: a.uid ? a.username || '(deleted)' : null })));
});

// ---------- partner bars ----------
P = partners({
  app, auth, requireBasic, requireAdmin, audit, getUser, isOut, distanceKm, pushTo, sec, str, id, now,
  normalizePhone, verification, bbox,
});

// ---------- M-Pesa billing ----------
const B = billing({
  app, auth, requireBasic, requireAdmin, audit, getUser, sec, str, id, now, normalizePhone, hmac, APP_URL, sms, P,
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Don't leak stack traces.
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong' });
});

// ---------- start ----------
// Housekeeping: drop expired sessions and audit entries older than a year.
async function housekeeping() {
  await D.q('DELETE FROM sessions WHERE created < $1 OR last_seen < $2', [now() - SESSION_MAX_AGE, now() - SESSION_IDLE]);
  await D.q('DELETE FROM audit WHERE at < $1', [now() - 365 * 86400e3]);
}

(async () => {
  try { await D.migrate(); } catch (e) {
    console.error(`Can't reach the database (${e.message}).`);
    if (!PRODUCTION) console.error('Start the dev database with:  npm run db:start');
    process.exit(1);
  }
  await limiter.connect();
  try { await storage.check(); } catch (e) {
    console.error(`Photo storage (${storage.driver}) isn't reachable: ${e.message}`);
    if (PRODUCTION) process.exit(1);
  }
  if (storage.delivery === 'redirect') cspExtra.imgOrigins.push(await storage.origin());
  const pending = await one('SELECT count(*)::int AS n FROM photos WHERE storage_key IS NULL');
  if (pending.n) console.warn(`  ${pending.n} photo(s) still stored in the database — move them with: npm run photos:migrate`);
  setInterval(processDeletions, 60e3).unref();
  kickDeletions();
  setInterval(() => housekeeping().catch((e) => console.error('housekeeping:', e.message)), 3600e3).unref();
  const server = app.listen(PORT, () => {
    console.log(`Drinking Buddies running on ${APP_URL}${DEMO ? '  (demo bots ON)' : ''}`);
    if (!PRODUCTION) {
      console.log(`  Photos: ${storage.driver} (${storage.delivery})`);
      console.log(`  SMS: ${sms.name} · email: ${mailer.name} · ID checks: ${kyc.name} · M-Pesa: ${B.mode} · admins: ${[...ADMIN_USERS].join(', ') || '(none — set ADMIN_USERS)'}`);
    }
    if (B.mode === 'disabled') console.warn('  M-Pesa not configured: payments are switched off (set MPESA_* to enable).');
    if (B.mode === 'daraja') console.log(`  M-Pesa callback URL: ${APP_URL}/api/mpesa/callback/<secret> (must be public https)`);
  });
  const stop = () => { server.close(() => Promise.allSettled([D.pool.end(), limiter.close()]).finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})();

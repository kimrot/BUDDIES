// Security helpers: password hashing/policy, tokens, rate limiting, cookies, headers.

const crypto = require('crypto');

// ---------- passwords ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return { alg: 'scrypt', salt, hash, N: SCRYPT.N };
}

function verifyPassword(password, pw) {
  if (!pw) return false;
  const hash = crypto.scryptSync(String(password), pw.salt, SCRYPT.keylen, { N: pw.N || SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  const expected = Buffer.from(pw.hash, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

// Burn the same CPU for unknown usernames so response time doesn't reveal who has an account.
const DUMMY_PW = hashPassword(crypto.randomBytes(12).toString('hex'));
const fakeVerify = (password) => { verifyPassword(password, DUMMY_PW); return false; };

const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123',
  'qwertyui', 'iloveyou', 'abcd1234', 'letmein1', 'welcome1', 'football', 'baseball', 'sunshine', 'princess',
  'admin123', '11111111', '00000000', '87654321', 'passw0rd', 'trustno1', 'nairobi1', 'kenya254', 'tusker123']);

function passwordProblem(password, { username, phone, email } = {}) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 200) return 'Password is too long';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common — pick something harder to guess';
  if (/^(.)\1+$/.test(password)) return 'Password can\'t be one repeated character';
  for (const v of [username, phone && phone.replace('+', ''), email && email.split('@')[0]]) {
    if (v && v.length >= 4 && lower.includes(String(v).toLowerCase())) return 'Password can\'t contain your username, phone or email';
  }
  return null;
}

// ---------- tokens / hashing ----------
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const makeHmac = (secret) => (s) => crypto.createHmac('sha256', secret).update(String(s)).digest('hex');
const otpCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- rate limiting (Redis-backed, shared by all instances; see lib/ratelimit.js) ----------
const limiter = require('./ratelimit');
const hit = (key, limit, windowMs) => limiter.hit(key, limit, windowMs); // async → { ok, retryAfter, count }

// Express middleware factory. keyFn(req) → string (default: client IP).
function rateLimit(name, limit, windowMs, keyFn = (req) => req.ip) {
  return async (req, res, next) => {
    const r = await hit(`${name}:${keyFn(req)}`, limit, windowMs);
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfter));
    res.status(429).json({ error: `Too many attempts. Try again in ${fmtWait(r.retryAfter)}.` });
  };
}
const fmtWait = (s) => (s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`);

// ---------- cookies ----------
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- headers ----------
// opts.imgOrigins: extra origins allowed for images (e.g. the photo storage host in redirect mode).
// It's read on every request, so it can be filled in after startup.
function securityHeaders(production, opts = { imgOrigins: [] }) {
  const cspFor = () => [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // inline style attributes (avatars, layout)
    ["img-src 'self' data: blob:", ...opts.imgOrigins].join(' '),
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': cspFor(),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=(), payment=()',
    });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  };
}

module.exports = {
  hashPassword, verifyPassword, fakeVerify, passwordProblem,
  randomToken, sha256, makeHmac, otpCode, safeEqual,
  hit, rateLimit, fmtWait, parseCookies, securityHeaders,
};

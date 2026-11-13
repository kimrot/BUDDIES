// Rate limiting shared by every server instance, stored in Redis (REDIS_URL).
//
// - Fixed window per key: one atomic Lua script does INCR + set expiry, so simultaneous requests
//   (on any instance) are counted exactly and keys always expire.
// - Keys are hashed: phone numbers, emails, usernames and IPs never appear in Redis.
// - If Redis is unreachable, each instance falls back to an in-memory limiter (still protected,
//   just not shared) and switches back automatically when Redis returns.

const crypto = require('crypto');
const { createClient, defineScript } = require('redis');

const env = process.env;
const PREFIX = env.REDIS_PREFIX || 'buddies:';
// Dev default: a local Redis. Production must set REDIS_URL (enforced in server.js).
if (!env.REDIS_URL && env.NODE_ENV !== 'production' && env.REDIS_URL !== '') env.REDIS_URL = 'redis://127.0.0.1:6379';

const HIT = defineScript({
  NUMBER_OF_KEYS: 1,
  SCRIPT: `
    local count = redis.call('INCR', KEYS[1])
    local ttl = redis.call('PTTL', KEYS[1])
    if count == 1 or ttl < 0 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
      ttl = tonumber(ARGV[1])
    end
    return { count, ttl }`,
  transformArguments: (key, windowMs) => [key, String(windowMs)],
  transformReply: (r) => r,
});

let client = null;
let ready = false;
let lastWarn = 0;
const warn = (msg) => { if (Date.now() - lastWarn > 60e3) { lastWarn = Date.now(); console.warn(msg); } };

async function connect() {
  if (!env.REDIS_URL) { console.warn('  Rate limits: in-memory (no REDIS_URL) — not shared between instances'); return; }
  client = createClient({
    url: env.REDIS_URL,
    scripts: { hit: HIT },
    socket: { connectTimeout: 3000, reconnectStrategy: (n) => Math.min(250 * n, 5000) },
    disableOfflineQueue: true, // fail fast while disconnected → use the fallback instead of waiting
  });
  client.on('ready', () => { if (!ready) console.log('  Rate limits: Redis connected'); ready = true; });
  client.on('end', () => { ready = false; });
  client.on('reconnecting', () => { ready = false; });
  client.on('error', (e) => { ready = false; warn(`  Rate limits: Redis unavailable (${e.message}) — using per-instance memory until it's back`); });
  try {
    await Promise.race([client.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
  } catch (e) {
    warn(`  Rate limits: Redis unavailable (${e.message}) — using per-instance memory until it's back`);
  }
}

// ---------- in-memory fallback ----------
const buckets = new Map();
function memHit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return { ok: b.count <= limit, retryAfter: Math.ceil((b.reset - now) / 1000), count: b.count };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 60_000).unref();

// "name:key" → "buddies:rl:name:<sha256 of key>"
function redisKey(fullKey) {
  const i = fullKey.indexOf(':');
  const name = i < 0 ? fullKey : fullKey.slice(0, i);
  const rest = i < 0 ? '' : fullKey.slice(i + 1);
  return `${PREFIX}rl:${name}:${crypto.createHash('sha256').update(rest).digest('base64url').slice(0, 22)}`;
}

// Count one attempt. Returns { ok, retryAfter (s), count }.
async function hit(fullKey, limit, windowMs) {
  const key = redisKey(fullKey);
  if (client && ready) {
    try {
      const [count, ttl] = await client.hit(key, windowMs);
      return { ok: count <= limit, retryAfter: Math.max(1, Math.ceil(ttl / 1000)), count };
    } catch (e) {
      warn(`  Rate limits: Redis error (${e.message}) — using per-instance memory`);
    }
  }
  return memHit(key, limit, windowMs);
}

const status = () => (!env.REDIS_URL ? 'memory' : ready ? 'redis' : 'fallback');
async function close() { if (client) await client.quit().catch(() => client.disconnect().catch(() => {})); }

module.exports = { connect, hit, status, close };

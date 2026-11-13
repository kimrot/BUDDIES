// Test harness: each test file gets its own throwaway Postgres database and its own server process,
// so files run in parallel without sharing state. Tests talk to the real HTTP API, using the dev
// codes/links the server echoes back when SMS and email are in console mode.
//
// Needs the dev Postgres running (`npm run db:start`). Point elsewhere with TEST_DATABASE_URL
// (any database on the server; it's only used to create and drop the test databases).

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client: PgClient } = require('pg');

const ROOT = path.join(__dirname, '..');
const ADMIN = 'admin_t';
const BASE_URL = process.env.TEST_DATABASE_URL
  || `postgres://buddies@127.0.0.1:${process.env.DEV_PG_PORT || 5433}/postgres`;

const withDb = (url, name) => { const u = new URL(url); u.pathname = '/' + name; return u.toString(); };

async function admin(sql) {
  const c = new PgClient({ connectionString: BASE_URL });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

async function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Start a fresh database + server. Returns { url, db, stop }.
async function startServer(extraEnv = {}) {
  const dbName = `buddies_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  try {
    await admin(`CREATE DATABASE ${dbName}`);
  } catch (e) {
    throw new Error(`Can't reach the test Postgres at ${BASE_URL} (${e.message}). Start it with \`npm run db:start\`, or set TEST_DATABASE_URL / DEV_PG_PORT.`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddies-test-'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: withDb(BASE_URL, dbName),
    REDIS_URL: '',                 // in-memory rate limits, private to this server
    TRUST_PROXY: '1',              // each test client sends its own X-Forwarded-For, so per-IP limits don't collide
    DATA_DIR: dir,
    STORAGE_DRIVER: 'local',
    STORAGE_DIR: path.join(dir, 'photos'),
    APP_SECRET: 'test-secret-'.padEnd(48, 'x'),
    ADMIN_USERS: ADMIN,
    ...extraEnv,
  };
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server didn't start in 15 s:\n${log}`)), 15000);
    proc.stdout.on('data', () => { if (log.includes('running on')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  const db = new PgClient({ connectionString: env.DATABASE_URL });
  await db.connect();
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    await db.end().catch(() => {});
    proc.removeAllListeners('exit');
    await new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); setTimeout(() => { proc.kill('SIGKILL'); r(); }, 3000).unref(); });
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { url, db, stop, log: () => log };
}

// ---------- HTTP client with its own cookie jar and IP ----------
let ipSeq = 0;
class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    ipSeq++;
    this.ip = `10.${(process.pid >> 8) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
  }

  async req(method, url, body, headers = {}) {
    const res = await fetch(this.base + '/api' + url, {
      method,
      headers: {
        'Content-Type': 'application/json', 'X-CSRF': '1', 'X-Forwarded-For': this.ip,
        ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  }

  get(u, h) { return this.req('GET', u, undefined, h); }
  post(u, b = {}, h) { return this.req('POST', u, b, h); }
  put(u, b = {}, h) { return this.req('PUT', u, b, h); }
  del(u, b, h) { return this.req('DELETE', u, b, h); }
}

// ---------- users ----------
const PASSWORD = 'Amber-Lantern-Harbour-42';
const ALL_CONSENT = { age: true, terms: true, idCheck: true, location: true };
let seq = 0;

function newUserData(overrides = {}) {
  seq++;
  const n = String(process.pid % 1000).padStart(3, '0') + String(seq).padStart(4, '0');
  return {
    username: `user${n}`,
    name: 'Test',
    dob: '1995-06-15',
    phone: `071${n}`.slice(0, 10).padEnd(10, '1'),
    email: `user${n}@example.com`,
    password: PASSWORD,
    consent: { ...ALL_CONSENT },
    ...overrides,
  };
}

const tokenFrom = (link) => link.split('/').pop();

// Sign up, then verify phone + email. Returns { c, user, data }.
async function basicUser(base, overrides = {}) {
  const c = new Client(base);
  const data = newUserData(overrides);
  const r = await c.post('/signup', data);
  if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  const p = await c.post('/verify/phone', { code: r.body.dev.code });
  if (p.status !== 200) throw new Error(`phone verify failed: ${JSON.stringify(p.body)}`);
  const e = await c.post('/verify/email/confirm', { token: tokenFrom(r.body.dev.link) });
  if (e.status !== 200) throw new Error(`email verify failed: ${JSON.stringify(e.body)}`);
  return { c, data, user: (await c.get('/me')).body };
}

// A tiny valid JPEG is enough: the server checks the data-URL type and size, not the pixels.
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString('base64');

let idSeq = 0;
const nextIdNumber = () => String(20000000 + (process.pid % 1000) * 1000 + ++idSeq);

// Basic user + photo + selfie (approved by the admin client) + ID check.
async function fullUser(base, adminClient, overrides = {}) {
  const u = await basicUser(base, overrides);
  const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  must(await u.c.post('/me/photos', { image: JPEG }), 'photo');
  const ch = must(await u.c.post('/verify/selfie/challenge'), 'selfie challenge');
  must(await u.c.post('/verify/selfie', { challengeId: ch.challengeId, image: JPEG }), 'selfie');
  must(await adminClient.post(`/admin/selfies/${u.user.id}`, { decision: 'approve' }), 'selfie approval');
  must(await u.c.post('/verify/id', {
    idType: 'NATIONAL_ID', idNumber: nextIdNumber(), firstName: 'Test', lastName: 'User', dob: u.data.dob,
  }), 'ID check');
  u.user = (await u.c.get('/me')).body;
  return u;
}

async function adminUser(base) {
  return basicUser(base, { username: ADMIN });
}

// Nairobi CBD, and a spot ~1 km away.
const NAIROBI = { lat: -1.2864, lng: 36.8172 };
const NEARBY = { lat: -1.2774, lng: 36.8172 };
const goOut = (c, where = NAIROBI, extra = {}) => c.put('/me/status', { joint: 'The Tap', drink: 'Tusker', hours: 3, ...where, ...extra });

const waitFor = async (fn, { timeout = 10000, every = 250 } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, every));
  }
};

module.exports = {
  startServer, Client, basicUser, fullUser, adminUser, newUserData, tokenFrom, goOut, waitFor,
  PASSWORD, ALL_CONSENT, JPEG, NAIROBI, NEARBY, ADMIN,
};

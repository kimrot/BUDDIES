// PostgreSQL access: pool, query helpers, transactions, migrations, and the user row mapper.
// Connection comes from DATABASE_URL (e.g. postgres://user:pass@host:5432/buddies).

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Dev default matches `npm run db:start` (a private Postgres inside ./data/pg). Production must set DATABASE_URL.
if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'production') process.env.DATABASE_URL = 'postgres://buddies@127.0.0.1:5433/buddies';

// bigint columns hold epoch-ms timestamps and small counts — safe as JS numbers.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE) || 10,
  ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== '1' } : undefined,
});
pool.on('error', (e) => console.error('postgres pool error:', e.message));

const q = (text, params) => pool.query(text, params);
const one = async (text, params, client = pool) => (await client.query(text, params)).rows[0] || null;
const many = async (text, params, client = pool) => (await client.query(text, params)).rows;

// Run fn(client) in a transaction. Retries serialization/deadlock failures a couple of times.
async function tx(fn) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt < 3 && (e.code === '40001' || e.code === '40P01')) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

// Apply db/migrations/*.sql in order, once each. An advisory lock stops two servers racing.
async function migrate() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files.filter((x) => !done.has(x))) {
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`  migrated ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

// ---------- users: row ⇄ object ----------
// Code works with camelCase objects (u.phoneVerified, u.status.joint…); the table is snake_case.
const USER_COLS = {
  id: 'id', username: 'username', name: 'name', dob: 'dob', bio: 'bio', createdAt: 'created_at', bot: 'bot', pw: 'pw',
  phone: 'phone', phoneVerified: 'phone_verified', phoneOtp: 'phone_otp', email: 'email', emailVerified: 'email_verified',
  emailToken: 'email_token', resetToken: 'reset_token', selfie: 'selfie', selfieChallenge: 'selfie_challenge', kyc: 'kyc',
  idHash: 'id_hash', nameLocked: 'name_locked', failedLogins: 'failed_logins', lockedUntil: 'locked_until', banned: 'banned',
  underReview: 'under_review', promoOptIn: 'promo_opt_in', pushSubs: 'push_subs', plusUntil: 'plus_until', boosts: 'boosts',
  boostUntil: 'boost_until', consentVersion: 'consent_version',
};
const JSON_COLS = new Set(['pw', 'phone_otp', 'email_token', 'reset_token', 'selfie', 'selfie_challenge', 'kyc', 'banned', 'push_subs']);
const STATUS_COLS = { joint: 'status_joint', drink: 'status_drink', lat: 'status_lat', lng: 'status_lng', until: 'status_until', since: 'status_since', venueId: 'status_venue_id' };

function toUser(row) {
  if (!row) return null;
  const u = {};
  for (const [k, c] of Object.entries(USER_COLS)) u[k] = row[c];
  u.status = row.status_until === null || row.status_until === undefined ? null : {
    joint: row.status_joint, drink: row.status_drink, lat: row.status_lat, lng: row.status_lng,
    until: row.status_until, since: row.status_since, ...(row.status_venue_id ? { venueId: row.status_venue_id } : {}),
  };
  return u;
}

// Turn a camelCase patch into "col = $n" pieces. patch.status = null clears it; an object sets all fields.
function userPatchSql(patch, startAt = 1) {
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(JSON_COLS.has(col) && v !== null && v !== undefined ? JSON.stringify(v) : v); sets.push(`${col} = $${startAt + vals.length - 1}`); };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'status') {
      for (const [sk, col] of Object.entries(STATUS_COLS)) add(col, v ? (v[sk] ?? null) : null);
    } else if (USER_COLS[k]) add(USER_COLS[k], v === undefined ? null : v);
    else throw new Error(`unknown user field ${k}`);
  }
  return { sets, vals };
}

async function updateUser(id, patch, client = pool) {
  if (!Object.keys(patch).length) return;
  const { sets, vals } = userPatchSql(patch, 2);
  await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
}

async function insertUser(u, client = pool) {
  const { id, ...rest } = u;
  const { sets, vals } = userPatchSql(rest, 2);
  const cols = sets.map((s) => s.split(' = ')[0]);
  await client.query(`INSERT INTO users (id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`, [id, ...vals]);
}

const getUser = async (id, client = pool) => (id ? toUser(await one('SELECT * FROM users WHERE id = $1', [id], client)) : null);
const getUsers = async (ids, client = pool) => {
  if (!ids.length) return new Map();
  const rows = await many('SELECT * FROM users WHERE id = ANY($1)', [[...new Set(ids)]], client);
  return new Map(rows.map((r) => [r.id, toUser(r)]));
};

module.exports = { pool, q, one, many, tx, migrate, toUser, updateUser, insertUser, getUser, getUsers, USER_COLS };

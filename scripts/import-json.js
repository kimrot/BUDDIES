#!/usr/bin/env node
// One-time import of the old JSON store (data/db.json) into PostgreSQL.
//   DATABASE_URL=... node scripts/import-json.js [path/to/db.json]
// Safe to re-run: rows that already exist are skipped.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgres://buddies@127.0.0.1:5433/buddies';
const D = require('../lib/db');
const storage = require('../lib/storage');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'db.json');
const rid = () => crypto.randomBytes(9).toString('base64url');
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s;
const uploaded = []; // photo objects written by this run — removed again if the import rolls back

(async () => {
  if (!fs.existsSync(file)) { console.error(`No file at ${file}`); process.exit(1); }
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  await D.migrate();
  await storage.check();
  const n = {};
  const count = (k, r) => { n[k] = (n[k] || 0) + (r.rowCount || 0); };

  await D.tx(async (c) => {
    const userIds = new Set();
    for (const u of db.users || []) {
      const exists = await c.query('SELECT 1 FROM users WHERE id = $1 OR username = $2', [u.id, u.username]);
      if (exists.rowCount) continue;
      const pick = {};
      for (const k of Object.keys(D.USER_COLS)) if (u[k] !== undefined) pick[k] = u[k];
      if (!pick.pw && u.hash) pick.pw = { alg: 'scrypt', salt: u.salt, hash: u.hash, N: 16384 };
      pick.createdAt = u.createdAt || Date.now();
      pick.name = u.name || u.username;
      if (u.status) pick.status = u.status;
      await D.insertUser(pick, c);
      userIds.add(u.id);
      n.users = (n.users || 0) + 1;
      const photos = u.photos || (typeof u.photo === 'string' ? [{ id: rid(), data: u.photo, at: Date.now() }] : []);
      let pos = 0;
      for (const ph of photos) {
        const m = typeof ph.data === 'string' && ph.data.match(DATA_URL_RE);
        if (!m) continue;
        const pid = ph.id || rid(), bytes = Buffer.from(m[2], 'base64'), key = storage.newKey(pid, m[1]);
        await storage.put(key, bytes, m[1]);
        uploaded.push(key);
        count('photos', await c.query('INSERT INTO photos (id, user_id, position, mime, storage_key, size, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
          [pid, u.id, pos++, m[1], key, bytes.length, ph.at || Date.now()]));
      }
    }
    const known = async (uid) => userIds.has(uid) || (await c.query('SELECT 1 FROM users WHERE id = $1', [uid])).rowCount > 0;

    for (const [hash, s] of Object.entries(db.sessions || {})) {
      if (typeof s !== 'object' || !(await known(s.uid))) continue; // old plaintext tokens are dropped (re-login)
      count('sessions', await c.query('INSERT INTO sessions (hash, user_id, created, last_seen, ip, ua) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
        [hash, s.uid, s.created, s.lastSeen, s.ip || null, s.ua || null]));
    }
    for (const s of db.swipes || []) {
      if (!(await known(s.from)) || !(await known(s.to))) continue;
      count('swipes', await c.query('INSERT INTO swipes (from_id, to_id, liked, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [s.from, s.to, !!s.like, s.at || Date.now()]));
    }
    for (const m of db.matches || []) {
      count('matches', await c.query(`INSERT INTO matches (id, user_a, user_b, created_at, ended, ended_by, seen) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING`, [m.id, m.users[0], m.users[1], m.createdAt || Date.now(), !!m.ended, m.endedBy || null, JSON.stringify(m.seen || {})]));
    }
    for (const x of db.messages || []) {
      count('messages', await c.query(`INSERT INTO messages (id, match_id, from_id, text, at, updated_at, kind, drink, note, state)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 WHERE EXISTS (SELECT 1 FROM matches WHERE id = $2) ON CONFLICT DO NOTHING`,
      [x.id, x.matchId, x.from, x.text, x.at, x.updatedAt || null, x.kind || null, x.drink || null, x.note ?? null, x.state || null]));
    }
    for (const r of db.reports || []) {
      count('reports', await c.query('INSERT INTO reports (id, from_id, about_id, reason, at, resolved) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
        [r.id || rid(), r.from, r.about, r.reason || '', r.at, !!r.resolved]));
    }
    for (const a of db.audit || []) {
      count('audit', await c.query(`INSERT INTO audit (at, action, uid, ip, meta) SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM audit WHERE at = $1 AND action = $2 AND uid IS NOT DISTINCT FROM $3)`,
      [a.at, a.action, a.uid || null, a.ip || null, a.meta ? JSON.stringify(a.meta) : null]));
    }
    for (const v of db.venues || []) {
      const featuredUntil = v.featuredUntil || (v.plan === 'featured' ? Date.now() + 30 * 86400e3 : 0);
      const r = await c.query(`INSERT INTO venues (id, name, area, address, description, kra_pin, contact_phone, lat, lng, status, note, featured_until,
          reminder_for, deal, last_promo_at, created_at, approved_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT DO NOTHING`, [v.id, v.name, v.area, v.address, v.description || '', v.kraPin, v.contactPhone, v.lat, v.lng, v.status, v.note || null,
        featuredUntil, v.reminderFor || null, JSON.stringify(v.deal || { title: '', details: '', active: false }), v.lastPromoAt || null, v.createdAt || Date.now(), v.approvedAt || null]);
      count('venues', r);
      for (const m of v.members || []) {
        if (!(await known(m.uid))) continue;
        await c.query('INSERT INTO venue_members (venue_id, user_id, role, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [v.id, m.uid, m.role, v.createdAt || Date.now()]);
      }
    }
    const venueOk = async (vid) => (await c.query('SELECT 1 FROM venues WHERE id = $1', [vid])).rowCount > 0;
    for (const x of db.checkins || []) {
      if (!(await venueOk(x.venueId)) || !(await known(x.uid))) continue;
      count('checkins', await c.query('INSERT INTO checkins (venue_id, user_id, day, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [x.venueId, x.uid, x.day, x.at]));
    }
    for (const x of db.venueMatches || []) {
      if (!(await venueOk(x.venueId))) continue;
      count('venue_matches', await c.query(`INSERT INTO venue_matches (venue_id, match_id, at) SELECT $1, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM venue_matches WHERE venue_id = $1 AND match_id = $2)`, [x.venueId, x.matchId, x.at]));
    }
    for (const x of db.redemptions || []) {
      if (!(await venueOk(x.venueId))) continue;
      count('redemptions', await c.query(`INSERT INTO redemptions (id, venue_id, match_id, code, created_at, redeemed_at, redeemed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING`, [x.id, x.venueId, x.matchId, x.code, x.createdAt, x.redeemedAt || null, x.redeemedBy || null]));
    }
    for (const x of db.promos || []) {
      if (!(await venueOk(x.venueId))) continue;
      count('promos', await c.query(`INSERT INTO promos (venue_id, at, text, reach) SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (SELECT 1 FROM promos WHERE venue_id = $1 AND at = $2)`, [x.venueId, x.at, x.text, x.reach]));
    }
    for (const p of db.payments || []) {
      const productId = p.productId || (p.venueId && p.planId && p.planId !== 'gift' ? 'featured_' + p.planId : null);
      // Pending payments from the old store can't be settled any more: import them as expired.
      const status = p.status === 'pending' ? 'expired' : p.status;
      count('payments', await c.query(`INSERT INTO payments (id, uid, venue_id, product_id, plan_id, days, amount, msisdn, status, checkout_request_id,
          merchant_request_id, receipt, result_code, result_desc, boosts, created_at, paid_at, period_start, period_end, last_query_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) ON CONFLICT DO NOTHING`,
      [p.id, p.uid || null, p.venueId || null, productId, p.planId || null, p.days || null, p.amount || 0, p.msisdn || null, status,
        p.checkoutRequestId || null, p.merchantRequestId || null, p.receipt || null, p.resultCode || null, p.resultDesc || null,
        p.boosts || null, p.createdAt || Date.now(), p.paidAt || null, p.periodStart || null, p.periodEnd || null, p.lastQueryAt || null]));
    }
  });
  console.log('Imported:', Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new');
  await D.pool.end();
})().catch(async (e) => {
  console.error('Import failed (nothing was written):', e.message);
  await Promise.all(uploaded.map((k) => storage.del(k).catch(() => {})));
  await D.pool.end(); process.exit(1);
});

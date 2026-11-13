// Partner bars: venue applications (admin-approved), match deals with redeemable codes,
// promo pushes to opted-in users nearby, staff, and anonymous stats for the dashboard.
//
// Privacy: venues only ever see counts — never who checked in, matched or received a promo.

const crypto = require('crypto');
const D = require('./db');

const { one, many, tx } = D;
const PROMO_RADIUS_KM = 3;
const PROMO_COOLDOWN = 24 * 3600e3;
const CODE_TTL = 24 * 3600e3;
const MIN_REACH_SHOWN = 5; // below this, show "fewer than 5" so a count can't identify someone
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const DAY_SQL = (col) => `to_char(to_timestamp(${col} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

const toVenue = (r) => r && ({
  id: r.id, name: r.name, area: r.area, address: r.address, description: r.description, kraPin: r.kra_pin,
  contactPhone: r.contact_phone, lat: r.lat, lng: r.lng, status: r.status, note: r.note, featuredUntil: r.featured_until,
  reminderFor: r.reminder_for, deal: r.deal, lastPromoAt: r.last_promo_at, createdAt: r.created_at, approvedAt: r.approved_at,
});

module.exports = function partners(ctx) {
  const { app, auth, requireBasic, requireAdmin, audit, getUser, isOut, distanceKm, pushTo, sec, str, id, now, normalizePhone, verification, bbox } = ctx;

  const getVenue = async (vid, client) => toVenue(await one('SELECT * FROM venues WHERE id = $1', [vid], client));
  // Featured = paid (or gifted) time remaining. Billing extends featured_until.
  const isFeatured = (v) => (v.featuredUntil || 0) > now();
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const randomCode = () => 'BUDDY-' + Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

  const publicVenue = (v, from) => ({
    id: v.id, name: v.name, area: v.area,
    featured: isFeatured(v),
    deal: v.deal?.active ? { title: v.deal.title, details: v.deal.details } : null,
    distanceKm: from ? Math.round(distanceKm(from, v) * 10) / 10 : null,
  });

  async function memberView(v, uid) {
    const members = await many(`SELECT m.user_id, m.role, u.username FROM venue_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.venue_id = $1 ORDER BY m.role = 'owner' DESC, m.added_at`, [v.id]);
    const role = members.find((m) => m.user_id === uid)?.role || null;
    return {
      ...publicVenue(v), role, status: v.status, note: v.note || null,
      plan: isFeatured(v) ? 'featured' : 'basic', featuredUntil: isFeatured(v) ? v.featuredUntil : null,
      address: v.address, description: v.description, lat: v.lat, lng: v.lng, contactPhone: v.contactPhone,
      deal: v.deal || { title: '', details: '', active: false },
      nextPromoAt: v.lastPromoAt ? v.lastPromoAt + PROMO_COOLDOWN : 0,
      members: role === 'owner' ? members.map((m) => ({ uid: m.user_id, role: m.role, username: m.username || '(deleted)' })) : undefined,
    };
  }

  // ---------- hooks used by server.js ----------
  // Public info for active partner venues (shown on people's cards).
  async function venuesByIds(ids) {
    const rows = await many(`SELECT * FROM venues WHERE id = ANY($1) AND status = 'active'`, [ids]);
    return new Map(rows.map((r) => [r.id, publicVenue(toVenue(r))]));
  }

  // Called when someone sets their status. Returns the venue (if a valid partner was picked).
  async function onCheckin(u, venueId) {
    const v = venueId && await getVenue(venueId);
    if (!v || v.status !== 'active') return null;
    await D.q('INSERT INTO checkins (venue_id, user_id, day, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [v.id, u.id, day(now()), now()]);
    return v;
  }

  async function onMatch(match, a, b) {
    const venues = new Set([a, b].map((u) => isOut(u) && u.status.venueId).filter(Boolean));
    for (const vid of venues) await D.q('INSERT INTO venue_matches (venue_id, match_id, at) VALUES ($1, $2, $3)', [vid, match.id, now()]).catch(() => {});
  }

  // Deals available to a matched pair: any active partner venue either of them is at right now.
  async function dealsForMatch(m, viewer) {
    const users = (await Promise.all(m.users.map((x) => getUser(x)))).filter(Boolean);
    const vids = [...new Set(users.map((u) => isOut(u) && u.status.venueId).filter(Boolean))];
    const out = [];
    for (const vid of vids) {
      const v = await getVenue(vid);
      if (!v || v.status !== 'active' || !v.deal?.active) continue;
      // One live code per match + venue; the advisory lock stops both people minting one at once.
      const r = await tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`code:${m.id}:${v.id}`]);
        const existing = await one(`SELECT * FROM redemptions WHERE match_id = $1 AND venue_id = $2
          AND (redeemed_at IS NOT NULL OR created_at > $3) ORDER BY created_at DESC LIMIT 1`, [m.id, v.id, now() - CODE_TTL], c);
        if (existing) return existing;
        for (;;) {
          const code = randomCode();
          const ins = await one(`INSERT INTO redemptions (id, venue_id, match_id, code, created_at) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (code) DO NOTHING RETURNING *`, [id(), v.id, m.id, code, now()], c);
          if (ins) return ins;
        }
      });
      out.push({ venueId: v.id, venueName: v.name, title: v.deal.title, details: v.deal.details, code: r.code, redeemed: !!r.redeemed_at,
        theirs: viewer && users.find((u) => u.id !== viewer.id)?.status?.venueId === v.id });
    }
    return out;
  }

  // ---------- app: partner venues near me ----------
  app.get('/api/venues/nearby', auth, requireBasic, async (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat/lng required' });
    const from = { lat, lng };
    const [a, b, c, d] = bbox(lat, lng, 10);
    const rows = await many(`SELECT * FROM venues WHERE status = 'active' AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`, [a, b, c, d]);
    res.json(rows.map(toVenue)
      .filter((v) => distanceKm(from, v) <= 10)
      .map((v) => publicVenue(v, from))
      .sort((x, y) => (y.featured - x.featured) || (x.distanceKm - y.distanceKm))
      .slice(0, 12));
  });

  // ---------- partner dashboard ----------
  // Membership check. role: 'owner' | 'staff' (any member).
  const member = (role) => async (req, res, next) => {
    const row = await one(`SELECT v.*, m.role AS member_role FROM venues v JOIN venue_members m ON m.venue_id = v.id
      WHERE v.id = $1 AND m.user_id = $2`, [req.params.vid, req.user.id]);
    if (!row || (role === 'owner' && row.member_role !== 'owner')) return res.status(404).json({ error: 'Venue not found' });
    req.venue = toVenue(row);
    req.venueRole = row.member_role;
    next();
  };
  const activeOnly = (req, res, next) => (req.venue.status === 'active' ? next()
    : res.status(409).json({ error: req.venue.status === 'pending' ? 'Your venue is still awaiting approval' : 'This venue is not active' }));

  app.get('/api/partner/venues', auth, requireBasic, async (req, res) => {
    const rows = await many(`SELECT v.* FROM venues v JOIN venue_members m ON m.venue_id = v.id WHERE m.user_id = $1 ORDER BY v.created_at`, [req.user.id]);
    res.json(await Promise.all(rows.map((r) => memberView(toVenue(r), req.user.id))));
  });

  app.post('/api/partner/venues', auth, requireBasic, sec.rateLimit('venue-apply', 3, 24 * 3600e3, (r) => r.user.id), async (req, res) => {
    const b = req.body;
    const name = str(b.name, 60), area = str(b.area, 60), address = str(b.address, 160), description = str(b.description, 400);
    const kraPin = str(b.kraPin, 11).toUpperCase();
    const contactPhone = normalizePhone(b.contactPhone);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!name || !area || !address) return res.status(400).json({ error: 'Name, area and address are required' });
    if (!/^[AP]\d{9}[A-Z]$/.test(kraPin)) return res.status(400).json({ error: 'Enter the business KRA PIN, e.g. P051234567X' });
    if (!contactPhone) return res.status(400).json({ error: 'Enter a valid contact phone' });
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Set the venue location' });
    const owned = await one(`SELECT count(*)::int AS n FROM venue_members WHERE user_id = $1 AND role = 'owner'`, [req.user.id]);
    if (owned.n >= 5) return res.status(400).json({ error: 'Limit of 5 venues per account — contact us to add more' });
    if (await one(`SELECT 1 FROM venues WHERE status <> 'rejected' AND kra_pin = $1 AND lower(name) = lower($2)`, [kraPin, name])) {
      return res.status(409).json({ error: 'This venue is already registered' });
    }
    const vid = id();
    await tx(async (c) => {
      await c.query(`INSERT INTO venues (id, name, area, address, description, kra_pin, contact_phone, lat, lng, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [vid, name, area, address, description, kraPin, contactPhone, lat, lng, now()]);
      await c.query(`INSERT INTO venue_members (venue_id, user_id, role, added_at) VALUES ($1, $2, 'owner', $3)`, [vid, req.user.id, now()]);
    });
    await audit('venue_applied', { req, meta: { venue: vid, name } });
    res.json(await memberView(await getVenue(vid), req.user.id));
  });

  // Name and location are locked once approved (stops bait-and-switch); the rest is editable.
  app.put('/api/partner/venues/:vid', auth, requireBasic, member('owner'), async (req, res) => {
    const v = req.venue, b = req.body;
    const next = { area: v.area, address: v.address, description: v.description, contactPhone: v.contactPhone, name: v.name, lat: v.lat, lng: v.lng };
    if (b.area !== undefined) next.area = str(b.area, 60) || v.area;
    if (b.address !== undefined) next.address = str(b.address, 160) || v.address;
    if (b.description !== undefined) next.description = str(b.description, 400);
    if (b.contactPhone !== undefined) {
      const p = normalizePhone(b.contactPhone);
      if (!p) return res.status(400).json({ error: 'Enter a valid contact phone' });
      next.contactPhone = p;
    }
    if (v.status === 'pending') { // still under review: everything may change
      if (b.name !== undefined) next.name = str(b.name, 60) || v.name;
      const lat = Number(b.lat), lng = Number(b.lng);
      if (b.lat !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) { next.lat = lat; next.lng = lng; }
    }
    // The status guard means an approval landing mid-request still locks name + location.
    await D.q(`UPDATE venues SET area = $2, address = $3, description = $4, contact_phone = $5,
        name = CASE WHEN status = 'pending' THEN $6 ELSE name END,
        lat = CASE WHEN status = 'pending' THEN $7 ELSE lat END,
        lng = CASE WHEN status = 'pending' THEN $8 ELSE lng END
      WHERE id = $1`, [v.id, next.area, next.address, next.description, next.contactPhone, next.name, next.lat, next.lng]);
    await audit('venue_updated', { req, meta: { venue: v.id } });
    res.json(await memberView(await getVenue(v.id), req.user.id));
  });

  app.put('/api/partner/venues/:vid/deal', auth, requireBasic, member('owner'), async (req, res) => {
    const v = req.venue;
    const title = str(req.body.title, 60), details = str(req.body.details, 200);
    const active = !!req.body.active;
    if (active && !title) return res.status(400).json({ error: 'Give the deal a short title, e.g. "20% off your first round"' });
    await D.q('UPDATE venues SET deal = $2 WHERE id = $1', [v.id, JSON.stringify({ title, details, active })]);
    await audit('venue_deal_updated', { req, meta: { venue: v.id, active } });
    res.json(await memberView(await getVenue(v.id), req.user.id));
  });

  app.get('/api/partner/venues/:vid/stats', auth, requireBasic, member(), async (req, res) => {
    const v = req.venue;
    const days = Math.min(Math.max(Number(req.query.days) || 14, 7), 90);
    const series = [];
    for (let i = days - 1; i >= 0; i--) series.push({ day: day(now() - i * 86400e3), checkins: 0, matches: 0, redemptions: 0 });
    const idx = new Map(series.map((s, i) => [s.day, i]));
    const from = Date.parse(series[0].day + 'T00:00:00Z');
    const count = async (key, sql) => {
      for (const r of await many(sql, [v.id, from])) { const i = idx.get(r.d); if (i !== undefined) series[i][key] = r.n; }
    };
    await count('checkins', `SELECT ${DAY_SQL('at')} AS d, count(*)::int AS n FROM checkins WHERE venue_id = $1 AND at >= $2 GROUP BY 1`);
    await count('matches', `SELECT ${DAY_SQL('at')} AS d, count(*)::int AS n FROM venue_matches WHERE venue_id = $1 AND at >= $2 GROUP BY 1`);
    await count('redemptions', `SELECT ${DAY_SQL('redeemed_at')} AS d, count(*)::int AS n FROM redemptions WHERE venue_id = $1 AND redeemed_at >= $2 GROUP BY 1`);
    const sum = (k) => series.reduce((a, s) => a + s[k], 0);
    const here = await one('SELECT count(*)::int AS n FROM users WHERE status_venue_id = $1 AND status_until > $2', [v.id, now()]);
    const recent = await many(`SELECT r.code, r.redeemed_at, u.username FROM redemptions r LEFT JOIN users u ON u.id = r.redeemed_by
      WHERE r.venue_id = $1 AND r.redeemed_at IS NOT NULL ORDER BY r.redeemed_at DESC LIMIT 10`, [v.id]);
    const promos = await many('SELECT at, text, reach FROM promos WHERE venue_id = $1 ORDER BY at DESC LIMIT 5', [v.id]);
    res.json({
      days, series,
      totals: { checkins: sum('checkins'), matches: sum('matches'), redemptions: sum('redemptions') },
      hereNow: here.n,
      recentRedemptions: recent.map((r) => ({ code: r.code.slice(0, 8) + '••', at: r.redeemed_at, by: r.username || '(deleted)' })),
      promos,
    });
  });

  app.post('/api/partner/venues/:vid/redeem', auth, requireBasic, member(), activeOnly,
    sec.rateLimit('redeem', 30, 10 * 60e3, (r) => `${r.params.vid}:${r.user.id}`), async (req, res) => {
      const code = str(req.body.code, 20).toUpperCase().replace(/\s/g, '');
      const full = code.startsWith('BUDDY-') ? code : 'BUDDY-' + code;
      const r = await one('SELECT * FROM redemptions WHERE code = $1 AND venue_id = $2', [full, req.venue.id]);
      if (!r) return res.status(404).json({ error: 'Code not valid at this venue' });
      const already = () => res.status(409).json({ error: `Already redeemed ${new Date(r.redeemed_at || now()).toLocaleString('en-KE')}` });
      if (r.redeemed_at) return already();
      if (r.created_at < now() - CODE_TTL) return res.status(410).json({ error: 'Code expired' });
      const m = await one('SELECT ended FROM matches WHERE id = $1', [r.match_id]);
      if (!m || m.ended) return res.status(410).json({ error: 'Code no longer valid' });
      // Only one redemption wins, even if two staff scan the same code at once.
      const done = await one('UPDATE redemptions SET redeemed_at = $2, redeemed_by = $3 WHERE id = $1 AND redeemed_at IS NULL RETURNING id', [r.id, now(), req.user.id]);
      if (!done) return already();
      await audit('deal_redeemed', { req, meta: { venue: req.venue.id } });
      res.json({ ok: true, deal: req.venue.deal.title || 'Deal', note: 'Valid for the matched pair (2 people).' });
    });

  // Opted-in, verified people currently out within the promo radius.
  async function promoAudience(v) {
    const [a, b, c, d] = bbox(v.lat, v.lng, PROMO_RADIUS_KM);
    const rows = await many(`SELECT * FROM users WHERE NOT bot AND promo_opt_in AND banned IS NULL AND phone_verified AND email_verified
      AND status_until > $1 AND status_lat BETWEEN $2 AND $3 AND status_lng BETWEEN $4 AND $5`, [now(), a, b, c, d]);
    return rows.map(D.toUser).filter((u) => verification(u).basic && distanceKm(u.status, v) <= PROMO_RADIUS_KM);
  }
  const reachText = (n) => (n >= MIN_REACH_SHOWN ? `${n} people` : `fewer than ${MIN_REACH_SHOWN} people`);

  app.get('/api/partner/venues/:vid/promo', auth, requireBasic, member(), async (req, res) => {
    const n = (await promoAudience(req.venue)).length;
    res.json({ reach: n >= MIN_REACH_SHOWN ? n : null, reachText: reachText(n), radiusKm: PROMO_RADIUS_KM, nextPromoAt: req.venue.lastPromoAt ? req.venue.lastPromoAt + PROMO_COOLDOWN : 0 });
  });

  app.post('/api/partner/venues/:vid/promo', auth, requireBasic, member('owner'), activeOnly, async (req, res) => {
    const v = req.venue;
    const text = str(req.body.text, 120);
    if (!text) return res.status(400).json({ error: 'Write a short message' });
    // Claim today's promo slot atomically (two clicks can't both send).
    const claimed = await one('UPDATE venues SET last_promo_at = $2 WHERE id = $1 AND (last_promo_at IS NULL OR last_promo_at < $3) RETURNING id', [v.id, now(), now() - PROMO_COOLDOWN]);
    if (!claimed) return res.status(429).json({ error: 'You can send one promo every 24 hours' });
    const audience = await promoAudience(v);
    await D.q('INSERT INTO promos (venue_id, at, text, reach) VALUES ($1, $2, $3, $4)', [v.id, now(), text, audience.length]);
    for (const u of audience) pushTo(u, { title: `🍻 ${v.name}`, body: text, url: '/#/out', tag: `promo-${v.id}` });
    await audit('venue_promo_sent', { req, meta: { venue: v.id, reach: audience.length } });
    res.json({ ok: true, reachText: reachText(audience.length) });
  });

  app.post('/api/partner/venues/:vid/staff', auth, requireBasic, member('owner'), async (req, res) => {
    const v = req.venue;
    const u = D.toUser(await one('SELECT * FROM users WHERE username = $1 AND NOT bot', [str(req.body.username, 30).toLowerCase()]));
    if (!u || !verification(u).basic) return res.status(404).json({ error: 'No verified account with that username' });
    const n = (await one('SELECT count(*)::int AS n FROM venue_members WHERE venue_id = $1', [v.id])).n;
    if (n >= 10) return res.status(400).json({ error: 'Team limit is 10' });
    const ins = await D.q(`INSERT INTO venue_members (venue_id, user_id, role, added_at) VALUES ($1, $2, 'staff', $3) ON CONFLICT DO NOTHING`, [v.id, u.id, now()]);
    if (!ins.rowCount) return res.status(409).json({ error: 'Already on your team' });
    await audit('venue_staff_added', { req, meta: { venue: v.id, staff: u.id } });
    res.json(await memberView(v, req.user.id));
  });

  app.delete('/api/partner/venues/:vid/staff/:uid', auth, requireBasic, member('owner'), async (req, res) => {
    const v = req.venue;
    const target = await one('SELECT role FROM venue_members WHERE venue_id = $1 AND user_id = $2', [v.id, req.params.uid]);
    if (!target) return res.status(404).json({ error: 'Not on your team' });
    if (target.role === 'owner') return res.status(400).json({ error: 'Owners can\'t be removed here' });
    await D.q('DELETE FROM venue_members WHERE venue_id = $1 AND user_id = $2', [v.id, req.params.uid]);
    await audit('venue_staff_removed', { req, meta: { venue: v.id, staff: req.params.uid } });
    res.json(await memberView(v, req.user.id));
  });

  // ---------- admin ----------
  app.get('/api/admin/venues', auth, requireAdmin, async (req, res) => {
    const rows = await many(`
      SELECT v.*, (SELECT u.username FROM venue_members m JOIN users u ON u.id = m.user_id WHERE m.venue_id = v.id AND m.role = 'owner' LIMIT 1) AS owner,
        (SELECT count(*)::int FROM checkins c WHERE c.venue_id = v.id AND c.at > $1) AS checkins30
      FROM venues v
      ORDER BY CASE v.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, v.created_at DESC`, [now() - 30 * 86400e3]);
    res.json(rows.map((r) => {
      const v = toVenue(r);
      return {
        id: v.id, name: v.name, area: v.area, address: v.address, kraPin: v.kraPin, contactPhone: v.contactPhone,
        lat: v.lat, lng: v.lng, status: v.status, plan: isFeatured(v) ? 'featured' : 'basic',
        featuredUntil: isFeatured(v) ? v.featuredUntil : null, note: v.note || null, createdAt: v.createdAt,
        owner: r.owner || '(deleted)', checkins30: r.checkins30,
      };
    }));
  });

  app.post('/api/admin/venues/:vid/:action', auth, requireAdmin, async (req, res) => {
    const v = await getVenue(req.params.vid);
    if (!v) return res.status(404).json({ error: 'Venue not found' });
    const reason = str(req.body.reason, 200);
    const set = (sql, params = []) => D.q(`UPDATE venues SET ${sql} WHERE id = $1`, [v.id, ...params]);
    switch (req.params.action) {
      case 'approve': await set('status = \'active\', note = NULL, approved_at = $2', [now()]); break;
      case 'reject': if (!reason) return res.status(400).json({ error: 'Give a reason' }); await set('status = \'rejected\', note = $2', [reason]); break;
      case 'suspend': if (!reason) return res.status(400).json({ error: 'Give a reason' }); await set('status = \'suspended\', note = $2', [reason]); break;
      case 'unsuspend': await set('status = \'active\', note = NULL'); break;
      case 'gift': { // complimentary Featured days (launch partners, goodwill)
        const days = Math.floor(Number(req.body.days));
        if (!(days >= 1 && days <= 90)) return res.status(400).json({ error: 'Gift 1–90 days' });
        await tx(async (c) => {
          const r = await one('UPDATE venues SET featured_until = GREATEST($2::bigint, featured_until) + $3 WHERE id = $1 RETURNING featured_until', [v.id, now(), days * 86400e3], c);
          await c.query(`INSERT INTO payments (id, venue_id, uid, plan_id, days, amount, status, created_at, paid_at, period_end)
            VALUES ($1, $2, $3, 'gift', $4, 0, 'gift', $5, $5, $6)`, [id(), v.id, req.user.id, days, now(), r.featured_until]);
        });
        break;
      }
      case 'unfeature': await set('featured_until = 0'); break;
      default: return res.status(400).json({ error: 'Unknown action' });
    }
    await audit(`admin_venue_${req.params.action}`, { req, meta: { venue: v.id, reason: reason || undefined, days: req.body.days } });
    res.json({ ok: true });
  });

  return { venuesByIds, onCheckin, onMatch, dealsForMatch, getVenue, member, activeOnly, isFeatured, toVenue };
};

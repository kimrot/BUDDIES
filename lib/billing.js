// M-Pesa billing (STK push) for everything we sell:
//   bars:  Featured listing (1 week / 1 month)
//   users: Buddies Plus (1 week / 1 month) and Boost packs
//
// Payment safety (same for every product):
//  - Callbacks hit a secret URL (/api/mpesa/callback/<secret>) and must match a payment we started.
//  - With real Daraja, every callback (paid or failed) is re-confirmed with Safaricom (STK query)
//    before anything changes, so a forged callback can't buy anything or void a real payment.
//  - Amount must equal what we charged; each payment and each M-Pesa receipt is applied once
//    (row lock + unique index). Anything else is held for admin review and nothing is granted.
//  - One pending payment per venue / per user, enforced by the database.
//  - If the callback never arrives (e.g. no public URL), polling reconciles via STK query.

const mpesa = require('./mpesa');
const D = require('./db');

const { one, many, tx } = D;
const env = process.env;
const kes = (n) => Math.round(Number(n));
const DAY = 86400e3;
const PRODUCTS = {
  featured_week: { id: 'featured_week', kind: 'venue', name: 'Featured — 1 week', days: 7, amount: kes(env.FEATURED_WEEK_KES || 3000) },
  featured_month: { id: 'featured_month', kind: 'venue', name: 'Featured — 1 month', days: 30, amount: kes(env.FEATURED_MONTH_KES || 10000) },
  plus_week: { id: 'plus_week', kind: 'user', name: 'Buddies Plus — 1 week', days: 7, amount: kes(env.PLUS_WEEK_KES || 149) },
  plus_month: { id: 'plus_month', kind: 'user', name: 'Buddies Plus — 1 month', days: 30, amount: kes(env.PLUS_MONTH_KES || 499), bonusBoosts: 2 },
  boost_1: { id: 'boost_1', kind: 'user', name: '1 Boost', boosts: 1, amount: kes(env.BOOST_1_KES || 50) },
  boost_5: { id: 'boost_5', kind: 'user', name: '5 Boosts', boosts: 5, amount: kes(env.BOOST_5_KES || 200) },
};
// Partner dashboard keeps its original plan ids.
const VENUE_PLANS = { week: PRODUCTS.featured_week, month: PRODUCTS.featured_month };
const PENDING_TTL = 3 * 60e3;   // STK prompts time out on the phone after ~1–2 min
const QUERY_EVERY = 15e3;       // don't hammer Daraja while polling
const MAX_AHEAD = 366 * DAY;    // can't prepay more than a year
const MAX_BOOSTS = 100;

const toPayment = (r) => r && ({
  id: r.id, uid: r.uid, venueId: r.venue_id, productId: r.product_id, planId: r.plan_id, days: r.days, amount: r.amount,
  msisdn: r.msisdn, status: r.status, checkoutRequestId: r.checkout_request_id, receipt: r.receipt, resultCode: r.result_code,
  resultDesc: r.result_desc, boosts: r.boosts, createdAt: r.created_at, paidAt: r.paid_at, periodStart: r.period_start,
  periodEnd: r.period_end, lastQueryAt: r.last_query_at,
});

module.exports = function billing(ctx) {
  const { app, auth, requireBasic, requireAdmin, audit, getUser, sec, str, id, now, normalizePhone, hmac, APP_URL, sms, P } = ctx;

  const callbackSecret = hmac('mpesa-callback').slice(0, 32);
  const callbackUrl = `${APP_URL}/api/mpesa/callback/${callbackSecret}`;
  const ipAllow = (env.MPESA_CALLBACK_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const toMsisdn = (raw) => { // Safaricom M-Pesa numbers only: 2547XXXXXXXX / 2541XXXXXXXX
    const p = normalizePhone(raw);
    return p && /^\+254[17]\d{8}$/.test(p) ? p.slice(1) : null;
  };
  const maskMsisdn = (m) => (m ? '0' + m.slice(3, 6) + '•••' + m.slice(-3) : null);
  const localPhone = (e164) => (e164 && toMsisdn(e164) ? '0' + e164.slice(4) : '');
  const fmtDate = (t) => new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  const productOf = (p) => PRODUCTS[p.productId];

  const paymentView = (p) => ({
    id: p.id, productId: p.productId || p.planId, planId: p.planId || null,
    plan: productOf(p)?.name || (p.planId === 'gift' ? `Gift — ${p.days} days` : p.productId || p.planId),
    amount: p.amount, status: p.status, receipt: p.receipt || null, phone: maskMsisdn(p.msisdn),
    message: p.status === 'failed' ? mpesa.resultText(p.resultCode, p.resultDesc) : null,
    createdAt: p.createdAt, paidAt: p.paidAt || null, periodStart: p.periodStart || null, periodEnd: p.periodEnd || null,
    boosts: p.boosts || null,
  });

  const ownerOf = async (venueId) => D.toUser(await one(`SELECT u.* FROM venue_members m JOIN users u ON u.id = m.user_id
    WHERE m.venue_id = $1 AND m.role = 'owner' LIMIT 1`, [venueId]));

  // Apply a confirmed payment exactly once (row lock). Returns what to tell the customer, or null.
  async function grant(paymentId, { receipt, amount }) {
    const result = await tx(async (c) => {
      const p = toPayment(await one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId], c));
      if (!p || !['pending', 'expired'].includes(p.status)) return null;
      const hold = async (why, action, meta) => {
        await c.query(`UPDATE payments SET status = 'review', result_desc = $2 WHERE id = $1`, [p.id, why]);
        return { held: { action, meta: { payment: p.id, ...meta } }, p };
      };
      if (amount !== null && amount !== undefined && kes(amount) !== p.amount) {
        return hold(`Amount mismatch: paid ${amount}, expected ${p.amount}`, 'payment_amount_mismatch', { amount, expected: p.amount });
      }
      if (receipt && await one(`SELECT 1 FROM payments WHERE receipt = $1 AND id <> $2`, [receipt, p.id], c)) {
        return hold(`Duplicate receipt ${receipt}`, 'payment_duplicate_receipt', { receipt });
      }
      const prod = productOf(p);
      let periodStart = null, periodEnd = null, boosts = null, line = '', to = null;
      if (prod.kind === 'venue') {
        const r = await one(`UPDATE venues SET featured_until = GREATEST($2::bigint, featured_until) + $3, reminder_for = NULL
          WHERE id = $1 RETURNING featured_until, name`, [p.venueId, now(), prod.days * DAY], c);
        if (r) { periodEnd = r.featured_until; periodStart = periodEnd - prod.days * DAY; line = `${r.name} is Featured until ${fmtDate(periodEnd)}.`; }
        to = { venueId: p.venueId };
      } else {
        if (prod.days) {
          const r = await one(`UPDATE users SET plus_until = GREATEST($2::bigint, plus_until) + $3 WHERE id = $1 RETURNING plus_until`, [p.uid, now(), prod.days * DAY], c);
          if (r) { periodEnd = r.plus_until; periodStart = periodEnd - prod.days * DAY; }
        }
        const add = (prod.boosts || 0) + (prod.bonusBoosts || 0);
        if (add) { await c.query('UPDATE users SET boosts = LEAST($2, boosts + $3) WHERE id = $1', [p.uid, MAX_BOOSTS, add]); boosts = add; }
        line = prod.days
          ? `Buddies Plus is on until ${fmtDate(periodEnd)}${prod.bonusBoosts ? ` and ${prod.bonusBoosts} Boosts were added` : ''}. Cheers!`
          : `${add} Boost${add === 1 ? '' : 's'} added. Use them while you're out.`;
        to = { uid: p.uid };
      }
      await c.query(`UPDATE payments SET status = 'paid', receipt = $2, paid_at = $3, period_start = $4, period_end = $5, boosts = $6 WHERE id = $1`,
        [p.id, receipt || null, now(), periodStart, periodEnd, boosts]);
      return { p: { ...p, receipt }, line, to };
    }).catch(async (e) => {
      if (e.code !== '23505') throw e; // receipt raced with another payment: hold for review
      await D.q(`UPDATE payments SET status = 'review', result_desc = $2 WHERE id = $1 AND status IN ('pending', 'expired')`, [paymentId, `Duplicate receipt ${receipt}`]);
      return { held: { action: 'payment_duplicate_receipt', meta: { payment: paymentId, receipt } } };
    });
    if (!result) return;
    if (result.held) return audit(result.held.action, { uid: result.p?.uid, meta: result.held.meta });
    const { p, line, to } = result;
    await audit('payment_paid', { uid: p.uid, meta: { payment: p.id, product: p.productId, venue: p.venueId, amount: p.amount, receipt: p.receipt } });
    const who = to.venueId ? await ownerOf(to.venueId) : await getUser(to.uid);
    if (who?.phoneVerified) {
      sms.send(who.phone, `Buddies: payment received, KES ${p.amount.toLocaleString('en-KE')}${p.receipt ? ` (M-Pesa ${p.receipt})` : ''}. ${line}`).catch(() => {});
    }
  }

  async function fail(paymentId, code, desc) {
    const r = await one(`UPDATE payments SET status = 'failed', result_code = $2, result_desc = $3
      WHERE id = $1 AND status IN ('pending', 'expired') RETURNING uid`, [paymentId, code, desc]);
    if (r) await audit('payment_failed', { uid: r.uid, meta: { payment: paymentId, code } });
  }

  // Shared by the real callback, the dev simulator and polling reconciliation.
  async function processResult(r, { confirm }) {
    const p = toPayment(await one('SELECT * FROM payments WHERE checkout_request_id = $1', [r.checkoutRequestId]));
    if (!p) return; // not a payment we started → ignore
    // Already granted via polling (STK query has no receipt): just record the receipt.
    if (p.status === 'paid' && !p.receipt && r.resultCode === '0' && r.receipt && kes(r.amount) === p.amount) {
      await D.q(`UPDATE payments SET receipt = $2 WHERE id = $1 AND receipt IS NULL`, [p.id, r.receipt]).catch(() => {});
      return;
    }
    if (!['pending', 'expired'].includes(p.status)) return; // already final → ignore
    if (confirm && mpesa.mode === 'daraja') {
      const q = await mpesa.stkQuery(p.checkoutRequestId).catch(() => ({ resultCode: null }));
      if (q.resultCode !== r.resultCode) {
        await audit('payment_callback_unconfirmed', { uid: p.uid, meta: { payment: p.id, callback: r.resultCode, query: q.resultCode } });
        if (q.resultCode === null) return; // stays pending; polling will settle it
        r = { ...r, resultCode: q.resultCode, resultDesc: q.resultDesc, receipt: null, amount: null }; // trust the query
      }
    }
    if (r.resultCode === '0') await grant(p.id, { receipt: r.receipt, amount: r.amount });
    else if (r.resultCode !== null) await fail(p.id, r.resultCode, r.resultDesc);
  }
  mpesa.onMockResult((r) => processResult(r, { confirm: false }).catch((e) => console.error('mock payment:', e.message)));

  // Poll-time reconciliation. Claiming last_query_at atomically means only one request asks Daraja.
  async function refresh(paymentId) {
    const p = toPayment(await one(`UPDATE payments SET last_query_at = $2 WHERE id = $1 AND status = 'pending'
      AND coalesce(last_query_at, 0) < $3 AND created_at < $4 RETURNING *`, [paymentId, now(), now() - QUERY_EVERY, now() - 10e3]));
    if (!p) return;
    const q = await mpesa.stkQuery(p.checkoutRequestId).catch(() => ({ resultCode: null }));
    if (q.resultCode === '0') await grant(p.id, { receipt: null, amount: null }); // receipt arrives with the callback
    else if (q.resultCode !== null) await fail(p.id, q.resultCode, q.resultDesc);
    else if (now() - p.createdAt > PENDING_TTL) await D.q(`UPDATE payments SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [p.id]); // a late callback can still complete it
  }
  const getPayment = async (pid) => toPayment(await one('SELECT * FROM payments WHERE id = $1', [pid]));

  // Start an STK push. The pending row is written first: the unique index allows one pending
  // payment per venue / per user, so two quick taps can't send two prompts.
  async function startPayment(req, res, { product, phone, venue }) {
    if (mpesa.mode === 'disabled') return res.status(503).json({ error: 'Online payments aren\'t available yet.' });
    const msisdn = toMsisdn(phone);
    if (!msisdn) return res.status(400).json({ error: 'Enter a Safaricom M-Pesa number, e.g. 0712 345 678' });
    const openSql = venue ? `SELECT * FROM payments WHERE status = 'pending' AND venue_id = $1` : `SELECT * FROM payments WHERE status = 'pending' AND venue_id IS NULL AND uid = $1`;
    const open = toPayment(await one(openSql, [venue ? venue.id : req.user.id]));
    if (open) {
      await refresh(open.id);
      const again = await getPayment(open.id);
      if (again.status === 'pending') return res.status(409).json({ error: 'A payment is already waiting for the M-Pesa PIN. Finish or cancel it on your phone first.', pending: paymentView(again) });
    }
    const pid = id();
    try {
      await D.q(`INSERT INTO payments (id, uid, venue_id, product_id, plan_id, days, amount, msisdn, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [pid, req.user.id, venue?.id || null, product.id, venue ? product.id.replace('featured_', '') : null, product.days || null, product.amount, msisdn, now()]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'A payment is already waiting for the M-Pesa PIN. Finish or cancel it on your phone first.' });
      throw e;
    }
    try {
      const r = await mpesa.stkPush({
        phone: msisdn, amount: product.amount, callbackUrl,
        accountRef: venue ? `BUDDY${venue.id.slice(0, 7)}` : `BUDDY${req.user.id.slice(0, 7)}`,
        description: product.kind === 'venue' ? 'Featured' : product.days ? 'Buddies Plus' : 'Boosts',
      });
      await D.q('UPDATE payments SET checkout_request_id = $2, merchant_request_id = $3 WHERE id = $1', [pid, r.checkoutRequestId, r.merchantRequestId]);
    } catch (e) {
      console.error('STK push failed:', e.message);
      await D.q('DELETE FROM payments WHERE id = $1', [pid]); // no prompt was sent: free the slot
      return res.status(502).json({ error: 'Couldn\'t reach M-Pesa. Try again in a moment.' });
    }
    await audit('payment_initiated', { req, meta: { payment: pid, product: product.id, venue: venue?.id, amount: product.amount } });
    res.json({ payment: paymentView(await getPayment(pid)), mode: mpesa.mode });
  }

  // ---------- partner routes: Featured (owner only) ----------
  app.get('/api/partner/venues/:vid/billing', auth, requireBasic, P.member('owner'), async (req, res) => {
    const v = req.venue;
    const pending = await one(`SELECT id FROM payments WHERE venue_id = $1 AND status = 'pending'`, [v.id]);
    if (pending) await refresh(pending.id);
    const mine = (await many('SELECT * FROM payments WHERE venue_id = $1 ORDER BY created_at DESC LIMIT 20', [v.id])).map(toPayment);
    const fresh = await P.getVenue(v.id);
    res.json({
      mode: mpesa.mode,
      plans: Object.entries(VENUE_PLANS).map(([pid, pr]) => ({ id: pid, name: pr.name, days: pr.days, amount: pr.amount })),
      featured: P.isFeatured(fresh), featuredUntil: P.isFeatured(fresh) ? fresh.featuredUntil : null,
      defaultPhone: localPhone(req.user.phone) || localPhone(v.contactPhone),
      pending: mine.find((p) => p.status === 'pending') ? paymentView(mine.find((p) => p.status === 'pending')) : null,
      payments: mine.map(paymentView),
    });
  });

  app.post('/api/partner/venues/:vid/billing/pay', auth, requireBasic, P.member('owner'), P.activeOnly,
    sec.rateLimit('pay', 10, 10 * 60e3, (r) => r.params.vid), async (req, res) => {
      const v = req.venue;
      const product = VENUE_PLANS[req.body.planId];
      if (!product) return res.status(400).json({ error: 'Choose a plan' });
      if ((v.featuredUntil || 0) + product.days * DAY > now() + MAX_AHEAD) return res.status(400).json({ error: 'You can prepay up to a year ahead' });
      return startPayment(req, res, { product, phone: req.body.phone, venue: v });
    });

  app.get('/api/partner/venues/:vid/billing/payments/:pid', auth, requireBasic, P.member('owner'), async (req, res) => {
    const p0 = await one('SELECT id FROM payments WHERE id = $1 AND venue_id = $2', [req.params.pid, req.venue.id]);
    if (!p0) return res.status(404).json({ error: 'Payment not found' });
    await refresh(p0.id);
    const v = await P.getVenue(req.venue.id);
    res.json({ payment: paymentView(await getPayment(p0.id)), featuredUntil: P.isFeatured(v) ? v.featuredUntil : null });
  });

  app.get('/api/partner/venues/:vid/billing/payments/:pid/receipt', auth, requireBasic, P.member('owner'), async (req, res) => {
    const p = toPayment(await one(`SELECT * FROM payments WHERE id = $1 AND venue_id = $2 AND status = 'paid'`, [req.params.pid, req.venue.id]));
    if (!p) return res.status(404).json({ error: 'Receipt not found' });
    const v = req.venue;
    res.json({ ...paymentView(p), venue: { name: v.name, address: v.address, area: v.area, kraPin: v.kraPin }, number: 'BB-' + p.id.slice(0, 8).toUpperCase() });
  });

  // ---------- user routes: Buddies Plus & Boosts ----------
  const userView = (u) => ({
    plus: { active: (u.plusUntil || 0) > now(), until: (u.plusUntil || 0) > now() ? u.plusUntil : null },
    boosts: u.boosts || 0,
  });

  app.get('/api/billing', auth, requireBasic, async (req, res) => {
    const pending = await one(`SELECT id FROM payments WHERE uid = $1 AND venue_id IS NULL AND status = 'pending'`, [req.user.id]);
    if (pending) await refresh(pending.id);
    const mine = (await many('SELECT * FROM payments WHERE uid = $1 AND venue_id IS NULL ORDER BY created_at DESC LIMIT 20', [req.user.id])).map(toPayment);
    const u = await getUser(req.user.id);
    res.json({
      mode: mpesa.mode,
      products: Object.values(PRODUCTS).filter((p) => p.kind === 'user'),
      ...userView(u),
      defaultPhone: localPhone(u.phone),
      pending: mine.find((p) => p.status === 'pending') ? paymentView(mine.find((p) => p.status === 'pending')) : null,
      payments: mine.map(paymentView),
    });
  });

  app.post('/api/billing/pay', auth, requireBasic, sec.rateLimit('pay-user', 10, 10 * 60e3, (r) => r.user.id), async (req, res) => {
    const product = PRODUCTS[str(req.body.productId, 30)];
    if (!product || product.kind !== 'user') return res.status(400).json({ error: 'Choose what to buy' });
    const u = req.user;
    if (product.days && (u.plusUntil || 0) + product.days * DAY > now() + MAX_AHEAD) return res.status(400).json({ error: 'You can prepay up to a year ahead' });
    if (product.boosts && (u.boosts || 0) + product.boosts > MAX_BOOSTS) return res.status(400).json({ error: `You can hold up to ${MAX_BOOSTS} Boosts` });
    return startPayment(req, res, { product, phone: req.body.phone });
  });

  app.get('/api/billing/payments/:pid', auth, requireBasic, async (req, res) => {
    const p0 = await one('SELECT id FROM payments WHERE id = $1 AND venue_id IS NULL AND uid = $2', [req.params.pid, req.user.id]);
    if (!p0) return res.status(404).json({ error: 'Payment not found' });
    await refresh(p0.id);
    res.json({ payment: paymentView(await getPayment(p0.id)), ...userView(await getUser(req.user.id)) });
  });

  // ---------- Daraja callback (no session; secret URL + matching + confirmation) ----------
  app.post('/api/mpesa/callback/:secret', sec.rateLimit('mpesa-cb', 300, 60e3), async (req, res) => {
    // Always answer 200 quickly so Safaricom doesn't retry forever; do the checks ourselves.
    const accepted = () => res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    if (!sec.safeEqual(req.params.secret, callbackSecret)) { await audit('mpesa_callback_bad_secret', { req }); return res.status(404).json({}); }
    if (ipAllow.length && !ipAllow.includes(req.ip)) { await audit('mpesa_callback_bad_ip', { req }); return accepted(); }
    const r = mpesa.parseCallback(req.body);
    if (!r) { await audit('mpesa_callback_malformed', { req }); return accepted(); }
    accepted();
    processResult(r, { confirm: true }).catch((e) => console.error('callback processing failed:', e.message));
  });

  // ---------- renewal reminders: SMS 3 days before Featured ends ----------
  async function remind() {
    const due = await many(`SELECT id, name, featured_until FROM venues WHERE status = 'active'
      AND featured_until BETWEEN $1 AND $2 AND reminder_for IS DISTINCT FROM featured_until`, [now(), now() + 3 * DAY]);
    for (const v of due) {
      // Claim the reminder first so two servers don't both send it.
      const claimed = await one('UPDATE venues SET reminder_for = featured_until WHERE id = $1 AND reminder_for IS DISTINCT FROM featured_until RETURNING id', [v.id]);
      if (!claimed) continue;
      const owner = await ownerOf(v.id);
      if (owner?.phoneVerified) {
        sms.send(owner.phone, `Buddies: ${v.name}'s Featured listing ends ${fmtDate(v.featured_until)}. Renew with M-Pesa in your partner dashboard to stay at the top.`).catch(() => {});
      }
    }
  }
  setInterval(() => remind().catch((e) => console.error('reminders:', e.message)), 3600e3).unref();
  setTimeout(() => remind().catch((e) => console.error('reminders:', e.message)), 5000).unref();

  // ---------- admin ----------
  app.get('/api/admin/payments', auth, requireAdmin, async (req, res) => {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const kindSql = `CASE WHEN venue_id IS NOT NULL THEN 'featured' WHEN product_id LIKE 'plus_%' THEN 'plus' ELSE 'boosts' END`;
    const byKind = await many(`SELECT ${kindSql} AS kind, sum(amount)::int AS total FROM payments WHERE status = 'paid' AND paid_at >= $1 GROUP BY 1`, [monthStart.getTime()]);
    const totals = await one(`SELECT coalesce(sum(amount) FILTER (WHERE paid_at >= $1), 0)::int AS month, coalesce(sum(amount), 0)::int AS all_time,
      (SELECT count(*)::int FROM payments WHERE status = 'review') AS review FROM payments WHERE status = 'paid'`, [monthStart.getTime()]);
    const counts = await one('SELECT (SELECT count(*)::int FROM venues WHERE featured_until > $1) AS featured, (SELECT count(*)::int FROM users WHERE plus_until > $1) AS plus', [now()]);
    const rows = await many(`SELECT p.*, v.name AS venue_name, u.username FROM payments p
      LEFT JOIN venues v ON v.id = p.venue_id LEFT JOIN users u ON u.id = p.uid ORDER BY p.created_at DESC LIMIT 200`);
    const k = Object.fromEntries(byKind.map((r) => [r.kind, r.total]));
    res.json({
      mode: mpesa.mode,
      revenueThisMonth: totals.month,
      revenueAllTime: totals.all_time,
      byKindThisMonth: { featured: k.featured || 0, plus: k.plus || 0, boosts: k.boosts || 0 },
      featuredNow: counts.featured,
      plusNow: counts.plus,
      needsReview: totals.review,
      payments: rows.map((r) => {
        const p = toPayment(r);
        return { ...paymentView(p), venue: p.venueId ? r.venue_name || '(deleted)' : null, by: r.username || '(deleted)', note: p.status === 'review' ? p.resultDesc : null };
      }),
    });
  });

  return { mode: mpesa.mode, callbackUrl, PRODUCTS };
};

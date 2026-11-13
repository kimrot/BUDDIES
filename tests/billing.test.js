// Buddies Plus and Boosts over (simulated) M-Pesa. The mock settles a payment ~3.5 s after the prompt;
// numbers ending in 000 simulate the user cancelling.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, basicUser, fullUser, adminUser, goOut, waitFor } = require('./helpers');

let srv, admin;
before(async () => { srv = await startServer(); admin = (await adminUser(srv.url)).c; });
after(async () => { await srv?.stop(); });

async function pay(c, productId, phone = '0712345678') {
  const r = await c.post('/billing/pay', { productId, phone });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pid = r.body.payment?.id || r.body.id;
  assert.ok(pid, `payment id in ${JSON.stringify(r.body)}`);
  return waitFor(async () => {
    const s = await c.get(`/billing/payments/${pid}`);
    return s.body.payment.status !== 'pending' && s.body;
  });
}

describe('payments', () => {
  test('buying a Boost adds one Boost and records the receipt', async () => {
    const { c } = await basicUser(srv.url);
    const r = await pay(c, 'boost_1');
    assert.equal(r.payment.status, 'paid');
    assert.match(r.payment.receipt, /^SIM/);
    assert.equal(r.boosts, 1);
    assert.equal((await c.get('/me')).body.boosts, 1);
  });

  test('buying Plus for a week makes the account Plus', async () => {
    const { c } = await basicUser(srv.url);
    const r = await pay(c, 'plus_week');
    assert.equal(r.payment.status, 'paid');
    const me = (await c.get('/me')).body;
    assert.equal(me.plus.active, true);
    const days = (me.plus.until - Date.now()) / 864e5;
    assert.ok(days > 6.9 && days <= 7, `about 7 days, got ${days}`);
  });

  test('a cancelled payment grants nothing', async () => {
    const { c } = await basicUser(srv.url);
    const r = await pay(c, 'boost_5', '0712345000');
    assert.equal(r.payment.status, 'failed');
    assert.equal((await c.get('/me')).body.boosts, 0);
  });

  test('only one payment can wait for a PIN at a time', async () => {
    const { c } = await basicUser(srv.url);
    assert.equal((await c.post('/billing/pay', { productId: 'boost_1', phone: '0712345678' })).status, 200);
    assert.equal((await c.post('/billing/pay', { productId: 'boost_1', phone: '0712345678' })).status, 409);
  });

  test('refuses unknown products, venue products and non-Safaricom numbers', async () => {
    const { c } = await basicUser(srv.url);
    assert.equal((await c.post('/billing/pay', { productId: 'free_beer', phone: '0712345678' })).status, 400);
    assert.equal((await c.post('/billing/pay', { productId: 'featured_week', phone: '0712345678' })).status, 400);
    assert.equal((await c.post('/billing/pay', { productId: 'boost_1', phone: '12' })).status, 400);
  });

  test('you can\'t see someone else\'s payment', async () => {
    const a = await basicUser(srv.url);
    const b = await basicUser(srv.url);
    const r = await a.c.post('/billing/pay', { productId: 'boost_1', phone: '0712345678' });
    const pid = r.body.payment?.id || r.body.id;
    assert.equal((await b.c.get(`/billing/payments/${pid}`)).status, 404);
  });
});

describe('Plus features', () => {
  test('Plus members see who liked them', async () => {
    const a = await fullUser(srv.url, admin);
    const b = await fullUser(srv.url, admin);
    await goOut(a.c);
    await goOut(b.c);
    await b.c.post('/swipe', { targetId: a.user.id, dir: 'like' });
    assert.deepEqual((await a.c.get('/likes')).body.people, []);
    await pay(a.c, 'plus_week');
    assert.deepEqual((await a.c.get('/likes')).body.people.map((p) => p.id), [b.user.id]);
  });

  test('rewind is Plus-only', async () => {
    const a = await fullUser(srv.url, admin);
    const r = await a.c.post('/swipe/rewind');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PLUS_ONLY');
  });

  test('a Boost is spent once and only while out', async () => {
    const a = await fullUser(srv.url, admin);
    assert.equal((await a.c.post('/boost')).status, 409, 'not out yet');
    await goOut(a.c);
    const none = await a.c.post('/boost');
    assert.equal(none.status, 402);
    assert.equal(none.body.code, 'NO_BOOSTS');
    await pay(a.c, 'boost_1');
    const used = await a.c.post('/boost');
    assert.equal(used.status, 200);
    assert.equal(used.body.boosts, 0);
    assert.ok(used.body.boostUntil > Date.now());
    assert.equal((await a.c.post('/boost')).status, 409, 'already boosted');
  });
});

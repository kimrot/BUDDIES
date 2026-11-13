// Verification tiers: phone + email unlock the app; selfie + ID unlock liking and chat.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, basicUser, fullUser, adminUser, newUserData, tokenFrom, goOut, JPEG } = require('./helpers');

let srv, admin;
before(async () => { srv = await startServer(); admin = (await adminUser(srv.url)).c; });
after(async () => { await srv?.stop(); });

describe('phone', () => {
  test('a wrong code is refused and counted; 5 wrong codes kill the code', async () => {
    const c = new Client(srv.url);
    const r = await c.post('/signup', newUserData());
    const wrong = r.body.dev.code === '000000' ? '111111' : '000000';
    const first = await c.post('/verify/phone', { code: wrong });
    assert.equal(first.status, 400);
    assert.match(first.body.error, /4 attempts left/);
    for (let i = 0; i < 4; i++) await c.post('/verify/phone', { code: wrong });
    const blocked = await c.post('/verify/phone', { code: r.body.dev.code });
    assert.equal(blocked.status, 429, 'even the right code fails after 5 wrong ones');
  });

  test('the right code verifies the phone', async () => {
    const c = new Client(srv.url);
    const r = await c.post('/signup', newUserData());
    const ok = await c.post('/verify/phone', { code: r.body.dev.code });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.verification.phone, true);
  });

  test('resending within 60 s is refused', async () => {
    const c = new Client(srv.url);
    await c.post('/signup', newUserData());
    assert.equal((await c.post('/verify/phone/send')).status, 429);
  });
});

describe('email', () => {
  test('the link works once, without being logged in', async () => {
    const c = new Client(srv.url);
    const r = await c.post('/signup', newUserData());
    const token = tokenFrom(r.body.dev.link);
    const anon = new Client(srv.url);
    assert.equal((await anon.post('/verify/email/confirm', { token })).status, 200);
    assert.equal((await anon.post('/verify/email/confirm', { token })).status, 400);
    assert.equal((await c.get('/me')).body.verification.email, true);
  });
});

describe('access gates', () => {
  test('without phone + email, the app is locked', async () => {
    const c = new Client(srv.url);
    await c.post('/signup', newUserData());
    const r = await goOut(c);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'VERIFY_BASIC');
  });

  test('with phone + email but no selfie/ID, you can go out and browse but not like', async () => {
    const { c } = await basicUser(srv.url);
    assert.equal((await goOut(c)).status, 200);
    assert.equal((await c.get('/feed')).status, 200);
    const target = await fullUser(srv.url, admin);
    const like = await c.post('/swipe', { targetId: target.user.id, dir: 'like' });
    assert.equal(like.status, 403);
    assert.equal(like.body.code, 'VERIFY_FULL');
  });

  test('a fully verified user can like', async () => {
    const u = await fullUser(srv.url, admin);
    assert.equal(u.user.verification.full, true);
    const target = await fullUser(srv.url, admin);
    assert.equal((await u.c.post('/swipe', { targetId: target.user.id, dir: 'like' })).status, 200);
  });
});

describe('selfie', () => {
  test('needs a profile photo first', async () => {
    const { c } = await basicUser(srv.url);
    assert.equal((await c.post('/verify/selfie/challenge')).status, 400);
  });

  test('a rejected selfie needs a reason, and the image is deleted after review', async () => {
    const { c, user } = await basicUser(srv.url);
    await c.post('/me/photos', { image: JPEG });
    const ch = (await c.post('/verify/selfie/challenge')).body;
    await c.post('/verify/selfie', { challengeId: ch.challengeId, image: JPEG });
    assert.equal((await admin.post(`/admin/selfies/${user.id}`, { decision: 'reject' })).status, 400);
    assert.equal((await admin.post(`/admin/selfies/${user.id}`, { decision: 'reject', reason: 'Face not visible' })).status, 200);
    const { rows } = await srv.db.query('SELECT selfie FROM users WHERE id = $1', [user.id]);
    assert.equal(rows[0].selfie.status, 'rejected');
    assert.equal(rows[0].selfie.image, undefined);
  });

  test('only admins can review selfies', async () => {
    const { c, user } = await basicUser(srv.url);
    assert.equal((await c.get('/admin/selfies')).status, 403);
    assert.equal((await c.post(`/admin/selfies/${user.id}`, { decision: 'approve' })).status, 403);
  });
});

describe('government ID', () => {
  const idBody = (dob, idNumber = String(30000000 + Math.floor(Math.random() * 1e6))) => ({ idType: 'NATIONAL_ID', idNumber, firstName: 'wanjiru', lastName: 'Kamau', dob });

  test('sets age from the ID and locks the name; the ID number is never stored', async () => {
    const { c, user } = await basicUser(srv.url);
    const body = idBody('1990-03-01');
    const r = await c.post('/verify/id', body);
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Wanjiru');
    assert.equal(r.body.nameLocked, true);
    assert.equal(r.body.dob, '1990-03-01');
    const { rows } = await srv.db.query('SELECT row_to_json(u)::text AS j FROM users u WHERE id = $1', [user.id]);
    assert.ok(!rows[0].j.includes(body.idNumber));
  });

  test('one ID can only verify one account', async () => {
    const a = await basicUser(srv.url);
    const b = await basicUser(srv.url);
    const body = idBody('1990-03-01');
    assert.equal((await a.c.post('/verify/id', body)).status, 200);
    assert.equal((await b.c.post('/verify/id', body)).status, 409);
  });

  test('an under-18 ID suspends the account and logs it out', async () => {
    const { c, data } = await basicUser(srv.url);
    const dob = new Date(Date.now() - 16 * 365.25 * 864e5).toISOString().slice(0, 10);
    const r = await c.post('/verify/id', idBody(dob));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'BANNED');
    assert.equal((await c.get('/me')).status, 401, 'sessions revoked');
    const relogin = await new Client(srv.url).post('/login', { username: data.username, password: data.password });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.body.code, 'BANNED');
  });

  test('a failed registry check is reported and nothing is verified', async () => {
    const { c } = await basicUser(srv.url);
    const r = await c.post('/verify/id', idBody('1990-03-01', '12340000')); // mock: ending 0000 = not found
    assert.equal(r.status, 400);
    assert.equal(r.body.user.verification.id, 'failed');
  });
});

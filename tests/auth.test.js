// Sign up, log in, lockout, sessions, password reset, CSRF.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, basicUser, newUserData, tokenFrom, PASSWORD } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

describe('signup', () => {
  test('creates an account, logs in, and returns dev verification codes', async () => {
    const c = new Client(srv.url);
    const data = newUserData();
    const r = await c.post('/signup', data);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.username, data.username);
    assert.equal(r.body.user.verification.basic, false);
    assert.match(r.body.dev.code, /^\d{6}$/);
    assert.match(r.body.dev.link, /#\/confirm-email\//);
    assert.equal((await c.get('/me')).status, 200, 'signup starts a session');
  });

  test('never stores the password in plain text', async () => {
    const { data } = await basicUser(srv.url);
    const { rows } = await srv.db.query('SELECT pw::text AS pw FROM users WHERE username = $1', [data.username]);
    assert.ok(!rows[0].pw.includes(PASSWORD));
  });

  test('refuses under-18 dates of birth', async () => {
    const dob = new Date(Date.now() - 17 * 365.25 * 864e5).toISOString().slice(0, 10);
    const r = await new Client(srv.url).post('/signup', newUserData({ dob }));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /18\+/);
  });

  test('refuses weak passwords and passwords containing the username', async () => {
    const c = new Client(srv.url);
    assert.equal((await c.post('/signup', newUserData({ password: 'short' }))).status, 400);
    assert.equal((await c.post('/signup', newUserData({ password: 'password123' }))).status, 400);
    const d = newUserData();
    assert.equal((await c.post('/signup', { ...d, password: `${d.username}-Xy9!` })).status, 400);
  });

  test('refuses invalid usernames, phones and emails', async () => {
    const c = new Client(srv.url);
    assert.equal((await c.post('/signup', newUserData({ username: 'a b' }))).status, 400);
    assert.equal((await c.post('/signup', newUserData({ phone: '12' }))).status, 400);
    assert.equal((await c.post('/signup', newUserData({ email: 'nope' }))).status, 400);
  });

  test('refuses a taken username', async () => {
    const { data } = await basicUser(srv.url);
    const r = await new Client(srv.url).post('/signup', newUserData({ username: data.username }));
    assert.equal(r.status, 409);
  });

  test('refuses a phone or email already verified on another account', async () => {
    const { data } = await basicUser(srv.url);
    const c = new Client(srv.url);
    assert.equal((await c.post('/signup', newUserData({ phone: data.phone }))).status, 409);
    assert.equal((await c.post('/signup', newUserData({ email: data.email }))).status, 409);
  });
});

describe('login and sessions', () => {
  test('logs in with the right password and rejects the wrong one', async () => {
    const { data } = await basicUser(srv.url);
    const c = new Client(srv.url);
    assert.equal((await c.post('/login', { username: data.username, password: 'Wrong-Password-1' })).status, 401);
    const ok = await c.post('/login', { username: data.username.toUpperCase(), password: PASSWORD });
    assert.equal(ok.status, 200, 'usernames are case-insensitive');
    assert.equal(ok.body.user.username, data.username);
  });

  test('gives the same answer for unknown usernames as for wrong passwords', async () => {
    const r = await new Client(srv.url).post('/login', { username: 'nobody_here', password: PASSWORD });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Wrong username or password');
  });

  test('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const { data } = await basicUser(srv.url);
    const c = new Client(srv.url);
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/login', { username: data.username, password: `Wrong-${i}-Password` })).status, 401);
    const locked = await c.post('/login', { username: data.username, password: PASSWORD });
    assert.equal(locked.status, 423, 'even the right password is refused while locked');
    const { rows } = await srv.db.query(`SELECT count(*)::int AS n FROM audit a JOIN users u ON u.id = a.uid WHERE u.username = $1 AND a.action = 'account_locked'`, [data.username]);
    assert.equal(rows[0].n, 1);
  });

  test('logout ends the session', async () => {
    const { c } = await basicUser(srv.url);
    assert.equal((await c.post('/logout')).status, 200);
    assert.equal((await c.get('/me')).status, 401);
  });

  test('logout-all ends sessions on every device', async () => {
    const { c, data } = await basicUser(srv.url);
    const other = new Client(srv.url);
    await other.post('/login', { username: data.username, password: PASSWORD });
    assert.equal((await other.get('/me')).status, 200);
    await c.post('/logout-all');
    assert.equal((await other.get('/me')).status, 401);
  });

  test('changing the password logs out other devices but keeps this one', async () => {
    const { c, data } = await basicUser(srv.url);
    const other = new Client(srv.url);
    await other.post('/login', { username: data.username, password: PASSWORD });
    assert.equal((await c.post('/me/password', { current: 'Not-My-Password-9', next: 'Brand-New-Secret-77' })).status, 400);
    assert.equal((await c.post('/me/password', { current: PASSWORD, next: 'Brand-New-Secret-77' })).status, 200);
    assert.equal((await c.get('/me')).status, 200);
    assert.equal((await other.get('/me')).status, 401);
    assert.equal((await new Client(srv.url).post('/login', { username: data.username, password: 'Brand-New-Secret-77' })).status, 200);
  });
});

describe('password reset', () => {
  test('resets with a single-use link and logs out everywhere', async () => {
    const { c, data } = await basicUser(srv.url);
    const anon = new Client(srv.url);
    const f = await anon.post('/password/forgot', { email: data.email });
    assert.equal(f.status, 200);
    const token = tokenFrom(f.body.dev.link);

    const r = await anon.post('/password/reset', { token, password: 'Reset-Works-Fine-31' });
    assert.equal(r.status, 200);
    assert.equal((await c.get('/me')).status, 401, 'old sessions are revoked');
    assert.equal((await anon.post('/password/reset', { token, password: 'Second-Try-Again-31' })).status, 400, 'link is single use');
    assert.equal((await anon.post('/login', { username: data.username, password: 'Reset-Works-Fine-31' })).status, 200);
  });

  test("doesn't reveal whether an account exists", async () => {
    const r = await new Client(srv.url).post('/password/forgot', { email: 'nobody@example.com' });
    assert.equal(r.status, 200);
    assert.equal(r.body.dev, undefined);
    assert.match(r.body.message, /If that email/);
  });

  test('rejects made-up tokens', async () => {
    const r = await new Client(srv.url).post('/password/reset', { token: 'abc', password: 'Whatever-Pass-55' });
    assert.equal(r.status, 400);
  });
});

describe('CSRF', () => {
  test('refuses writes without the X-CSRF header', async () => {
    const r = await new Client(srv.url).post('/login', { username: 'x', password: 'y' }, { 'X-CSRF': '' });
    assert.equal(r.status, 403);
  });

  test('refuses writes from another origin', async () => {
    const r = await new Client(srv.url).post('/login', { username: 'x', password: 'y' }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });
});

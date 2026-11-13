// Registration consent: required at signup, recorded per version, re-accepted when missing or outdated.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, basicUser, newUserData, ALL_CONSENT } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

describe('at signup', () => {
  test('is refused without consent', async () => {
    const d = newUserData();
    delete d.consent;
    const r = await new Client(srv.url).post('/signup', d);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'CONSENT_REQUIRED');
  });

  for (const missing of Object.keys(ALL_CONSENT)) {
    test(`is refused when "${missing}" isn't ticked`, async () => {
      const r = await new Client(srv.url).post('/signup', newUserData({ consent: { ...ALL_CONSENT, [missing]: false } }));
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'CONSENT_REQUIRED');
    });
  }

  test('does not create the account when refused', async () => {
    const d = newUserData({ consent: {} });
    await new Client(srv.url).post('/signup', d);
    const { rows } = await srv.db.query('SELECT 1 FROM users WHERE username = $1', [d.username]);
    assert.equal(rows.length, 0);
  });

  test('records the version and every choice', async () => {
    const d = newUserData({ consent: { ...ALL_CONSENT, deals: true, notify: false } });
    const r = await new Client(srv.url).post('/signup', d);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.consent.accepted, true);
    const { rows } = await srv.db.query(
      'SELECT c.version, c.choices, u.consent_version FROM user_consents c JOIN users u ON u.id = c.user_id WHERE u.username = $1', [d.username]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, r.body.user.consent.version);
    assert.equal(rows[0].consent_version, r.body.user.consent.version);
    assert.deepEqual(rows[0].choices, { ...ALL_CONSENT, deals: true, notify: false });
  });

  test('"deals" turns on partner promos; leaving it unticked keeps them off', async () => {
    const yes = await new Client(srv.url).post('/signup', newUserData({ consent: { ...ALL_CONSENT, deals: true } }));
    const no = await new Client(srv.url).post('/signup', newUserData());
    assert.equal(yes.body.user.promoOptIn, true);
    assert.equal(no.body.user.promoOptIn, false);
  });

  test('ignores truthy-looking values that are not an explicit tick', async () => {
    const r = await new Client(srv.url).post('/signup', newUserData({ consent: { age: 1, terms: 'yes', idCheck: true, location: true } }));
    assert.equal(r.status, 400);
  });
});

describe('re-accepting', () => {
  test('an account without the current consent is flagged and can accept it', async () => {
    const { c, user } = await basicUser(srv.url);
    await srv.db.query('UPDATE users SET consent_version = NULL WHERE id = $1', [user.id]);
    assert.equal((await c.get('/me')).body.consent.accepted, false);

    assert.equal((await c.post('/consent', { consent: { age: true } })).status, 400);
    const r = await c.post('/consent', { consent: { ...ALL_CONSENT, notify: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.consent.accepted, true);

    const { rows } = await srv.db.query('SELECT choices FROM user_consents WHERE user_id = $1', [user.id]);
    assert.equal(rows.length, 1, 'same version is updated, not duplicated');
    assert.equal(rows[0].choices.notify, true);
    const audit = await srv.db.query(`SELECT 1 FROM audit WHERE uid = $1 AND action = 'consent'`, [user.id]);
    assert.equal(audit.rows.length, 1);
  });

  test('needs a login', async () => {
    assert.equal((await new Client(srv.url).post('/consent', { consent: ALL_CONSENT })).status, 401);
  });
});

test('the full text is served at /consent.html', async () => {
  const res = await fetch(srv.url + '/consent.html');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Data Protection Act/);
});

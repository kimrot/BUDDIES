// Feed, swiping, matching, chat, drink offers, and safety (reports, bans, unmatch).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, basicUser, fullUser, adminUser, goOut, PASSWORD, NAIROBI, NEARBY } = require('./helpers');

let srv, admin;
before(async () => { srv = await startServer({ FREE_LIKES_PER_DAY: '3' }); admin = (await adminUser(srv.url)).c; });
after(async () => { await srv?.stop(); });

// Two fully verified people, both out ~1 km apart.
async function pair() {
  const a = await fullUser(srv.url, admin);
  const b = await fullUser(srv.url, admin);
  assert.equal((await goOut(a.c, NAIROBI)).status, 200);
  assert.equal((await goOut(b.c, NEARBY)).status, 200);
  return [a, b];
}
const feedIds = async (c) => (await c.get('/feed')).body.map((p) => p.id);

async function matched() {
  const [a, b] = await pair();
  await a.c.post('/swipe', { targetId: b.user.id, dir: 'like' });
  const r = await b.c.post('/swipe', { targetId: a.user.id, dir: 'like' });
  return { a, b, matchId: r.body.match.id };
}

describe('feed', () => {
  test('needs an "out" status', async () => {
    const a = await fullUser(srv.url, admin);
    const r = await a.c.get('/feed');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NOT_OUT');
  });

  test('shows verified people nearby, with a rounded distance and no private details', async () => {
    const [a, b] = await pair();
    const person = (await a.c.get('/feed')).body.find((p) => p.id === b.user.id);
    assert.ok(person, 'b is in a\'s feed');
    assert.equal(person.distanceKm, 1);
    for (const k of ['phone', 'email', 'dob', 'lat', 'lng', 'status']) assert.equal(person[k], undefined, `${k} must not leak`);
  });

  test('hides people who are not fully verified', async () => {
    const [a] = await pair();
    const half = await basicUser(srv.url);
    await goOut(half.c, NEARBY);
    assert.ok(!(await feedIds(a.c)).includes(half.user.id));
  });

  test('hides people outside the radius', async () => {
    const [a] = await pair();
    const far = await fullUser(srv.url, admin);
    await goOut(far.c, { lat: -0.0917, lng: 34.768 }); // Kisumu, ~265 km away
    assert.ok(!(await feedIds(a.c)).includes(far.user.id));
  });

  test('hides people you already swiped on', async () => {
    const [a, b] = await pair();
    await a.c.post('/swipe', { targetId: b.user.id, dir: 'pass' });
    assert.ok(!(await feedIds(a.c)).includes(b.user.id));
  });

  test('hides people who stopped being out', async () => {
    const [a, b] = await pair();
    await b.c.del('/me/status');
    assert.ok(!(await feedIds(a.c)).includes(b.user.id));
  });
});

describe('swiping and matching', () => {
  test('a one-sided like is not a match', async () => {
    const [a, b] = await pair();
    const r = await a.c.post('/swipe', { targetId: b.user.id, dir: 'like' });
    assert.equal(r.status, 200);
    assert.equal(r.body.match, null);
    assert.equal((await a.c.get('/matches')).body.length, 0);
  });

  test('mutual likes make exactly one match, visible to both', async () => {
    const { a, b, matchId } = await matched();
    assert.ok(matchId);
    assert.deepEqual((await a.c.get('/matches')).body.map((m) => m.id), [matchId]);
    assert.deepEqual((await b.c.get('/matches')).body.map((m) => m.id), [matchId]);
    // Liking again doesn't create a second match.
    await a.c.post('/swipe', { targetId: b.user.id, dir: 'like' });
    const { rows } = await srv.db.query('SELECT count(*)::int AS n FROM matches WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)', [a.user.id, b.user.id]);
    assert.equal(rows[0].n, 1);
  });

  test('a like then a pass is not a match', async () => {
    const [a, b] = await pair();
    await a.c.post('/swipe', { targetId: b.user.id, dir: 'like' });
    const r = await b.c.post('/swipe', { targetId: a.user.id, dir: 'pass' });
    assert.equal(r.body.match, null);
  });

  test('you can\'t swipe on yourself or on unknown users', async () => {
    const [a] = await pair();
    assert.equal((await a.c.post('/swipe', { targetId: a.user.id, dir: 'like' })).status, 404);
    assert.equal((await a.c.post('/swipe', { targetId: 'nope', dir: 'like' })).status, 404);
  });

  test('free accounts get a limited number of likes a day', async () => {
    const a = await fullUser(srv.url, admin);
    await goOut(a.c);
    const targets = [];
    for (let i = 0; i < 4; i++) targets.push(await fullUser(srv.url, admin));
    for (let i = 0; i < 3; i++) assert.equal((await a.c.post('/swipe', { targetId: targets[i].user.id, dir: 'like' })).status, 200);
    const over = await a.c.post('/swipe', { targetId: targets[3].user.id, dir: 'like' });
    assert.equal(over.status, 403);
    assert.equal(over.body.code, 'LIKE_LIMIT');
    assert.equal((await a.c.post('/swipe', { targetId: targets[3].user.id, dir: 'pass' })).status, 200, 'passes are unlimited');
  });

  test('free accounts see how many liked them, but not who', async () => {
    const [a, b] = await pair();
    await b.c.post('/swipe', { targetId: a.user.id, dir: 'like' });
    const r = await a.c.get('/likes');
    assert.equal(r.body.count, 1);
    assert.deepEqual(r.body.people, []);
  });
});

describe('chat and drink offers', () => {
  test('matched people can message each other; others can\'t read or write', async () => {
    const { a, b, matchId } = await matched();
    assert.equal((await a.c.post(`/matches/${matchId}/messages`, { text: 'Cheers!' })).status, 200);
    const seen = await b.c.get(`/matches/${matchId}`);
    assert.deepEqual(seen.body.messages.map((m) => m.text), ['Cheers!']);

    const stranger = await fullUser(srv.url, admin);
    assert.equal((await stranger.c.get(`/matches/${matchId}`)).status, 404);
    assert.equal((await stranger.c.post(`/matches/${matchId}/messages`, { text: 'hi' })).status, 404);
    assert.equal((await a.c.post(`/matches/${matchId}/messages`, { text: '   ' })).status, 400);
  });

  test('a drink offer can be answered once, and only by the other person', async () => {
    const { a, b, matchId } = await matched();
    const offer = await a.c.post(`/matches/${matchId}/drinks`, { drink: 'Tusker', note: 'On me' });
    assert.equal(offer.status, 200);
    assert.equal((await a.c.post(`/matches/${matchId}/drinks`, { drink: 'Guinness' })).status, 409, 'one pending offer at a time');
    assert.equal((await a.c.post(`/matches/${matchId}/drinks/${offer.body.id}`, { action: 'accept' })).status, 403);
    const ok = await b.c.post(`/matches/${matchId}/drinks/${offer.body.id}`, { action: 'accept' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.state, 'accepted');
    assert.equal((await b.c.post(`/matches/${matchId}/drinks/${offer.body.id}`, { action: 'decline' })).status, 409);
  });

  test('unmatching ends the chat and keeps them out of each other\'s feed', async () => {
    const { a, b, matchId } = await matched();
    assert.equal((await a.c.del(`/matches/${matchId}`)).status, 200);
    assert.equal((await b.c.get(`/matches/${matchId}`)).status, 404);
    assert.equal((await b.c.post(`/matches/${matchId}/messages`, { text: 'hello?' })).status, 404);
    await srv.db.query('DELETE FROM swipes WHERE from_id IN ($1, $2)', [a.user.id, b.user.id]);
    assert.ok(!(await feedIds(b.c)).includes(a.user.id));
  });
});

describe('reports and bans', () => {
  test('3 reports from different people hide someone until an admin clears them', async () => {
    const [a, target] = await pair();
    const reporter = await basicUser(srv.url);
    assert.ok((await feedIds(a.c)).includes(target.user.id));

    // The same person reporting twice counts once.
    await reporter.c.post('/report', { userId: target.user.id, reason: 'rude' });
    await reporter.c.post('/report', { userId: target.user.id, reason: 'rude again' });
    await (await basicUser(srv.url)).c.post('/report', { userId: target.user.id, reason: 'spam' });
    assert.ok((await feedIds(a.c)).includes(target.user.id), 'still visible with 2 reporters');

    await (await basicUser(srv.url)).c.post('/report', { userId: target.user.id, reason: 'fake' });
    assert.ok(!(await feedIds(a.c)).includes(target.user.id), 'hidden after 3 reporters');
    const reports = await admin.get('/admin/reports');
    assert.ok(reports.body.some((r) => r.user.id === target.user.id));

    assert.equal((await admin.post(`/admin/users/${target.user.id}/clear`)).status, 200);
    assert.ok((await feedIds(a.c)).includes(target.user.id), 'visible again after review');
  });

  test('you can\'t report yourself', async () => {
    const { c, user } = await basicUser(srv.url);
    assert.equal((await c.post('/report', { userId: user.id })).status, 404);
  });

  test('a ban needs a reason, logs the user out everywhere, and blocks login', async () => {
    const { a, b, matchId } = await matched();
    assert.equal((await admin.post(`/admin/users/${b.user.id}/ban`)).status, 400);
    assert.equal((await admin.post(`/admin/users/${b.user.id}/ban`, { reason: 'Harassment' })).status, 200);
    assert.equal((await b.c.get('/me')).status, 401);
    const login = await new Client(srv.url).post('/login', { username: b.data.username, password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.body.code, 'BANNED');
    assert.ok(!(await feedIds(a.c)).includes(b.user.id));
    assert.equal((await a.c.get(`/matches/${matchId}`)).status, 404, 'chat with a banned user is closed');
  });

  test('admin actions are admin-only and logged', async () => {
    const { c, user } = await basicUser(srv.url);
    const other = await basicUser(srv.url);
    assert.equal((await c.post(`/admin/users/${other.user.id}/ban`, { reason: 'x' })).status, 403);
    assert.equal((await admin.post(`/admin/users/${user.id}/ban`, { reason: 'Spam' })).status, 200);
    const log = await admin.get('/admin/audit');
    assert.ok(log.body.some((e) => e.action === 'admin_ban' && e.meta?.user === user.id));
  });
});

describe('account deletion', () => {
  test('needs the password, then removes the user and their data', async () => {
    const { a, b, matchId } = await matched();
    await a.c.post(`/matches/${matchId}/messages`, { text: 'bye' });
    assert.equal((await a.c.del('/me', { password: 'Not-The-Password-1' })).status, 400);
    assert.equal((await a.c.del('/me', { password: PASSWORD })).status, 200);
    const { rows } = await srv.db.query('SELECT (SELECT count(*) FROM users WHERE id = $1)::int AS u, (SELECT count(*) FROM messages WHERE from_id = $1)::int AS m, (SELECT count(*) FROM user_consents WHERE user_id = $1)::int AS c', [a.user.id]);
    assert.deepEqual(rows[0], { u: 0, m: 0, c: 0 });
    assert.equal((await b.c.get(`/matches/${matchId}`)).status, 404);
  });
});

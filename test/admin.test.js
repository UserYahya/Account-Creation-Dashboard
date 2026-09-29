const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, eventInput } = require('./helpers/harness');

async function withEvent(env) {
  const t = await startApp(env);
  const admin = t.client();
  await admin.oauthLogin();
  const created = await admin.post('/api/admin/events', eventInput());
  assert.equal(created.status, 200, created.text);
  return { ...t, admin, eventId: created.data.id };
}

async function submit(t, username, email = `${username.replace(/\s/g, '').toLowerCase()}@example.com`) {
  const student = t.client();
  await student.get('/');
  const res = await student.post(`/api/events/${t.eventId}/register`, { email, email_confirm: email, username, consent: true });
  assert.equal(res.status, 200, res.text);
  return t.db.prepare('SELECT * FROM requests WHERE status_token = ?').get(res.data.token);
}

test('OAuth login checks the state parameter and the user groups', async () => {
  const t = await startApp();
  try {
    const visitor = t.client();
    await visitor.get('/');
    const start = await visitor.get('/login');
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get('location'));
    assert.ok(authorize.searchParams.get('state'), 'state is sent to Wikimedia');

    const forged = await visitor.get('/auth/callback?code=good-code&state=forged');
    assert.equal(forged.status, 400, 'a callback with the wrong state is refused');

    const admin = t.client();
    await admin.oauthLogin();
    const home = await admin.get('/admin');
    assert.equal(home.status, 200);
    assert.match(home.text, /Admin User/);

    // A user without an allowed group ends up on the explanation page
    t.wiki.state.oauth.username = 'Existing User';
    const other = t.client();
    await other.get('/');
    const s = new URL((await other.get('/login')).headers.get('location')).searchParams.get('state');
    const denied = await other.get(`/auth/callback?code=good-code&state=${s}`);
    assert.equal(denied.headers.get('location'), '/login-error');
    const page = await other.get('/login-error');
    assert.match(page.text, /Existing User/);
    assert.equal((await other.get('/api/admin/events')).status, 401);
  } finally {
    await t.stop();
  }
});

test('mock login is off unless enabled, and never works in production', async () => {
  const t = await startApp();
  try {
    const c = t.client();
    await c.get('/');
    const res = await c.get('/login?user=Dev%20User');
    assert.match(res.headers.get('location'), /\/oauth2\/authorize/, 'goes to OAuth instead of logging in');
  } finally {
    await t.stop();
  }
  const { loadConfig } = require('../src/config');
  const config = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), ENABLE_MOCK_LOGIN: 'true' });
  assert.equal(config.mockLogin, false);
  assert.equal(config.mockLoginIgnored, true);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' }), /SESSION_SECRET/);
});

test('approving creates the account, posts a welcome and adds the participant', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'Fresh Student');
    const res = await t.admin.post(`/api/admin/requests/${request.id}/approve`, { reason: 'Workshop day 1' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.wiki, 'bn.wikipedia.org');
    assert.equal(res.data.welcome, 'posted');

    const created = t.wiki.state.created[0];
    assert.equal(created.username, 'Fresh Student');
    assert.equal(created.email, 'freshstudent@example.com');
    assert.equal(created.mailpassword, '1');
    assert.match(created.reason, /Test Editathon-এর অংশগ্রহণকারীর জন্য/, 'log summary names the request\'s own event');
    assert.match(created.reason, /Workshop day 1/);

    const row = t.db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.created_on_wiki, 'bn.wikipedia.org');
    const participant = t.db.prepare('SELECT * FROM participants WHERE event_id = ? AND username = ?').get(t.eventId, 'Fresh Student');
    assert.equal(participant.source, 'account');

    const again = await t.admin.post(`/api/admin/requests/${request.id}/approve`, {});
    assert.equal(again.status, 409, 'an approved request cannot be approved twice');
    const decline = await t.admin.post(`/api/admin/requests/${request.id}/decline`, {});
    assert.equal(decline.status, 409, 'an approved request cannot be declined afterwards');
  } finally {
    await t.stop();
  }
});

test('two admins approving at the same moment create the account only once', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'Race Student');
    const second = t.client();
    await second.oauthLogin();
    const [a, b] = await Promise.all([
      t.admin.post(`/api/admin/requests/${request.id}/approve`, {}),
      second.post(`/api/admin/requests/${request.id}/approve`, {})
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(t.wiki.state.created.length, 1);
  } finally {
    await t.stop();
  }
});

test('a failed creation returns the request to the queue with a readable error', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'Throttled Student');
    t.wiki.state.createFail = { status: 'FAIL', messagecode: 'acct_creation_throttle_hit', message: 'throttled' };
    const res = await t.admin.post(`/api/admin/requests/${request.id}/approve`, {});
    assert.equal(res.data.success, false);
    assert.match(res.data.error, /সীমা অতিক্রম/);
    const row = t.db.prepare('SELECT status, error_message FROM requests WHERE id = ?').get(request.id);
    assert.equal(row.status, 'pending');
    assert.match(row.error_message, /সীমা অতিক্রম/);

    t.wiki.state.createFail = null;
    const retry = await t.admin.post(`/api/admin/requests/${request.id}/approve`, {});
    assert.equal(retry.status, 200);
  } finally {
    await t.stop();
  }
});

test('an account created earlier by the same admin is recovered instead of failing', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'Lost Student');
    // The account exists on the wiki (created by this admin) but the tool never recorded it
    t.wiki.state.users.add('Lost Student');
    t.wiki.state.logevents.push({ wiki: 'bn.wikipedia.org', title: 'User:Lost Student', user: 'Admin User', type: 'newusers' });
    const res = await t.admin.post(`/api/admin/requests/${request.id}/approve`, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.recovered, true);

    const other = await submit(t, 'Taken Student');
    t.wiki.state.users.add('Taken Student');
    const taken = await t.admin.post(`/api/admin/requests/${other.id}/approve`, {});
    assert.equal(taken.data.success, false);
    assert.match(taken.data.error, /অন্য কেউ নিয়ে নিয়েছেন/);
  } finally {
    await t.stop();
  }
});

test('expired OAuth tokens are refreshed before creating accounts', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'Refresh Student');
    // Pretend the token is about to expire
    const sessions = t.db.prepare('SELECT sid, sess FROM sessions').all();
    for (const row of sessions) {
      const sess = JSON.parse(row.sess);
      if (sess.isAdmin) {
        sess.tokenExpiresAt = Date.now() + 10 * 1000;
        t.db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), row.sid);
      }
    }
    const res = await t.admin.post(`/api/admin/requests/${request.id}/approve`, {});
    assert.equal(res.status, 200, res.text);
    assert.match(t.wiki.state.oauth.accessToken, /refreshed$/);
  } finally {
    await t.stop();
  }
});

test('the welcome message never overwrites an existing talk page', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'Talky Student');
    t.wiki.state.pages.add('bn.wikipedia.org|User talk:Talky Student');
    const res = await t.admin.post(`/api/admin/requests/${request.id}/approve`, {});
    assert.equal(res.data.welcome, 'exists');
  } finally {
    await t.stop();
  }
});

test('an admin whose Wikimedia token stopped working can log in again', async () => {
  const t = await withEvent();
  try {
    const plain = await t.admin.get('/login');
    assert.equal(plain.headers.get('location'), '/admin');
    const again = await t.admin.get('/login?reauth=1');
    assert.match(again.headers.get('location'), /\/oauth2\/authorize/, 'reauth starts OAuth even with an admin session');
  } finally {
    await t.stop();
  }
});

test('a rename loses to an approval that happened meanwhile', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'Slow Rename');
    t.wiki.state.delayMs = 150;
    const rename = t.admin.patch(`/api/admin/requests/${request.id}`, { username: 'Other Name' });
    await new Promise(resolve => setTimeout(resolve, 50));
    t.db.prepare("UPDATE requests SET status = 'approved' WHERE id = ?").run(request.id);
    const res = await rename;
    assert.equal(res.status, 409);
    assert.equal(t.db.prepare('SELECT username FROM requests WHERE id = ?').get(request.id).username, 'Slow Rename');
  } finally {
    await t.stop();
  }
});

test('admins can rename a pending request after re-checking the name', async () => {
  const t = await withEvent();
  try {
    const request = await submit(t, 'First Choice');
    let res = await t.admin.patch(`/api/admin/requests/${request.id}`, { username: 'Existing User' });
    assert.equal(res.status, 400);
    res = await t.admin.patch(`/api/admin/requests/${request.id}`, { username: 'second_choice' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.username, 'Second choice');
  } finally {
    await t.stop();
  }
});

test('only developers see emails and may delete events', async () => {
  const t = await withEvent();
  try {
    await submit(t, 'Private Student', 'private@example.com');
    const list = await t.admin.get(`/api/admin/events/${t.eventId}/requests`);
    assert.equal(list.data.showEmail, false);
    assert.equal(list.data.requests[0].email, undefined);
    assert.equal(list.data.requests[0].status_token, undefined, 'status tokens are not shown to admins');
    assert.equal((await t.admin.get('/api/admin/download-log')).status, 403);
    assert.equal((await t.admin.delete(`/api/admin/events/${t.eventId}`)).status, 403);

    const csv = await t.admin.get(`/api/admin/events/${t.eventId}/requests.csv`);
    assert.ok(!csv.text.includes('private@example.com'), 'CSV for admins has no emails');
  } finally {
    await t.stop();
  }

  const t2 = await startApp({ ENABLE_MOCK_LOGIN: 'true' });
  try {
    const dev = t2.client();
    await dev.mockLogin('Dev User');
    const created = await dev.post('/api/admin/events', eventInput());
    const student = t2.client();
    await student.get('/');
    await student.post(`/api/events/${created.data.id}/register`, { email: 'private@example.com', email_confirm: 'private@example.com', username: 'Private Student', consent: true });
    const list = await dev.get(`/api/admin/events/${created.data.id}/requests`);
    assert.equal(list.data.requests[0].email, 'private@example.com');
    const log = await dev.get('/api/admin/download-log');
    assert.equal(log.status, 200);
    assert.match(log.text, /private@example.com/);
    const del = await dev.delete(`/api/admin/events/${created.data.id}`);
    assert.equal(del.status, 200);
    assert.equal(t2.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0, 'requests are deleted with the event');
    const audit = t2.db.prepare("SELECT action FROM audit_log WHERE action = 'event.delete'").all();
    assert.equal(audit.length, 1);
  } finally {
    await t2.stop();
  }
});

test('CSV exports neutralise spreadsheet formulas', async () => {
  const { escapeCSV } = require('../src/validation');
  assert.equal(escapeCSV('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(escapeCSV('+1'), "'+1");
  assert.equal(escapeCSV('normal, text'), '"normal, text"');
});

test('participants: validated mass add, exclusion that sticks, restore', async () => {
  const t = await withEvent();
  try {
    const res = await t.admin.post(`/api/admin/events/${t.eventId}/participants`, {
      usernames: 'Active Editor\nquiet Editor\nNobody Here\nbad<name\nGlobal Only\nActive Editor'
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.data.added.sort(), ['Active Editor', 'Global Only', 'Quiet Editor']);
    assert.deepEqual(res.data.notFound, ['Nobody Here']);
    assert.deepEqual(res.data.invalid, ['Bad<name']);

    // Participants created through the tool can be excluded and stay excluded
    const request = await submit(t, 'Leaving Student');
    await t.admin.post(`/api/admin/requests/${request.id}/approve`, {});
    let list = await t.admin.get(`/api/admin/events/${t.eventId}/participants`);
    const leaving = list.data.participants.find(p => p.username === 'Leaving Student');
    await t.admin.post(`/api/admin/participants/${leaving.id}/exclude`);
    list = await t.admin.get(`/api/admin/events/${t.eventId}/participants`);
    assert.equal(list.data.participants.find(p => p.username === 'Leaving Student').excluded, true, 'still excluded after reload');
    const stats = await t.client().get(`/api/events/${t.eventId}/stats`);
    assert.ok(!stats.data.leaderboard.some(r => r.username === 'Leaving Student'));

    await t.admin.post(`/api/admin/participants/${leaving.id}/restore`);
    list = await t.admin.get(`/api/admin/events/${t.eventId}/participants`);
    assert.equal(list.data.participants.find(p => p.username === 'Leaving Student').excluded, false);
  } finally {
    await t.stop();
  }
});

test('event form is validated on the server', async () => {
  const t = await withEvent();
  try {
    let res = await t.admin.post('/api/admin/events', eventInput({ name: 'Second', target_wikis: 'evil.example.com' }));
    assert.equal(res.status, 400);
    assert.match(res.data.error, /evil\.example\.com/);
    res = await t.admin.post('/api/admin/events', eventInput({ name: 'Third', start_time: '2026-05-02T10:00', end_time: '2026-05-01T10:00' }));
    assert.equal(res.status, 400);
    res = await t.admin.post('/api/admin/events', eventInput());
    assert.equal(res.status, 400, 'duplicate event names are refused');
    res = await t.admin.post('/api/admin/events', eventInput({ name: 'Fourth', workshop_url: 'javascript:alert(1)' }));
    assert.equal(res.status, 400);
    res = await t.admin.post('/api/admin/events', eventInput({ name: 'Fifth', account_wiki: 'en.wikipedia.org' }));
    assert.equal(res.status, 400, 'account wiki must be one of the admin wikis');

    // Times are entered in Bangladesh time and stored in UTC
    res = await t.admin.post('/api/admin/events', eventInput({ name: 'Timed', start_time: '2026-06-18T10:00', end_time: '2026-06-18T18:00' }));
    const event = t.db.prepare('SELECT start_time, end_time FROM events WHERE id = ?').get(res.data.id);
    assert.equal(event.start_time, '2026-06-18T04:00:00.000Z');
    assert.equal(event.end_time, '2026-06-18T12:00:00.000Z');
  } finally {
    await t.stop();
  }
});

test('admin pages render for a logged-in admin', async () => {
  const t = await withEvent();
  try {
    for (const path of ['/admin', '/admin/events/new', `/admin/events/${t.eventId}`, '/admin/settings']) {
      const res = await t.admin.get(path);
      assert.equal(res.status, 200, `${path}: ${res.text.slice(0, 200)}`);
    }
    assert.equal((await t.admin.get('/admin/audit')).status, 403, 'audit log is for developers');
    const anonymous = t.client();
    assert.equal((await anonymous.get('/admin')).headers.get('location'), '/login');
  } finally {
    await t.stop();
  }
});

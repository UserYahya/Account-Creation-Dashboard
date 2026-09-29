const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, eventInput } = require('./helpers/harness');

async function setup(env) {
  const t = await startApp({ ENABLE_MOCK_LOGIN: 'true', ...env });
  const admin = t.client();
  await admin.mockLogin('Admin User');
  const created = await admin.post('/api/admin/events', eventInput());
  assert.equal(created.status, 200, created.text);
  return { ...t, admin, eventId: created.data.id };
}

function registration(overrides = {}) {
  return { email: 'student@example.com', email_confirm: 'student@example.com', username: 'new_student one', consent: true, ...overrides };
}

test('a student can register and follow the status of the request', async () => {
  const t = await setup();
  try {
    const student = t.client();
    const page = await student.get('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /উইকিপিডিয়া অ্যাকাউন্টের আবেদন/, 'single open event shows the form on the home page');

    const res = await student.post(`/api/events/${t.eventId}/register`, registration());
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.username, 'New student one', 'username is normalised like MediaWiki');
    assert.match(res.data.statusUrl, /^\/status\/[\w-]{20,}$/);

    const status = await student.get(`/api/status/${res.data.token}`);
    assert.equal(status.data.request.status, 'pending');
    assert.equal(status.data.request.masked_email, 'st*****@example.com');
    assert.equal(status.data.request.email, undefined, 'full email is never exposed');

    const statusPage = await student.get(res.data.statusUrl);
    assert.equal(statusPage.status, 200);
    assert.match(statusPage.text, /New student one/);
  } finally {
    await t.stop();
  }
});

test('registration validates input on the server', async () => {
  const t = await setup({ RATE_REGISTER_PER_SESSION: '50' });
  try {
    const student = t.client();
    await student.get('/');
    const url = `/api/events/${t.eventId}/register`;

    let res = await student.post(url, registration({ email: '<img src=x onerror=alert(1)>', email_confirm: '<img src=x onerror=alert(1)>' }));
    assert.equal(res.status, 400);
    assert.equal(res.data.field, 'email');

    res = await student.post(url, registration({ email_confirm: 'other@example.com' }));
    assert.equal(res.data.field, 'email_confirm');

    res = await student.post(url, registration({ consent: false }));
    assert.equal(res.data.field, 'consent');

    res = await student.post(url, registration({ username: 'a<b>c' }));
    assert.equal(res.data.field, 'username');

    res = await student.post(url, registration({ username: 'Existing User' }));
    assert.equal(res.status, 400);
    assert.match(res.data.error, /ইতিমধ্যে নেওয়া/);

    res = await student.post(url, registration({ username: 'Existing Usr' }));
    assert.match(res.data.error, /AntiSpoof/);

    res = await student.post(url, registration({ username: 'My Wikipedia Name' }));
    assert.match(res.data.error, /নিষিদ্ধ/, 'title blacklist is checked');
  } finally {
    await t.stop();
  }
});

test('duplicate names and emails are refused, and a declined student can re-apply', async () => {
  const t = await setup();
  try {
    const a = t.client();
    await a.get('/');
    const first = await a.post(`/api/events/${t.eventId}/register`, registration());
    assert.equal(first.status, 200);

    const b = t.client();
    await b.get('/');
    let res = await b.post(`/api/events/${t.eventId}/register`, registration({ email: 'x@example.com', email_confirm: 'x@example.com', username: 'New student one' }));
    assert.equal(res.status, 400, 'same username is taken by the pending request');

    res = await b.post(`/api/events/${t.eventId}/register`, registration({ username: 'Another Name', email: 'STUDENT@example.com', email_confirm: 'student@example.com' }));
    assert.equal(res.status, 400, 'same email already pending in this event');
    assert.equal(res.data.field, 'email');

    const requests = await t.admin.get(`/api/admin/events/${t.eventId}/requests`);
    const id = requests.data.requests[0].id;
    await t.admin.post(`/api/admin/requests/${id}/decline`, { reason: 'Please choose a personal name' });

    res = await b.post(`/api/events/${t.eventId}/register`, registration({ email: 'x@example.com', email_confirm: 'x@example.com', username: 'New student one' }));
    assert.equal(res.status, 200, 'the name is free again after the decline');

    const status = await a.get(`/api/status/${first.data.token}`);
    assert.equal(status.data.request.status, 'declined');
    assert.equal(status.data.request.decision_reason, 'Please choose a personal name');
  } finally {
    await t.stop();
  }
});

test('the honeypot silently drops bot submissions', async () => {
  const t = await setup();
  try {
    const bot = t.client();
    await bot.get('/');
    const res = await bot.post(`/api/events/${t.eventId}/register`, registration({ website: 'http://spam.example' }));
    assert.equal(res.status, 200);
    assert.equal(res.data.token, undefined);
    const count = t.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
    assert.equal(count, 0);
  } finally {
    await t.stop();
  }
});

test('requests without the CSRF token are rejected', async () => {
  const t = await setup();
  try {
    const student = t.client();
    await student.get('/');
    const res = await student.request(`/api/events/${t.eventId}/register`, { method: 'POST', body: registration(), headers: { 'X-CSRF-Token': 'wrong' } });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'csrf');
  } finally {
    await t.stop();
  }
});

test('rate limits apply per browser session, so a classroom on one IP is not blocked', async () => {
  const t = await setup({ RATE_REGISTER_PER_SESSION: '2', RATE_REGISTER_PER_IP: '50' });
  try {
    const first = t.client();
    await first.get('/');
    for (let i = 0; i < 2; i++) {
      await first.post(`/api/events/${t.eventId}/register`, registration({ username: `Student ${i}`, email: `s${i}@example.com`, email_confirm: `s${i}@example.com` }));
    }
    const blocked = await first.post(`/api/events/${t.eventId}/register`, registration({ username: 'Student 9', email: 's9@example.com', email_confirm: 's9@example.com' }));
    assert.equal(blocked.status, 429);
    assert.ok(blocked.data.error, 'the 429 response carries a readable message');
    assert.ok(blocked.headers.get('retry-after'));

    // Other students in the same room (same IP) can still register
    for (let i = 10; i < 15; i++) {
      const student = t.client();
      await student.get('/');
      const res = await student.post(`/api/events/${t.eventId}/register`, registration({ username: `Student ${i}`, email: `s${i}@example.com`, email_confirm: `s${i}@example.com` }));
      assert.equal(res.status, 200, res.text);
    }
  } finally {
    await t.stop();
  }
});

test('live username check explains problems and suggests free names', async () => {
  const t = await setup();
  try {
    const student = t.client();
    await student.get('/');
    let res = await student.get('/api/check-username?username=brand%20new%20person');
    assert.equal(res.data.valid, true);
    assert.equal(res.data.normalized, 'Brand new person');

    res = await student.get('/api/check-username?username=Existing%20User');
    assert.equal(res.data.valid, false);
    assert.ok(Array.isArray(res.data.suggestions) && res.data.suggestions.length > 0, 'suggestions offered');
    assert.ok(res.data.suggestions.every(s => s.startsWith('Existing User')));

    res = await student.get('/api/check-username?username=ab');
    assert.equal(res.status, 400);

    t.wiki.state.down = true;
    res = await student.get('/api/check-username?username=Someone%20Else');
    assert.equal(res.status, 502);
    assert.ok(res.data.reason, 'wiki outage is reported, not shown as "undefined"');
  } finally {
    await t.stop();
  }
});

test('closed, upcoming and paused events do not accept registrations', async () => {
  const t = await setup();
  try {
    await t.admin.post(`/api/admin/events/${t.eventId}/registration`, { active: false });
    const student = t.client();
    const page = await student.get(`/event/${t.eventId}`);
    assert.match(page.text, /সাময়িকভাবে বন্ধ/);
    const res = await student.post(`/api/events/${t.eventId}/register`, registration());
    assert.equal(res.status, 403);

    const upcoming = await t.admin.post('/api/admin/events', eventInput({
      name: 'Later event',
      start_time: '2099-01-01T10:00',
      end_time: '2099-01-02T10:00'
    }));
    const upcomingPage = await student.get(`/event/${upcoming.data.id}`);
    assert.match(upcomingPage.text, /এখনো শুরু হয়নি/);
  } finally {
    await t.stop();
  }
});

test('existing Wikipedians can join an event themselves', async () => {
  const t = await setup();
  try {
    const student = t.client();
    await student.get('/');
    let res = await student.post(`/api/events/${t.eventId}/join`, { username: 'active_Editor' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.username, 'Active Editor');

    res = await student.post(`/api/events/${t.eventId}/join`, { username: 'Global Only' });
    assert.equal(res.status, 200, 'global accounts that never visited the wiki are accepted');

    res = await student.post(`/api/events/${t.eventId}/join`, { username: 'Nobody Here' });
    assert.equal(res.status, 400);

    res = await student.post(`/api/events/${t.eventId}/join`, { username: 'Active Editor' });
    assert.equal(res.data.already, true);

    const rows = t.db.prepare('SELECT username, source FROM participants WHERE event_id = ? ORDER BY username').all(t.eventId);
    assert.deepEqual(rows, [{ username: 'Active Editor', source: 'self' }, { username: 'Global Only', source: 'self' }]);
  } finally {
    await t.stop();
  }
});

test('event names and usernames are escaped in rendered pages', async () => {
  const t = await setup();
  try {
    await t.admin.put(`/api/admin/events/${t.eventId}`, eventInput({ name: 'Edit <script>alert(1)</script> "a"' }));
    const student = t.client();
    for (const path of ['/', `/event/${t.eventId}`, `/event/${t.eventId}/stats`, '/events', `/event/${t.eventId}/display`]) {
      const res = await student.get(path);
      assert.equal(res.status, 200, path);
      assert.ok(!res.text.includes('<script>alert(1)</script>'), `${path} escapes the event name`);
      assert.ok(res.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), `${path} shows the escaped name`);
    }
  } finally {
    await t.stop();
  }
});

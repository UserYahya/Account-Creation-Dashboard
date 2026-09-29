const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, eventInput } = require('./helpers/harness');

test('pages send a strict Content-Security-Policy and other security headers', async () => {
  const t = await startApp();
  try {
    const res = await t.client().get('/');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes('unsafe-inline'), 'no inline scripts or styles allowed');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(!/<script>(?!\s*<\/script>)/.test(res.text) && !/\son(click|load|error)=/i.test(res.text), 'no inline script handlers in the HTML');
  } finally {
    await t.stop();
  }
});

test('in production behind a proxy the session cookie is secure and forms work', async () => {
  const t = await startApp({ NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(32), ENABLE_MOCK_LOGIN: 'true' });
  try {
    assert.equal(t.config.mockLogin, false);
    const client = t.client();
    const page = await client.get('/', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' } });
    const cookies = typeof page.headers.getSetCookie === 'function' ? page.headers.getSetCookie() : [page.headers.get('set-cookie')];
    const cookie = cookies.find(c => c && c.startsWith('acd.sid='));
    assert.ok(cookie, 'session cookie is sent behind the TLS proxy');
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(page.headers.get('strict-transport-security'), /max-age/);

    // A POST with the token from the page passes the CSRF check
    const res = await client.request('/api/events/999/register', {
      method: 'POST',
      headers: { 'X-Forwarded-Proto': 'https' },
      body: { email: 'a@example.com', email_confirm: 'a@example.com', username: 'Someone', consent: true }
    });
    assert.equal(res.status, 404, 'reaches the handler (404 for the unknown event), not a CSRF 403');
  } finally {
    await t.stop();
  }
});

test('emails are deleted after the retention period', async () => {
  const t = await startApp({ ENABLE_MOCK_LOGIN: 'true', EMAIL_RETENTION_DAYS: '90' });
  try {
    const admin = t.client();
    await admin.mockLogin();
    const { data } = await admin.post('/api/admin/events', eventInput());
    const insert = t.db.prepare("INSERT INTO requests (event_id, username, email, status, status_token, requested_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    insert.run(data.id, 'Old Approved', 'old@example.com', 'approved', 'tok-a-aaaaaaaaaaaaaaaaaaa', old, old);
    insert.run(data.id, 'Recent Approved', 'recent@example.com', 'approved', 'tok-b-bbbbbbbbbbbbbbbbbbb', recent, recent);
    insert.run(data.id, 'Still Pending', 'pending@example.com', 'pending', 'tok-c-ccccccccccccccccccc', old, null);

    const result = t.ctx.retention.run();
    assert.equal(result.purged, 1);
    const rows = Object.fromEntries(t.db.prepare('SELECT username, email, status FROM requests').all().map(r => [r.username, r]));
    assert.equal(rows['Old Approved'].email, null);
    assert.equal(rows['Recent Approved'].email, 'recent@example.com');
    assert.equal(rows['Still Pending'].email, 'pending@example.com', 'pending requests of a running event keep their email');
    assert.equal(rows['Still Pending'].status, 'pending');
  } finally {
    await t.stop();
  }
});

test('approvals interrupted by a restart go back to the queue', async () => {
  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-restart-'));
  const env = { NODE_ENV: 'test', DB_PATH: path.join(dir, 'db.sqlite'), DISABLE_BACKGROUND_JOBS: 'true' };
  const silent = { log() {}, warn() {}, error() {} };
  try {
    let instance = createApp(loadConfig(env), { log: silent });
    instance.ctx.db.prepare("INSERT INTO events (name, start_time, end_time, created_at) VALUES ('E', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    instance.ctx.db.prepare("INSERT INTO requests (event_id, username, email, status, status_token, requested_at) VALUES (1, 'Stuck', 'a@b.co', 'processing', 'tok-stuck-xxxxxxxxxxxxxx', '2026-01-01T00:00:00.000Z')").run();
    instance.close();
    instance = createApp(loadConfig(env), { log: silent });
    const row = instance.ctx.db.prepare("SELECT status, error_message FROM requests WHERE username = 'Stuck'").get();
    assert.equal(row.status, 'pending');
    assert.ok(row.error_message);
    instance.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

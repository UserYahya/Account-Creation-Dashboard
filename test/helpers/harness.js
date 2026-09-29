// Starts the app against the stub wiki and provides a cookie-aware client.
const { loadConfig } = require('../../src/config');
const { createApp } = require('../../src/app');
const { createMockWiki } = require('./mock-wiki');
const { utcIsoToBdLocal } = require('../../src/time');

const silentLog = { log() {}, warn() {}, error() {} };

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const h = { Accept: 'text/html', ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (method !== 'GET' && this.csrf && !('X-CSRF-Token' in h)) h['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      const key = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /Expires=Thu, 01 Jan 1970/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    const text = await res.text();
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (meta) this.csrf = meta[1];
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // HTML or CSV response
    }
    return { status: res.status, headers: res.headers, text, data };
  }

  get(path, options) {
    return this.request(path, options);
  }

  post(path, body, options = {}) {
    return this.request(path, { ...options, method: 'POST', body: body === undefined ? {} : body });
  }

  put(path, body) {
    return this.request(path, { method: 'PUT', body });
  }

  patch(path, body) {
    return this.request(path, { method: 'PATCH', body });
  }

  delete(path) {
    return this.request(path, { method: 'DELETE' });
  }

  // Needs ENABLE_MOCK_LOGIN=true
  async mockLogin(user = 'Admin User') {
    await this.get(`/login?user=${encodeURIComponent(user)}`);
    await this.get('/admin');
  }

  // Full OAuth round trip through the stub
  async oauthLogin() {
    await this.get('/');
    const start = await this.get('/login');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await this.get(`/auth/callback?code=good-code&state=${state}`);
    await this.get('/admin');
    return callback;
  }
}

async function startApp(env = {}) {
  const wiki = createMockWiki();
  const wikiUrl = await wiki.start();
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_PATH: ':memory:',
    DISABLE_BACKGROUND_JOBS: 'true',
    WIKI_API_URL_TEMPLATE: `${wikiUrl}/{wiki}/w/api.php`,
    OAUTH_BASE_URL: `${wikiUrl}/oauth2`,
    WIKIMEDIA_CLIENT_ID: 'test-client',
    WIKIMEDIA_CLIENT_SECRET: 'test-secret',
    WIKIMEDIA_REDIRECT_URI: 'http://localhost/auth/callback',
    DEVELOPER_USERNAMES: 'Dev User',
    ...env
  });
  const instance = createApp(config, { log: silentLog });
  const server = await new Promise(resolve => {
    const s = instance.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    wiki,
    config,
    ctx: instance.ctx,
    db: instance.ctx.db,
    client: () => new Client(base),
    async stop() {
      await new Promise(resolve => server.close(resolve));
      instance.close();
      await wiki.stop();
    }
  };
}

// Event form values in Bangladesh local time, open from an hour ago for a week
function eventInput(overrides = {}) {
  const now = Date.now();
  return {
    name: 'Test Editathon',
    workshop_url: 'https://bn.wikipedia.org/wiki/Workshop',
    start_time: utcIsoToBdLocal(new Date(now - 60 * 60 * 1000).toISOString()),
    end_time: utcIsoToBdLocal(new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString()),
    target_wikis: 'bn.wikipedia.org',
    target_namespaces: 'all',
    registration_active: true,
    allow_self_enroll: true,
    ...overrides
  };
}

module.exports = { startApp, Client, eventInput, silentLog };

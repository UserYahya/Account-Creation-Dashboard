// A small stand-in for the MediaWiki Action API and Wikimedia OAuth 2, so the
// whole app can be tested without network access.
const http = require('http');

const INVALID = /[#<>[\]|{}@:=/\\]/;

function createMockWiki() {
  const state = {
    // Accounts that exist everywhere (SUL)
    users: new Set(['Existing User', 'Admin User', 'Active Editor', 'Quiet Editor']),
    // Accounts that exist globally but never visited the local wiki
    globalOnly: new Set(['Global Only']),
    groups: new Map([['Admin User', ['sysop', 'user']]]),
    antispoof: new Map([['Existing Usr', ['Existing User']]]),
    blacklist: [/wikipedia/i],
    contribs: [],
    contribPageSize: 500,
    created: [],
    pages: new Set(),
    logevents: [],
    createFail: null,
    down: false,
    requests: [],
    oauth: { code: 'good-code', accessToken: 'token-1', refreshToken: 'refresh-1', username: 'Admin User', expiresIn: 14400 }
  };

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function authorized(req) {
    return req.headers.authorization === `Bearer ${state.oauth.accessToken}`;
  }

  function query(wiki, p, req) {
    const result = { batchcomplete: true, query: {} };
    if (p.list === 'users') {
      result.query.users = p.ususers.split('|').map(name => {
        if (INVALID.test(name)) return { name, invalid: true };
        if (state.users.has(name)) return { userid: 1, name, groups: state.groups.get(name) || ['user'] };
        const entry = { name, missing: true };
        if ((p.usprop || '').includes('cancreate')) {
          // Like some wikis, the blacklist is only reported by action=titleblacklist
          entry.cancreate = !state.globalOnly.has(name);
          if (!entry.cancreate) entry.cancreateerror = [{ code: 'userexists', text: 'ব্যবহারকারী নামটি ইতিমধ্যে ব্যবহৃত।' }];
        }
        return entry;
      });
    }
    if (p.meta === 'globaluserinfo') {
      if (INVALID.test(p.guiuser)) return { error: { code: 'invaliduser', info: 'Invalid username' } };
      result.query.globaluserinfo = state.users.has(p.guiuser) || state.globalOnly.has(p.guiuser)
        ? { home: 'bnwiki', id: 7, name: p.guiuser }
        : { missing: true };
    }
    if (p.meta === 'tokens') {
      const suffix = authorized(req) ? 'user+\\' : '+\\';
      result.query.tokens = { [`${p.type}token`]: `${p.type}-${suffix}` };
    }
    if (p.list === 'usercontribs') {
      const users = p.ucuser.split('|');
      const bad = users.find(u => INVALID.test(u));
      if (bad) return { error: { code: 'baduser_ucuser', info: `Invalid value "${bad}" for user parameter "ucuser".` } };
      const namespaces = p.ucnamespace ? p.ucnamespace.split('|').map(Number) : null;
      const all = state.contribs
        .filter(c => c.wiki === wiki && users.includes(c.user))
        .filter(c => c.timestamp >= p.ucstart && c.timestamp <= p.ucend)
        .filter(c => !namespaces || namespaces.includes(c.ns))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.revid - b.revid);
      const offset = Number(p.uccontinue || 0);
      const page = all.slice(offset, offset + state.contribPageSize);
      result.query.usercontribs = page.map(c => ({
        userid: 1, user: c.user, revid: c.revid, ns: c.ns, title: c.title, timestamp: c.timestamp, sizediff: c.sizediff, ...(c.new ? { new: true } : {})
      }));
      if (offset + state.contribPageSize < all.length) {
        result.continue = { uccontinue: String(offset + state.contribPageSize), continue: '-||' };
      }
    }
    if (p.list === 'logevents') {
      result.query.logevents = state.logevents.filter(l => l.wiki === wiki && l.title === p.letitle);
    }
    return result;
  }

  function wikiApi(wiki, p, req) {
    if (p.action === 'query') return query(wiki, p, req);
    if (p.action === 'antispoof') {
      const similar = state.antispoof.get(p.username);
      return { antispoof: similar ? { result: 'conflict', users: similar } : { result: 'pass', normalised: p.username } };
    }
    if (p.action === 'titleblacklist') {
      const name = p.tbtitle.replace(/^User:/, '');
      return { titleblacklist: state.blacklist.some(re => re.test(name)) ? { result: 'blacklisted', reason: 'blacklisted', line: '.*wikipedia.*' } : { result: 'ok' } };
    }
    if (p.action === 'createaccount') {
      if (!authorized(req)) return { error: { code: 'mwoauth-invalid-authorization', info: 'The authorization headers in your request are not valid' } };
      if (state.createFail) return { createaccount: state.createFail };
      if (state.users.has(p.username)) return { createaccount: { status: 'FAIL', messagecode: 'userexists', message: 'Username entered already in use.' } };
      state.users.add(p.username);
      state.created.push({ wiki, username: p.username, email: p.email, reason: p.reason, mailpassword: p.mailpassword });
      state.logevents.push({ wiki, title: `User:${p.username}`, user: state.oauth.username, type: 'newusers' });
      return { createaccount: { status: 'PASS', username: p.username } };
    }
    if (p.action === 'edit') {
      if (!authorized(req)) return { error: { code: 'mwoauth-invalid-authorization', info: 'Invalid authorization' } };
      const key = `${wiki}|${p.title}`;
      if (p.createonly && state.pages.has(key)) return { error: { code: 'articleexists', info: 'The article you tried to create has been created already.' } };
      state.pages.add(key);
      return { edit: { result: 'Success', title: p.title, text: p.text } };
    }
    return { error: { code: 'badvalue', info: `Unrecognized value for parameter "action": ${p.action}.` } };
  }

  function readBody(req) {
    return new Promise(resolve => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : '';
    const params = Object.fromEntries(req.method === 'POST' ? new URLSearchParams(body) : url.searchParams);
    state.requests.push({ method: req.method, path: url.pathname, params });

    if (state.down) return json(res, 503, { error: 'down' });

    if (url.pathname === '/oauth2/access_token') {
      if (params.grant_type === 'authorization_code' && params.code === state.oauth.code) {
        return json(res, 200, { token_type: 'Bearer', access_token: state.oauth.accessToken, refresh_token: state.oauth.refreshToken, expires_in: state.oauth.expiresIn });
      }
      if (params.grant_type === 'refresh_token' && params.refresh_token === state.oauth.refreshToken) {
        state.oauth.accessToken = `${state.oauth.accessToken}-refreshed`;
        return json(res, 200, { token_type: 'Bearer', access_token: state.oauth.accessToken, refresh_token: state.oauth.refreshToken, expires_in: state.oauth.expiresIn });
      }
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/oauth2/resource/profile') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { sub: 7, username: state.oauth.username });
    }
    const match = url.pathname.match(/^\/([^/]+)\/w\/api\.php$/);
    if (match) return json(res, 200, wikiApi(match[1], params, req));
    json(res, 404, { error: 'not found' });
  });

  return {
    state,
    start() {
      return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    },
    stop() {
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

module.exports = { createMockWiki };

const express = require('express');
const crypto = require('crypto');
const { asyncHandler } = require('./util');
const { tokensMatch } = require('../security');
const { normalizeUsername } = require('../validation');
const { nowIso } = require('../time');

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate(err => (err ? reject(err) : resolve())));
}

function createAuth({ config, db, wiki, oauth, log }) {
  const router = express.Router();
  const logLogin = db.prepare('INSERT INTO login_logs (username, wiki, logged_at) VALUES (?, ?, ?)');

  // Fresh session for a logged-in admin (prevents session fixation)
  async function startAdminSession(req, { username, adminWikis, tokens = null, mock = false }) {
    await regenerate(req);
    const s = req.session;
    s.csrfToken = crypto.randomBytes(32).toString('hex');
    s.username = username;
    s.isAdmin = true;
    s.isDeveloper = config.developerUsernames.includes(normalizeUsername(username));
    s.adminWikis = adminWikis;
    s.adminWiki = adminWikis[0];
    s.isMock = mock;
    if (tokens) {
      s.accessToken = tokens.accessToken;
      s.refreshToken = tokens.refreshToken;
      s.tokenExpiresAt = tokens.expiresAt;
    }
    logLogin.run(username, s.adminWiki, nowIso());
  }

  // A usable access token, refreshed when it is about to expire; null when the
  // admin has to log in again.
  async function getValidAccessToken(req) {
    const s = req.session;
    if (!s.accessToken) return null;
    if (!s.tokenExpiresAt || s.tokenExpiresAt - Date.now() > 60 * 1000) return s.accessToken;
    if (!s.refreshToken) return null;
    try {
      const tokens = await oauth.refresh(s.refreshToken);
      s.accessToken = tokens.accessToken;
      s.refreshToken = tokens.refreshToken || s.refreshToken;
      s.tokenExpiresAt = tokens.expiresAt;
      return s.accessToken;
    } catch (err) {
      log.error('OAuth token refresh failed:', err.message);
      return null;
    }
  }

  router.get('/login', asyncHandler(async (req, res) => {
    // ?reauth=1 asks Wikimedia again, e.g. when the saved access token stopped working
    if (req.session.isAdmin && req.query.reauth !== '1') return res.redirect('/admin');

    if (config.mockLogin) {
      // Local testing only: /login?user=Name&wiki=bd
      const username = normalizeUsername(typeof req.query.user === 'string' ? req.query.user : '') || 'Test admin';
      const adminWikis = req.query.wiki === 'bd' ? ['bd.wikimedia.org'] : ['bn.wikipedia.org'];
      log.log(`[MOCK LOGIN] Logged in as "${username}" (${adminWikis[0]}).`);
      await startAdminSession(req, { username, adminWikis, mock: true });
      return res.redirect('/admin');
    }

    if (!oauth.isConfigured()) {
      log.error('Wikimedia OAuth is not configured. Set WIKIMEDIA_CLIENT_ID, WIKIMEDIA_CLIENT_SECRET and WIKIMEDIA_REDIRECT_URI, or ENABLE_MOCK_LOGIN=true for local testing.');
      return res.status(500).render('error', {
        title: 'লগ ইন করা যাচ্ছে না',
        heading: 'লগ ইন এখন চালু নেই',
        message: 'সার্ভারে উইকিমিডিয়া OAuth কনফিগার করা হয়নি। অনুগ্রহ করে টুলের রক্ষণাবেক্ষণকারীর সাথে যোগাযোগ করুন।'
      });
    }

    // Random state ties the callback to this browser session (prevents login CSRF)
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    req.session.save(err => {
      if (err) return res.status(500).send('Session error');
      res.redirect(oauth.authorizeUrl(state));
    });
  }));

  router.get('/auth/callback', asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    const expected = req.session.oauthState;
    delete req.session.oauthState;

    if (req.query.error) {
      return res.status(400).render('error', { title: 'লগ ইন বাতিল', heading: 'লগ ইন বাতিল করা হয়েছে', message: 'আপনি উইকিমিডিয়াতে অনুমতি দেননি। আবার চেষ্টা করতে লগ ইন বাটনে চাপুন।' });
    }
    if (typeof code !== 'string' || !tokensMatch(state, expected)) {
      return res.status(400).render('error', { title: 'লগ ইন ব্যর্থ', heading: 'লগ ইন যাচাই ব্যর্থ হয়েছে', message: 'লগ ইনের অনুরোধটির মেয়াদ শেষ হয়েছে বা এটি অন্য কোথাও থেকে এসেছে। অনুগ্রহ করে আবার লগ ইন করুন।' });
    }

    let tokens;
    let username;
    try {
      tokens = await oauth.exchangeCode(code);
      const profile = await oauth.profile(tokens.accessToken);
      username = profile.username;
      if (!username) throw new Error('OAuth profile has no username.');
    } catch (err) {
      log.error('OAuth callback error:', err.message);
      return res.status(502).render('error', { title: 'লগ ইন ব্যর্থ', heading: 'লগ ইন করতে সমস্যা হয়েছে', message: 'উইকিমিডিয়ার সাথে যোগাযোগ করা যায়নি। কিছুক্ষণ পরে আবার চেষ্টা করুন।' });
    }

    // Which admin wikis is this user a member of an allowed group on?
    const adminWikis = [];
    let lookupFailed = false;
    for (const wikiName of config.adminWikis) {
      const groups = await wiki.getUserGroups(wikiName, username);
      if (groups === null) lookupFailed = true;
      else if (groups.some(g => config.allowedGroups.includes(g))) adminWikis.push(wikiName);
    }

    if (adminWikis.length === 0 && lookupFailed) {
      return res.status(502).render('error', { title: 'লগ ইন ব্যর্থ', heading: 'আপনার অধিকার যাচাই করা যায়নি', message: 'উইকিপিডিয়ার সাথে যোগাযোগ করা যায়নি। কিছুক্ষণ পরে আবার লগ ইন করুন।' });
    }
    if (adminWikis.length === 0) {
      req.session.loginErrorUsername = username;
      return res.redirect('/login-error');
    }
    await startAdminSession(req, { username, adminWikis, tokens });
    res.redirect('/admin');
  }));

  router.get('/login-error', (req, res) => {
    const username = req.session.loginErrorUsername || null;
    delete req.session.loginErrorUsername;
    res.render('login-error', { title: 'প্রবেশাধিকার নেই', username, adminWikis: config.adminWikis, allowedGroups: config.allowedGroups });
  });

  // Logging out needs a POST with the CSRF token; the GET page shows a button
  router.get('/logout', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    res.render('logout', { title: 'লগ আউট' });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('acd.sid');
      res.redirect('/');
    });
  });

  return { router, getValidAccessToken };
}

module.exports = { createAuth };

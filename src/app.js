const path = require('path');
const express = require('express');
const session = require('express-session');
const { openDatabase } = require('./db');
const { createWikiClient } = require('./wiki');
const { createOAuthClient } = require('./oauth');
const { createData } = require('./data');
const { createAudit } = require('./audit');
const { createStatsService } = require('./stats');
const { createAccountService } = require('./accounts');
const { createRetention } = require('./retention');
const { securityHeaders, csrf, RateLimiter, wantsJson } = require('./security');
const { createLocals } = require('./render');
const createSessionStore = require('./session-store');
const { createAuth } = require('./routes/auth');
const { createPublicRoutes } = require('./routes/public');
const { createPublicApi } = require('./routes/public-api');
const { createAdminPages } = require('./routes/admin-pages');
const { createAdminApi } = require('./routes/admin-api');

// Build the Express app and its services. Tests pass their own config and a
// fake fetch to talk to a stub MediaWiki server.
function createApp(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
  const db = openDatabase(config.dbPath, { log });
  // Approvals interrupted by a restart go back to the queue; a retry detects
  // accounts that were in fact created.
  db.prepare("UPDATE requests SET status = 'pending', error_message = ? WHERE status = 'processing'")
    .run('আগের চেষ্টাটি মাঝপথে থেমে গিয়েছিল। আবার অনুমোদন করুন।');

  const wiki = createWikiClient(config, { fetchImpl, log });
  const oauth = createOAuthClient(config, { fetchImpl });
  const data = createData(db);
  const audit = createAudit(db);
  const stats = createStatsService({ db, wiki, config, log });
  const accounts = createAccountService({ db, wiki, stats, audit, data, log });
  const retention = createRetention({ db, config, log });
  const limiter = new RateLimiter();
  const SqliteSessionStore = createSessionStore(session);
  const sessionStore = new SqliteSessionStore(db);
  const auth = createAuth({ config, db, wiki, oauth, log });
  const ctx = { config, db, wiki, oauth, data, audit, stats, accounts, retention, limiter, log, getValidAccessToken: auth.getValidAccessToken };

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.rootDir, 'views'));

  app.use(securityHeaders);
  // Static files are served before the session so they never create one
  app.use('/static', express.static(path.join(config.rootDir, 'public'), { maxAge: config.isProduction ? '7d' : 0 }));
  app.get(['/favicon.ico', '/favicon.png'], (req, res) => {
    res.sendFile(path.join(config.rootDir, 'public', 'img', 'favicon.png'), { maxAge: '7d' });
  });

  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(session({
    name: 'acd.sid',
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: config.sessionMaxAgeMs,
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax'
    }
  }));
  app.use(csrf);
  app.use(createLocals(ctx));

  app.use(auth.router);
  app.use(createPublicRoutes(ctx));
  app.use(createPublicApi(ctx));
  app.use(createAdminPages(ctx));
  app.use(createAdminApi(ctx));

  app.use((req, res) => {
    if (wantsJson(req)) return res.status(404).json({ success: false, error: 'পাওয়া যায়নি।' });
    res.status(404).render('error', { title: 'পাওয়া যায়নি', heading: 'পাতাটি পাওয়া যায়নি', message: 'আপনি যে পাতাটি খুঁজছেন সেটি নেই বা সরিয়ে নেওয়া হয়েছে।' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ success: false, error: 'অনুরোধটি পড়া যায়নি।' });
    }
    log.error('Unhandled error:', err);
    if (res.headersSent) return;
    if (wantsJson(req)) return res.status(500).json({ success: false, error: 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।' });
    res.status(500).render('error', { title: 'সমস্যা হয়েছে', heading: 'সার্ভারে একটি সমস্যা হয়েছে', message: 'অনুগ্রহ করে কিছুক্ষণ পরে আবার চেষ্টা করুন।' });
  });

  function start() {
    stats.start();
    retention.start();
  }

  function close() {
    stats.stop();
    retention.stop();
    limiter.close();
    sessionStore.close();
    db.close();
  }

  return { app, ctx, start, close };
}

module.exports = { createApp };

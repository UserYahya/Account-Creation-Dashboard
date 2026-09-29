const path = require('path');
const crypto = require('crypto');
const { normalizeUsername } = require('./validation');

const ROOT_DIR = path.join(__dirname, '..');

function list(value, fallback) {
  const source = value === undefined || value === '' ? fallback : value;
  return String(source || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Read settings from environment variables (see .env.example)
function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';

  let trustProxy = false;
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '') {
    trustProxy = /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY === 'true';
  } else if (isProduction) {
    trustProxy = 1;
  }

  const sessionSecret = env.SESSION_SECRET;
  const weakSecret = !sessionSecret || sessionSecret === 'some_random_session_secret_string' || sessionSecret.length < 16;
  if (isProduction && weakSecret) {
    throw new Error('SESSION_SECRET is not securely configured for production (use at least 16 random characters).');
  }

  const mockRequested = env.ENABLE_MOCK_LOGIN === 'true';
  const clientId = env.WIKIMEDIA_CLIENT_ID && env.WIKIMEDIA_CLIENT_ID !== 'your_client_id_here' ? env.WIKIMEDIA_CLIENT_ID : '';

  return {
    rootDir: ROOT_DIR,
    isProduction,
    port: int(env.PORT, 3000),
    trustProxy,
    sessionSecret: weakSecret && !isProduction ? crypto.randomBytes(32).toString('hex') : sessionSecret,
    sessionMaxAgeMs: 24 * 60 * 60 * 1000,
    mockLogin: mockRequested && !isProduction,
    mockLoginIgnored: mockRequested && isProduction,
    developerUsernames: list(env.DEVELOPER_USERNAMES, '').map(normalizeUsername).filter(Boolean),
    allowedGroups: list(env.ALLOWED_GROUPS, 'sysop'),
    adminWikis: list(env.ADMIN_WIKIS, 'bn.wikipedia.org,bd.wikimedia.org'),
    // Wiki whose username rules are used for the live availability check
    usernameCheckWiki: env.USERNAME_CHECK_WIKI || 'bn.wikipedia.org',
    oauth: {
      clientId,
      clientSecret: env.WIKIMEDIA_CLIENT_SECRET || '',
      redirectUri: env.WIKIMEDIA_REDIRECT_URI || '',
      baseUrl: env.OAUTH_BASE_URL || 'https://meta.wikimedia.org/w/rest.php/oauth2'
    },
    // "{wiki}" is replaced with the wiki's domain; tests point this at a local stub
    wikiApiUrlTemplate: env.WIKI_API_URL_TEMPLATE || 'https://{wiki}/w/api.php',
    userAgent: env.USER_AGENT || 'Wikimedia-BD-Outreach-Tool/2.0 (https://acd.toolforge.org; contact@wikimedia.org.bd) - Account creator for outreach event and workshop participants',
    dbPath: env.DB_PATH === ':memory:' ? ':memory:' : env.DB_PATH ? path.resolve(ROOT_DIR, env.DB_PATH) : path.join(ROOT_DIR, 'database.sqlite'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    contactEmail: env.CONTACT_EMAIL || 'yahya@wikimedia.org.bd',
    emailRetentionDays: int(env.EMAIL_RETENTION_DAYS, 90),
    pollIntervalMinutes: int(env.STATS_POLL_MINUTES, 5),
    // Background jobs (stats polling, email clean-up); tests switch them off
    backgroundJobs: env.DISABLE_BACKGROUND_JOBS !== 'true',
    rateLimits: {
      register: { perSession: int(env.RATE_REGISTER_PER_SESSION, 10), perIp: int(env.RATE_REGISTER_PER_IP, 300), windowMs: 15 * 60 * 1000 },
      checkUsername: { perSession: int(env.RATE_CHECK_PER_SESSION, 60), perIp: int(env.RATE_CHECK_PER_IP, 1500), windowMs: 60 * 1000 },
      statsRefresh: { perEventMs: 60 * 1000 }
    }
  };
}

module.exports = { loadConfig, ROOT_DIR };

const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { getDatabase } = require('./db');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enforce strong session secret in production
const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && (!sessionSecret || sessionSecret === 'some_random_session_secret_string')) {
  console.error("CRITICAL: SESSION_SECRET is not securely configured in production.");
  process.exit(1);
}

// Setup session
app.use(session({
  secret: sessionSecret || 'wmbdedu_secret_session_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax'
  }
}));

// Basic Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// CSRF Generation and Cookie Setup Middleware
app.use((req, res, next) => {
  if (!req.session) return next();
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.cookie('XSRF-TOKEN', req.session.csrfToken, {
    httpOnly: false, // Must be readable by client JS to attach as header
    secure: isProduction,
    sameSite: 'lax'
  });
  next();
});

// CSRF Verification Middleware
function csrfVerify(req, res, next) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const clientToken = req.headers['x-xsrf-token'] || (req.body && req.body._csrf);
    if (!clientToken || clientToken !== req.session.csrfToken) {
      return res.status(403).json({ success: false, error: 'CSRF verification failed.' });
    }
  }
  next();
}
app.use(csrfVerify);

// Custom In-Memory IP Rate Limiter
const rateLimitMap = new Map();
function ipRateLimiter(limit, windowMs) {
  return (req, res, next) => {
    if (isProduction) {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const now = Date.now();
      if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, []);
      }
      const timestamps = rateLimitMap.get(ip);
      const activeTimestamps = timestamps.filter(t => now - t < windowMs);
      if (activeTimestamps.length >= limit) {
        return res.status(429).json({ success: false, error: 'অতিরিক্ত রিকোয়েস্ট করা হয়েছে। অনুগ্রহ করে কিছু সময় পর আবার চেষ্টা করুন।' });
      }
      activeTimestamps.push(now);
      rateLimitMap.set(ip, activeTimestamps);
    }
    next();
  };
}

// URL Validation Helper
function isValidHttpUrl(string) {
  let url;
  try {
    url = new URL(string);
  } catch (_) {
    return false;  
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

// HTML Escaping Helper
function escapeHTML(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Serve static elements if any
// (Our app has server-rendered views but Tailwind is fetched from CDN)

// Helper: check if admin
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect('/login');
}

// Helper: Query MediaWiki Action API (GET)
async function queryWikiAPI(wiki, params, accessToken = null) {
  const url = new URL(`https://${wiki}/w/api.php`);
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
  
  const headers = {
    'User-Agent': 'Wikimedia-BD-Outreach-Tool/1.0 (https://acd.toolforge.org; contact@wikimedia.org.bd) - Account creator for outreach event and workshop participants'
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`MediaWiki API error: ${response.statusText}`);
  }
  return await response.json();
}

// Helper: Post to MediaWiki Action API (POST)
async function postWikiAPI(wiki, params, accessToken = null) {
  const url = `https://${wiki}/w/api.php`;
  const body = new URLSearchParams();
  Object.keys(params).forEach(key => body.append(key, params[key]));
  
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Wikimedia-BD-Outreach-Tool/1.0 (https://acd.toolforge.org; contact@wikimedia.org.bd) - Account creator for outreach event and workshop participants'
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body
  });
  
  if (!response.ok) {
    throw new Error(`MediaWiki API post error: ${response.statusText}`);
  }
  return await response.json();
}

// Helper: Check username availability and AntiSpoof
async function checkUsername(username) {
  try {
    // 1. Local check (bn.wikipedia.org)
    const localData = await queryWikiAPI('bn.wikipedia.org', {
      action: 'query',
      list: 'users',
      ususers: username,
      format: 'json',
      formatversion: '2'
    });
    
    if (localData.query && localData.query.users && localData.query.users[0] && !localData.query.users[0].missing) {
      return { valid: false, reason: 'স্থানীয় উইকিপিডিয়ায় (bnwiki) এই ব্যবহারকারী নাম ইতিমধ্যে বিদ্যমান।' };
    }

    // 2. Global check
    const globalData = await queryWikiAPI('bn.wikipedia.org', {
      action: 'query',
      meta: 'globaluserinfo',
      guiuser: username,
      format: 'json',
      formatversion: '2'
    });

    if (globalData.query && globalData.query.globaluserinfo && !globalData.query.globaluserinfo.missing) {
      return { valid: false, reason: 'বৈশ্বিক উইকিমিডিয়া নেটওয়ার্কে (SUL) এই ব্যবহারকারী নাম ইতিমধ্যে বিদ্যমান।' };
    }

    // 3. AntiSpoof check
    const spoofData = await queryWikiAPI('bn.wikipedia.org', {
      action: 'antispoof',
      username: username,
      format: 'json',
      formatversion: '2'
    });

    if (spoofData.antispoof) {
      if (spoofData.antispoof.result === 'conflict') {
        return { valid: false, reason: `এই নামটি অন্য একটি নামের সাথে বিভ্রান্তি তৈরি করে (AntiSpoof সংঘাত)।` };
      } else if (spoofData.antispoof.result === 'error') {
        return { valid: false, reason: `নামটিতে এমন অক্ষর আছে যা উইকিপিডিয়ায় সমর্থন করে না বা এটি ব্যবহারের অনুপযোগী।` };
      }
    }

    return { valid: true };
  } catch (err) {
    console.error("Username check error:", err);
    throw new Error("উইকিপিডিয়া সার্ভারের সাথে যোগাযোগ করতে ব্যর্থ হয়েছে।");
  }
}

// Helper: Replace common placeholders in HTML views
function renderView(viewName, replacements = {}, req = null) {
  const viewPath = path.join(__dirname, 'views', viewName);
  let html = fs.readFileSync(viewPath, 'utf8');

  // Replace custom variables passed in
  Object.keys(replacements).forEach(key => {
    let value = replacements[key];
    if (typeof value === 'string' && !key.endsWith('_HTML')) {
      value = escapeHTML(value);
    }
    html = html.replaceAll(`{{${key}}}`, value);
  });

  // Render navigation auth section
  let authHtml = '';
  if (req && req.session && req.session.isAdmin) {
    authHtml = `
      <a class="text-primary font-bold font-label-md text-label-md hover:bg-surface-container-low px-md py-xs rounded-lg transition-colors" href="/admin">ড্যাশবোর্ড</a>
      <a class="text-error font-bold font-label-md text-label-md hover:bg-surface-container-low px-md py-xs rounded-lg transition-colors ml-sm" href="/logout">লগ আউট</a>
    `;
  } else {
    authHtml = `
      <a class="bg-primary text-on-primary px-md py-2 rounded-lg font-label-md text-label-md hover:opacity-80 transition-opacity" href="/login">লগ ইন</a>
    `;
  }
  html = html.replace('<!-- NAV_AUTH -->', authHtml);

  return html;
}

// --- USER ROUTES ---

// Homepage
app.get('/', async (req, res) => {
  const db = await getDatabase();
  const regActive = await db.get("SELECT value FROM settings WHERE key = 'registration_active'");
  const eventName = await db.get("SELECT value FROM settings WHERE key = 'event_name'");
  const workshopUrl = await db.get("SELECT value FROM settings WHERE key = 'workshop_url'");
  const addInstructions = await db.get("SELECT value FROM settings WHERE key = 'additional_instructions'");
  
  const wUrl = workshopUrl ? workshopUrl.value : 'https://bn.wikipedia.org';
  
  let instructionsHtml = '';
  if (addInstructions && addInstructions.value.trim()) {
    const listItems = addInstructions.value.trim().split('\n').map(item => {
      const trimmed = item.trim();
      return trimmed ? `<li>${escapeHTML(trimmed)}</li>` : '';
    }).filter(Boolean).join('');
    
    if (listItems) {
      instructionsHtml = `
        <div class="mt-md pt-md border-t border-outline-variant">
            <h4 class="font-body-lg text-body-lg font-bold text-primary mb-sm">আয়োজকদের অতিরিক্ত নির্দেশনা:</h4>
            <ul class="list-disc pl-lg space-y-sm font-body-md text-body-md text-on-surface-variant">
                ${listItems}
            </ul>
        </div>
      `;
    }
  }

  if (regActive && regActive.value === '1') {
    res.send(renderView('registration.html', { 
      EVENT_NAME: eventName.value, 
      WORKSHOP_URL: wUrl,
      ADDITIONAL_INSTRUCTIONS_HTML: instructionsHtml
    }, req));
  } else {
    res.send(renderView('registration_stopped.html', { WORKSHOP_URL: wUrl }, req));
  }
});

// Success Page
app.get('/success', async (req, res) => {
  const db = await getDatabase();
  const workshopUrl = await db.get("SELECT value FROM settings WHERE key = 'workshop_url'");
  const wUrl = workshopUrl ? workshopUrl.value : 'https://bn.wikipedia.org';
  res.send(renderView('success.html', { WORKSHOP_URL: wUrl }, req));
});

// Real-time username availability check endpoint
app.get('/api/check-username', ipRateLimiter(30, 60 * 1000), async (req, res) => {
  const username = req.query.username;
  if (!username || username.trim().length < 3) {
    return res.status(400).json({ valid: false, reason: 'নামটি কমপক্ষে ৩ অক্ষরের হতে হবে।' });
  }
  
  try {
    const result = await checkUsername(username.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ valid: false, reason: err.message });
  }
});

// Submit registration requests
app.post('/api/register', ipRateLimiter(5, 15 * 60 * 1000), async (req, res) => {
  const { email, username } = req.body;
  if (!email || !username) {
    return res.status(400).json({ success: false, error: 'সবগুলো ঘর পূরণ করা আবশ্যক।' });
  }

  try {
    const db = await getDatabase();
    
    // Check if registration is active
    const regActive = await db.get("SELECT value FROM settings WHERE key = 'registration_active'");
    if (!regActive || regActive.value !== '1') {
      return res.status(403).json({ success: false, error: 'দুঃখিত, বর্তমানে রেজিস্ট্রেশন বন্ধ আছে।' });
    }

    // Backend validation of username to prevent bypass
    const check = await checkUsername(username.trim());
    if (!check.valid) {
      return res.status(400).json({ success: false, error: check.reason });
    }

    const eventName = await db.get("SELECT value FROM settings WHERE key = 'event_name'");

    // Insert request
    await db.run(
      'INSERT INTO requests (username, email, status, event_name) VALUES (?, ?, ?, ?)',
      username.trim(),
      email.trim(),
      'pending',
      eventName ? eventName.value : ''
    );

    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, error: 'এই ব্যবহারকারী নাম দিয়ে ইতিমধ্যে একটি আবেদন করা হয়েছে।' });
    }
    console.error("Register request error:", err);
    res.status(500).json({ success: false, error: 'আবেদনটি সংরক্ষণ করতে ব্যর্থ হয়েছে।' });
  }
});

// --- OAUTH AUTHENTICATION ROUTES ---

// Login route (initiates OAuth)
app.get('/login', (req, res) => {
  const clientID = process.env.WIKIMEDIA_CLIENT_ID;
  
  // MOCK LOGIN MODE (if credentials are placeholders or not set)
  if (!clientID || clientID === 'your_client_id_here') {
    if (isProduction) {
      console.error("CRITICAL: WIKIMEDIA_CLIENT_ID is not configured in production mode.");
      return res.status(500).send("Critical Configuration Error: Wikimedia OAuth client credentials are not configured.");
    }
    console.log("Wikimedia OAuth credentials not configured. Entering Mock OAuth Mode.");
    
    // Support mock super-admin login: /login?user=Yahya
    const mockUser = req.query.user === 'Yahya' ? 'Yahya' : 'উইকি_অ্যাডমিন';
    req.session.username = mockUser;
    req.session.isAdmin = true;
    req.session.isSuperAdmin = mockUser === 'Yahya';
    
    // Allow query parameter override for testing different targets: ?wiki=bd
    const targetWiki = req.query.wiki === 'bd' ? 'bd.wikimedia.org' : 'bn.wikipedia.org';
    req.session.adminWiki = targetWiki;
    
    return res.redirect('/admin');
  }

  // Real OAuth flow redirect
  const authUrl = `https://meta.wikimedia.org/w/rest.php/oauth2/authorize?response_type=code&client_id=${clientID}&redirect_uri=${encodeURIComponent(process.env.WIKIMEDIA_REDIRECT_URI)}`;
  res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('OAuth callback parameters missing.');
  }

  try {
    // Exchange authorization code for access token
    const tokenUrl = 'https://meta.wikimedia.org/w/rest.php/oauth2/access_token';
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.WIKIMEDIA_CLIENT_ID,
      client_secret: process.env.WIKIMEDIA_CLIENT_SECRET,
      redirect_uri: process.env.WIKIMEDIA_REDIRECT_URI
    });

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.statusText}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile info
    const profileUrl = 'https://meta.wikimedia.org/w/rest.php/oauth2/resource/profile';
    const profileRes = await fetch(profileUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!profileRes.ok) {
      throw new Error(`Profile fetch failed: ${profileRes.statusText}`);
    }

    const profileData = await profileRes.json();
    const username = profileData.username || profileData.sub;

    if (!username) {
      throw new Error("Unable to identify username from OAuth profile.");
    }

    // Check if user is a sysop (admin) on bn.wikipedia.org or bd.wikimedia.org
    let isBnAdmin = false;
    let isBdAdmin = false;

    try {
      const bnUserData = await queryWikiAPI('bn.wikipedia.org', {
        action: 'query',
        list: 'users',
        ususers: username,
        usprop: 'groups',
        format: 'json',
        formatversion: '2'
      });
      const bnUser = bnUserData.query && bnUserData.query.users && bnUserData.query.users[0];
      if (bnUser && bnUser.groups && bnUser.groups.includes('sysop')) {
        isBnAdmin = true;
      }
    } catch (e) {
      console.error("Failed to query bnwiki admin groups:", e);
    }

    try {
      const bdUserData = await queryWikiAPI('bd.wikimedia.org', {
        action: 'query',
        list: 'users',
        ususers: username,
        usprop: 'groups',
        format: 'json',
        formatversion: '2'
      });
      const bdUser = bdUserData.query && bdUserData.query.users && bdUserData.query.users[0];
      if (bdUser && bdUser.groups && bdUser.groups.includes('sysop')) {
        isBdAdmin = true;
      }
    } catch (e) {
      console.error("Failed to query bdwikimedia admin groups:", e);
    }

    // Determine access and primary wiki target
    if (isBnAdmin || isBdAdmin) {
      req.session.username = username;
      req.session.isAdmin = true;
      req.session.accessToken = accessToken;
      
      // If username is Yahya, grant Super Admin rights
      if (username.toLowerCase() === 'yahya') {
        req.session.isSuperAdmin = true;
      } else {
        req.session.isSuperAdmin = false;
      }

      // If sysop on bnwiki, create account there; else on bd.wikimedia.org
      if (isBnAdmin) {
        req.session.adminWiki = 'bn.wikipedia.org';
      } else {
        req.session.adminWiki = 'bd.wikimedia.org';
      }

      res.redirect('/admin');
    } else {
      // Access denied
      res.redirect(`/login-error?username=${encodeURIComponent(username)}`);
    }
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send(`লগ ইন করতে সমস্যা হয়েছে: ${err.message}`);
  }
});

// Login error page
app.get('/login-error', (req, res) => {
  const username = req.query.username || 'ব্যবহারকারী';
  res.send(renderView('login_error.html', { ADMIN_USERNAME: username }));
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// --- ADMIN PANEL SECURED ROUTES ---

// Admin Dashboard page
app.get('/admin', isAdmin, async (req, res) => {
  const db = await getDatabase();
  const eventName = await db.get("SELECT value FROM settings WHERE key = 'event_name'");
  
  const isSuperAdmin = req.session.isSuperAdmin ? 'true' : 'false';
  const showDownloadClass = req.session.isSuperAdmin ? '' : 'hidden';

  res.send(renderView('admin_dashboard.html', {
    ADMIN_USERNAME: req.session.username,
    ADMIN_WIKI: req.session.adminWiki,
    EVENT_NAME: eventName ? eventName.value : '',
    IS_SUPER_ADMIN: isSuperAdmin,
    DOWNLOAD_BUTTON_CLASS: showDownloadClass
  }, req));
});

// Settings configuration page
app.get('/admin/settings', isAdmin, async (req, res) => {
  const db = await getDatabase();
  const eventName = await db.get("SELECT value FROM settings WHERE key = 'event_name'");
  const regActive = await db.get("SELECT value FROM settings WHERE key = 'registration_active'");
  const workshopUrl = await db.get("SELECT value FROM settings WHERE key = 'workshop_url'");
  const addInstructions = await db.get("SELECT value FROM settings WHERE key = 'additional_instructions'");
  const welcomeMessage = await db.get("SELECT value FROM settings WHERE key = 'welcome_message'");
  
  const regActiveVal = regActive && regActive.value === '1' ? 'true' : 'false';
  const wUrl = workshopUrl ? workshopUrl.value : 'https://bn.wikipedia.org';
  const instructionsText = addInstructions ? addInstructions.value : '';
  const welcomeText = welcomeMessage ? welcomeMessage.value : '';

  res.send(renderView('event_settings.html', {
    ADMIN_USERNAME: req.session.username,
    ADMIN_WIKI: req.session.adminWiki,
    EVENT_NAME: eventName ? eventName.value : '',
    REG_ACTIVE_VAL: regActiveVal,
    WORKSHOP_URL: wUrl,
    ADDITIONAL_INSTRUCTIONS: instructionsText,
    WELCOME_MESSAGE: welcomeText
  }, req));
});

// --- SECURED API ENDPOINTS FOR ADMINS ---

// Fetch requests list and statistics
app.get('/api/requests', isAdmin, async (req, res) => {
  try {
    const db = await getDatabase();
    
    // Fetch all requests
    const requests = await db.all('SELECT * FROM requests ORDER BY requested_at DESC');
    
    // Calculate statistics
    const stats = {
      pending: requests.filter(r => r.status === 'pending').length,
      approved: requests.filter(r => r.status === 'approved').length
    };

    // Sanitize email address for non-super-admins
    const isSuperAdmin = !!req.session.isSuperAdmin;
    const sanitizedRequests = requests.map(r => {
      const sanitized = { ...r };
      if (!isSuperAdmin) {
        sanitized.email = '';
      }
      return sanitized;
    });

    res.json({ requests: sanitizedRequests, stats });
  } catch (err) {
    res.status(500).json({ error: 'ডাটাবেজ থেকে তথ্য আনা যায়নি।' });
  }
});

// Save global settings
app.post('/api/settings', isAdmin, async (req, res) => {
  const { event_name, registration_active, workshop_url, additional_instructions, welcome_message } = req.body;
  if (!event_name) {
    return res.status(400).json({ success: false, error: 'ইভেন্টের নাম আবশ্যক।' });
  }
  if (workshop_url && !isValidHttpUrl(workshop_url)) {
    return res.status(400).json({ success: false, error: 'ইউআরএলটি (Workshop URL) সঠিক নয়।' });
  }

  try {
    const db = await getDatabase();
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('event_name', ?)", event_name);
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('registration_active', ?)", String(registration_active));
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('workshop_url', ?)", workshop_url || 'https://bn.wikipedia.org');
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('additional_instructions', ?)", additional_instructions || '');
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('welcome_message', ?)", welcome_message || '');
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'কনফিগারেশন সংরক্ষণ করা যায়নি।' });
  }
});

// Fetch all events (Event History Log)
app.get('/api/events', isAdmin, async (req, res) => {
  try {
    const db = await getDatabase();
    const events = await db.all('SELECT * FROM events ORDER BY created_at DESC');
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: 'ইভেন্ট তালিকা লোড করা যায়নি।' });
  }
});

// Fetch requests for a specific event (only super-admin can see emails)
app.get('/api/events/:eventName/requests', isAdmin, async (req, res) => {
  try {
    const eventName = req.params.eventName;
    const db = await getDatabase();
    
    // Fetch requests matching the event name
    const requests = await db.all(
      'SELECT * FROM requests WHERE event_name = ? ORDER BY requested_at DESC',
      eventName
    );
    
    const isSuperAdmin = !!req.session.isSuperAdmin;
    const sanitizedRequests = requests.map(r => {
      const sanitized = { ...r };
      if (!isSuperAdmin) {
        delete sanitized.email;
      }
      return sanitized;
    });
    
    res.json({ requests: sanitizedRequests, showEmail: isSuperAdmin });
  } catch (err) {
    console.error("Error fetching event requests:", err);
    res.status(500).json({ error: 'ইভেন্টের আবেদন ইতিহাস লোড করা যায়নি।' });
  }
});

// Create a new event and set it active
app.post('/api/events', isAdmin, async (req, res) => {
  const { name, workshop_url } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'ইভেন্টের নাম আবশ্যক।' });
  }

  const wUrl = workshop_url ? workshop_url.trim() : 'https://bn.wikipedia.org';
  if (wUrl && !isValidHttpUrl(wUrl)) {
    return res.status(400).json({ success: false, error: 'ইউআরএলটি (Workshop URL) সঠিক নয়।' });
  }

  try {
    const db = await getDatabase();
    // 1. Insert into events table
    await db.run('INSERT INTO events (name, workshop_url) VALUES (?, ?)', name.trim(), wUrl);
    // 2. Set active settings
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('event_name', ?)", name.trim());
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('workshop_url', ?)", wUrl);
    
    res.json({ success: true });
  } catch (err) {
    console.error("Create event error:", err);
    res.status(500).json({ success: false, error: 'নতুন ইভেন্ট তৈরি করতে ব্যর্থ হয়েছে।' });
  }
});

// Download previous events log containing email addresses (Super-admin Yahya only)
app.get('/api/admin/download-log', isAdmin, async (req, res) => {
  if (!req.session.isSuperAdmin) {
    return res.status(403).send('দুঃখিত, এই ফাইলটি ডাউনলোড করার অনুমতি শুধুমাত্র সুপার অ্যাডমিন Yahya-এর আছে।');
  }

  try {
    const db = await getDatabase();
    const requests = await db.all('SELECT * FROM requests ORDER BY requested_at DESC');
    
    // Create CSV header (UTF-8 signature BOM first to preserve Bengali characters in Excel)
    let csvContent = '\uFEFFID,Username,Email,Status,Event Name,Requested At,Decided By,Decided At,Error Message,Decision Reason\n';
    
    // Helper to escape CSV values
    const escapeCSV = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replaceAll('"', '""')}"`;
      }
      return str;
    };

    // Populate rows
    requests.forEach(r => {
      csvContent += `${r.id},${escapeCSV(r.username)},${escapeCSV(r.email)},${escapeCSV(r.status)},${escapeCSV(r.event_name)},${escapeCSV(r.requested_at)},${escapeCSV(r.decided_by)},${escapeCSV(r.decided_at)},${escapeCSV(r.error_message)},${escapeCSV(r.decision_reason)}\n`;
    });


    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=wikimedia_outreach_requests_log.csv');
    res.send(Buffer.from(csvContent, 'utf-8'));
  } catch (err) {
    console.error("Download log error:", err);
    res.status(500).send('লগ ডাউনলোড করতে ব্যর্থ হয়েছে।');
  }
});

// Decline request
app.post('/api/requests/:id/decline', isAdmin, async (req, res) => {
  const requestId = req.params.id;
  const { reason } = req.body || {};
  try {
    const db = await getDatabase();
    await db.run(
      "UPDATE requests SET status = 'declined', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_reason = ? WHERE id = ?",
      req.session.username,
      reason ? reason.trim() : null,
      requestId
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'আবেদনটি বাতিল করতে সমস্যা হয়েছে।' });
  }
});

// Approve and create account on the target wiki
app.post('/api/requests/:id/approve', isAdmin, async (req, res) => {
  const requestId = req.params.id;
  const { reason } = req.body || {};

  
  try {
    const db = await getDatabase();
    
    // Fetch request details
    const request = await db.get('SELECT * FROM requests WHERE id = ?', requestId);
    if (!request) {
      return res.status(404).json({ success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' });
    }

    if (request.status === 'approved') {
      return res.status(400).json({ success: false, error: 'এই অ্যাকাউন্টটি ইতিমধ্যে তৈরি করা হয়েছে।' });
    }

    // Determine target wiki based on the admin's rights
    const targetWiki = req.session.adminWiki || 'bn.wikipedia.org';
    const eventName = await db.get("SELECT value FROM settings WHERE key = 'event_name'");
    let summaryReason = `${eventName ? eventName.value : 'ইভেন্ট'}-এর অংশগ্রহণকারীর জন্য অ্যাকাউন্ট তৈরি করা হলো।`;
    if (reason && reason.trim()) {
      summaryReason += ` (${reason.trim()})`;
    }

    console.log(`Creating account "${request.username}" on "${targetWiki}" by admin "${req.session.username}"`);

    // MOCK MODE CREATION (if session has no valid access token)
    if (!req.session.accessToken) {
      if (isProduction) {
        return res.status(400).json({ success: false, error: 'সেশন টোকেন পাওয়া যায়নি। অনুগ্রহ করে আবার লগ ইন করুন।' });
      }
      console.log(`[MOCK MODE] Account "${request.username}" successfully created on "${targetWiki}"!`);
      
      // Update database status
      await db.run(
        "UPDATE requests SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_reason = ?, error_message = NULL WHERE id = ?",
        req.session.username,
        reason ? reason.trim() : null,
        requestId
      );
      
      // --- EDIT/POST MOCK WELCOME MESSAGE ON TALK PAGE ---
      try {
         const welcomeMessageSetting = await db.get("SELECT value FROM settings WHERE key = 'welcome_message'");
         let welcomeText = welcomeMessageSetting ? welcomeMessageSetting.value : '';
         if (welcomeText.trim()) {
           welcomeText = welcomeText.replaceAll('{{username}}', request.username);
           console.log(`[MOCK MODE] Posted welcome message on "User talk:${request.username}":\n${welcomeText}`);
         }
      } catch (welcomeErr) {
        console.error("Mock welcome message error:", welcomeErr);
      }
      
      return res.json({ success: true, username: request.username });
    }

    // --- REAL ACCOUNT CREATION VIA MEDIAWIKI API ---

    // 1. Fetch createaccount token
    let tokenData;
    try {
      tokenData = await queryWikiAPI(targetWiki, {
        action: 'query',
        meta: 'tokens',
        type: 'createaccount',
        format: 'json',
        formatversion: '2'
      }, req.session.accessToken);
    } catch (tokenErr) {
      console.error("Token fetch failed:", tokenErr);
      throw new Error(`টোকেন আনতে ব্যর্থ হয়েছে: ${tokenErr.message}`);
    }


    const createToken = tokenData.query && tokenData.query.tokens && tokenData.query.tokens.createaccounttoken;
    if (!createToken) {
      throw new Error("সিস্টেম থেকে ক্রিয়েট অ্যাকাউন্ট টোকেন পাওয়া যায়নি।");
    }

    // 2. Call action=createaccount API
    let creationData;
    const returnUrl = req.protocol + '://' + req.get('host') + '/';
    try {
      creationData = await postWikiAPI(targetWiki, {
        action: 'createaccount',
        username: request.username,
        email: request.email,
        mailpassword: 'true',
        reason: summaryReason,
        createtoken: createToken,
        createreturnurl: returnUrl,
        format: 'json',
        formatversion: '2'
      }, req.session.accessToken);
    } catch (creationErr) {
      console.error("Creation POST call failed:", creationErr);
      throw new Error(`অ্যাকাউন্ট তৈরির সাবমিশন ব্যর্থ হয়েছে: ${creationErr.message}`);
    }

    console.log("MediaWiki createaccount API response:", JSON.stringify(creationData));

    if (creationData.error) {
      const errorMsg = creationData.error.info || creationData.error.code || JSON.stringify(creationData.error);
      throw new Error(`মিডিয়াউইকি এপিআই ত্রুটি: ${errorMsg}`);
    }

    const result = creationData.createaccount;
    if (!result) {
      throw new Error("সার্ভার থেকে কোনো বৈধ রেসপন্স পাওয়া যায়নি।");
    }

    if (result.status === 'PASS') {
      // Account created successfully! Update Database status
      await db.run(
        "UPDATE requests SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_reason = ?, error_message = NULL WHERE id = ?",
        req.session.username,
        reason ? reason.trim() : null,
        requestId
      );
      console.log(`Account "${request.username}" successfully created on "${targetWiki}".`);

      
      // --- EDIT/POST WELCOME MESSAGE ON TALK PAGE ---
      try {
        const welcomeMessageSetting = await db.get("SELECT value FROM settings WHERE key = 'welcome_message'");
        let welcomeText = welcomeMessageSetting ? welcomeMessageSetting.value : '';
        
        if (welcomeText.trim()) {
          welcomeText = welcomeText.replaceAll('{{username}}', request.username);
          
          console.log(`Posting welcome message to "User talk:${request.username}" on "${targetWiki}"`);
          
          // 1. Fetch edit token (csrf)
          const tokenData = await queryWikiAPI(targetWiki, {
            action: 'query',
            meta: 'tokens',
            type: 'csrf',
            format: 'json',
            formatversion: '2'
          }, req.session.accessToken);
          
          const csrfToken = tokenData.query && tokenData.query.tokens && tokenData.query.tokens.csrftoken;
          if (csrfToken) {
            // 2. Post edit to User talk page
            const editResult = await postWikiAPI(targetWiki, {
              action: 'edit',
              title: `User talk:${request.username}`,
              text: welcomeText,
              summary: 'নতুন ব্যবহারকারীকে স্বাগত জানানো হলো (অ্যাকাউন্ট তৈরির ড্যাশবোর্ড)',
              token: csrfToken,
              format: 'json',
              formatversion: '2'
            }, req.session.accessToken);
            
            if (editResult.edit && editResult.edit.result === 'Success') {
              console.log(`Successfully posted welcome message to "User talk:${request.username}" on "${targetWiki}".`);
            } else {
              console.warn(`Failed to post welcome message:`, editResult);
            }
          } else {
            console.warn("Failed to retrieve csrf token for posting welcome message.");
          }
        }
      } catch (welcomeErr) {
        console.error("Error posting welcome message to talk page:", welcomeErr);
      }
      
      res.json({ success: true, username: request.username });
    } else {
      // Failed account creation
      const wikiError = result.message || `অ্যাকাউন্ট তৈরি করা যায়নি (স্ট্যাটাস: ${result.status})`;
      
      // Save the error log in the database
      await db.run(
        "UPDATE requests SET error_message = ? WHERE id = ?",
        wikiError,
        requestId
      );
      
      console.warn(`Failed to create account "${request.username}" on "${targetWiki}": ${wikiError}`);
      res.json({ success: false, error: wikiError });
    }

  } catch (err) {
    console.error("Approve request error:", err);
    
    // Save general error message in requests DB
    try {
      const db = await getDatabase();
      await db.run("UPDATE requests SET error_message = ? WHERE id = ?", err.message, requestId);
    } catch (dbErr) {
      console.error("Failed to write error to database:", dbErr);
    }
    
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Account Creation Dashboard is running on http://localhost:${PORT}`);
});

const crypto = require('crypto');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
}

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function wantsJson(req) {
  return req.originalUrl.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
}

// Every session gets a CSRF token. Pages expose it in a <meta> tag and forms;
// state-changing requests must send it back.
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const sent = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || (req.body && req.body._csrf);
    if (!tokensMatch(sent, req.session.csrfToken)) {
      const message = 'নিরাপত্তা যাচাই ব্যর্থ হয়েছে। পাতাটি রিলোড করে আবার চেষ্টা করুন।';
      if (wantsJson(req)) {
        return res.status(403).json({ success: false, code: 'csrf', error: message });
      }
      return res.status(403).send(message);
    }
  }
  next();
}

// Fixed-window counters kept in memory. Participants at one event usually
// share a single Wi-Fi IP, so limits apply per browser session (tight) and per
// IP (generous, only stops floods).
class RateLimiter {
  constructor({ maxKeys = 100000 } = {}) {
    this.buckets = new Map();
    this.maxKeys = maxKeys;
    this.timer = setInterval(() => this.sweep(), 60 * 1000);
    this.timer.unref();
  }

  hit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && this.buckets.size >= this.maxKeys) this.sweep(true);
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return { blocked: bucket.count > limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  sweep(force = false) {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
    // Still full after removing expired windows: drop the oldest entries
    if (force && this.buckets.size >= this.maxKeys) {
      const drop = Math.ceil(this.maxKeys / 10);
      let i = 0;
      for (const key of this.buckets.keys()) {
        if (i++ >= drop) break;
        this.buckets.delete(key);
      }
    }
  }

  middleware(name, { perSession, perIp, windowMs }) {
    return (req, res, next) => {
      const bySession = this.hit(`${name}:s:${req.sessionID}`, perSession, windowMs);
      const byIp = this.hit(`${name}:ip:${req.ip}`, perIp, windowMs);
      const blocked = bySession.blocked ? bySession : byIp.blocked ? byIp : null;
      if (blocked) {
        const message = 'অতিরিক্ত রিকোয়েস্ট করা হয়েছে। অনুগ্রহ করে কিছু সময় পর আবার চেষ্টা করুন।';
        res.setHeader('Retry-After', String(blocked.retryAfter));
        return res.status(429).json({ success: false, valid: false, code: 'rate_limited', error: message, reason: message });
      }
      next();
    };
  }

  close() {
    clearInterval(this.timer);
  }
}

const AUTH_MESSAGE = 'আপনার সেশনের মেয়াদ শেষ হয়েছে। অনুগ্রহ করে আবার লগ ইন করুন।';

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (wantsJson(req)) {
    return res.status(401).json({ success: false, code: 'auth_required', error: AUTH_MESSAGE });
  }
  res.redirect('/login');
}

function requireDeveloper(req, res, next) {
  if (req.session && req.session.isDeveloper) return next();
  const message = 'দুঃখিত, এই কাজটি শুধুমাত্র ডেভেলপাররা করতে পারেন।';
  if (wantsJson(req)) {
    return res.status(403).json({ success: false, code: 'forbidden', error: message });
  }
  res.status(403).send(message);
}

module.exports = { securityHeaders, csrf, RateLimiter, requireAdmin, requireDeveloper, tokensMatch, wantsJson, AUTH_MESSAGE };

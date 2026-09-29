const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { formatBn, eventPhase, isRegistrationOpen, utcIsoToBdLocal } = require('./time');

// Short hash of the built assets so browsers fetch new CSS/JS after a deploy
function assetVersion(publicDir) {
  const hash = crypto.createHash('sha1');
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(css|js|svg)$/.test(entry.name)) hash.update(fs.readFileSync(full));
    }
  };
  if (fs.existsSync(publicDir)) walk(publicDir);
  return hash.digest('hex').slice(0, 10);
}

const PHASE_LABELS = { ongoing: 'চলমান', upcoming: 'আসন্ন', finished: 'সমাপ্ত' };
const STATUS_LABELS = { pending: 'অপেক্ষমাণ', processing: 'প্রক্রিয়াধীন', approved: 'অনুমোদিত', declined: 'বাতিল' };

function formatNumber(n) {
  return Number(n || 0).toLocaleString('bn-BD');
}

// JSON for <script type="application/json">, safe against "</script>"
function pageData(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function createLocals({ config, data }) {
  const version = assetVersion(path.join(config.rootDir, 'public'));

  function asset(file) {
    return `/static/${file}?v=${version}`;
  }

  // SVG icon from the sprite built by scripts/build-assets.js
  function icon(name, className = '') {
    return `<svg class="icon ${className}" aria-hidden="true" focusable="false"><use href="${asset('icons.svg')}#${name}"></use></svg>`;
  }

  return (req, res, next) => {
    const s = req.session || {};
    res.locals.user = s.isAdmin ? { username: s.username, isDeveloper: !!s.isDeveloper, adminWiki: s.adminWiki, isMock: !!s.isMock } : null;
    res.locals.currentPath = req.path;
    res.locals.navEvents = data.openEvents().slice(0, 8).map(e => ({ id: e.id, name: e.name }));
    res.locals.contactEmail = config.contactEmail;
    res.locals.retentionDays = config.emailRetentionDays;
    res.locals.asset = asset;
    res.locals.icon = icon;
    res.locals.formatBn = formatBn;
    res.locals.formatNumber = formatNumber;
    res.locals.eventPhase = eventPhase;
    res.locals.isRegistrationOpen = isRegistrationOpen;
    res.locals.utcIsoToBdLocal = utcIsoToBdLocal;
    res.locals.phaseLabels = PHASE_LABELS;
    res.locals.statusLabels = STATUS_LABELS;
    res.locals.pageData = pageData;
    res.locals.title = 'ইভেন্ট ড্যাশবোর্ড';
    next();
  };
}

module.exports = { createLocals, pageData, formatNumber, PHASE_LABELS, STATUS_LABELS };

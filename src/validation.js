// Input validation and normalisation shared by all routes.

const EMAIL_REGEX = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_REGEX.test(email);
}

// Normalise a username the way MediaWiki does: Unicode NFC, underscores become
// spaces, repeated spaces collapse and the first letter is capitalised.
function normalizeUsername(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name.normalize('NFC').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Characters MediaWiki never allows in usernames
// eslint-disable-next-line no-control-regex
const INVALID_USERNAME_CHARS = /[#<>[\]|{}@:=/\\\u0000-\u001f\u007f]/;
const IP_LIKE = /^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f:]+:[0-9a-f:]*$/i;

// Returns a Bangla error message, or null when the name looks usable
function usernameProblem(username) {
  if (!username || [...username].length < 3) return 'ব্যবহারকারী নাম কমপক্ষে ৩ অক্ষরের হতে হবে।';
  if ([...username].length > 85) return 'ব্যবহারকারী নাম ৮৫ অক্ষরের বেশি হতে পারবে না।';
  if (INVALID_USERNAME_CHARS.test(username)) return 'নামে # < > [ ] | { } @ : = / \\ অক্ষরগুলো ব্যবহার করা যাবে না।';
  if (IP_LIKE.test(username)) return 'আইপি ঠিকানা ব্যবহারকারী নাম হিসেবে ব্যবহার করা যাবে না।';
  return null;
}

// Only Wikimedia wikis may be used as stats or account-creation targets
const WIKI_DOMAIN_REGEX = /^([a-z0-9-]+\.)?(wikipedia|wiktionary|wikibooks|wikinews|wikiquote|wikisource|wikiversity|wikivoyage|wikimedia|wikidata|mediawiki|wikifunctions)\.org$/;

function isWikimediaDomain(domain) {
  return typeof domain === 'string' && WIKI_DOMAIN_REGEX.test(domain);
}

function parseWikiList(value) {
  const wikis = String(value || '')
    .split(/[,\n]/)
    .map(w => w.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const unique = [...new Set(wikis)];
  return { wikis: unique, invalid: unique.filter(w => !isWikimediaDomain(w)) };
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const NAMESPACE_REGEX = /^(all|\d{1,4}(,\d{1,4})*)$/;

function optionalText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function optionalPositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 100000 ? n : undefined;
}

// Validate the event form. Times arrive as Bangladesh local "YYYY-MM-DDTHH:mm".
// Returns { error } or { values } with UTC ISO times.
function validateEventInput(body, { bdLocalToUtcIso, adminWikis = [] }) {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { error: 'ইভেন্টের নাম আবশ্যক।' };
  if (name.length > 150) return { error: 'ইভেন্টের নাম ১৫০ অক্ষরের বেশি হতে পারবে না।' };

  const workshopUrl = typeof body.workshop_url === 'string' && body.workshop_url.trim() ? body.workshop_url.trim() : '';
  if (workshopUrl && (!isValidHttpUrl(workshopUrl) || workshopUrl.length > 500)) {
    return { error: 'কর্মশালার ইউআরএলটি সঠিক নয় (http:// বা https:// দিয়ে শুরু হতে হবে)।' };
  }

  const start = bdLocalToUtcIso(body.start_time);
  const end = bdLocalToUtcIso(body.end_time);
  if (!start || !end) return { error: 'ইভেন্টের শুরু ও শেষের সময় সঠিকভাবে দিন।' };
  if (end <= start) return { error: 'ইভেন্ট শেষের সময় অবশ্যই শুরুর সময়ের পরে হতে হবে।' };

  const { wikis, invalid } = parseWikiList(body.target_wikis || 'bn.wikipedia.org');
  if (invalid.length > 0) {
    return { error: `এই উইকিগুলো গ্রহণযোগ্য নয়: ${invalid.join(', ')}। শুধুমাত্র উইকিমিডিয়া প্রকল্পের ডোমেইন (যেমন bn.wikipedia.org) দিন।` };
  }
  if (wikis.length === 0) return { error: 'অন্তত একটি টার্গেট উইকি দিন।' };
  if (wikis.length > 10) return { error: 'সর্বোচ্চ ১০টি টার্গেট উইকি দেওয়া যাবে।' };

  const namespaces = typeof body.target_namespaces === 'string' && body.target_namespaces.trim() ? body.target_namespaces.replace(/\s+/g, '') : 'all';
  if (!NAMESPACE_REGEX.test(namespaces)) return { error: 'নেমস্পেস তালিকা সঠিক নয়।' };

  const accountWiki = typeof body.account_wiki === 'string' && body.account_wiki ? body.account_wiki : null;
  if (accountWiki && !adminWikis.includes(accountWiki)) {
    return { error: 'অ্যাকাউন্ট তৈরির উইকিটি গ্রহণযোগ্য নয়।' };
  }

  const goalEdits = optionalPositiveInt(body.goal_edits);
  const goalArticles = optionalPositiveInt(body.goal_articles);
  if (goalEdits === undefined || goalArticles === undefined) {
    return { error: 'লক্ষ্যমাত্রা অবশ্যই একটি ধনাত্মক পূর্ণসংখ্যা হতে হবে।' };
  }

  const welcome = optionalText(body.welcome_message, 10000);
  const instructions = optionalText(body.instructions, 5000);

  return {
    values: {
      name,
      workshop_url: workshopUrl || null,
      start_time: start,
      end_time: end,
      target_wikis: wikis.join(','),
      target_namespaces: namespaces,
      account_wiki: accountWiki,
      registration_active: body.registration_active === false || body.registration_active === 0 || body.registration_active === '0' ? 0 : 1,
      allow_self_enroll: body.allow_self_enroll === false || body.allow_self_enroll === 0 || body.allow_self_enroll === '0' ? 0 : 1,
      welcome_message: welcome,
      instructions,
      goal_edits: goalEdits,
      goal_articles: goalArticles
    }
  };
}

// Prevent spreadsheet formula injection and quote values for CSV
function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  let str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

// Build a UTF-8 CSV (with BOM so Excel shows Bangla correctly)
function toCSV(headers, rows) {
  const lines = [headers.map(escapeCSV).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCSV).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// "someone@gmail.com" -> "so*****@gmail.com"
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

module.exports = {
  isValidEmail,
  normalizeUsername,
  usernameProblem,
  isWikimediaDomain,
  parseWikiList,
  isValidHttpUrl,
  validateEventInput,
  escapeCSV,
  toCSV,
  maskEmail,
  WIKI_DOMAIN_REGEX
};

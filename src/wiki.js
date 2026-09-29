const { isWikimediaDomain, normalizeUsername, usernameProblem } = require('./validation');

const UNAVAILABLE_MESSAGE = 'উইকিপিডিয়া সার্ভারের সাথে যোগাযোগ করতে ব্যর্থ হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।';

class WikiError extends Error {
  constructor(message, { code = null, unavailable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WikiError';
    this.code = code;
    this.unavailable = unavailable;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Requests made while a person waits: fail fast with one quick retry
const INTERACTIVE = { retries: 1, retryDelayMs: 300, timeoutMs: 10000 };

// Normalise both MediaWiki error formats into { code, text }
function apiError(data) {
  if (!data) return null;
  if (data.error) {
    return { code: data.error.code, text: data.error.info || data.error.text || data.error.code };
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const e = data.errors[0];
    return { code: e.code, text: e.text || e['*'] || e.html || e.code };
  }
  return null;
}

// Bangla explanations for common account-creation failures
function explainCreateError(code, fallback) {
  const c = String(code || '');
  if (c === 'userexists') return 'এই ব্যবহারকারী নামটি ইতিমধ্যে অন্য কেউ নিয়ে নিয়েছেন। নাম পরিবর্তন করে আবার চেষ্টা করুন।';
  if (c.includes('throttle')) return 'অ্যাকাউন্ট তৈরির সীমা অতিক্রম হয়েছে। আপনার অ্যাকাউন্টে এই সীমা এড়ানোর অধিকার (যেমন sysop বা accountcreator) আছে কিনা দেখুন, অথবা কিছুক্ষণ পরে চেষ্টা করুন।';
  if (c.includes('block') || c.startsWith('cantcreateaccount')) return 'এই আইপি বা অ্যাকাউন্ট থেকে অ্যাকাউন্ট তৈরি করা ব্লক করা আছে।';
  if (c.includes('email')) return 'ইমেইল ঠিকানাটি উইকিপিডিয়া গ্রহণ করেনি। আবেদনকারীকে সঠিক ইমেইল দিয়ে আবার আবেদন করতে বলুন।';
  if (c.startsWith('antispoof')) return 'নামটি বিদ্যমান একটি নামের সাথে প্রায় একই দেখায় (AntiSpoof)। নাম পরিবর্তন করে আবার চেষ্টা করুন।';
  if (c.startsWith('titleblacklist')) return 'নামটি উইকিপিডিয়ার নিষিদ্ধ নামের তালিকায় আছে। নাম পরিবর্তন করে আবার চেষ্টা করুন।';
  if (c === 'noname' || c === 'invaliduser') return 'নামটি উইকিপিডিয়ার ব্যবহারকারী নাম হিসেবে গ্রহণযোগ্য নয়।';
  if (c.startsWith('mwoauth') || c === 'badtoken' || c === 'notloggedin') return 'আপনার উইকিপিডিয়া লগ ইনের মেয়াদ শেষ হয়েছে। অনুগ্রহ করে লগ আউট করে আবার লগ ইন করুন।';
  if (c === 'permissiondenied') return 'আপনার অ্যাকাউন্টের এই উইকিতে অ্যাকাউন্ট তৈরির অনুমতি নেই।';
  return fallback ? `উইকিপিডিয়া অ্যাকাউন্টটি তৈরি করেনি: ${fallback}` : 'উইকিপিডিয়া অ্যাকাউন্টটি তৈরি করেনি।';
}

function createWikiClient(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
  function apiUrl(wiki) {
    if (!isWikimediaDomain(wiki)) {
      throw new WikiError(`Refusing to contact non-Wikimedia host: ${wiki}`);
    }
    return config.wikiApiUrlTemplate.replace('{wiki}', wiki);
  }

  // One MediaWiki Action API request, with timeout and maxlag/5xx retries
  async function call(wiki, params, { method = 'GET', accessToken = null, maxlag = false, timeoutMs = 20000, retries = 2, retryDelayMs = 2000 } = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ format: 'json', formatversion: '2', ...params, ...(maxlag ? { maxlag: '5' } : {}) })) {
      if (value !== undefined && value !== null) search.append(key, String(value));
    }
    const headers = { 'User-Agent': config.userAgent };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    let url = apiUrl(wiki);
    let body;
    if (method === 'GET') {
      url += `?${search}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = search.toString();
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, { method, headers, body, signal: controller.signal });
      } catch (err) {
        if (attempt < retries) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        throw new WikiError(UNAVAILABLE_MESSAGE, { unavailable: true, cause: err });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(Math.min(Number(res.headers.get('retry-after')) * 1000 || Infinity, retryDelayMs * (attempt + 1)));
          continue;
        }
        throw new WikiError(UNAVAILABLE_MESSAGE, { unavailable: true, code: `http_${res.status}` });
      }
      const data = await res.json();
      const err = apiError(data);
      if (err && err.code === 'maxlag' && attempt < retries) {
        await sleep((Number(res.headers.get('retry-after')) || 5) * 1000);
        continue;
      }
      return data;
    }
  }

  // Short-lived cache so students retyping a name do not hit the wiki again
  const checkCache = new Map();
  function cached(key) {
    const hit = checkCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    checkCache.delete(key);
    return null;
  }
  function remember(key, value) {
    if (checkCache.size > 5000) checkCache.clear();
    checkCache.set(key, { value, expires: Date.now() + 60 * 1000 });
  }

  // Can a new account with this name be created? Returns { valid, reason, code }
  async function checkUsername(rawName) {
    const name = normalizeUsername(rawName);
    const problem = usernameProblem(name);
    if (problem) return { valid: false, reason: problem, code: 'invalid' };
    const hit = cached(name);
    if (hit) return hit;

    const wiki = config.usernameCheckWiki;
    const [usersRes, spoofRes, blacklistRes] = await Promise.allSettled([
      call(wiki, { action: 'query', list: 'users', ususers: name, usprop: 'cancreate', meta: 'globaluserinfo', guiuser: name, errorformat: 'plaintext', uselang: 'bn' }, INTERACTIVE),
      call(wiki, { action: 'antispoof', username: name }, { retries: 0 }),
      call(wiki, { action: 'titleblacklist', tbaction: 'new-account', tbtitle: `User:${name}` }, { retries: 0 })
    ]);
    if (usersRes.status === 'rejected') throw usersRes.reason;

    const result = evaluateUsernameCheck(name, usersRes.value,
      spoofRes.status === 'fulfilled' ? spoofRes.value : null,
      blacklistRes.status === 'fulfilled' ? blacklistRes.value : null);
    remember(name, result);
    return result;
  }

  function evaluateUsernameCheck(name, usersData, spoofData, blacklistData) {
    const err = apiError(usersData);
    if (err) {
      if (err.code === 'invaliduser' || err.code === 'baduser') {
        return { valid: false, code: 'invalid', reason: 'নামটি উইকিপিডিয়ার ব্যবহারকারী নাম হিসেবে গ্রহণযোগ্য নয়। অন্য একটি নাম চেষ্টা করুন।' };
      }
      throw new WikiError(UNAVAILABLE_MESSAGE, { unavailable: true, code: err.code });
    }
    const user = usersData.query && usersData.query.users && usersData.query.users[0];
    if (!user || user.invalid) {
      return { valid: false, code: 'invalid', reason: 'নামটি উইকিপিডিয়ার ব্যবহারকারী নাম হিসেবে গ্রহণযোগ্য নয়। অন্য একটি নাম চেষ্টা করুন।' };
    }
    if (!user.missing) {
      return { valid: false, code: 'exists', reason: 'এই ব্যবহারকারী নামটি ইতিমধ্যে নেওয়া হয়েছে।' };
    }
    const global = usersData.query.globaluserinfo;
    if (global && !global.missing) {
      return { valid: false, code: 'exists', reason: 'এই নামে উইকিমিডিয়ার একটি বৈশ্বিক (SUL) অ্যাকাউন্ট ইতিমধ্যে আছে।' };
    }
    if (user.cancreate === false) {
      const first = (user.cancreateerror || [])[0] || {};
      return { valid: false, code: first.code || 'cannot_create', reason: first.text ? `এই নামে অ্যাকাউন্ট তৈরি করা যাবে না: ${first.text}` : 'এই নামে অ্যাকাউন্ট তৈরি করা যাবে না।' };
    }
    const spoof = spoofData && spoofData.antispoof;
    if (spoof && spoof.result === 'conflict') {
      const similar = (spoof.users || []).slice(0, 3).join(', ');
      return { valid: false, code: 'antispoof', reason: `নামটি বিদ্যমান ${similar ? `"${similar}"` : 'একটি'} নামের সাথে প্রায় একই দেখায় (AntiSpoof)। একটু ভিন্ন নাম বেছে নিন।` };
    }
    if (spoof && spoof.result === 'error') {
      return { valid: false, code: 'antispoof', reason: 'নামটিতে এমন অক্ষর আছে যা উইকিপিডিয়ায় ব্যবহার করা যায় না।' };
    }
    const blacklist = blacklistData && blacklistData.titleblacklist;
    if (blacklist && blacklist.result === 'blacklisted') {
      return { valid: false, code: 'titleblacklist', reason: 'নামটি উইকিপিডিয়ার নিষিদ্ধ নামের তালিকার সাথে মিলে যায়। অন্য একটি নাম চেষ্টা করুন।' };
    }
    return { valid: true, code: 'ok' };
  }

  // Up to three similar names that are free, e.g. "Rahim Uddin 2026"
  async function suggestUsernames(rawName) {
    const base = normalizeUsername(rawName);
    if (!base) return [];
    const year = new Date().getFullYear();
    const two = () => String(10 + Math.floor(Math.random() * 90));
    const candidates = [...new Set([`${base} ${year}`, `${base} ${two()}`, `${base} ${two()}${two()}`, `${base} BD`])]
      .map(normalizeUsername)
      .filter(c => !usernameProblem(c));
    if (candidates.length === 0) return [];
    const data = await call(config.usernameCheckWiki, { action: 'query', list: 'users', ususers: candidates.join('|'), usprop: 'cancreate' }, INTERACTIVE);
    const free = ((data.query && data.query.users) || [])
      .filter(u => u.missing && !u.invalid && u.cancreate !== false)
      .map(u => u.name);
    const checks = await Promise.allSettled(free.slice(0, 4).map(async name => {
      const result = await checkUsername(name);
      return result.valid ? name : null;
    }));
    return checks.filter(c => c.status === 'fulfilled' && c.value).map(c => c.value).slice(0, 3);
  }

  // Look up many users (50 per request). Returns Map(name -> { exists, invalid })
  async function lookupUsers(wiki, names) {
    const result = new Map();
    for (let i = 0; i < names.length; i += 50) {
      const batch = names.slice(i, i + 50);
      const data = await call(wiki, { action: 'query', list: 'users', ususers: batch.join('|') });
      const err = apiError(data);
      if (err) throw new WikiError(err.text, { code: err.code });
      for (const u of (data.query && data.query.users) || []) {
        result.set(normalizeUsername(u.name), { exists: !u.missing && !u.invalid, invalid: !!u.invalid, name: u.name });
      }
    }
    return result;
  }

  // Does a global (SUL) account with this name exist? Returns the canonical name or null.
  async function globalUser(username) {
    const data = await call(config.usernameCheckWiki, { action: 'query', meta: 'globaluserinfo', guiuser: username }, INTERACTIVE);
    const err = apiError(data);
    if (err) {
      if (err.code === 'invaliduser' || err.code === 'baduser') return null;
      throw new WikiError(UNAVAILABLE_MESSAGE, { unavailable: true, code: err.code });
    }
    const info = data.query && data.query.globaluserinfo;
    return info && !info.missing ? info.name || username : null;
  }

  // Resolve names against a wiki, falling back to the global account list for
  // people who have never visited that wiki. Returns Map(name -> canonical name | null)
  async function resolveUsers(wikiName, names) {
    const local = await lookupUsers(wikiName, names);
    const result = new Map();
    const unknown = [];
    for (const name of names) {
      const hit = local.get(name);
      if (hit && hit.exists) result.set(name, hit.name);
      else if (hit && hit.invalid) result.set(name, null);
      else unknown.push(name);
    }
    for (let i = 0; i < unknown.length; i += 5) {
      await Promise.all(unknown.slice(i, i + 5).map(async name => result.set(name, await globalUser(name))));
    }
    return result;
  }

  // The user's groups on a wiki, or null when the wiki could not be asked
  async function getUserGroups(wiki, username) {
    try {
      const data = await call(wiki, { action: 'query', list: 'users', ususers: username, usprop: 'groups' }, INTERACTIVE);
      if (apiError(data)) return null;
      const user = data.query && data.query.users && data.query.users[0];
      return (user && user.groups) || [];
    } catch (err) {
      log.error(`Failed to query user groups on ${wiki}:`, err.message);
      return null;
    }
  }

  async function getToken(wiki, type, accessToken) {
    const data = await call(wiki, { action: 'query', meta: 'tokens', type }, { accessToken });
    const err = apiError(data);
    if (err) throw new WikiError(explainCreateError(err.code, err.text), { code: err.code });
    const token = data.query && data.query.tokens && data.query.tokens[`${type}token`];
    if (!token) throw new WikiError('উইকিপিডিয়া থেকে টোকেন পাওয়া যায়নি।', { code: 'notoken' });
    return token;
  }

  // Create an account; the wiki emails a temporary password to the address.
  // Returns { status: 'PASS' | 'FAIL' | ..., code, message }
  async function createAccount(wiki, { username, email, reason, returnUrl }, accessToken) {
    const createtoken = await getToken(wiki, 'createaccount', accessToken);
    const data = await call(wiki, {
      action: 'createaccount',
      username,
      email,
      mailpassword: '1',
      reason,
      createtoken,
      createreturnurl: returnUrl,
      errorformat: 'plaintext',
      uselang: 'bn'
    }, { method: 'POST', accessToken, retries: 0 });
    const err = apiError(data);
    if (err) return { status: 'ERROR', code: err.code, message: err.text };
    const r = data.createaccount || {};
    return { status: r.status || 'ERROR', code: r.messagecode || null, message: r.message || null };
  }

  // Post the welcome message on a new user's talk page (never overwrites)
  async function postWelcome(wiki, username, text, accessToken) {
    try {
      const token = await getToken(wiki, 'csrf', accessToken);
      const data = await call(wiki, {
        action: 'edit',
        title: `User talk:${username}`,
        text,
        summary: 'নতুন ব্যবহারকারীকে স্বাগত জানানো হলো (ইভেন্ট ড্যাশবোর্ড)',
        createonly: '1',
        token
      }, { method: 'POST', accessToken, retries: 0 });
      if (data.edit && data.edit.result === 'Success') return 'posted';
      const err = apiError(data);
      if (err && err.code === 'articleexists') return 'exists';
      log.warn(`Welcome message not posted for ${username}:`, err ? err.code : JSON.stringify(data));
      return 'failed';
    } catch (err) {
      log.warn(`Welcome message not posted for ${username}:`, err.message);
      return 'failed';
    }
  }

  // Did `performer` create this account? Used to recover when an earlier
  // attempt created the account but the tool never recorded it.
  async function wasCreatedBy(wiki, username, performer) {
    const data = await call(wiki, { action: 'query', list: 'logevents', letype: 'newusers', letitle: `User:${username}`, lelimit: '10', leprop: 'user|type|timestamp' });
    const events = (data.query && data.query.logevents) || [];
    return events.some(e => normalizeUsername(e.user) === normalizeUsername(performer));
  }

  // All contributions by up to 50 users between two UTC times
  async function fetchContribs(wiki, usernames, { start, end, namespaces = 'all' }) {
    const rows = [];
    let cont = {};
    do {
      const params = {
        action: 'query',
        list: 'usercontribs',
        ucuser: usernames.join('|'),
        ucstart: start,
        ucend: end,
        ucdir: 'newer',
        uclimit: 'max',
        ucprop: 'ids|title|timestamp|sizediff|flags',
        ...cont
      };
      if (namespaces && namespaces !== 'all') {
        params.ucnamespace = namespaces.split(',').join('|');
      }
      const data = await call(wiki, params, { maxlag: true });
      const err = apiError(data);
      if (err) throw new WikiError(err.text, { code: err.code });
      for (const c of (data.query && data.query.usercontribs) || []) {
        rows.push({
          revid: c.revid,
          username: c.user,
          title: c.title,
          ns: c.ns,
          timestamp: c.timestamp,
          sizediff: typeof c.sizediff === 'number' ? c.sizediff : 0,
          is_new: c.new ? 1 : 0
        });
      }
      cont = data.continue || null;
    } while (cont);
    return rows;
  }

  return { call, checkUsername, suggestUsernames, lookupUsers, globalUser, resolveUsers, getUserGroups, createAccount, postWelcome, wasCreatedBy, fetchContribs };
}

module.exports = { createWikiClient, WikiError, apiError, explainCreateError, UNAVAILABLE_MESSAGE };

const { normalizeUsername, usernameProblem } = require('./validation');
const { explainCreateError, WikiError } = require('./wiki');
const { nowIso } = require('./time');

const RELOGIN_MESSAGE = 'আপনার উইকিপিডিয়া লগ ইনের মেয়াদ শেষ হয়েছে। অনুগ্রহ করে লগ আউট করে আবার লগ ইন করুন।';

// Approving, declining and editing account requests
function createAccountService({ db, wiki, stats, audit, data, log = console }) {
  const q = {
    request: db.prepare('SELECT * FROM requests WHERE id = ?'),
    claim: db.prepare("UPDATE requests SET status = 'processing', decided_by = ?, error_message = NULL WHERE id = ? AND status = 'pending'"),
    release: db.prepare("UPDATE requests SET status = 'pending', decided_by = NULL, error_message = ? WHERE id = ? AND status = 'processing'"),
    approve: db.prepare(`
      UPDATE requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_reason = ?, error_message = NULL, created_on_wiki = ?
      WHERE id = ?`),
    welcome: db.prepare('UPDATE requests SET welcome_status = ? WHERE id = ?'),
    decline: db.prepare(`
      UPDATE requests SET status = 'declined', decided_by = ?, decided_at = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending'`),
    rename: db.prepare("UPDATE requests SET username = ?, error_message = NULL WHERE id = ? AND status = 'pending'"),
    addParticipant: db.prepare(`
      INSERT INTO participants (event_id, username, source, added_by, added_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (event_id, username) DO NOTHING`)
  };

  // Accounts are created on the event's chosen wiki when the admin has rights
  // there, otherwise on the admin's own wiki.
  function accountWikiFor(event, actor) {
    const wikis = actor.adminWikis || [];
    if (event && event.account_wiki && wikis.includes(event.account_wiki)) return event.account_wiki;
    return actor.adminWiki || wikis[0] || 'bn.wikipedia.org';
  }

  function welcomeText(event, username) {
    const template = (event && event.welcome_message) || data.getSetting('welcome_message', '');
    if (!template.trim()) return '';
    return template.replaceAll('{{username}}', username).replaceAll('{{event}}', event ? event.name : '');
  }

  function addParticipant(eventId, username, source, addedBy) {
    const result = q.addParticipant.run(eventId, username, source, addedBy || null, nowIso());
    if (result.changes > 0) stats.schedulePoll(eventId);
    return result.changes > 0;
  }

  function releaseWithError(requestId, message) {
    q.release.run(message, requestId);
  }

  // Create the account for one request. Returns { status, body } for the API.
  async function approve(actor, requestId, reason, { returnUrl, getAccessToken }) {
    const claimed = q.claim.run(actor.username, requestId);
    if (claimed.changes === 0) {
      const existing = q.request.get(requestId);
      if (!existing) return { status: 404, body: { success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' } };
      return { status: 409, body: { success: false, code: existing.status, error: 'আবেদনটি ইতিমধ্যে নিষ্পত্তি হয়েছে বা অন্য কেউ প্রক্রিয়া করছেন। তালিকাটি রিফ্রেশ করুন।' } };
    }

    const request = q.request.get(requestId);
    const event = request.event_id ? data.getEvent(request.event_id) : null;
    const accountWiki = accountWikiFor(event, actor);
    let summary = `${event ? event.name : 'ইভেন্ট'}-এর অংশগ্রহণকারীর জন্য অ্যাকাউন্ট তৈরি করা হলো।`;
    if (reason) summary += ` (${reason})`;

    try {
      let recovered = false;
      let accessToken = null;
      if (actor.isMock) {
        log.log(`[MOCK LOGIN] Pretending to create "${request.username}" on ${accountWiki}.`);
      } else {
        accessToken = await getAccessToken();
        if (!accessToken) {
          releaseWithError(requestId, null);
          return { status: 401, body: { success: false, code: 'auth_required', error: RELOGIN_MESSAGE } };
        }
        if (!request.email) {
          releaseWithError(requestId, 'আবেদনে ইমেইল ঠিকানা নেই, তাই অ্যাকাউন্ট তৈরি করা যাবে না।');
          return { status: 400, body: { success: false, error: 'আবেদনে ইমেইল ঠিকানা নেই, তাই অ্যাকাউন্ট তৈরি করা যাবে না।' } };
        }
        const result = await wiki.createAccount(accountWiki, { username: request.username, email: request.email, reason: summary, returnUrl }, accessToken);
        if (result.status !== 'PASS') {
          // An earlier attempt may have created the account without the tool recording it
          if (result.code === 'userexists' && await wiki.wasCreatedBy(accountWiki, request.username, actor.username).catch(() => false)) {
            recovered = true;
          } else {
            const message = explainCreateError(result.code, result.message);
            releaseWithError(requestId, message);
            audit(actor.username, 'request.approve_failed', { eventId: request.event_id, target: request.username, details: { code: result.code, message: result.message } });
            const relogin = String(result.code || '').startsWith('mwoauth');
            return { status: relogin ? 401 : 200, body: { success: false, code: relogin ? 'auth_required' : result.code, error: message } };
          }
        }
      }

      q.approve.run(actor.username, nowIso(), reason || null, accountWiki, requestId);
      audit(actor.username, 'request.approve', { eventId: request.event_id, target: request.username, details: { wiki: accountWiki, recovered } });
      if (request.event_id) addParticipant(request.event_id, request.username, 'account', actor.username);

      let welcome = 'skipped';
      const text = welcomeText(event, request.username);
      if (text && !recovered) {
        welcome = actor.isMock ? 'posted' : await wiki.postWelcome(accountWiki, request.username, text, accessToken);
      }
      q.welcome.run(welcome, requestId);

      return { status: 200, body: { success: true, username: request.username, wiki: accountWiki, welcome, recovered } };
    } catch (err) {
      const message = err instanceof WikiError ? err.message : 'অ্যাকাউন্ট তৈরির সময় একটি অপ্রত্যাশিত সমস্যা হয়েছে।';
      if (!(err instanceof WikiError)) log.error('Approve request error:', err);
      releaseWithError(requestId, message);
      const relogin = err instanceof WikiError && /^(mwoauth|badtoken|notloggedin)/.test(String(err.code || ''));
      return { status: relogin ? 401 : 502, body: { success: false, code: relogin ? 'auth_required' : 'wiki_error', error: message } };
    }
  }

  function decline(actor, requestId, reason) {
    const result = q.decline.run(actor.username, nowIso(), reason || null, requestId);
    if (result.changes === 0) {
      const existing = q.request.get(requestId);
      if (!existing) return { status: 404, body: { success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' } };
      return { status: 409, body: { success: false, code: existing.status, error: 'আবেদনটি ইতিমধ্যে নিষ্পত্তি হয়েছে। তালিকাটি রিফ্রেশ করুন।' } };
    }
    const request = q.request.get(requestId);
    audit(actor.username, 'request.decline', { eventId: request.event_id, target: request.username, details: reason || null });
    return { status: 200, body: { success: true } };
  }

  // Change the username on a pending request (e.g. the name was taken meanwhile)
  async function rename(actor, requestId, rawName) {
    const request = q.request.get(requestId);
    if (!request) return { status: 404, body: { success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' } };
    if (request.status !== 'pending') return { status: 409, body: { success: false, error: 'শুধুমাত্র অপেক্ষমাণ আবেদনের নাম পরিবর্তন করা যায়।' } };
    const username = normalizeUsername(rawName);
    const problem = usernameProblem(username);
    if (problem) return { status: 400, body: { success: false, error: problem } };
    if (username === request.username) return { status: 200, body: { success: true, username } };

    const check = await wiki.checkUsername(username);
    if (!check.valid) return { status: 400, body: { success: false, error: check.reason } };
    try {
      if (q.rename.run(username, requestId).changes === 0) {
        return { status: 409, body: { success: false, error: 'আবেদনটি এর মধ্যে নিষ্পত্তি হয়ে গেছে। তালিকাটি রিফ্রেশ করুন।' } };
      }
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return { status: 400, body: { success: false, error: 'এই নামে আরেকটি আবেদন ইতিমধ্যে আছে।' } };
      }
      throw err;
    }
    audit(actor.username, 'request.rename', { eventId: request.event_id, target: username, details: { from: request.username } });
    return { status: 200, body: { success: true, username } };
  }

  return { approve, decline, rename, accountWikiFor, addParticipant };
}

module.exports = { createAccountService, RELOGIN_MESSAGE };

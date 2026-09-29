const express = require('express');
const { asyncHandler, sendCSV } = require('./util');
const { eventPhase, isRegistrationOpen, nowIso } = require('../time');
const { isValidEmail, normalizeUsername, usernameProblem, maskEmail, toCSV } = require('../validation');
const { WikiError, UNAVAILABLE_MESSAGE } = require('../wiki');
const { newToken } = require('../db');

function publicEvent(event) {
  return {
    id: event.id,
    name: event.name,
    workshop_url: event.workshop_url,
    start_time: event.start_time,
    end_time: event.end_time,
    target_wikis: event.target_wikis,
    target_namespaces: event.target_namespaces,
    phase: eventPhase(event),
    registration_open: isRegistrationOpen(event),
    allow_self_enroll: event.allow_self_enroll === 1
  };
}

function createPublicApi({ config, db, data, wiki, stats, limiter, log }) {
  const router = express.Router();
  const registerLimit = limiter.middleware('register', config.rateLimits.register);
  const checkLimit = limiter.middleware('check-username', config.rateLimits.checkUsername);

  const q = {
    liveByName: db.prepare("SELECT event_id FROM requests WHERE username = ? AND status IN ('pending', 'processing', 'approved')"),
    pendingByEmail: db.prepare("SELECT 1 FROM requests WHERE event_id = ? AND status IN ('pending', 'processing') AND lower(email) = lower(?)"),
    insertRequest: db.prepare(`
      INSERT INTO requests (event_id, username, email, status, status_token, requested_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`),
    byToken: db.prepare('SELECT * FROM requests WHERE status_token = ?'),
    participant: db.prepare('SELECT * FROM participants WHERE event_id = ? AND username = ?'),
    insertParticipant: db.prepare("INSERT INTO participants (event_id, username, source, added_at) VALUES (?, ?, 'self', ?)"),
    requestTotals: db.prepare("SELECT COUNT(*) AS submitted, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved FROM requests WHERE event_id = ?")
  };

  function wikiFailure(res, err) {
    if (err instanceof WikiError) {
      return res.status(502).json({ success: false, valid: false, error: err.message, reason: err.message });
    }
    throw err;
  }

  // Live username availability check while the student types
  router.get('/api/check-username', checkLimit, asyncHandler(async (req, res) => {
    const username = normalizeUsername(typeof req.query.username === 'string' ? req.query.username : '');
    const problem = usernameProblem(username);
    if (problem) return res.status(400).json({ valid: false, reason: problem, normalized: username });

    const live = q.liveByName.get(username);
    if (live) {
      return res.json({ valid: false, code: 'requested', normalized: username, reason: 'এই নামে ইতিমধ্যে একটি আবেদন জমা পড়েছে। অন্য একটি নাম বেছে নিন।' });
    }
    try {
      const result = await wiki.checkUsername(username);
      const body = { ...result, normalized: username };
      if (!result.valid && ['exists', 'antispoof', 'userexists'].includes(result.code)) {
        body.suggestions = await wiki.suggestUsernames(username).catch(() => []);
      }
      res.json(body);
    } catch (err) {
      wikiFailure(res, err);
    }
  }));

  async function register(req, res, event) {
    // Honeypot: real visitors never see or fill this field
    if (req.body.website) return res.json({ success: true });
    if (!event) return res.status(404).json({ success: false, error: 'ইভেন্টটি পাওয়া যায়নি।' });
    if (!isRegistrationOpen(event)) {
      return res.status(403).json({ success: false, error: 'দুঃখিত, এই ইভেন্টের নিবন্ধন এখন বন্ধ।' });
    }

    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const username = normalizeUsername(typeof req.body.username === 'string' ? req.body.username : '');
    if (!email || !username) return res.status(400).json({ success: false, error: 'সবগুলো ঘর পূরণ করা আবশ্যক।' });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, field: 'email', error: 'ইমেইল ঠিকানাটি সঠিক নয়।' });
    if (typeof req.body.email_confirm === 'string' && req.body.email_confirm.trim().toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ success: false, field: 'email_confirm', error: 'দুটি ইমেইল ঠিকানা মেলেনি। আবার দেখে নিন।' });
    }
    if (req.body.consent !== true && req.body.consent !== 'on' && req.body.consent !== '1') {
      return res.status(400).json({ success: false, field: 'consent', error: 'আবেদন জমা দিতে তথ্য ব্যবহারের শর্তে সম্মতি দিন।' });
    }
    const problem = usernameProblem(username);
    if (problem) return res.status(400).json({ success: false, field: 'username', error: problem });
    if (q.liveByName.get(username)) {
      return res.status(400).json({ success: false, field: 'username', error: 'এই নামে ইতিমধ্যে একটি আবেদন জমা পড়েছে। অন্য একটি নাম বেছে নিন।' });
    }
    if (q.pendingByEmail.get(event.id, email)) {
      return res.status(400).json({ success: false, field: 'email', error: 'এই ইমেইল দিয়ে এই ইভেন্টে একটি আবেদন ইতিমধ্যে অপেক্ষমাণ আছে।' });
    }

    let check;
    try {
      check = await wiki.checkUsername(username);
    } catch (err) {
      return wikiFailure(res, err);
    }
    if (!check.valid) return res.status(400).json({ success: false, field: 'username', error: check.reason });

    const token = newToken();
    try {
      q.insertRequest.run(event.id, username, email, token, nowIso());
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(400).json({ success: false, field: 'username', error: 'এই নামে ইতিমধ্যে একটি আবেদন জমা পড়েছে। অন্য একটি নাম বেছে নিন।' });
      }
      throw err;
    }
    res.json({ success: true, token, statusUrl: `/status/${token}`, username });
  }

  router.post('/api/events/:id/register', registerLimit, asyncHandler(async (req, res) => {
    await register(req, res, data.getEvent(req.params.id));
  }));

  // Older pages posted here with the event id in the body
  router.post('/api/register', registerLimit, asyncHandler(async (req, res) => {
    const open = data.openEvents();
    const event = req.body.eventId ? data.getEvent(req.body.eventId) : open.length === 1 ? open[0] : null;
    await register(req, res, event);
  }));

  // Existing Wikipedians add themselves to the event's leaderboard
  router.post('/api/events/:id/join', registerLimit, asyncHandler(async (req, res) => {
    if (req.body.website) return res.json({ success: true });
    const event = data.getEvent(req.params.id);
    if (!event) return res.status(404).json({ success: false, error: 'ইভেন্টটি পাওয়া যায়নি।' });
    if (!isRegistrationOpen(event) || event.allow_self_enroll !== 1) {
      return res.status(403).json({ success: false, error: 'এই ইভেন্টে এখন নিজে থেকে যুক্ত হওয়া যাচ্ছে না।' });
    }
    const username = normalizeUsername(typeof req.body.username === 'string' ? req.body.username : '');
    const problem = usernameProblem(username);
    if (problem) return res.status(400).json({ success: false, error: problem });

    const existing = q.participant.get(event.id, username);
    if (existing && !existing.excluded) {
      return res.json({ success: true, already: true, username, statsUrl: `/event/${event.id}/stats` });
    }
    if (existing && existing.excluded) {
      return res.status(403).json({ success: false, error: 'আপনাকে এই ইভেন্টে যুক্ত করা যাচ্ছে না। আয়োজকদের সাথে যোগাযোগ করুন।' });
    }

    let canonical;
    try {
      canonical = await wiki.globalUser(username);
    } catch (err) {
      return wikiFailure(res, err);
    }
    if (!canonical) {
      return res.status(400).json({ success: false, error: 'এই নামে কোনো উইকিপিডিয়া অ্যাকাউন্ট পাওয়া যায়নি। নামটি ঠিক আছে কিনা দেখুন, অথবা নতুন অ্যাকাউন্টের জন্য আবেদন করুন।' });
    }
    const name = normalizeUsername(canonical);
    if (!q.participant.get(event.id, name)) {
      q.insertParticipant.run(event.id, name, nowIso());
      stats.schedulePoll(event.id);
    }
    res.json({ success: true, username: name, statsUrl: `/event/${event.id}/stats` });
  }));

  router.get('/api/status/:token', (req, res) => {
    const request = q.byToken.get(String(req.params.token));
    if (!request) return res.status(404).json({ success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' });
    const event = request.event_id ? data.getEvent(request.event_id) : null;
    res.json({
      success: true,
      request: {
        username: request.username,
        status: request.status,
        requested_at: request.requested_at,
        decided_at: request.decided_at,
        decision_reason: request.status === 'declined' ? request.decision_reason : null,
        created_on_wiki: request.created_on_wiki,
        masked_email: maskEmail(request.email)
      },
      event: event ? { id: event.id, name: event.name, workshop_url: event.workshop_url } : null
    });
  });

  function statsPayload(event) {
    const leaderboard = stats.leaderboard(event.id);
    const totals = q.requestTotals.get(event.id);
    return {
      success: true,
      event: publicEvent(event),
      stats: {
        ...stats.summarize(event, leaderboard),
        requests_submitted: totals.submitted || 0,
        accounts_created: totals.approved || 0,
        refreshing: stats.isRunning(event.id)
      },
      timeline: stats.timeline(event),
      leaderboard
    };
  }

  router.get('/api/events/:id/stats', (req, res) => {
    const event = data.getEvent(req.params.id);
    if (!event) return res.status(404).json({ success: false, error: 'ইভেন্টটি পাওয়া যায়নি।' });
    res.json(statsPayload(event));
  });

  // Older URL: /api/stats and /api/stats/:id
  router.get('/api/stats/:id?', (req, res) => {
    const ongoing = data.groupedEvents().ongoing;
    const event = req.params.id ? data.getEvent(req.params.id) : ongoing.length === 1 ? ongoing[0] : null;
    if (!event) return res.status(404).json({ success: false, error: 'ইভেন্টটি পাওয়া যায়নি।' });
    res.json(statsPayload(event));
  });

  router.get('/api/events/:id/participants/:username/contribs', (req, res) => {
    const event = data.getEvent(req.params.id);
    const username = normalizeUsername(req.params.username);
    const participant = event && q.participant.get(event.id, username);
    if (!participant || participant.excluded) {
      return res.status(404).json({ success: false, error: 'অংশগ্রহণকারী পাওয়া যায়নি।' });
    }
    res.json({ success: true, username, contributions: stats.contributionsFor(event.id, username) });
  });

  // Anyone may ask for fresh numbers, at most once a minute per event
  const lastRefresh = new Map();
  function refresh(req, res, event) {
    if (!event) return res.status(404).json({ success: false, error: 'ইভেন্টটি পাওয়া যায়নি।' });
    if (stats.isRunning(event.id)) return res.json({ success: true, status: 'busy', message: 'পরিসংখ্যান এখন হালনাগাদ হচ্ছে।' });
    const waitMs = config.rateLimits.statsRefresh.perEventMs - (Date.now() - (lastRefresh.get(event.id) || 0));
    if (waitMs > 0) {
      return res.status(429).json({ success: false, retryAfter: Math.ceil(waitMs / 1000), error: `পরিসংখ্যান সম্প্রতি হালনাগাদ করা হয়েছে। ${Math.ceil(waitMs / 1000)} সেকেন্ড পরে আবার চেষ্টা করুন।` });
    }
    lastRefresh.set(event.id, Date.now());
    stats.pollEvent(event.id).catch(err => log.error('Manual stats refresh failed:', err));
    res.json({ success: true, status: 'started', message: 'পরিসংখ্যান হালনাগাদ শুরু হয়েছে।' });
  }

  router.post('/api/events/:id/refresh', (req, res) => refresh(req, res, data.getEvent(req.params.id)));
  router.post('/api/stats/refresh/:id?', (req, res) => {
    const ongoing = data.groupedEvents().ongoing;
    refresh(req, res, req.params.id ? data.getEvent(req.params.id) : ongoing.length === 1 ? ongoing[0] : null);
  });

  router.get('/api/events/:id/leaderboard.csv', (req, res) => {
    const event = data.getEvent(req.params.id);
    if (!event) return res.status(404).send('Not found');
    const rows = stats.leaderboard(event.id).map(r => [r.rank, r.username, r.total_edits, r.articles_created, r.pages_edited, r.file_uploads, r.bytes_added]);
    sendCSV(res, `leaderboard-event-${event.id}.csv`, toCSV(['Rank', 'Username', 'Edits', 'Articles created', 'Pages edited', 'Files uploaded', 'Bytes added'], rows));
  });

  router.get('/api/public/events', (req, res) => {
    res.json({ success: true, events: data.listEvents().map(publicEvent) });
  });

  return router;
}

module.exports = { createPublicApi, publicEvent, UNAVAILABLE_MESSAGE };

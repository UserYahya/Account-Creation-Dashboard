const express = require('express');
const { asyncHandler, absoluteUrl, sendCSV } = require('./util');
const { requireAdmin, requireDeveloper } = require('../security');
const { validateEventInput, normalizeUsername, usernameProblem, toCSV } = require('../validation');
const { bdLocalToUtcIso, eventPhase, nowIso } = require('../time');
const { WikiError } = require('../wiki');

const TRACKING_FIELDS = ['start_time', 'end_time', 'target_wikis', 'target_namespaces'];
const MAX_PARTICIPANTS_PER_REQUEST = 500;

function createAdminApi({ config, db, data, wiki, stats, accounts, audit, getValidAccessToken }) {
  const router = express.Router();
  router.use('/api/admin', requireAdmin);

  const q = {
    insertEvent: db.prepare(`
      INSERT INTO events (name, workshop_url, start_time, end_time, target_wikis, target_namespaces, registration_active, allow_self_enroll,
        account_wiki, welcome_message, instructions, goal_edits, goal_articles, created_by, created_at)
      VALUES (@name, @workshop_url, @start_time, @end_time, @target_wikis, @target_namespaces, @registration_active, @allow_self_enroll,
        @account_wiki, @welcome_message, @instructions, @goal_edits, @goal_articles, @created_by, @created_at)`),
    updateEvent: db.prepare(`
      UPDATE events SET name = @name, workshop_url = @workshop_url, start_time = @start_time, end_time = @end_time,
        target_wikis = @target_wikis, target_namespaces = @target_namespaces, registration_active = @registration_active,
        allow_self_enroll = @allow_self_enroll, account_wiki = @account_wiki, welcome_message = @welcome_message,
        instructions = @instructions, goal_edits = @goal_edits, goal_articles = @goal_articles
      WHERE id = @id`),
    nameTaken: db.prepare('SELECT id FROM events WHERE name = ? AND id != ?'),
    setRegistration: db.prepare('UPDATE events SET registration_active = ? WHERE id = ?'),
    deleteEvent: db.prepare('DELETE FROM events WHERE id = ?'),
    eventRequests: db.prepare('SELECT * FROM requests WHERE event_id = ? ORDER BY requested_at DESC'),
    request: db.prepare('SELECT * FROM requests WHERE id = ?'),
    participants: db.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY added_at DESC'),
    participant: db.prepare('SELECT * FROM participants WHERE id = ?'),
    participantByName: db.prepare('SELECT * FROM participants WHERE event_id = ? AND username = ?'),
    insertParticipant: db.prepare("INSERT INTO participants (event_id, username, source, added_by, added_at) VALUES (?, ?, 'manual', ?, ?)"),
    exclude: db.prepare('UPDATE participants SET excluded = 1 WHERE id = ?'),
    restore: db.prepare('UPDATE participants SET excluded = 0, synced = 0 WHERE id = ?'),
    allRequests: db.prepare(`
      SELECT r.*, e.name AS event_name FROM requests r LEFT JOIN events e ON e.id = r.event_id
      ORDER BY r.requested_at DESC`),
    loginLogs: db.prepare('SELECT * FROM login_logs ORDER BY id DESC'),
    auditLog: db.prepare('SELECT * FROM audit_log ORDER BY id DESC')
  };

  function actor(req) {
    return {
      username: req.session.username,
      adminWiki: req.session.adminWiki,
      adminWikis: req.session.adminWikis || [],
      isMock: !!req.session.isMock
    };
  }

  function reasonFrom(body) {
    return typeof (body || {}).reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
  }

  function eventOr404(req, res) {
    const event = data.getEvent(req.params.id);
    if (!event) res.status(404).json({ success: false, error: 'ইভেন্টটি পাওয়া যায়নি।' });
    return event;
  }

  function validate(body) {
    return validateEventInput(body, { bdLocalToUtcIso, adminWikis: config.adminWikis });
  }

  // --- Events ---

  router.get('/api/admin/events', (req, res) => {
    const counts = data.eventCounts();
    res.json({
      success: true,
      events: data.listEvents().map(e => ({ ...e, phase: eventPhase(e), counts: counts[e.id] || null }))
    });
  });

  router.post('/api/admin/events', (req, res) => {
    const { error, values } = validate(req.body);
    if (error) return res.status(400).json({ success: false, error });
    if (q.nameTaken.get(values.name, 0)) {
      return res.status(400).json({ success: false, error: 'এই নামে একটি ইভেন্ট ইতিমধ্যে আছে। অন্য একটি নাম দিন।' });
    }
    const result = q.insertEvent.run({ ...values, created_by: req.session.username, created_at: nowIso() });
    const id = Number(result.lastInsertRowid);
    audit(req.session.username, 'event.create', { eventId: id, target: values.name });
    res.json({ success: true, id, adminUrl: `/admin/events/${id}` });
  });

  router.put('/api/admin/events/:id', (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    const { error, values } = validate(req.body);
    if (error) return res.status(400).json({ success: false, error });
    if (q.nameTaken.get(values.name, event.id)) {
      return res.status(400).json({ success: false, error: 'এই নামে আরেকটি ইভেন্ট ইতিমধ্যে আছে।' });
    }
    q.updateEvent.run({ ...values, id: event.id });
    const trackingChanged = TRACKING_FIELDS.some(f => values[f] !== event[f]);
    if (trackingChanged) {
      // Dates, wikis or namespaces changed: count everything again
      stats.resetEvent(event.id);
      stats.schedulePoll(event.id, 1000);
    }
    const changed = Object.keys(values).filter(k => values[k] !== event[k]);
    audit(req.session.username, 'event.update', { eventId: event.id, target: values.name, details: { changed } });
    res.json({ success: true, statsReset: trackingChanged });
  });

  // Quick open/close toggle
  router.post('/api/admin/events/:id/registration', (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    const active = req.body.active ? 1 : 0;
    q.setRegistration.run(active, event.id);
    audit(req.session.username, active ? 'event.open' : 'event.close', { eventId: event.id, target: event.name });
    res.json({ success: true, active });
  });

  router.delete('/api/admin/events/:id', requireDeveloper, (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    q.deleteEvent.run(event.id);
    audit(req.session.username, 'event.delete', { eventId: event.id, target: event.name });
    res.json({ success: true });
  });

  router.post('/api/admin/events/:id/resync', (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    if (stats.isRunning(event.id)) {
      return res.status(409).json({ success: false, error: 'পরিসংখ্যান এখন হালনাগাদ হচ্ছে। একটু পরে আবার চেষ্টা করুন।' });
    }
    stats.resetEvent(event.id);
    stats.pollEvent(event.id).catch(() => {});
    audit(req.session.username, 'event.resync', { eventId: event.id, target: event.name });
    res.json({ success: true });
  });

  // --- Requests ---

  router.get('/api/admin/events/:id/requests', (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    const showEmail = !!req.session.isDeveloper;
    // Status links belong to the applicant, so they are not sent to admins
    const requests = q.eventRequests.all(event.id).map(r => {
      const rest = { ...r };
      delete rest.status_token;
      return showEmail ? rest : { ...rest, email: undefined, has_email: !!r.email };
    });
    res.json({ success: true, showEmail, requests, accountWiki: accounts.accountWikiFor(event, actor(req)) });
  });

  router.post('/api/admin/requests/:id/approve', asyncHandler(async (req, res) => {
    const id = data.parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' });
    const { status, body } = await accounts.approve(actor(req), id, reasonFrom(req.body), {
      returnUrl: absoluteUrl(config, req, '/'),
      getAccessToken: () => getValidAccessToken(req)
    });
    res.status(status).json(body);
  }));

  router.post('/api/admin/requests/:id/decline', (req, res) => {
    const id = data.parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' });
    const { status, body } = accounts.decline(actor(req), id, reasonFrom(req.body));
    res.status(status).json(body);
  });

  router.patch('/api/admin/requests/:id', asyncHandler(async (req, res) => {
    const id = data.parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, error: 'আবেদনটি খুঁজে পাওয়া যায়নি।' });
    try {
      const { status, body } = await accounts.rename(actor(req), id, req.body.username);
      res.status(status).json(body);
    } catch (err) {
      if (err instanceof WikiError) return res.status(502).json({ success: false, error: err.message });
      throw err;
    }
  }));

  // --- Participants ---

  router.get('/api/admin/events/:id/participants', (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    const metrics = new Map(stats.leaderboard(event.id).map(r => [r.username, r]));
    const participants = q.participants.all(event.id).map(p => ({
      id: p.id,
      username: p.username,
      source: p.source,
      excluded: p.excluded === 1,
      added_by: p.added_by,
      added_at: p.added_at,
      ...(metrics.get(p.username) || {})
    }));
    res.json({ success: true, participants });
  });

  // Add one or many existing Wikipedians (checked against the wiki first)
  router.post('/api/admin/events/:id/participants', asyncHandler(async (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    const raw = Array.isArray(req.body.usernames) ? req.body.usernames : String(req.body.usernames || '').split(/\r?\n|,/);
    const names = [...new Set(raw.map(n => normalizeUsername(String(n))).filter(Boolean))];
    if (names.length === 0) return res.status(400).json({ success: false, error: 'অন্তত একটি ব্যবহারকারী নাম দিন।' });
    if (names.length > MAX_PARTICIPANTS_PER_REQUEST) {
      return res.status(400).json({ success: false, error: `একসাথে সর্বোচ্চ ${MAX_PARTICIPANTS_PER_REQUEST} জন যোগ করা যাবে।` });
    }

    const result = { added: [], restored: [], alreadyPresent: [], notFound: [], invalid: [] };
    const toCheck = [];
    for (const name of names) {
      if (usernameProblem(name)) {
        result.invalid.push(name);
        continue;
      }
      const existing = q.participantByName.get(event.id, name);
      if (existing && existing.excluded) {
        q.restore.run(existing.id);
        result.restored.push(name);
      } else if (existing) {
        result.alreadyPresent.push(name);
      } else {
        toCheck.push(name);
      }
    }

    if (toCheck.length > 0) {
      let resolved;
      try {
        resolved = await wiki.resolveUsers(event.target_wikis.split(',')[0], toCheck);
      } catch (err) {
        if (err instanceof WikiError) return res.status(502).json({ success: false, error: err.message });
        throw err;
      }
      const now = nowIso();
      db.transaction(() => {
        for (const name of toCheck) {
          const canonical = resolved.get(name);
          if (!canonical) {
            result.notFound.push(name);
            continue;
          }
          const finalName = normalizeUsername(canonical);
          if (q.participantByName.get(event.id, finalName)) {
            result.alreadyPresent.push(finalName);
          } else {
            q.insertParticipant.run(event.id, finalName, req.session.username, now);
            result.added.push(finalName);
          }
        }
      })();
    }

    if (result.added.length || result.restored.length) {
      stats.schedulePoll(event.id, 2000);
      audit(req.session.username, 'participants.add', { eventId: event.id, details: { added: result.added, restored: result.restored } });
    }
    res.json({ success: true, ...result });
  }));

  function participantAction(action) {
    return (req, res) => {
      const participant = q.participant.get(data.parseId(req.params.id));
      if (!participant) return res.status(404).json({ success: false, error: 'অংশগ্রহণকারী পাওয়া যায়নি।' });
      if (action === 'exclude') q.exclude.run(participant.id);
      else {
        q.restore.run(participant.id);
        stats.schedulePoll(participant.event_id, 2000);
      }
      audit(req.session.username, `participant.${action}`, { eventId: participant.event_id, target: participant.username });
      res.json({ success: true });
    };
  }
  router.post('/api/admin/participants/:id/exclude', participantAction('exclude'));
  router.post('/api/admin/participants/:id/restore', participantAction('restore'));

  // --- Settings ---

  router.post('/api/admin/settings', (req, res) => {
    const { welcome_message, additional_instructions } = req.body;
    if ((typeof welcome_message === 'string' && welcome_message.length > 10000) ||
        (typeof additional_instructions === 'string' && additional_instructions.length > 5000)) {
      return res.status(400).json({ success: false, error: 'লেখাটি অনেক বড়। অনুগ্রহ করে ছোট করুন।' });
    }
    if (typeof welcome_message === 'string') data.setSetting('welcome_message', welcome_message.replace(/\r\n/g, '\n').trim());
    if (typeof additional_instructions === 'string') data.setSetting('additional_instructions', additional_instructions.replace(/\r\n/g, '\n').trim());
    audit(req.session.username, 'settings.update');
    res.json({ success: true });
  });

  // --- Exports ---

  router.get('/api/admin/events/:id/requests.csv', (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    const showEmail = !!req.session.isDeveloper;
    const headers = ['ID', 'Username', ...(showEmail ? ['Email'] : []), 'Status', 'Requested at (UTC)', 'Decided by', 'Decided at (UTC)', 'Reason', 'Error', 'Created on'];
    const rows = q.eventRequests.all(event.id).map(r => [
      r.id, r.username, ...(showEmail ? [r.email] : []), r.status, r.requested_at, r.decided_by, r.decided_at, r.decision_reason, r.error_message, r.created_on_wiki
    ]);
    sendCSV(res, `requests-event-${event.id}.csv`, toCSV(headers, rows));
  });

  router.get('/api/admin/events/:id/participants.csv', (req, res) => {
    const event = eventOr404(req, res);
    if (!event) return;
    const metrics = new Map(stats.leaderboard(event.id).map(r => [r.username, r]));
    const rows = q.participants.all(event.id).map(p => {
      const m = metrics.get(p.username) || {};
      return [p.username, p.source, p.excluded ? 'yes' : 'no', m.rank || '', m.total_edits || 0, m.articles_created || 0, m.pages_edited || 0, m.file_uploads || 0, m.bytes_added || 0, p.added_at];
    });
    sendCSV(res, `participants-event-${event.id}.csv`,
      toCSV(['Username', 'Source', 'Excluded', 'Rank', 'Edits', 'Articles created', 'Pages edited', 'Files uploaded', 'Bytes added', 'Added at (UTC)'], rows));
  });

  router.get('/api/admin/download-log', requireDeveloper, (req, res) => {
    const rows = q.allRequests.all().map(r => [r.id, r.username, r.email, r.status, r.event_name, r.requested_at, r.decided_by, r.decided_at, r.error_message, r.decision_reason]);
    sendCSV(res, 'wikimedia_outreach_requests_log.csv',
      toCSV(['ID', 'Username', 'Email', 'Status', 'Event Name', 'Requested At (UTC)', 'Decided By', 'Decided At (UTC)', 'Error Message', 'Decision Reason'], rows));
  });

  router.get('/api/admin/download-login-log', requireDeveloper, (req, res) => {
    const rows = q.loginLogs.all().map(l => [l.id, l.username, l.wiki, l.logged_at]);
    sendCSV(res, 'developer_login_history_log.csv', toCSV(['ID', 'Username', 'Wiki', 'Logged At (UTC)'], rows));
  });

  router.get('/api/admin/audit.csv', requireDeveloper, (req, res) => {
    const rows = q.auditLog.all().map(a => [a.id, a.created_at, a.actor, a.action, a.event_id, a.target, a.details]);
    sendCSV(res, 'audit_log.csv', toCSV(['ID', 'Time (UTC)', 'Actor', 'Action', 'Event ID', 'Target', 'Details'], rows));
  });

  return router;
}

module.exports = { createAdminApi };

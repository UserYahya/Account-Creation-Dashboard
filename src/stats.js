const { WikiError } = require('./wiki');
const { nowIso } = require('./time');

const BATCH_SIZE = 50; // MediaWiki accepts up to 50 users per usercontribs request
const OVERLAP_MS = 10 * 60 * 1000; // re-read the last 10 minutes to catch late replication
const POLL_AFTER_END_MS = 12 * 60 * 60 * 1000; // keep polling 12 hours after an event ends

function isBadUserError(err) {
  return err instanceof WikiError && String(err.code || '').startsWith('baduser');
}

// Tracks participants' contributions. Each poll only asks the wikis for edits
// made since the previous poll; newly added participants get their full
// history for the event window once.
function createStatsService({ db, wiki, config, log = console }) {
  const running = new Set();
  const scheduled = new Map();
  let intervalTimer = null;
  let startupTimer = null;

  const q = {
    event: db.prepare('SELECT * FROM events WHERE id = ?'),
    participants: db.prepare('SELECT id, username, synced FROM participants WHERE event_id = ? AND excluded = 0'),
    syncState: db.prepare('SELECT synced_until FROM sync_state WHERE event_id = ? AND wiki = ?'),
    setSync: db.prepare('INSERT OR REPLACE INTO sync_state (event_id, wiki, synced_until) VALUES (?, ?, ?)'),
    insertContrib: db.prepare(`
      INSERT OR REPLACE INTO contributions (event_id, wiki, revid, username, title, ns, timestamp, sizediff, is_new)
      VALUES (@event_id, @wiki, @revid, @username, @title, @ns, @timestamp, @sizediff, @is_new)`),
    markSynced: db.prepare('UPDATE participants SET synced = 1 WHERE id = ?'),
    setUpdated: db.prepare('UPDATE events SET stats_updated_at = ?, stats_error = NULL WHERE id = ?'),
    setError: db.prepare('UPDATE events SET stats_error = ? WHERE id = ?'),
    dueEvents: db.prepare('SELECT id, end_time FROM events WHERE start_time <= ?'),
    leaderboard: db.prepare(`
      SELECT p.username, p.source,
        COUNT(c.revid) AS total_edits,
        COALESCE(SUM(CASE WHEN c.is_new = 1 AND c.ns = 0 THEN 1 ELSE 0 END), 0) AS articles_created,
        COUNT(DISTINCT CASE WHEN c.revid IS NOT NULL THEN c.wiki || '|' || c.title END) AS pages_edited,
        COALESCE(SUM(CASE WHEN c.is_new = 1 AND c.ns = 6 THEN 1 ELSE 0 END), 0) AS file_uploads,
        COALESCE(SUM(CASE WHEN c.sizediff > 0 THEN c.sizediff ELSE 0 END), 0) AS bytes_added
      FROM participants p
      LEFT JOIN contributions c ON c.event_id = p.event_id AND c.username = p.username
      WHERE p.event_id = ? AND p.excluded = 0
      GROUP BY p.id`),
    contribs: db.prepare(`
      SELECT wiki, revid, title, ns, timestamp, sizediff, is_new
      FROM contributions WHERE event_id = ? AND username = ?
      ORDER BY timestamp DESC LIMIT ?`),
    timeline: db.prepare(`
      SELECT strftime(?, c.timestamp, '+6 hours') AS bucket, COUNT(*) AS edits
      FROM contributions c
      JOIN participants p ON p.event_id = c.event_id AND p.username = c.username AND p.excluded = 0
      WHERE c.event_id = ?
      GROUP BY bucket ORDER BY bucket`)
  };

  const storeRows = db.transaction((eventId, wikiName, rows) => {
    for (const row of rows) {
      q.insertContrib.run({ event_id: eventId, wiki: wikiName, ...row });
    }
  });

  // Fetch contributions in batches; a batch rejected because of one bad
  // username is retried user by user so the others still count.
  async function fetchAndStore(event, wikiName, usernames, from, to) {
    if (usernames.length === 0 || from >= to) return;
    for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
      const batch = usernames.slice(i, i + BATCH_SIZE);
      const options = { start: from, end: to, namespaces: event.target_namespaces };
      try {
        storeRows(event.id, wikiName, await wiki.fetchContribs(wikiName, batch, options));
      } catch (err) {
        if (!isBadUserError(err)) throw err;
        for (const name of batch) {
          try {
            storeRows(event.id, wikiName, await wiki.fetchContribs(wikiName, [name], options));
          } catch (singleErr) {
            if (!isBadUserError(singleErr)) throw singleErr;
            log.warn(`Skipping invalid username "${name}" on ${wikiName}.`);
          }
        }
      }
    }
  }

  async function pollEvent(eventId) {
    eventId = Number(eventId);
    if (running.has(eventId)) return { status: 'busy' };
    const event = q.event.get(eventId);
    if (!event) return { status: 'missing' };
    const now = new Date();
    if (new Date(event.start_time) > now) return { status: 'not_started' };

    running.add(eventId);
    try {
      const windowEnd = new Date(Math.min(now.getTime(), new Date(event.end_time).getTime())).toISOString();
      const participants = q.participants.all(eventId);
      const fresh = participants.filter(p => !p.synced);
      const known = participants.filter(p => p.synced).map(p => p.username);
      const wikis = event.target_wikis.split(',').map(w => w.trim()).filter(Boolean);

      for (const wikiName of wikis) {
        await fetchAndStore(event, wikiName, fresh.map(p => p.username), event.start_time, windowEnd);
        const state = q.syncState.get(eventId, wikiName);
        let from = event.start_time;
        if (state) {
          const resume = new Date(new Date(state.synced_until).getTime() - OVERLAP_MS).toISOString();
          if (resume > from) from = resume;
        }
        await fetchAndStore(event, wikiName, known, from, windowEnd);
        q.setSync.run(eventId, wikiName, windowEnd);
      }
      db.transaction(() => fresh.forEach(p => q.markSynced.run(p.id)))();
      q.setUpdated.run(nowIso(), eventId);
      return { status: 'done' };
    } catch (err) {
      log.error(`Stats update for event ${eventId} failed:`, err.message);
      q.setError.run(String(err.message).slice(0, 500), eventId);
      return { status: 'error', error: err.message };
    } finally {
      running.delete(eventId);
    }
  }

  // Poll soon, but only once even if many changes arrive together
  function schedulePoll(eventId, delayMs = 20000) {
    eventId = Number(eventId);
    if (scheduled.has(eventId)) return;
    const timer = setTimeout(() => {
      scheduled.delete(eventId);
      pollEvent(eventId).catch(err => log.error('Scheduled stats poll failed:', err));
    }, delayMs);
    timer.unref();
    scheduled.set(eventId, timer);
  }

  async function pollDue() {
    const now = Date.now();
    const events = q.dueEvents.all(new Date(now).toISOString())
      .filter(e => new Date(e.end_time).getTime() + POLL_AFTER_END_MS >= now);
    for (const e of events) {
      await pollEvent(e.id);
    }
  }

  // Forget all stored contributions, e.g. after the event's dates or wikis change
  function resetEvent(eventId) {
    db.transaction(() => {
      db.prepare('DELETE FROM contributions WHERE event_id = ?').run(eventId);
      db.prepare('DELETE FROM sync_state WHERE event_id = ?').run(eventId);
      db.prepare('UPDATE participants SET synced = 0 WHERE event_id = ?').run(eventId);
      db.prepare('UPDATE events SET stats_updated_at = NULL, stats_error = NULL WHERE id = ?').run(eventId);
    })();
  }

  function leaderboard(eventId) {
    const rows = q.leaderboard.all(eventId);
    rows.sort((a, b) =>
      b.total_edits - a.total_edits ||
      b.bytes_added - a.bytes_added ||
      b.articles_created - a.articles_created ||
      a.username.localeCompare(b.username));
    return rows.map((row, i) => ({ rank: i + 1, ...row }));
  }

  function summarize(event, rows) {
    const totals = rows.reduce((acc, r) => {
      acc.total_edits += r.total_edits;
      acc.articles_created += r.articles_created;
      acc.pages_edited += r.pages_edited;
      acc.file_uploads += r.file_uploads;
      acc.bytes_added += r.bytes_added;
      return acc;
    }, { total_edits: 0, articles_created: 0, pages_edited: 0, file_uploads: 0, bytes_added: 0 });
    const goals = event.goal_edits || event.goal_articles ? {
      edits: event.goal_edits || null,
      articles: event.goal_articles || null,
      reached: rows.filter(r =>
        (!event.goal_edits || r.total_edits >= event.goal_edits) &&
        (!event.goal_articles || r.articles_created >= event.goal_articles)).length
    } : null;
    return {
      total_participants: rows.length,
      active_participants: rows.filter(r => r.total_edits > 0).length,
      ...totals,
      goals,
      last_updated: event.stats_updated_at,
      last_error: event.stats_error
    };
  }

  // Edits per hour (events up to 3 days) or per day, in Bangladesh time
  function timeline(event) {
    const start = new Date(event.start_time);
    const end = new Date(Math.min(Date.now(), new Date(event.end_time).getTime()));
    if (end <= start) return { unit: 'day', points: [] };
    const hourly = new Date(event.end_time) - start <= 3 * 24 * 60 * 60 * 1000;
    const format = hourly ? '%Y-%m-%dT%H' : '%Y-%m-%d';
    const counts = new Map(q.timeline.all(format, event.id).map(r => [r.bucket, r.edits]));

    const stepMs = hourly ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const keyLength = hourly ? 13 : 10;
    const bdStart = new Date(start.getTime() + 6 * 60 * 60 * 1000);
    // Start at the beginning of the first hour/day in Bangladesh time
    const cursor = new Date(Date.UTC(bdStart.getUTCFullYear(), bdStart.getUTCMonth(), bdStart.getUTCDate(), hourly ? bdStart.getUTCHours() : 0));
    const bdEnd = new Date(end.getTime() + 6 * 60 * 60 * 1000);
    const points = [];
    while (cursor <= bdEnd && points.length < 400) {
      const key = cursor.toISOString().slice(0, keyLength);
      points.push({ bucket: key, edits: counts.get(key) || 0 });
      cursor.setTime(cursor.getTime() + stepMs);
    }
    return { unit: hourly ? 'hour' : 'day', points: points.slice(-180) };
  }

  function contributionsFor(eventId, username, limit = 500) {
    return q.contribs.all(eventId, username, limit);
  }

  function isRunning(eventId) {
    return running.has(Number(eventId));
  }

  function start() {
    if (!config.backgroundJobs) return;
    startupTimer = setTimeout(() => pollDue().catch(err => log.error('Stats poll failed:', err)), 10 * 1000);
    startupTimer.unref();
    intervalTimer = setInterval(() => pollDue().catch(err => log.error('Stats poll failed:', err)), config.pollIntervalMinutes * 60 * 1000);
    intervalTimer.unref();
  }

  function stop() {
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
    for (const timer of scheduled.values()) clearTimeout(timer);
    scheduled.clear();
  }

  return { pollEvent, pollDue, schedulePoll, resetEvent, leaderboard, summarize, timeline, contributionsFor, isRunning, start, stop };
}

module.exports = { createStatsService };

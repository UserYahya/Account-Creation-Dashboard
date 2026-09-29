const { eventPhase, isRegistrationOpen } = require('./time');

// Queries shared by several routes
function createData(db) {
  const q = {
    event: db.prepare('SELECT * FROM events WHERE id = ?'),
    events: db.prepare('SELECT * FROM events ORDER BY start_time DESC, id DESC'),
    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
    requestCounts: db.prepare('SELECT event_id, status, COUNT(*) AS n FROM requests GROUP BY event_id, status'),
    participantCounts: db.prepare('SELECT event_id, COUNT(*) AS n FROM participants WHERE excluded = 0 GROUP BY event_id')
  };

  function parseId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function getEvent(idValue) {
    const id = parseId(idValue);
    return id ? q.event.get(id) || null : null;
  }

  function listEvents() {
    return q.events.all();
  }

  function openEvents(now = new Date()) {
    return listEvents().filter(e => isRegistrationOpen(e, now));
  }

  // Events grouped by phase: ongoing first by end date, upcoming by start
  function groupedEvents(now = new Date()) {
    const groups = { ongoing: [], upcoming: [], finished: [] };
    for (const e of listEvents()) groups[eventPhase(e, now)].push(e);
    groups.ongoing.sort((a, b) => a.end_time.localeCompare(b.end_time));
    groups.upcoming.sort((a, b) => a.start_time.localeCompare(b.start_time));
    return groups;
  }

  function getSetting(key, fallback = '') {
    const row = q.setting.get(key);
    return row && row.value !== null ? row.value : fallback;
  }

  function setSetting(key, value) {
    q.setSetting.run(key, value);
  }

  // { [eventId]: { pending, processing, approved, declined, participants } }
  function eventCounts() {
    const counts = {};
    const bucket = id => (counts[id] = counts[id] || { pending: 0, processing: 0, approved: 0, declined: 0, participants: 0 });
    for (const row of q.requestCounts.all()) bucket(row.event_id)[row.status] = row.n;
    for (const row of q.participantCounts.all()) bucket(row.event_id).participants = row.n;
    return counts;
  }

  return { parseId, getEvent, listEvents, openEvents, groupedEvents, getSetting, setSetting, eventCounts };
}

module.exports = { createData };

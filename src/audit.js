const { nowIso } = require('./time');

// Record who did what, for the developer's audit log
function createAudit(db) {
  const insert = db.prepare('INSERT INTO audit_log (actor, action, event_id, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  return function audit(actor, action, { eventId = null, target = null, details = null } = {}) {
    const text = details === null || details === undefined ? null : typeof details === 'string' ? details : JSON.stringify(details);
    insert.run(actor || null, action, eventId, target, text, nowIso());
  };
}

module.exports = { createAudit };

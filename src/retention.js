const { nowIso } = require('./time');

const DAY_MS = 24 * 60 * 60 * 1000;

// Students' email addresses are only needed until their account exists.
// They are deleted a fixed number of days after the decision; requests left
// pending long after their event ended are closed the same way.
function createRetention({ db, config, log = console }) {
  const purgeDecided = db.prepare(`
    UPDATE requests SET email = NULL, email_purged_at = ?
    WHERE email IS NOT NULL AND status IN ('approved', 'declined') AND decided_at < ?`);
  const expireAbandoned = db.prepare(`
    UPDATE requests
    SET status = 'declined', decided_by = 'system', decided_at = ?, decision_reason = ?, email = NULL, email_purged_at = ?
    WHERE status = 'pending' AND (
      event_id IN (SELECT id FROM events WHERE end_time < ?)
      OR (event_id IS NULL AND requested_at < ?)
    )`);
  let timer = null;

  function run() {
    const now = nowIso();
    const cutoff = new Date(Date.now() - config.emailRetentionDays * DAY_MS).toISOString();
    const reason = `মেয়াদোত্তীর্ণ: ইভেন্ট শেষ হওয়ার ${config.emailRetentionDays} দিন পরও আবেদনটি নিষ্পত্তি হয়নি।`;
    const purged = purgeDecided.run(now, cutoff).changes;
    const expired = expireAbandoned.run(now, reason, now, cutoff, cutoff).changes;
    if (purged || expired) {
      log.log(`Email retention: removed ${purged} email address(es), closed ${expired} abandoned request(s).`);
    }
    return { purged, expired };
  }

  function start() {
    if (!config.backgroundJobs) return;
    run();
    timer = setInterval(() => {
      try {
        run();
      } catch (err) {
        log.error('Email retention job failed:', err);
      }
    }, 12 * 60 * 60 * 1000);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
  }

  return { run, start, stop };
}

module.exports = { createRetention };

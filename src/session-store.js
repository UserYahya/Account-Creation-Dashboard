// express-session store backed by the app's SQLite database, so admins stay
// logged in across restarts and memory use stays flat.
module.exports = function createSessionStore(session) {
  class SqliteSessionStore extends session.Store {
    constructor(db, { cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
      super();
      this.statements = {
        get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
        set: db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)'),
        touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
        destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
        cleanup: db.prepare('DELETE FROM sessions WHERE expires <= ?')
      };
      this.timer = setInterval(() => this.cleanup(), cleanupIntervalMs);
      this.timer.unref();
    }

    expiry(sess) {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge;
      return Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000);
    }

    get(sid, cb) {
      try {
        const row = this.statements.get.get(sid, Date.now());
        cb(null, row ? JSON.parse(row.sess) : null);
      } catch (err) {
        cb(err);
      }
    }

    set(sid, sess, cb = () => {}) {
      try {
        this.statements.set.run(sid, JSON.stringify(sess), this.expiry(sess));
        cb(null);
      } catch (err) {
        cb(err);
      }
    }

    touch(sid, sess, cb = () => {}) {
      try {
        this.statements.touch.run(this.expiry(sess), sid);
        cb(null);
      } catch (err) {
        cb(err);
      }
    }

    destroy(sid, cb = () => {}) {
      try {
        this.statements.destroy.run(sid);
        cb(null);
      } catch (err) {
        cb(err);
      }
    }

    cleanup() {
      try {
        this.statements.cleanup.run(Date.now());
      } catch (err) {
        console.error('Session cleanup failed:', err);
      }
    }

    close() {
      clearInterval(this.timer);
    }
  }

  return SqliteSessionStore;
};

// Minimal express-session store that keeps sessions in the app's SQLite
// database, so admins stay logged in across restarts and memory stays flat.
module.exports = function createSqliteSessionStore(session) {
  const Store = session.Store;

  class SqliteSessionStore extends Store {
    constructor({ getDatabase, cleanupIntervalMs = 15 * 60 * 1000 }) {
      super();
      this.getDatabase = getDatabase;
      this.ready = this.getDatabase().then(db =>
        db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)')
      );
      this.cleanupTimer = setInterval(() => this.cleanup().catch(() => {}), cleanupIntervalMs);
      this.cleanupTimer.unref();
    }

    async db() {
      await this.ready;
      return this.getDatabase();
    }

    expiryFor(sess) {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge;
      return Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000);
    }

    get(sid, cb) {
      this.db()
        .then(db => db.get('SELECT sess, expires FROM sessions WHERE sid = ?', sid))
        .then(row => {
          if (!row || row.expires < Date.now()) return cb(null, null);
          cb(null, JSON.parse(row.sess));
        })
        .catch(cb);
    }

    set(sid, sess, cb = () => {}) {
      this.db()
        .then(db => db.run(
          'INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)',
          sid, JSON.stringify(sess), this.expiryFor(sess)
        ))
        .then(() => cb(null))
        .catch(cb);
    }

    touch(sid, sess, cb = () => {}) {
      this.db()
        .then(db => db.run('UPDATE sessions SET expires = ? WHERE sid = ?', this.expiryFor(sess), sid))
        .then(() => cb(null))
        .catch(cb);
    }

    destroy(sid, cb = () => {}) {
      this.db()
        .then(db => db.run('DELETE FROM sessions WHERE sid = ?', sid))
        .then(() => cb(null))
        .catch(cb);
    }

    async cleanup() {
      const db = await this.db();
      await db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
    }
  }

  return SqliteSessionStore;
};

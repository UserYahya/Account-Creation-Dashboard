const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { normalizeUsername } = require('./validation');
const { bdLocalToUtcIso, sqliteToIso, nowIso } = require('./time');

const SCHEMA = `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    workshop_url TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    target_wikis TEXT NOT NULL DEFAULT 'bn.wikipedia.org',
    target_namespaces TEXT NOT NULL DEFAULT 'all',
    registration_active INTEGER NOT NULL DEFAULT 1,
    allow_self_enroll INTEGER NOT NULL DEFAULT 1,
    account_wiki TEXT,
    welcome_message TEXT,
    instructions TEXT,
    goal_edits INTEGER,
    goal_articles INTEGER,
    created_by TEXT,
    created_at TEXT NOT NULL,
    stats_updated_at TEXT,
    stats_error TEXT
  );

  CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'approved', 'declined')),
    status_token TEXT NOT NULL UNIQUE,
    requested_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    decision_reason TEXT,
    error_message TEXT,
    created_on_wiki TEXT,
    welcome_status TEXT,
    email_purged_at TEXT
  );
  -- A username can only have one live (pending, processing or approved) request
  CREATE UNIQUE INDEX idx_requests_live_username ON requests(username) WHERE status IN ('pending', 'processing', 'approved');
  CREATE INDEX idx_requests_event ON requests(event_id, status);

  CREATE TABLE participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('account', 'manual', 'self')),
    excluded INTEGER NOT NULL DEFAULT 0,
    synced INTEGER NOT NULL DEFAULT 0,
    added_by TEXT,
    added_at TEXT NOT NULL,
    UNIQUE (event_id, username)
  );

  CREATE TABLE contributions (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    wiki TEXT NOT NULL,
    revid INTEGER NOT NULL,
    username TEXT NOT NULL,
    title TEXT NOT NULL,
    ns INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    sizediff INTEGER NOT NULL DEFAULT 0,
    is_new INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, wiki, revid)
  );
  CREATE INDEX idx_contributions_user ON contributions(event_id, username);

  CREATE TABLE sync_state (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    wiki TEXT NOT NULL,
    synced_until TEXT NOT NULL,
    PRIMARY KEY (event_id, wiki)
  );

  CREATE TABLE login_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    wiki TEXT,
    logged_at TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT,
    action TEXT NOT NULL,
    event_id INTEGER,
    target TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_log(created_at);

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`;

const DEFAULT_WELCOME = '== উইকিপিডিয়ায় আপনাকে স্বাগত! ==\nপ্রিয় {{username}}, উইকিপিডিয়ায় আপনাকে স্বাগত। আপনার উইকিপিডিয়া যাত্রা শুভ হোক! -- ~~~~';

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// Copy data from the original (v1.x) database layout into the new schema
function migrateLegacyData(db) {
  const legacySettings = tableExists(db, 'legacy_settings')
    ? db.prepare('SELECT key, value FROM legacy_settings').all()
    : [];
  const keep = new Set(['welcome_message', 'additional_instructions']);
  const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const row of legacySettings) {
    if (keep.has(row.key)) insertSetting.run(row.key, row.value);
  }

  const eventIdsByName = new Map();
  if (tableExists(db, 'legacy_events')) {
    const insertEvent = db.prepare(`
      INSERT INTO events (id, name, workshop_url, start_time, end_time, target_wikis, target_namespaces, registration_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of db.prepare('SELECT * FROM legacy_events ORDER BY id').all()) {
      const start = bdLocalToUtcIso(e.start_time) || bdLocalToUtcIso('2026-01-01T00:00');
      let end = bdLocalToUtcIso(e.end_time) || start;
      if (end <= start) end = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
      insertEvent.run(
        e.id,
        e.name,
        e.workshop_url || null,
        start,
        end,
        e.target_wikis || 'bn.wikipedia.org',
        e.target_namespaces || 'all',
        e.registration_active === 0 ? 0 : 1,
        sqliteToIso(e.created_at) || nowIso()
      );
      eventIdsByName.set(e.name, e.id);
    }
  }

  if (tableExists(db, 'legacy_requests')) {
    const insertRequest = db.prepare(`
      INSERT INTO requests (id, event_id, username, email, status, status_token, requested_at, decided_by, decided_at, decision_reason, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const live = new Set();
    // Approved requests are handled first so they always keep their status;
    // ids are copied as they are, so the order here does not change them
    const priority = { approved: 0, pending: 1 };
    const legacyRequests = db.prepare('SELECT * FROM legacy_requests ORDER BY id').all()
      .sort((a, b) => (priority[a.status] ?? 2) - (priority[b.status] ?? 2) || a.id - b.id);
    for (const r of legacyRequests) {
      const username = normalizeUsername(r.username) || r.username;
      let status = ['pending', 'approved', 'declined'].includes(r.status) ? r.status : 'pending';
      let reason = r.decision_reason || null;
      // Two old requests that MediaWiki would treat as the same name
      if (status !== 'declined' && live.has(username)) {
        status = 'declined';
        reason = 'স্বয়ংক্রিয়: একই নামে আরেকটি আবেদন আছে (ডাটাবেজ হালনাগাদের সময় চিহ্নিত)।';
      }
      if (status !== 'declined') live.add(username);
      insertRequest.run(
        r.id,
        eventIdsByName.get(r.event_name) || null,
        username,
        r.email || null,
        status,
        newToken(),
        sqliteToIso(r.requested_at) || nowIso(),
        r.decided_by || null,
        sqliteToIso(r.decided_at),
        reason,
        r.error_message || null
      );
    }
  }

  if (tableExists(db, 'legacy_event_participants')) {
    const insertParticipant = db.prepare(`
      INSERT OR IGNORE INTO participants (event_id, username, source, added_at)
      VALUES (?, ?, ?, ?)`);
    for (const p of db.prepare('SELECT * FROM legacy_event_participants ORDER BY id').all()) {
      const eventId = eventIdsByName.get(p.event_name);
      const username = normalizeUsername(p.username);
      if (!eventId || !username) continue;
      insertParticipant.run(eventId, username, p.is_custom === 1 ? 'manual' : 'account', sqliteToIso(p.added_at) || nowIso());
    }
  }

  if (tableExists(db, 'legacy_login_logs')) {
    const insertLog = db.prepare('INSERT INTO login_logs (username, wiki, logged_at) VALUES (?, ?, ?)');
    for (const l of db.prepare('SELECT * FROM legacy_login_logs ORDER BY id').all()) {
      insertLog.run(l.username, l.wiki, sqliteToIso(l.logged_at) || nowIso());
    }
  }

  for (const t of ['legacy_settings', 'legacy_events', 'legacy_requests', 'legacy_event_participants', 'legacy_login_logs']) {
    if (tableExists(db, t)) db.exec(`DROP TABLE ${t}`);
  }
}

const MIGRATIONS = [
  // 1: new schema; converts a database created by version 1.x of the tool
  function initialSchema(db) {
    const legacyTables = ['settings', 'events', 'requests', 'event_participants', 'login_logs'].filter(t => tableExists(db, t));
    for (const t of legacyTables) {
      db.exec(`ALTER TABLE ${t} RENAME TO legacy_${t}`);
    }
    db.exec(SCHEMA);
    if (legacyTables.length > 0) {
      migrateLegacyData(db);
    }
    const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insertDefault.run('welcome_message', DEFAULT_WELCOME);
    insertDefault.run('additional_instructions', '');
  }
];

function backupBeforeMigration(db, dbPath) {
  if (dbPath === ':memory:') return null;
  const hasTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
  if (!hasTables) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(path.dirname(dbPath), `${path.basename(dbPath, '.sqlite')}.backup-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  return backupPath;
}

// Open (and if needed migrate) the database
function openDatabase(dbPath, { log = console } = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  // The default rollback journal is used on purpose: Toolforge stores tool
  // files on NFS, where SQLite's WAL mode is not safe.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true });
  if (version < MIGRATIONS.length) {
    const backupPath = backupBeforeMigration(db, dbPath);
    if (backupPath) log.log(`Database backup written to ${backupPath} before migrating.`);
    // Foreign keys must be off while tables are renamed and copied
    db.pragma('foreign_keys = OFF');
    const migrate = db.transaction(() => {
      for (let v = version; v < MIGRATIONS.length; v++) {
        MIGRATIONS[v](db);
        db.pragma(`user_version = ${v + 1}`);
      }
    });
    migrate();
    db.pragma('foreign_keys = ON');
    log.log(`Database migrated from version ${version} to ${MIGRATIONS.length}.`);
  }
  return db;
}

module.exports = { openDatabase, newToken, DEFAULT_WELCOME };

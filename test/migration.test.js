const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');

const silent = { log() {}, warn() {}, error() {} };

// The schema created by version 1.x of the tool (db.js before the rewrite)
function createLegacyDatabase(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT, status TEXT DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP, decided_by TEXT, decided_at DATETIME, error_message TEXT,
      event_name TEXT, decision_reason TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, workshop_url TEXT, start_time DATETIME, end_time DATETIME,
      target_wikis TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, target_namespaces TEXT, registration_active INTEGER DEFAULT 1);
    CREATE TABLE event_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT, username TEXT, total_edits INTEGER DEFAULT 0,
      file_uploads INTEGER DEFAULT 0, bytes_added INTEGER DEFAULT 0, is_custom INTEGER DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_name, username));
    CREATE TABLE login_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, wiki TEXT, logged_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
  `);
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('event_name', 'Ekushey 2024');
  insertSetting.run('welcome_message', 'Hello {{username}}');
  insertSetting.run('additional_instructions', 'Bring your phone');
  db.prepare("INSERT INTO events (id, name, workshop_url, start_time, end_time, target_wikis, target_namespaces, registration_active, created_at) VALUES (1, 'Ekushey 2024', 'https://bn.wikipedia.org', '2026-06-18T00:00', '2026-06-25T23:59', 'bn.wikipedia.org', '0,6', 1, '2026-06-01 08:00:00')").run();
  db.prepare("INSERT INTO events (id, name, workshop_url, start_time, end_time, target_wikis, target_namespaces, registration_active, created_at) VALUES (2, 'Workshop Dhaka', NULL, '2026-07-01T10:00', '2026-07-01T17:00', 'bn.wikipedia.org,commons.wikimedia.org', 'all', 0, '2026-06-20 08:00:00')").run();
  const insertRequest = db.prepare('INSERT INTO requests (username, email, status, requested_at, decided_by, decided_at, event_name, decision_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertRequest.run('Rahim Uddin', 'rahim@example.com', 'approved', '2026-06-18 04:30:00', 'Yahya', '2026-06-18 05:00:00', 'Ekushey 2024', null);
  insertRequest.run('karim_ali', 'karim@example.com', 'pending', '2026-06-18 04:31:00', null, null, 'Ekushey 2024', null);
  insertRequest.run('Karim ali', 'karim2@example.com', 'pending', '2026-06-18 04:32:00', null, null, 'Ekushey 2024', null);
  insertRequest.run('Old Person', 'old@example.com', 'declined', '2026-07-01 04:00:00', 'Yahya', '2026-07-01 05:00:00', 'Workshop Dhaka', 'Duplicate');
  const insertParticipant = db.prepare('INSERT INTO event_participants (event_name, username, total_edits, is_custom) VALUES (?, ?, ?, ?)');
  insertParticipant.run('Ekushey 2024', 'Rahim Uddin', 12, 0);
  insertParticipant.run('Ekushey 2024', 'experienced_editor', 40, 1);
  insertParticipant.run('Deleted Event', 'Ghost', 1, 1);
  db.prepare("INSERT INTO login_logs (username, wiki, logged_at) VALUES ('Yahya', 'bn.wikipedia.org', '2026-06-18 03:00:00')").run();
  db.close();
}

test('a database from version 1.x is backed up and converted without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-migrate-'));
  const file = path.join(dir, 'database.sqlite');
  createLegacyDatabase(file);

  const db = openDatabase(file, { log: silent });
  try {
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('database.backup-'));
    assert.equal(backups.length, 1, 'a backup was written before migrating');
    const backup = new Database(path.join(dir, backups[0]), { readonly: true });
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 4, 'backup has the original data');
    backup.close();

    assert.equal(db.pragma('user_version', { simple: true }), 1);

    const events = db.prepare('SELECT * FROM events ORDER BY id').all();
    assert.equal(events.length, 2);
    assert.equal(events[0].start_time, '2026-06-17T18:00:00.000Z', 'Bangladesh local time converted to UTC');
    assert.equal(events[0].end_time, '2026-06-25T17:59:00.000Z');
    assert.equal(events[0].target_namespaces, '0,6');
    assert.equal(events[0].created_at, '2026-06-01T08:00:00.000Z');
    assert.equal(events[1].registration_active, 0);
    assert.equal(events[1].workshop_url, null);

    const requests = db.prepare('SELECT * FROM requests ORDER BY id').all();
    assert.equal(requests.length, 4);
    assert.ok(requests.every(r => r.status_token && r.status_token.length >= 20), 'every request gets a status link');
    assert.equal(requests[0].event_id, 1);
    assert.equal(requests[0].email, 'rahim@example.com');
    assert.equal(requests[0].requested_at, '2026-06-18T04:30:00.000Z');
    assert.equal(requests[1].username, 'Karim ali', 'usernames are normalised');
    assert.equal(requests[1].status, 'pending');
    assert.equal(requests[2].status, 'declined', 'the second request for the same MediaWiki name is closed');
    assert.match(requests[2].decision_reason, /একই নামে/);
    assert.equal(requests[3].event_id, 2);
    assert.equal(requests[3].decision_reason, 'Duplicate');

    const participants = db.prepare('SELECT event_id, username, source, synced FROM participants ORDER BY username').all();
    assert.deepEqual(participants, [
      { event_id: 1, username: 'Experienced editor', source: 'manual', synced: 0 },
      { event_id: 1, username: 'Rahim Uddin', source: 'account', synced: 0 }
    ]);

    const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
    assert.equal(settings.welcome_message, 'Hello {{username}}');
    assert.equal(settings.additional_instructions, 'Bring your phone');
    assert.equal(settings.event_name, undefined, 'obsolete settings are dropped');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM login_logs').get().n, 1);
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'legacy_%'").all();
    assert.deepEqual(legacy, []);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opening an up-to-date database does nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-migrate-'));
  const file = path.join(dir, 'database.sqlite');
  try {
    openDatabase(file, { log: silent }).close();
    const before = fs.readdirSync(dir).length;
    const db = openDatabase(file, { log: silent });
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    db.close();
    assert.equal(fs.readdirSync(dir).length, before, 'no extra backup for a current database');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

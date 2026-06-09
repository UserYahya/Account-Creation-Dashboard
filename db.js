const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let db = null;

async function getDatabase() {
  if (db) return db;
  
  const dbPath = path.join(__dirname, 'database.sqlite');
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  // Create tables if they don't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      email TEXT,
      status TEXT DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_by TEXT,
      decided_at DATETIME,
      error_message TEXT,
      event_name TEXT,
      decision_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      workshop_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Try to alter table to add decision_reason if migrating existing database
  try {
    await db.exec('ALTER TABLE requests ADD COLUMN decision_reason TEXT');
  } catch (e) {
    // Column already exists, safe to ignore
  }


  // Insert default settings if they don't exist
  const eventName = await db.get('SELECT value FROM settings WHERE key = ?', 'event_name');
  if (!eventName) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'event_name', 'অমর একুশে উইকিপিডিয়া নিবন্ধ প্রতিযোগিতা ২০২৪');
  }

  const regActive = await db.get('SELECT value FROM settings WHERE key = ?', 'registration_active');
  if (!regActive) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'registration_active', '1');
  }

  const workshopUrl = await db.get('SELECT value FROM settings WHERE key = ?', 'workshop_url');
  if (!workshopUrl) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'workshop_url', 'https://bn.wikipedia.org');
  }

  const addInstructions = await db.get('SELECT value FROM settings WHERE key = ?', 'additional_instructions');
  if (!addInstructions) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'additional_instructions', '');
  }

  const welcomeMessage = await db.get('SELECT value FROM settings WHERE key = ?', 'welcome_message');
  if (!welcomeMessage) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'welcome_message', '== উইকিপিডিয়ায় আপনাকে স্বাগত! ==\nপ্রিয় {{username}}, উইকিপিডিয়ায় আপনাকে স্বাগত। আপনার উইকিপিডিয়া যাত্রা শুভ হোক! -- ~~~~');
  }

  // Migrate active event to events table if empty
  const eventsCount = await db.get('SELECT COUNT(*) as count FROM events');
  if (eventsCount.count === 0) {
    const curName = await db.get('SELECT value FROM settings WHERE key = ?', 'event_name');
    const curUrl = await db.get('SELECT value FROM settings WHERE key = ?', 'workshop_url');
    await db.run(
      'INSERT INTO events (name, workshop_url) VALUES (?, ?)',
      curName ? curName.value : 'অমর একুশে উইকিপিডিয়া নিবন্ধ প্রতিযোগিতা ২০২৪',
      curUrl ? curUrl.value : 'https://bn.wikipedia.org'
    );
  }

  return db;
}

module.exports = { getDatabase };

'use strict';
// Datenbank: SQLite über das in Node 22 eingebaute Modul node:sqlite.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_LOCATIONS = [
  ['Hauptgebäude', 'Erdgeschoss'],
  ['Hauptgebäude', '1. Obergeschoss'],
  ['Hauptgebäude', '2. Obergeschoss'],
  ['Sporthalle', 'Halle'],
  ['Sporthalle', 'Umkleiden'],
  ['Schulhof', 'Pausenhof'],
  ['Mensa', 'Speisesaal'],
];

const DEFAULT_INJURIES = [
  'Sturz/Prellung',
  'Schnittwunde/Blutung',
  'Kreislauf/Bewusstsein',
  'Atemnot/Allergie',
  'Krampfanfall',
  'Sonstiges',
];

// Startraster; der Admin passt es an die Zeiten der Schule an.
// Start: ein Tagesdienst von 08:00 bis 14:30 Uhr mit mindestens 2 Sanitätern.
const DEFAULT_PERIOD = { name: 'Tagesdienst', start: '08:00', end: '14:30', min: 2 };
// Startraster aus der ersten Dienstplan-Version; wird ersetzt, solange noch niemand eingeteilt ist.
const OLD_DEFAULT_NAMES = ['1. Stunde', '2. Stunde', '1. große Pause', '3. Stunde', '4. Stunde', '2. große Pause',
  '5. Stunde', '6. Stunde', 'Mittagspause', '7. Stunde', '8. Stunde'];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('medic', 'leader', 'sender', 'admin')),
      available INTEGER NOT NULL DEFAULT 1,
      default_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY,
      building TEXT NOT NULL,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS injury_types (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS duty_slots (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alarms (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      location TEXT NOT NULL,
      injury TEXT NOT NULL,
      urgency TEXT NOT NULL CHECK (urgency IN ('red', 'yellow', 'green')),
      note TEXT NOT NULL DEFAULT '',
      is_test INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL CHECK (scope IN ('duty', 'all')),
      escalated_at TEXT,
      no_response_at TEXT,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS alarm_recipients (
      alarm_id INTEGER NOT NULL REFERENCES alarms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      response TEXT CHECK (response IN ('coming', 'declined')),
      responded_at TEXT,
      PRIMARY KEY (alarm_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      alarm_id INTEGER REFERENCES alarms(id) ON DELETE CASCADE, -- NULL = allgemeiner Chat
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_by_alarm ON chat_messages (alarm_id, id);

    -- Dienstzeiten (Start: ein Tagesdienst). kind stammt aus der ersten Version mit Stunden und Pausen.
    CREATE TABLE IF NOT EXISTS periods (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('lesson', 'break')),
      min_total INTEGER NOT NULL DEFAULT 1,
      min_leaders INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS duty_assignments (
      id INTEGER PRIMARY KEY,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
      period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (weekday, period_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS absences (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL
    );
    -- Ein Sanitäter gibt einen einzelnen Termin ab; wer ihn nimmt, steht in taken_by.
    CREATE TABLE IF NOT EXISTS duty_offers (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL REFERENCES duty_assignments(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      taken_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      taken_at TEXT,
      UNIQUE (assignment_id, date)
    );
    -- Einzelne zusätzliche Dienste, z. B. ein übernommener offener Dienst.
    CREATE TABLE IF NOT EXISTS duty_extras (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (date, period_id, user_id)
    );
  `);
  db.exec('DROP TABLE IF EXISTS duty_slots');
  migrateLeaderRole(db);

  if (db.prepare('SELECT COUNT(*) AS n FROM locations').get().n === 0) {
    const ins = db.prepare('INSERT INTO locations (building, name, sort) VALUES (?, ?, ?)');
    DEFAULT_LOCATIONS.forEach(([b, n], i) => ins.run(b, n, i));
  }
  replaceOldRaster(db);
  if (db.prepare('SELECT COUNT(*) AS n FROM periods').get().n === 0) {
    db.prepare("INSERT INTO periods (name, start_time, end_time, kind, min_total, min_leaders) VALUES (?, ?, ?, 'lesson', ?, 0)")
      .run(DEFAULT_PERIOD.name, DEFAULT_PERIOD.start, DEFAULT_PERIOD.end, DEFAULT_PERIOD.min);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM injury_types').get().n === 0) {
    const ins = db.prepare('INSERT INTO injury_types (name, sort) VALUES (?, ?)');
    DEFAULT_INJURIES.forEach((n, i) => ins.run(n, i));
  }
  return db;
}

// Das alte Startraster (Stunden und Pausen) wird durch den Tagesdienst ersetzt,
// aber nur, wenn es unverändert ist und noch niemand eingeteilt wurde.
function replaceOldRaster(db) {
  const names = db.prepare('SELECT name FROM periods ORDER BY start_time, id').all().map((r) => r.name);
  if (names.join('|') !== OLD_DEFAULT_NAMES.join('|')) return;
  const used = ['duty_assignments', 'duty_extras'].some((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n > 0);
  if (!used) db.exec('DELETE FROM periods');
}

// Datenbanken aus dem Prototyp kennen die Rolle Gruppenführer/in noch nicht.
// SQLite kann eine CHECK-Bedingung nicht ändern, deshalb wird die Tabelle neu angelegt.
function migrateLeaderRole(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (sql.includes("'leader'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    // Reihenfolge nach https://www.sqlite.org/lang_altertable.html#otheralter,
    // damit die Fremdschlüssel anderer Tabellen weiter auf "users" zeigen.
    const newSql = sql
      .replace("('medic', 'sender', 'admin')", "('medic', 'leader', 'sender', 'admin')")
      .replace(/^CREATE TABLE "?users"?/, 'CREATE TABLE users_new');
    db.exec(`${newSql};
      INSERT INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

module.exports = { open, getSetting, setSetting };

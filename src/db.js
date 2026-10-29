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
  `);
  migrateLeaderRole(db);

  if (db.prepare('SELECT COUNT(*) AS n FROM locations').get().n === 0) {
    const ins = db.prepare('INSERT INTO locations (building, name, sort) VALUES (?, ?, ?)');
    DEFAULT_LOCATIONS.forEach(([b, n], i) => ins.run(b, n, i));
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM injury_types').get().n === 0) {
    const ins = db.prepare('INSERT INTO injury_types (name, sort) VALUES (?, ?)');
    DEFAULT_INJURIES.forEach((n, i) => ins.run(n, i));
  }
  return db;
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

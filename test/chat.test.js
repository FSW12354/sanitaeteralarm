'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');
const auth = require('../src/auth');
const db = require('../src/db');

async function start() {
  auth.setLeaderPermissions(auth.LEADER_DEFAULTS);
  const s = setup();
  const users = {
    admin: s.addUser('admin', 'admin', { available: 0 }),
    leader: s.addUser('gf', 'leader', { available: 0 }),
    sender: s.addUser('sender', 'sender'),
    lea: s.addUser('lea', 'medic'),
    tom: s.addUser('tom', 'medic'),
  };
  const { app, alarms } = createApp({ db: s.database, notifier: s.notifier });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login(username) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'passwort123' }),
    });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (p, { method = 'GET', body } = {}) => {
      const r = await fetch(`${base}/api${p}`, {
        method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    };
  }
  return { ...s, users, alarms, login, close: () => server.close() };
}

async function sendAlarm(sender) {
  const lists = (await sender('/lists')).data;
  return (await sender('/alarms', {
    method: 'POST', body: { locationId: lists.locations[0].id, injuryId: lists.injuries[0].id, urgency: 'green' },
  })).data;
}

test('Gruppenführer/in hat die Startrechte, aber keine Admin-Rechte', async (t) => {
  const s = await start();
  t.after(s.close);
  const gf = await s.login('gf');
  const perms = (await gf('/me')).data.permissions;
  assert.ok(perms.includes('alarm.view_all'));
  assert.ok(perms.includes('duty.manage'));
  assert.ok(!perms.includes('users.manage'));
  assert.equal((await gf('/users')).status, 403);
  assert.equal((await gf('/duty')).status, 200);
});

test('Admin legt die Rechte der Gruppenführer fest', async (t) => {
  const s = await start();
  t.after(s.close);
  const admin = await s.login('admin');
  const gf = await s.login('gf');
  const res = await admin('/settings', {
    method: 'PUT', body: { leader_permissions: ['alarm.receive', 'chat.general', 'users.manage', 'gibt.es.nicht'] },
  });
  assert.equal(res.status, 200);
  const settings = (await admin('/settings')).data;
  assert.deepEqual(settings.leader_permissions, ['alarm.receive', 'chat.general'], 'Admin-Rechte und Unbekanntes werden verworfen');
  assert.equal((await gf('/duty')).status, 403);
  assert.ok((await admin('/me')).data.permissions.includes('chat.moderate'), 'Admin behält alle Rechte');
});

test('Allgemeiner Chat: Sanitäter ja, Sender nein', async (t) => {
  const s = await start();
  t.after(s.close);
  const lea = await s.login('lea');
  const sender = await s.login('sender');
  assert.equal((await sender('/chat/general')).status, 403);
  const posted = await lea('/chat/general', { method: 'POST', body: { body: '  Wer hat den Schlüssel zum Sanitätsraum?  ' } });
  assert.equal(posted.data.body, 'Wer hat den Schlüssel zum Sanitätsraum?');
  assert.equal((await lea('/chat/general', { method: 'POST', body: { body: '   ' } })).status, 400);
  const list = (await lea('/chat/general')).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].display_name, 'lea');
  const sent = s.calls.message.at(-1);
  assert.deepEqual(sent.ids, [s.users.admin.id, s.users.leader.id, s.users.lea.id, s.users.tom.id].sort());
});

test('Einsatzchat nur für Beteiligte', async (t) => {
  const s = await start();
  t.after(s.close);
  const sender = await s.login('sender');
  const lea = await s.login('lea');
  const gf = await s.login('gf');
  const alarm = await sendAlarm(sender);
  // Niemand im Dienst: Alarm geht an Lea und Tom; Gruppenführer und Admin sind nicht verfügbar.
  assert.equal((await sender(`/alarms/${alarm.id}/chat`, { method: 'POST', body: { body: 'Schüler sitzt im Sekretariat' } })).status, 200);
  assert.equal((await lea(`/alarms/${alarm.id}/chat`, { method: 'POST', body: { body: 'Bin unterwegs' } })).status, 200);
  assert.equal((await gf(`/alarms/${alarm.id}/chat`)).data.length, 2, 'Gruppenführer sieht alle Einsätze');
  const sent = s.calls.message.at(-1);
  assert.deepEqual(sent.ids, [s.users.admin.id, s.users.leader.id, s.users.sender.id, s.users.lea.id, s.users.tom.id].sort());

  // Lea ist nicht verfügbar: Der nächste Alarm geht nur an Tom, Lea sieht seinen Chat nicht.
  await lea('/me/availability', { method: 'PUT', body: { available: false } });
  const second = await sendAlarm(sender);
  assert.equal((await lea(`/alarms/${second.id}/chat`)).status, 404);
  await sender(`/alarms/${second.id}/end`, { method: 'POST' });
  assert.equal((await sender(`/alarms/${second.id}/chat`, { method: 'POST', body: { body: 'zu spät' } })).status, 400, 'Beendeter Einsatz');
});

test('Gruppenführer/in löscht Nachrichten, Sanitäter nicht', async (t) => {
  const s = await start();
  t.after(s.close);
  const lea = await s.login('lea');
  const gf = await s.login('gf');
  const msg = (await lea('/chat/general', { method: 'POST', body: { body: 'Unpassend' } })).data;
  assert.equal((await lea(`/chat/${msg.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await gf(`/chat/${msg.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await lea('/chat/general')).data.length, 0);
  assert.equal(s.calls.message.at(-1).message.type, 'chat_delete');
});

test('Allgemeiner Chat wird nach der Frist gelöscht', async (t) => {
  const s = await start();
  t.after(s.close);
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  s.database.prepare('INSERT INTO chat_messages (alarm_id, user_id, body, created_at) VALUES (NULL, ?, ?, ?)').run(s.users.lea.id, 'alt', old);
  s.database.prepare('INSERT INTO chat_messages (alarm_id, user_id, body, created_at) VALUES (NULL, ?, ?, ?)').run(s.users.lea.id, 'neu', new Date().toISOString());
  s.alarms.tick();
  const left = s.database.prepare('SELECT body FROM chat_messages').all().map((r) => r.body);
  assert.deepEqual(left, ['neu']);
});

test('Datenbank aus dem Prototyp bekommt die neue Rolle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sani-'));
  const file = path.join(dir, 'alt.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE locations (id INTEGER PRIMARY KEY, building TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('medic', 'sender', 'admin')),
      available INTEGER NOT NULL DEFAULT 1,
      default_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (username, display_name, pw_hash, role) VALUES ('bruce', 'Bruce', 'x', 'admin');
    INSERT INTO sessions (token, user_id) VALUES ('t', 1);`);
  old.close();
  const migrated = db.open(file);
  migrated.prepare("INSERT INTO users (username, display_name, pw_hash, role) VALUES ('gf', 'GF', 'x', 'leader')").run();
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.match(migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get().sql, /REFERENCES users\(id\)/);
  migrated.close();
  fs.rmSync(dir, { recursive: true });
});

'use strict';
const db = require('../src/db');
const auth = require('../src/auth');

function setup() {
  const database = db.open(':memory:');
  const calls = { alarm: [], update: [], noResponse: [], message: [] };
  const notifier = {
    publicKey: 'test-key',
    attach() {},
    alarm: (ids, a) => calls.alarm.push({ ids: [...ids].sort(), alarm: a }),
    update: (ids, a) => calls.update.push({ ids, alarm: a }),
    noResponse: (ids, a) => calls.noResponse.push({ ids: [...ids].sort(), alarm: a }),
    message: (ids, m) => calls.message.push({ ids: [...ids].sort(), message: m }),
  };
  const addUser = (username, role, extra = {}) => {
    const { lastInsertRowid } = database.prepare(
      'INSERT INTO users (username, display_name, pw_hash, role, available) VALUES (?, ?, ?, ?, ?)',
    ).run(username, username, auth.hashPassword('passwort123'), role, extra.available ?? 1);
    return database.prepare('SELECT * FROM users WHERE id = ?').get(Number(lastInsertRowid));
  };
  return { database, notifier, calls, addUser };
}

module.exports = { setup };

'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');
const { createNotifier } = require('./notifier');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 8443);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { TLS_CERT, TLS_KEY } = process.env;

const database = db.open(path.join(DATA_DIR, 'sanitaeteralarm.db'));

// Beim ersten Start gibt es noch keinen Benutzer: Admin-Konto anlegen.
if (database.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  database.prepare('INSERT INTO users (username, display_name, pw_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, process.env.ADMIN_NAME || 'Admin', auth.hashPassword(password), 'admin');
  console.log(`Admin-Konto angelegt: Benutzername "${username}"${process.env.ADMIN_PASSWORD ? '' : `, Passwort "${password}"`}`);
  console.log('Bitte das Passwort nach der ersten Anmeldung ändern.');
}

const notifier = createNotifier(database, { subject: process.env.PUSH_CONTACT || 'mailto:admin@schule.local' });
const useTls = Boolean(TLS_CERT && TLS_KEY);
const { app, alarms, attachWebSocket } = createApp({ db: database, notifier, secureCookies: useTls });

const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
  : http.createServer(app);
attachWebSocket(server);
setInterval(() => {
  try {
    alarms.tick();
  } catch (err) {
    console.error('Fehler bei der Eskalationsprüfung', err);
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`Sanitäteralarm läuft auf ${useTls ? 'https' : 'http'}://0.0.0.0:${PORT}`);
  if (!useTls) console.log('Achtung: ohne HTTPS funktionieren Mitteilungen auf dem iPhone nicht (nur zum Testen).');
});

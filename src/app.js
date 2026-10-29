'use strict';
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const { getSetting, setSetting } = require('./db');
const { createAlarmService, DEFAULTS } = require('./alarms');

const COOKIE = 'sanialarm';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    role_label: auth.ROLE_LABELS[u.role],
    available: !!u.available,
    default_location_id: u.default_location_id,
    disabled: !!u.disabled,
  };
}

function createApp({ db, notifier, secureCookies = false, clock }) {
  const alarms = createAlarmService(db, notifier, clock);
  const now = clock || (() => new Date());
  const storedLeader = getSetting(db, 'leader_permissions');
  if (storedLeader) auth.setLeaderPermissions(JSON.parse(storedLeader));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function userFromToken(token) {
    if (!token) return null;
    return db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND u.disabled = 0`).get(token) || null;
  }

  app.use((req, _res, next) => {
    req.user = userFromToken(parseCookies(req.headers.cookie)[COOKIE]);
    next();
  });

  const wrap = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      next(err);
    }
  };

  function need(permission) {
    return (req, _res, next) => {
      if (!req.user) return next(new HttpError(401, 'Bitte anmelden'));
      if (permission && !auth.can(req.user, permission)) return next(new HttpError(403, 'Keine Berechtigung'));
      next();
    };
  }

  // --- Anmeldung -----------------------------------------------------------
  app.post('/api/login', wrap((req, res) => {
    const { username = '', password = '' } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').get(String(username).trim());
    if (!user || !auth.verifyPassword(String(password), user.pw_hash)) {
      throw new HttpError(401, 'Benutzername oder Passwort falsch');
    }
    const token = auth.newToken();
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
    // Das Gerät bleibt angemeldet, damit im Notfall niemand neu einloggen muss.
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: 400 * 24 * 3600 * 1000,
    });
    return { ok: true };
  }));

  app.post('/api/logout', need(), wrap((req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(parseCookies(req.headers.cookie)[COOKIE]);
    res.clearCookie(COOKIE);
    return { ok: true };
  }));

  app.get('/api/me', need(), wrap((req) => ({
    user: publicUser(req.user),
    permissions: auth.permissionsOf(req.user),
    vapidPublicKey: notifier.publicKey,
  })));

  app.put('/api/me/availability', need('availability.set'), wrap((req) => {
    db.prepare('UPDATE users SET available = ? WHERE id = ?').run(req.body?.available ? 1 : 0, req.user.id);
    return { ok: true };
  }));

  app.put('/api/me/password', need(), wrap((req) => {
    const { oldPassword = '', newPassword = '' } = req.body || {};
    if (!auth.verifyPassword(String(oldPassword), req.user.pw_hash)) throw new HttpError(400, 'Altes Passwort falsch');
    if (String(newPassword).length < 8) throw new HttpError(400, 'Neues Passwort braucht mindestens 8 Zeichen');
    db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(auth.hashPassword(newPassword), req.user.id);
    return { ok: true };
  }));

  app.post('/api/push/subscribe', need(), wrap((req) => {
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new HttpError(400, 'Ungültige Anmeldung für Mitteilungen');
    db.prepare(`
      INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(sub.endpoint, req.user.id, sub.keys.p256dh, sub.keys.auth);
    return { ok: true };
  }));

  // --- Listen ---------------------------------------------------------------
  app.get('/api/lists', need(), wrap(() => ({
    locations: db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY sort, building, name').all(),
    injuries: db.prepare('SELECT * FROM injury_types WHERE active = 1 ORDER BY sort, name').all(),
  })));

  // --- Alarme ----------------------------------------------------------------
  app.get('/api/alarms', need(), wrap((req) => alarms.visibleTo(req.user, { activeOnly: req.query.active === '1' })));

  app.post('/api/alarms', need('alarm.send'), wrap((req) => {
    const { locationId, room = '', injuryId, urgency, note = '', isTest = false } = req.body || {};
    const loc = db.prepare('SELECT * FROM locations WHERE id = ? AND active = 1').get(Number(locationId));
    const inj = db.prepare('SELECT * FROM injury_types WHERE id = ? AND active = 1').get(Number(injuryId));
    if (!loc || !inj) throw new HttpError(400, 'Ort und Verletzungsart wählen');
    if (isTest && !auth.can(req.user, 'alarm.test')) throw new HttpError(403, 'Keine Berechtigung für Testalarme');
    const roomText = String(room).trim().slice(0, 40);
    const location = `${loc.building} – ${loc.name}${roomText ? `, Raum ${roomText}` : ''}`;
    try {
      return alarms.create({ sender: req.user, location, injury: inj.name, urgency, note, isTest: !!isTest });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }));

  function alarmFor(req) {
    const alarm = alarms.load(Number(req.params.id));
    if (!alarm || !alarms.canSee(req.user, alarm)) throw new HttpError(404, 'Alarm nicht gefunden');
    return alarm;
  }

  app.post('/api/alarms/:id/respond', need('alarm.receive'), wrap((req) => {
    const alarm = alarmFor(req);
    if (alarm.ended_at) throw new HttpError(400, 'Alarm ist bereits beendet');
    try {
      return alarms.respond(alarm.id, req.user, req.body?.response);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }));

  function mayControl(user, alarm) {
    return auth.can(user, 'alarm.view_all') || alarm.sender_id === user.id
      || alarm.recipients.some((r) => r.user_id === user.id && r.response === 'coming');
  }

  app.post('/api/alarms/:id/resend', need(), wrap((req) => {
    const alarm = alarmFor(req);
    if (alarm.sender_id !== req.user.id && !auth.can(req.user, 'alarm.view_all')) throw new HttpError(403, 'Keine Berechtigung');
    try {
      return alarms.resend(alarm.id);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }));

  app.post('/api/alarms/:id/end', need(), wrap((req) => {
    const alarm = alarmFor(req);
    if (!mayControl(req.user, alarm)) throw new HttpError(403, 'Keine Berechtigung');
    return alarms.end(alarm.id);
  }));

  // --- Dienstplan ------------------------------------------------------------
  app.get('/api/duty/me', need('duty.view_own'), wrap((req) => db.prepare(
    'SELECT * FROM duty_slots WHERE user_id = ? ORDER BY weekday, start_time').all(req.user.id)));

  app.get('/api/duty', need('duty.manage'), wrap(() => db.prepare(`
    SELECT d.*, u.display_name FROM duty_slots d JOIN users u ON u.id = d.user_id
    ORDER BY d.weekday, d.start_time, u.display_name`).all()));

  app.post('/api/duty', need('duty.manage'), wrap((req) => {
    const { userId, weekday, start, end } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!user || !auth.can(user, 'alarm.receive')) throw new HttpError(400, 'Nur Sanitäter können Dienst haben');
    if (!(Number(weekday) >= 1 && Number(weekday) <= 7)) throw new HttpError(400, 'Ungültiger Wochentag');
    if (!TIME_RE.test(start) || !TIME_RE.test(end) || start >= end) throw new HttpError(400, 'Ungültige Uhrzeit');
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO duty_slots (user_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)',
    ).run(user.id, Number(weekday), start, end);
    return { id: Number(lastInsertRowid) };
  }));

  app.delete('/api/duty/:id', need('duty.manage'), wrap((req) => {
    db.prepare('DELETE FROM duty_slots WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  }));

  // --- Benutzer --------------------------------------------------------------
  app.get('/api/users', need('users.manage'), wrap(() => db.prepare('SELECT * FROM users ORDER BY role, display_name').all().map(publicUser)));

  function checkRole(role) {
    if (!auth.ROLE_LABELS[role]) throw new HttpError(400, 'Unbekannte Rolle');
  }

  app.post('/api/users', need('users.manage'), wrap((req) => {
    const { username = '', displayName = '', password = '', role, defaultLocationId = null } = req.body || {};
    checkRole(role);
    if (!String(username).trim() || !String(displayName).trim()) throw new HttpError(400, 'Name und Benutzername angeben');
    if (String(password).length < 8) throw new HttpError(400, 'Passwort braucht mindestens 8 Zeichen');
    try {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO users (username, display_name, pw_hash, role, default_location_id) VALUES (?, ?, ?, ?, ?)`)
        .run(String(username).trim(), String(displayName).trim(), auth.hashPassword(password), role, defaultLocationId || null);
      return { id: Number(lastInsertRowid) };
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(400, 'Benutzername ist schon vergeben');
      throw err;
    }
  }));

  app.put('/api/users/:id', need('users.manage'), wrap((req) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) throw new HttpError(404, 'Benutzer nicht gefunden');
    const b = req.body || {};
    const role = b.role ?? user.role;
    checkRole(role);
    const disabled = b.disabled === undefined ? user.disabled : (b.disabled ? 1 : 0);
    if (b.password && String(b.password).length < 8) throw new HttpError(400, 'Passwort braucht mindestens 8 Zeichen');
    const losesAdmin = user.role === 'admin' && (role !== 'admin' || disabled);
    if (losesAdmin && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n <= 1) {
      throw new HttpError(400, 'Es muss mindestens einen aktiven Admin geben');
    }
    db.prepare(`UPDATE users SET display_name = ?, role = ?, disabled = ?, default_location_id = ? WHERE id = ?`).run(
      String(b.displayName ?? user.display_name).trim() || user.display_name,
      role,
      disabled,
      b.defaultLocationId === undefined ? user.default_location_id : (b.defaultLocationId || null),
      user.id,
    );
    if (b.password) {
      db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), user.id);
    }
    if (disabled || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return { ok: true };
  }));

  // --- Orte und Verletzungsarten ----------------------------------------------
  function listRoutes(route, table, fields) {
    app.get(`/api/${route}`, need('lists.manage'), wrap(() => db.prepare(`SELECT * FROM ${table} ORDER BY sort, id`).all()));
    app.post(`/api/${route}`, need('lists.manage'), wrap((req) => {
      const values = fields.map((f) => String(req.body?.[f] ?? '').trim());
      if (values.some((v) => !v)) throw new HttpError(400, 'Bitte alle Felder ausfüllen');
      const sort = db.prepare(`SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM ${table}`).get().s;
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO ${table} (${fields.join(', ')}, sort) VALUES (${fields.map(() => '?').join(', ')}, ?)`,
      ).run(...values, sort);
      return { id: Number(lastInsertRowid) };
    }));
    app.put(`/api/${route}/:id`, need('lists.manage'), wrap((req) => {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(req.params.id));
      if (!row) throw new HttpError(404, 'Eintrag nicht gefunden');
      const values = fields.map((f) => String(req.body?.[f] ?? row[f]).trim() || row[f]);
      const active = req.body?.active === undefined ? row.active : (req.body.active ? 1 : 0);
      const sort = Number.isInteger(req.body?.sort) ? req.body.sort : row.sort;
      db.prepare(`UPDATE ${table} SET ${fields.map((f) => `${f} = ?`).join(', ')}, active = ?, sort = ? WHERE id = ?`)
        .run(...values, active, sort, row.id);
      return { ok: true };
    }));
  }
  listRoutes('locations', 'locations', ['building', 'name']);
  listRoutes('injuries', 'injury_types', ['name']);

  // --- Protokoll und Einstellungen -------------------------------------------------
  app.get('/api/log.csv', need('log.view'), (req, res) => {
    const rows = db.prepare(`
      SELECT a.*, u.display_name AS sender_name,
        (SELECT MIN(responded_at) FROM alarm_recipients r WHERE r.alarm_id = a.id AND r.response = 'coming') AS first_coming,
        (SELECT COUNT(*) FROM alarm_recipients r WHERE r.alarm_id = a.id) AS recipients,
        (SELECT COUNT(*) FROM alarm_recipients r WHERE r.alarm_id = a.id AND r.response = 'coming') AS coming
      FROM alarms a LEFT JOIN users u ON u.id = a.sender_id ORDER BY a.created_at DESC`).all();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Zeitpunkt', 'Test', 'Ort', 'Verletzungsart', 'Dringlichkeit', 'Sender', 'Empfänger', 'Zusagen',
      'Reaktionszeit (s)', 'Eskaliert', 'Ohne Zusage gemeldet', 'Beendet'];
    const lines = rows.map((a) => [
      a.created_at, a.is_test ? 'ja' : 'nein', a.location, a.injury, a.urgency, a.sender_name, a.recipients, a.coming,
      a.first_coming ? Math.round((new Date(a.first_coming) - new Date(a.created_at)) / 1000) : '',
      a.escalated_at || '', a.no_response_at || '', a.ended_at || '',
    ].map(esc).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="einsatzprotokoll.csv"');
    res.send(`﻿${[header.map(esc).join(';'), ...lines].join('\r\n')}`);
  });

  const SETTING_KEYS = Object.keys(DEFAULTS);
  app.get('/api/settings', need('settings.manage'), wrap(() => ({
    ...Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(db, k, String(DEFAULTS[k]))])),
    leader_permissions: auth.permissionsOf({ role: 'leader' }),
    permission_labels: auth.PERMISSIONS,
    admin_only: auth.ADMIN_ONLY,
  })));

  app.put('/api/settings', need('settings.manage'), wrap((req) => {
    const b = req.body || {};
    const updates = [];
    for (const k of ['escalate_seconds', 'no_response_seconds']) {
      if (b[k] !== undefined) {
        const n = Number(b[k]);
        if (!Number.isInteger(n) || n < 10 || n > 3600) throw new HttpError(400, 'Zeiten zwischen 10 und 3600 Sekunden');
        updates.push([k, n]);
      }
    }
    if (b.chat_retention_days !== undefined) {
      const n = Number(b.chat_retention_days);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'Chat-Löschfrist zwischen 1 und 365 Tagen');
      updates.push(['chat_retention_days', n]);
    }
    if (b.school_year_end !== undefined) {
      if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(b.school_year_end)) throw new HttpError(400, 'Datum als MM-TT angeben');
      updates.push(['school_year_end', b.school_year_end]);
    }
    if (b.leader_permissions !== undefined) {
      if (!Array.isArray(b.leader_permissions)) throw new HttpError(400, 'Ungültige Rechteliste');
      updates.push(['leader_permissions', JSON.stringify(auth.setLeaderPermissions(b.leader_permissions))]);
    }
    for (const [k, v] of updates) setSetting(db, k, v);
    return { ok: true };
  }));

  // --- Chat ------------------------------------------------------------------
  // Einsatzchat gehört zu einem Alarm, allgemeiner Chat hat alarm_id NULL.
  function chatMessages(alarmId) {
    const where = alarmId === null ? 'm.alarm_id IS NULL' : 'm.alarm_id = ?';
    const args = alarmId === null ? [] : [alarmId];
    return db.prepare(`
      SELECT * FROM (
        SELECT m.id, m.alarm_id, m.user_id, m.body, m.created_at, u.display_name, u.role
        FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE ${where} ORDER BY m.id DESC LIMIT 200
      ) ORDER BY id`).all(...args)
      .map((m) => ({ ...m, role_label: auth.ROLE_LABELS[m.role] || '' }));
  }

  function generalAudience() {
    return db.prepare('SELECT * FROM users WHERE disabled = 0').all()
      .filter((u) => auth.can(u, 'chat.general')).map((u) => u.id);
  }

  function postMessage(user, alarmId, body) {
    const text = String(body ?? '').trim().slice(0, 1000);
    if (!text) throw new HttpError(400, 'Leere Nachricht');
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO chat_messages (alarm_id, user_id, body, created_at) VALUES (?, ?, ?, ?)',
    ).run(alarmId, user.id, text, now().toISOString());
    const message = {
      id: Number(lastInsertRowid), alarm_id: alarmId, user_id: user.id, body: text,
      created_at: now().toISOString(), display_name: user.display_name, role: user.role,
      role_label: auth.ROLE_LABELS[user.role],
    };
    const ids = alarmId === null ? generalAudience() : alarms.audience(alarms.load(alarmId));
    notifier.message(ids, { type: 'chat', message });
    return message;
  }

  app.get('/api/chat/general', need('chat.general'), wrap(() => chatMessages(null)));
  app.post('/api/chat/general', need('chat.general'), wrap((req) => postMessage(req.user, null, req.body?.body)));

  app.get('/api/alarms/:id/chat', need(), wrap((req) => chatMessages(alarmFor(req).id)));
  app.post('/api/alarms/:id/chat', need(), wrap((req) => {
    const alarm = alarmFor(req);
    if (alarm.ended_at) throw new HttpError(400, 'Der Einsatz ist beendet');
    return postMessage(req.user, alarm.id, req.body?.body);
  }));

  app.delete('/api/chat/:id', need('chat.moderate'), wrap((req) => {
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(req.params.id));
    if (!msg) throw new HttpError(404, 'Nachricht nicht gefunden');
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(msg.id);
    const ids = msg.alarm_id === null ? generalAudience() : alarms.audience(alarms.load(msg.alarm_id));
    notifier.message(ids, { type: 'chat_delete', id: msg.id, alarm_id: msg.alarm_id });
    return { ok: true };
  }));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Nicht gefunden')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Interner Fehler' : err.message });
  });

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const user = req.url === '/ws' ? userFromToken(parseCookies(req.headers.cookie)[COOKIE]) : null;
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => notifier.attach(user.id, ws));
    });
    // Herzschlag: Die Geräte merken so, wenn der Server ausfällt.
    const beat = setInterval(() => {
      for (const ws of wss.clients) ws.send(JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() }));
    }, 30_000);
    server.on('close', () => clearInterval(beat));
    return wss;
  }

  return { app, alarms, attachWebSocket };
}

module.exports = { createApp };

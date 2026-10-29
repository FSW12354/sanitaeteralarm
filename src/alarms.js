'use strict';
const { can } = require('./auth');
const { getSetting } = require('./db');

const URGENCY_LABELS = { red: 'Rot, sofort', yellow: 'Gelb, dringend', green: 'Grün, nicht dringend' };

// Werte aus dem Konzept; der Admin kann sie unter Einstellungen ändern.
const DEFAULTS = { escalate_seconds: 60, no_response_seconds: 120, school_year_end: '07-31' };

function setting(db, key) {
  return getSetting(db, key, String(DEFAULTS[key]));
}

function weekdayAndTime(now) {
  const day = now.getDay() === 0 ? 7 : now.getDay(); // 1 = Montag … 7 = Sonntag
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return { day, time: `${hh}:${mm}` };
}

function receivers(db) {
  return db.prepare('SELECT * FROM users WHERE disabled = 0 AND available = 1').all()
    .filter((u) => can(u, 'alarm.receive'));
}

function onDutyIds(db, now) {
  const { day, time } = weekdayAndTime(now);
  return new Set(db.prepare(
    'SELECT user_id FROM duty_slots WHERE weekday = ? AND start_time <= ? AND end_time > ?',
  ).all(day, time, time).map((r) => r.user_id));
}

// Wer bekommt den Alarm? Rot geht immer an alle verfügbaren Sanitäter,
// Gelb und Grün an den Dienst. Ist niemand im Dienst, geht er an alle.
function pickRecipients(db, scope, now) {
  const all = receivers(db);
  if (scope === 'all') return all;
  const duty = onDutyIds(db, now);
  const onDuty = all.filter((u) => duty.has(u.id));
  return onDuty.length > 0 ? onDuty : all;
}

function createAlarmService(db, notifier, clock = () => new Date()) {
  function load(id) {
    const alarm = db.prepare(`
      SELECT a.*, u.display_name AS sender_name FROM alarms a
      LEFT JOIN users u ON u.id = a.sender_id WHERE a.id = ?`).get(id);
    if (!alarm) return null;
    alarm.recipients = db.prepare(`
      SELECT r.user_id, u.display_name, r.response, r.responded_at FROM alarm_recipients r
      JOIN users u ON u.id = r.user_id WHERE r.alarm_id = ? ORDER BY u.display_name`).all(id);
    alarm.urgency_label = URGENCY_LABELS[alarm.urgency];
    alarm.is_test = !!alarm.is_test;
    return alarm;
  }

  function audience(alarm) {
    const ids = new Set(alarm.recipients.map((r) => r.user_id));
    if (alarm.sender_id) ids.add(alarm.sender_id);
    for (const u of db.prepare('SELECT * FROM users WHERE disabled = 0').all()) {
      if (can(u, 'alarm.view_all')) ids.add(u.id);
    }
    return [...ids];
  }

  function broadcast(alarm) {
    notifier.update(audience(alarm), alarm);
  }

  function addRecipients(alarmId, users) {
    const ins = db.prepare('INSERT OR IGNORE INTO alarm_recipients (alarm_id, user_id) VALUES (?, ?)');
    const added = [];
    for (const u of users) {
      if (ins.run(alarmId, u.id).changes > 0) added.push(u.id);
    }
    return added;
  }

  function create({ sender, location, injury, urgency, note = '', isTest = false }) {
    if (!URGENCY_LABELS[urgency]) throw new Error('Unbekannte Dringlichkeit');
    if (!location || !injury) throw new Error('Ort und Verletzungsart fehlen');
    const now = clock();
    const scope = urgency === 'red' ? 'all' : 'duty';
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO alarms (created_at, sender_id, location, injury, urgency, note, is_test, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(now.toISOString(), sender.id, location, injury, urgency, String(note).slice(0, 500), isTest ? 1 : 0, scope);
    const id = Number(lastInsertRowid);
    const added = addRecipients(id, pickRecipients(db, scope, now));
    const alarm = load(id);
    notifier.alarm(added, alarm);
    broadcast(alarm);
    return alarm;
  }

  function respond(alarmId, user, response) {
    if (!['coming', 'declined'].includes(response)) throw new Error('Unbekannte Antwort');
    const res = db.prepare(`
      UPDATE alarm_recipients SET response = ?, responded_at = ?
      WHERE alarm_id = ? AND user_id = ?`).run(response, clock().toISOString(), alarmId, user.id);
    if (res.changes === 0) throw new Error('Kein Empfänger dieses Alarms');
    const alarm = load(alarmId);
    broadcast(alarm);
    return alarm;
  }

  function resend(alarmId) {
    const alarm = load(alarmId);
    if (!alarm || alarm.ended_at) throw new Error('Alarm ist nicht mehr aktiv');
    const open = alarm.recipients.filter((r) => !r.response).map((r) => r.user_id);
    notifier.alarm(open, alarm);
    return alarm;
  }

  function end(alarmId) {
    db.prepare('UPDATE alarms SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(clock().toISOString(), alarmId);
    const alarm = load(alarmId);
    broadcast(alarm);
    return alarm;
  }

  function hasComing(alarm) {
    return alarm.recipients.some((r) => r.response === 'coming');
  }

  // Wird regelmäßig aufgerufen. Läuft auch nach einem Neustart richtig weiter,
  // weil alles aus den gespeicherten Zeitpunkten berechnet wird.
  function tick() {
    const now = clock();
    const escalateMs = Number(setting(db, 'escalate_seconds')) * 1000;
    const noResponseMs = Number(setting(db, 'no_response_seconds')) * 1000;
    const open = db.prepare('SELECT id FROM alarms WHERE ended_at IS NULL').all();
    for (const { id } of open) {
      let alarm = load(id);
      const age = now - new Date(alarm.created_at);
      if (hasComing(alarm)) continue;
      if (alarm.urgency === 'yellow' && !alarm.escalated_at && age >= escalateMs) {
        db.prepare('UPDATE alarms SET escalated_at = ?, scope = ? WHERE id = ?').run(now.toISOString(), 'all', id);
        const added = addRecipients(id, receivers(db));
        alarm = load(id);
        notifier.alarm(added, alarm);
        broadcast(alarm);
      }
      if (alarm.urgency !== 'green' && !alarm.no_response_at && age >= noResponseMs) {
        db.prepare('UPDATE alarms SET no_response_at = ? WHERE id = ?').run(now.toISOString(), id);
        alarm = load(id);
        notifier.noResponse(audience(alarm).filter((u) => !alarm.recipients.some((r) => r.user_id === u)), alarm);
        broadcast(alarm);
      }
    }
    purgeOldAlarms(now);
  }

  // Einsatzprotokolle werden zum Schuljahresende gelöscht.
  function purgeOldAlarms(now) {
    const [mm, dd] = setting(db, 'school_year_end').split('-').map(Number);
    let cutoff = new Date(now.getFullYear(), mm - 1, dd, 23, 59, 59);
    if (cutoff > now) cutoff = new Date(now.getFullYear() - 1, mm - 1, dd, 23, 59, 59);
    db.prepare('DELETE FROM alarms WHERE created_at <= ?').run(cutoff.toISOString());
  }

  function visibleTo(user, { activeOnly = false } = {}) {
    const where = activeOnly ? 'WHERE a.ended_at IS NULL' : '';
    const ids = db.prepare(`SELECT a.id FROM alarms a ${where} ORDER BY a.created_at DESC LIMIT 200`).all();
    return ids.map(({ id }) => load(id)).filter((a) => canSee(user, a));
  }

  function canSee(user, alarm) {
    return can(user, 'alarm.view_all') || alarm.sender_id === user.id
      || alarm.recipients.some((r) => r.user_id === user.id);
  }

  return { create, respond, resend, end, tick, load, visibleTo, canSee };
}

module.exports = { createAlarmService, URGENCY_LABELS, DEFAULTS, pickRecipients };

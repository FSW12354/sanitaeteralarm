'use strict';
const webpush = require('web-push');
const { getSetting, setSetting } = require('./db');

// Verteilt Alarme an offene Web-Apps (WebSocket) und an gesperrte Geräte (Web Push).
function createNotifier(db, { subject = 'mailto:admin@schule.local', log = console } = {}) {
  let publicKey = getSetting(db, 'vapid_public');
  let privateKey = getSetting(db, 'vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting(db, 'vapid_public', publicKey);
    setSetting(db, 'vapid_private', privateKey);
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  const sockets = new Map(); // userId -> Set<WebSocket>

  function attach(userId, ws) {
    if (!sockets.has(userId)) sockets.set(userId, new Set());
    sockets.get(userId).add(ws);
    ws.on('close', () => sockets.get(userId)?.delete(ws));
  }

  function sendSocket(userIds, message) {
    const data = JSON.stringify(message);
    for (const id of userIds) {
      for (const ws of sockets.get(id) || []) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    }
  }

  async function sendPush(userIds, payload, urgency) {
    if (userIds.length === 0) return;
    const placeholders = userIds.map(() => '?').join(',');
    const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`).all(...userIds);
    const body = JSON.stringify(payload);
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 300, urgency },
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        } else {
          log.warn(`Push an Benutzer ${s.user_id} fehlgeschlagen: ${err.message}`);
        }
      }
    }));
  }

  function alarmText(alarm) {
    return `${alarm.location} · ${alarm.injury}${alarm.note ? ` · ${alarm.note}` : ''}`;
  }

  return {
    publicKey,
    attach,
    alarm(userIds, alarm) {
      sendSocket(userIds, { type: 'alarm', alarm });
      const prefix = alarm.is_test ? 'TEST: ' : '';
      return sendPush(userIds, {
        title: `${prefix}Sanitäteralarm (${alarm.urgency_label})`,
        body: alarmText(alarm),
        alarmId: alarm.id,
        tag: `alarm-${alarm.id}`,
      }, 'high');
    },
    update(userIds, alarm) {
      sendSocket(userIds, { type: 'update', alarm });
    },
    // Hinweise zum Dienstplan: offene App und Mitteilung, aber kein Alarm.
    remind(userIds, title, body) {
      sendSocket(userIds, { type: 'notice', title, body });
      return sendPush(userIds, { title, body, tag: `notice-${Date.now()}` }, 'normal');
    },
    // Chatnachrichten gehen nur an offene Apps, ohne Ton und ohne Mitteilung.
    message(userIds, message) {
      sendSocket(userIds, message);
    },
    noResponse(userIds, alarm) {
      sendSocket(userIds, { type: 'no_response', alarm });
      return sendPush(userIds, {
        title: 'Keine Zusage!',
        body: `Alarm ${alarmText(alarm)}: Bitte per Durchsage oder Telefon alarmieren.`,
        alarmId: alarm.id,
        tag: `alarm-${alarm.id}-noresp`,
      }, 'high');
    },
  };
}

module.exports = { createNotifier };

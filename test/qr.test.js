'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');
const auth = require('../src/auth');

// Mittwoch, 28.10.2026, 10:00 Uhr: Lea hat Tagesdienst
let now;

async function start() {
  auth.setLeaderPermissions(auth.LEADER_DEFAULTS);
  now = new Date(2026, 9, 28, 10, 0, 0);
  const s = setup();
  const users = {
    admin: s.addUser('admin', 'admin', { available: 0 }),
    lea: s.addUser('lea', 'medic'),
    tom: s.addUser('tom', 'medic'),
    sek: s.addUser('sek', 'sender'),
    lehrer: s.addUser('lehrer', 'sender'),
  };
  const day = s.database.prepare("SELECT id FROM periods WHERE name = 'Tagesdienst'").get();
  s.database.prepare('INSERT INTO duty_assignments (weekday, period_id, user_id) VALUES (3, ?, ?)').run(day.id, users.lea.id);
  const { app, alarms } = createApp({ db: s.database, notifier: s.notifier, clock: () => now });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, cookie } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body),
    });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, data: type.includes('json') ? await r.json() : await r.text() };
  };
  async function login(username) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'passwort123' }),
    });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return (p, opts = {}) => call(p, { ...opts, cookie });
  }
  return { ...s, users, alarms, call, login, close: () => server.close() };
}

async function makeCode(s, room = '1.12') {
  const admin = await s.login('admin');
  const loc = s.database.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get();
  await admin('/api/qr-codes', { method: 'POST', body: { locationId: loc.id, room } });
  const [code] = (await admin('/api/qr-codes')).data;
  return { admin, code, token: code.url.split('/r/')[1] };
}

test('Admin legt QR-Codes an, andere nicht', async (t) => {
  const s = await start();
  t.after(s.close);
  const { admin, code } = await makeCode(s);
  assert.match(code.label, /Raum 1\.12$/);
  assert.match(code.url, /^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]{12}$/);
  const svg = await admin(`/api/qr-codes/${code.id}/qr.svg`);
  assert.equal(svg.status, 200);
  assert.ok(svg.data.startsWith('<svg'));
  const print = await admin('/qr-codes/print');
  assert.ok(print.data.includes('Raum 1.12') && print.data.includes('<svg'));
  const lea = await s.login('lea');
  assert.equal((await lea('/api/qr-codes')).status, 403);
  assert.equal((await s.call('/api/qr-codes')).status, 401);
});

test('Scannen und tippen alarmiert den Dienst ohne Anmeldung', async (t) => {
  const s = await start();
  t.after(s.close);
  const { token } = await makeCode(s);
  const page = await s.call(`/r/${token}`);
  assert.equal(page.status, 200);
  assert.ok(page.data.includes('/qr.js'));
  const info = await s.call(`/api/qr/${token}`);
  assert.match(info.data.label, /Raum 1\.12/);
  assert.equal(info.data.alarm, null);
  const injury = info.data.injuries[0];
  const { status, data } = await s.call(`/api/qr/${token}/alarm`, { method: 'POST', body: { injuryId: injury.id } });
  assert.equal(status, 200);
  assert.deepEqual(s.calls.alarm.at(-1).ids, [s.users.lea.id], 'nur der Dienst');
  const alarm = s.alarms.load(data.id);
  assert.equal(alarm.urgency, 'yellow');
  assert.equal(alarm.injury, injury.name);
  assert.equal(alarm.sender_id, null);
  assert.equal(alarm.sender_name, 'QR-Code im Raum');
  // Erneutes Scannen zeigt denselben Alarm, statt einen zweiten auszulösen.
  assert.equal((await s.call(`/api/qr/${token}/alarm`, { method: 'POST', body: {} })).data.id, data.id);
  assert.equal((await s.call(`/api/qr/${token}`)).data.alarm.id, data.id);
  // Zusage wird auf der Seite sichtbar, ohne Namen.
  const lea = await s.login('lea');
  await lea(`/api/alarms/${data.id}/respond`, { method: 'POST', body: { response: 'coming' } });
  const st = (await s.call(`/api/qr/${token}/alarm/${data.id}`)).data;
  assert.equal(st.coming, 1);
  assert.equal(JSON.stringify(st).includes('lea'), false);
});

test('Ohne Zusage: Weiterleitung an alle, Status für den Raum', async (t) => {
  const s = await start();
  t.after(s.close);
  const { token } = await makeCode(s);
  const { data } = await s.call(`/api/qr/${token}/alarm`, { method: 'POST', body: {} });
  assert.equal(s.alarms.load(data.id).injury, 'Unbekannt, vor Ort klären');
  now = new Date(now.getTime() + 60_000);
  s.alarms.tick();
  assert.equal((await s.call(`/api/qr/${token}/alarm/${data.id}`)).data.escalated, true);
  assert.deepEqual(s.calls.alarm.at(-1).ids, [s.users.tom.id]);
  now = new Date(now.getTime() + 60_000);
  s.alarms.tick();
  assert.equal((await s.call(`/api/qr/${token}/alarm/${data.id}`)).data.no_response, true);
  assert.ok(s.calls.noResponse.at(-1).ids.includes(s.users.admin.id), 'Admin wird informiert');
});

test('Ausgeschaltete oder erneuerte Codes alarmieren nicht, Begrenzung pro Stunde', async (t) => {
  const s = await start();
  t.after(s.close);
  const { admin, code, token } = await makeCode(s);
  assert.equal((await s.call('/api/qr/falsch/alarm', { method: 'POST', body: {} })).status, 404);
  await admin(`/api/qr-codes/${code.id}`, { method: 'PUT', body: { active: false } });
  assert.equal((await s.call(`/api/qr/${token}/alarm`, { method: 'POST', body: {} })).status, 404);
  await admin(`/api/qr-codes/${code.id}`, { method: 'PUT', body: { active: true, renew: true } });
  assert.equal((await s.call(`/api/qr/${token}`)).status, 404, 'alter Ausdruck ungültig');
  const fresh = (await admin('/api/qr-codes')).data[0].url.split('/r/')[1];
  for (let i = 0; i < 5; i += 1) {
    const { status, data } = await s.call(`/api/qr/${fresh}/alarm`, { method: 'POST', body: {} });
    assert.equal(status, 200);
    s.alarms.end(data.id);
  }
  assert.equal((await s.call(`/api/qr/${fresh}/alarm`, { method: 'POST', body: {} })).status, 429);
});

test('Sekretariat sieht Alarme per QR-Code und bekommt den Hinweis ohne Zusage', async (t) => {
  const s = await start();
  t.after(s.close);
  const { token } = await makeCode(s);
  const sek = await s.login('sek');
  const { data } = await s.call(`/api/qr/${token}/alarm`, { method: 'POST', body: {} });
  const note = s.calls.remind.at(-1);
  assert.equal(note.title, 'Alarm per QR-Code');
  assert.ok(note.ids.includes(s.users.sek.id));
  assert.match(note.body, /Raum 1\.12/);
  assert.ok(s.calls.update.at(-1).ids.includes(s.users.sek.id), 'Live-Anzeige');
  const list = (await sek('/api/alarms?active=1')).data;
  assert.deepEqual(list.map((a) => a.id), [data.id]);
  assert.equal(s.alarms.load(data.id).recipients.some((r) => r.user_id === s.users.sek.id), false, 'wird nicht selbst alarmiert');
  now = new Date(now.getTime() + 120_000);
  s.alarms.tick();
  assert.ok(s.calls.noResponse.at(-1).ids.includes(s.users.sek.id), 'Aufforderung zur Durchsage');
  // Normale Alarme anderer Sender sieht das Sekretariat weiterhin nicht.
  const loc = s.database.prepare('SELECT id FROM locations LIMIT 1').get().id;
  const inj = s.database.prepare('SELECT id FROM injury_types LIMIT 1').get().id;
  const lehrer = await s.login('lehrer');
  const other = (await lehrer('/api/alarms', { method: 'POST', body: { locationId: loc, injuryId: inj, urgency: 'green' } })).data;
  assert.equal((await sek('/api/alarms')).data.some((a) => a.id === other.id), false);
});

test('Sekretariat beendet Alarme per QR-Code, fremde Alarme bleiben geschützt', async (t) => {
  const s = await start();
  t.after(s.close);
  const { token } = await makeCode(s);
  const sek = await s.login('sek');
  const { data } = await s.call(`/api/qr/${token}/alarm`, { method: 'POST', body: {} });
  assert.equal((await sek(`/api/alarms/${data.id}/end`, { method: 'POST' })).status, 200);
  assert.ok(s.alarms.load(data.id).ended_at, 'beendet');
  // Einen Alarm, den es nicht sehen darf, kann das Sekretariat auch nicht beenden.
  const loc = s.database.prepare('SELECT id FROM locations LIMIT 1').get().id;
  const inj = s.database.prepare('SELECT id FROM injury_types LIMIT 1').get().id;
  const lehrer = await s.login('lehrer');
  const other = (await lehrer('/api/alarms', { method: 'POST', body: { locationId: loc, injuryId: inj, urgency: 'green' } })).data;
  assert.equal((await sek(`/api/alarms/${other.id}/end`, { method: 'POST' })).status, 404);
  assert.equal(s.alarms.load(other.id).ended_at, null);
});

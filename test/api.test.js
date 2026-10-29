'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');

async function start() {
  const s = setup();
  const admin = s.addUser('admin', 'admin');
  s.addUser('sender', 'sender');
  s.addUser('lea', 'medic');
  const { app } = createApp({ db: s.database, notifier: s.notifier });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login(username) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'passwort123' }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (path, { method = 'GET', body } = {}) => {
      const r = await fetch(`${base}/api${path}`, {
        method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
      });
      const text = await r.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* CSV */ }
      return { status: r.status, data };
    };
  }
  return { ...s, admin, base, login, close: () => server.close() };
}

test('Rechte je Rolle', async (t) => {
  const s = await start();
  t.after(s.close);
  const sender = await s.login('sender');
  const medic = await s.login('lea');
  const admin = await s.login('admin');

  assert.equal((await sender('/users')).status, 403);
  assert.equal((await medic('/users')).status, 403);
  assert.equal((await admin('/users')).status, 200);
  assert.equal((await medic('/alarms', { method: 'POST', body: {} })).status, 403);

  const me = (await admin('/me')).data;
  assert.ok(me.permissions.includes('settings.manage'), 'Admin hat alle Rechte');
  assert.deepEqual((await sender('/me')).data.permissions, ['alarm.send']);
});

test('Alarm senden, zusagen, beenden', async (t) => {
  const s = await start();
  t.after(s.close);
  const sender = await s.login('sender');
  const medic = await s.login('lea');
  const lists = (await sender('/lists')).data;
  const res = await sender('/alarms', {
    method: 'POST',
    body: { locationId: lists.locations[0].id, room: '104', injuryId: lists.injuries[1].id, urgency: 'yellow' },
  });
  assert.equal(res.status, 200);
  assert.match(res.data.location, /Raum 104/);
  // Niemand im Dienst: geht an alle verfügbaren Empfänger (Sanitäterin und Admin).
  assert.equal(res.data.recipients.length, 2);

  assert.equal((await sender(`/alarms/${res.data.id}/respond`, { method: 'POST', body: { response: 'coming' } })).status, 403);
  const ok = await medic(`/alarms/${res.data.id}/respond`, { method: 'POST', body: { response: 'coming' } });
  assert.equal(ok.data.recipients.find((r) => r.display_name === 'lea').response, 'coming');
  assert.equal((await sender(`/alarms/${res.data.id}/end`, { method: 'POST' })).data.ended_at !== null, true);
  assert.equal((await sender('/alarms?active=1')).data.length, 0);
});

test('Testalarm nur für Admin', async (t) => {
  const s = await start();
  t.after(s.close);
  const sender = await s.login('sender');
  const lists = (await sender('/lists')).data;
  const body = { locationId: lists.locations[0].id, injuryId: lists.injuries[0].id, urgency: 'green', isTest: true };
  assert.equal((await sender('/alarms', { method: 'POST', body })).status, 403);
  const admin = await s.login('admin');
  assert.equal((await admin('/alarms', { method: 'POST', body })).data.is_test, true);
});

test('Admin pflegt Orte und Verletzungsarten', async (t) => {
  const s = await start();
  t.after(s.close);
  const admin = await s.login('admin');
  const { data } = await admin('/locations', { method: 'POST', body: { building: 'Neubau', name: 'Chemieraum' } });
  await admin('/injuries', { method: 'POST', body: { name: 'Verätzung' } });
  let lists = (await admin('/lists')).data;
  assert.ok(lists.locations.some((l) => l.name === 'Chemieraum'));
  assert.ok(lists.injuries.some((i) => i.name === 'Verätzung'));
  await admin(`/locations/${data.id}`, { method: 'PUT', body: { active: false } });
  lists = (await admin('/lists')).data;
  assert.ok(!lists.locations.some((l) => l.name === 'Chemieraum'));
});

test('Letzter Admin kann nicht entfernt werden', async (t) => {
  const s = await start();
  t.after(s.close);
  const admin = await s.login('admin');
  const res = await admin(`/users/${s.admin.id}`, { method: 'PUT', body: { role: 'medic' } });
  assert.equal(res.status, 400);
});

test('Protokoll als CSV', async (t) => {
  const s = await start();
  t.after(s.close);
  const admin = await s.login('admin');
  const res = await admin('/log.csv');
  assert.equal(res.status, 200);
  assert.match(res.data, /Zeitpunkt/);
});

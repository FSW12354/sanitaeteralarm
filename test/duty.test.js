'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');
const { createDutyService } = require('../src/duty');
const auth = require('../src/auth');

// Mittwoch, 28.10.2026, 08:00 Uhr Ortszeit
let now = new Date(2026, 9, 28, 8, 0, 0);
const WED = '2026-10-28';
const NEXT_WED = '2026-11-04';

async function start() {
  auth.setLeaderPermissions(auth.LEADER_DEFAULTS);
  now = new Date(2026, 9, 28, 8, 0, 0);
  const s = setup();
  const users = {
    admin: s.addUser('admin', 'admin', { available: 0 }),
    gf: s.addUser('gf', 'leader'),
    sender: s.addUser('sender', 'sender'),
    lea: s.addUser('lea', 'medic'),
    tom: s.addUser('tom', 'medic'),
  };
  const { app, alarms } = createApp({ db: s.database, notifier: s.notifier, clock: () => now });
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
  const period = (name) => s.database.prepare('SELECT * FROM periods WHERE name = ?').get(name);
  const duty = createDutyService(s.database);
  return { ...s, users, alarms, login, period, duty, close: () => server.close() };
}

const slotOf = (plan, date, periodId) => plan.find((d) => d.date === date).slots.find((x) => x.period.id === periodId);

test('Mindestbesetzung zeigt Lücken', async (t) => {
  const s = await start();
  t.after(s.close);
  const gf = await s.login('gf');
  const pause = s.period('Tagesdienst'); // Start: 08:00–14:30, mindestens 2 Personen
  assert.deepEqual([pause.start_time, pause.end_time, pause.min_total, pause.min_leaders], ['08:00', '14:30', 2, 0]);
  assert.equal((await gf(`/periods/${pause.id}`, { method: 'PUT', body: { minLeaders: 1 } })).status, 200);
  await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: pause.id, userId: s.users.lea.id } });
  let slot = slotOf((await gf(`/duty/plan?from=${WED}&days=1`)).data, WED, pause.id);
  assert.equal(slot.people.length, 1);
  assert.equal(slot.missing, 1);
  assert.equal(slot.leader_missing, 1);
  await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: pause.id, userId: s.users.gf.id } });
  slot = slotOf((await gf(`/duty/plan?from=${WED}&days=1`)).data, WED, pause.id);
  assert.equal(slot.missing, 0);
  assert.equal(slot.leader_missing, 0);
  assert.equal(slot.open, false);
  assert.equal((await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: pause.id, userId: s.users.lea.id } })).status, 400, 'doppelt');
  assert.equal((await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: pause.id, userId: s.users.sender.id } })).status, 400, 'Sender hat keinen Dienst');
});

test('Sanitäter dürfen den Plan sehen, aber nicht einteilen', async (t) => {
  const s = await start();
  t.after(s.close);
  const lea = await s.login('lea');
  assert.equal((await lea('/duty/plan')).status, 200);
  assert.equal((await lea('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: 1, userId: s.users.lea.id } })).status, 403);
  assert.equal((await lea('/periods', { method: 'POST', body: { name: 'x', start: '07:00', end: '07:10', kind: 'break' } })).status, 403);
  const sender = await s.login('sender');
  assert.equal((await sender('/duty/plan')).status, 403);
});

test('Abwesenheit nimmt aus dem Dienst und aus der Alarmierung', async (t) => {
  const s = await start();
  t.after(s.close);
  const gf = await s.login('gf');
  const lea = await s.login('lea');
  const first = s.period('Tagesdienst');
  await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: first.id, userId: s.users.lea.id } });
  assert.deepEqual([...s.duty.onDutyIds(now)], [s.users.lea.id]);
  assert.equal((await lea('/absences', { method: 'POST', body: { start: WED, end: WED, reason: 'Klassenfahrt', userId: s.users.tom.id } })).status, 403);
  assert.equal((await lea('/absences', { method: 'POST', body: { start: WED, end: '2026-10-27' } })).status, 400);
  await lea('/absences', { method: 'POST', body: { start: WED, end: '2026-10-30', reason: 'Klassenfahrt' } });
  const slot = slotOf((await gf(`/duty/plan?from=${WED}&days=1`)).data, WED, first.id);
  assert.equal(slot.people.length, 0);
  assert.equal(slot.absent[0].display_name, 'lea');
  assert.equal(s.duty.onDutyIds(now).size, 0);
  assert.equal((await gf('/absences?all=1')).data.length, 1);
});

test('Ferien: kein Dienst, Alarm geht an alle', async (t) => {
  const s = await start();
  t.after(s.close);
  const gf = await s.login('gf');
  const first = s.period('Tagesdienst');
  await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: first.id, userId: s.users.lea.id } });
  await gf('/holidays', { method: 'POST', body: { name: 'Herbstferien', start: '2026-10-26', end: '2026-10-30' } });
  const [day] = (await gf(`/duty/plan?from=${WED}&days=1`)).data;
  assert.equal(day.holiday, 'Herbstferien');
  assert.equal(day.slots.length, 0);
  const alarm = s.alarms.create({ sender: s.users.sender, location: 'Hof', injury: 'Sturz', urgency: 'green' });
  assert.equal(alarm.recipients.length, 3, 'Gruppenführer, Lea und Tom');
});

test('Diensttausch: Termin abgeben und übernehmen', async (t) => {
  const s = await start();
  t.after(s.close);
  const gf = await s.login('gf');
  const lea = await s.login('lea');
  const tom = await s.login('tom');
  const first = s.period('Tagesdienst');
  const { data: { id: assignmentId } } = await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: first.id, userId: s.users.lea.id } });
  assert.equal((await tom('/duty/offers', { method: 'POST', body: { assignmentId, date: NEXT_WED } })).status, 403, 'fremder Dienst');
  assert.equal((await lea('/duty/offers', { method: 'POST', body: { assignmentId, date: '2026-11-05' } })).status, 400, 'falscher Wochentag');
  const { data: { id: offerId } } = await lea('/duty/offers', { method: 'POST', body: { assignmentId, date: NEXT_WED } });
  let slot = slotOf((await tom(`/duty/plan?from=${NEXT_WED}&days=1`)).data, NEXT_WED, first.id);
  assert.equal(slot.open_offers.length, 1);
  assert.equal(slot.people[0].status, 'offered', 'bis zur Übernahme bleibt Lea im Dienst');
  assert.equal((await lea(`/duty/offers/${offerId}/take`, { method: 'POST' })).status, 400, 'eigener Dienst');
  assert.equal((await tom(`/duty/offers/${offerId}/take`, { method: 'POST' })).status, 200);
  assert.equal((await gf(`/duty/offers/${offerId}/take`, { method: 'POST' })).status, 400, 'schon übernommen');
  slot = slotOf((await tom(`/duty/plan?from=${NEXT_WED}&days=1`)).data, NEXT_WED, first.id);
  assert.deepEqual(slot.people.map((p) => [p.display_name, p.status]), [['tom', 'swapped_in']]);
  assert.equal(slot.swapped_out[0].display_name, 'lea');
  assert.deepEqual([...s.duty.onDutyIds(new Date(2026, 10, 4, 8, 0))], [s.users.tom.id]);
  const notes = s.calls.remind.map((r) => r.ids);
  assert.deepEqual(notes[0], [s.users.lea.id], 'Lea wird informiert');
  assert.deepEqual(notes[1], [s.users.admin.id, s.users.gf.id].sort(), 'Dienstplaner werden informiert');
  // Heute bleibt Lea im Dienst
  assert.deepEqual([...s.duty.onDutyIds(now)], [s.users.lea.id]);
});

test('Offenen Dienst übernehmen', async (t) => {
  const s = await start();
  t.after(s.close);
  const tom = await s.login('tom');
  const gf = await s.login('gf');
  const pause = s.period('Tagesdienst');
  const { status, data } = await tom('/duty/extras', { method: 'POST', body: { date: WED, periodId: pause.id } });
  assert.equal(status, 200);
  assert.equal((await tom('/duty/extras', { method: 'POST', body: { date: WED, periodId: pause.id } })).status, 400, 'doppelt');
  assert.equal((await tom('/duty/extras', { method: 'POST', body: { date: '2026-10-27', periodId: pause.id } })).status, 400, 'Vergangenheit');
  const slot = slotOf((await gf(`/duty/plan?from=${WED}&days=1`)).data, WED, pause.id);
  assert.deepEqual(slot.people.map((p) => p.status), ['extra']);
  assert.equal(slot.missing, 1);
  assert.ok(s.calls.remind.at(-1).body.includes('offenen Dienst'));
  assert.equal((await gf(`/duty/extras/${data.id}`, { method: 'DELETE' })).status, 200);
});

test('Erinnerung am Morgen, einmal pro Tag', async (t) => {
  const s = await start();
  t.after(s.close);
  const gf = await s.login('gf');
  await gf('/duty/assignments', { method: 'POST', body: { weekday: 3, periodId: s.period('Tagesdienst').id, userId: s.users.lea.id } });
  now = new Date(2026, 9, 28, 7, 29);
  s.alarms.tick();
  assert.equal(s.calls.remind.length, 0);
  now = new Date(2026, 9, 28, 7, 30);
  s.alarms.tick();
  s.alarms.tick();
  assert.equal(s.calls.remind.length, 1);
  assert.deepEqual(s.calls.remind[0].ids, [s.users.lea.id]);
  assert.equal(s.calls.remind[0].body, 'Heute Dienst: Tagesdienst (08:00–14:30)');
});

test('Altes Startraster wird durch den Tagesdienst ersetzt, solange niemand eingeteilt ist', () => {
  const { open } = require('../src/db');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sani-')), 'test.db');
  const old = ['1. Stunde', '2. Stunde', '1. große Pause', '3. Stunde', '4. Stunde', '2. große Pause',
    '5. Stunde', '6. Stunde', 'Mittagspause', '7. Stunde', '8. Stunde'];
  const seed = (db) => {
    db.exec('DELETE FROM periods');
    old.forEach((n, i) => db.prepare("INSERT INTO periods (name, start_time, end_time, kind) VALUES (?, ?, ?, 'lesson')")
      .run(n, `${String(7 + i).padStart(2, '0')}:00`, `${String(7 + i).padStart(2, '0')}:45`));
  };
  let db = open(file);
  seed(db);
  db.close();
  db = open(file);
  assert.deepEqual(db.prepare('SELECT name FROM periods').all().map((r) => r.name), ['Tagesdienst']);
  // Mit Einteilung bleibt das Raster, wie es ist.
  seed(db);
  db.prepare('INSERT INTO users (username, display_name, role, pw_hash) VALUES (?, ?, ?, ?)').run('x', 'x', 'medic', 'x');
  db.prepare('INSERT INTO duty_assignments (weekday, period_id, user_id) VALUES (1, (SELECT MIN(id) FROM periods), 1)').run();
  db.close();
  db = open(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM periods').get().n, 11);
  db.close();
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { createAlarmService } = require('../src/alarms');

// Mittwoch, 28.10.2026, 10:00 Uhr Ortszeit
const START = new Date(2026, 9, 28, 10, 0, 0);

function scenario() {
  const s = setup();
  let now = START;
  const service = createAlarmService(s.database, s.notifier, () => now);
  const sender = s.addUser('sekretariat', 'sender');
  const duty = s.addUser('lea', 'medic');
  const other = s.addUser('tom', 'medic');
  const away = s.addUser('mia', 'medic', { available: 0 });
  // Mittwoch, 3. Stunde (09:35–10:20) laut Startraster
  const period = s.database.prepare("SELECT id FROM periods WHERE name = '3. Stunde'").get();
  s.database.prepare('INSERT INTO duty_assignments (weekday, period_id, user_id) VALUES (3, ?, ?)').run(period.id, duty.id);
  return { ...s, service, sender, duty, other, away, advance: (sec) => { now = new Date(now.getTime() + sec * 1000); } };
}

const base = { location: 'Sporthalle – Halle', injury: 'Sturz/Prellung' };

test('Grün geht nur an den Dienst', () => {
  const s = scenario();
  const a = s.service.create({ sender: s.sender, ...base, urgency: 'green' });
  assert.deepEqual(a.recipients.map((r) => r.user_id), [s.duty.id]);
  s.advance(600);
  s.service.tick();
  assert.equal(s.service.load(a.id).escalated_at, null);
  assert.equal(s.calls.noResponse.length, 0);
});

test('Rot geht an alle verfügbaren, nicht an nicht verfügbare', () => {
  const s = scenario();
  const a = s.service.create({ sender: s.sender, ...base, urgency: 'red' });
  assert.deepEqual(a.recipients.map((r) => r.user_id).sort(), [s.duty.id, s.other.id].sort());
});

test('Gelb eskaliert nach 60 Sekunden ohne Zusage an alle', () => {
  const s = scenario();
  const a = s.service.create({ sender: s.sender, ...base, urgency: 'yellow' });
  assert.equal(a.recipients.length, 1);
  s.advance(59);
  s.service.tick();
  assert.equal(s.service.load(a.id).recipients.length, 1);
  s.advance(1);
  s.service.tick();
  const after = s.service.load(a.id);
  assert.ok(after.escalated_at);
  assert.equal(after.recipients.length, 2);
  // Nur der neu hinzugekommene Sanitäter wird erneut alarmiert.
  assert.deepEqual(s.calls.alarm.at(-1).ids, [s.other.id]);
});

test('Gelb mit Zusage eskaliert nicht', () => {
  const s = scenario();
  const a = s.service.create({ sender: s.sender, ...base, urgency: 'yellow' });
  s.service.respond(a.id, s.duty, 'coming');
  s.advance(300);
  s.service.tick();
  const after = s.service.load(a.id);
  assert.equal(after.escalated_at, null);
  assert.equal(after.no_response_at, null);
});

test('Nach 2 Minuten ohne Zusage wird der Sender gewarnt', () => {
  const s = scenario();
  const a = s.service.create({ sender: s.sender, ...base, urgency: 'red' });
  s.service.respond(a.id, s.duty, 'declined');
  s.advance(119);
  s.service.tick();
  assert.equal(s.calls.noResponse.length, 0);
  s.advance(1);
  s.service.tick();
  assert.equal(s.calls.noResponse.length, 1);
  assert.deepEqual(s.calls.noResponse[0].ids, [s.sender.id]);
  s.advance(60);
  s.service.tick();
  assert.equal(s.calls.noResponse.length, 1, 'Warnung kommt nur einmal');
});

test('Ohne Dienst geht der Alarm an alle verfügbaren', () => {
  const s = scenario();
  s.advance(3 * 3600); // 13:00, Mittagspause, niemand im Dienst
  const a = s.service.create({ sender: s.sender, ...base, urgency: 'green' });
  assert.equal(a.recipients.length, 2);
});

test('Nur Empfänger können antworten', () => {
  const s = scenario();
  const a = s.service.create({ sender: s.sender, ...base, urgency: 'green' });
  assert.throws(() => s.service.respond(a.id, s.other, 'coming'));
});

test('Protokolle aus dem letzten Schuljahr werden gelöscht', () => {
  const s = scenario();
  s.database.prepare(`INSERT INTO alarms (created_at, location, injury, urgency, scope) VALUES (?, 'x', 'y', 'green', 'duty')`)
    .run(new Date(2026, 6, 15).toISOString());
  const current = s.service.create({ sender: s.sender, ...base, urgency: 'green' });
  s.service.tick();
  const ids = s.database.prepare('SELECT id FROM alarms').all().map((r) => r.id);
  assert.deepEqual(ids, [current.id]);
});

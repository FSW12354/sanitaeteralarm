'use strict';
const auth = require('./auth');
const { getSetting, setSetting } = require('./db');

// Dienstplan nach Dienstzeiten (Start: ein Tagesdienst 08:00–14:30). Wer an einem Tag in einer Dienstzeit Dienst hat, ergibt sich aus:
// regelmäßigem Dienst (Wochentag + Dienstzeit) – Abwesenheit – abgegebenem Termin + übernommenem Termin + Zusatzdienst.
// An Ferientagen hat niemand Dienst.

const DAY_MS = 24 * 3600 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeStr(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

function weekdayOf(s) {
  const day = parseDate(s).getDay();
  return day === 0 ? 7 : day;
}

function isValidDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && dateStr(parseDate(s)) === s;
}

function createDutyService(db) {
  const periods = () => db.prepare('SELECT * FROM periods ORDER BY start_time, id').all();

  function holidayOn(date) {
    return db.prepare('SELECT * FROM holidays WHERE start_date <= ? AND end_date >= ? ORDER BY start_date LIMIT 1').get(date, date) || null;
  }

  function slot(date, period, cache) {
    const weekday = weekdayOf(date);
    const users = cache.users;
    const absent = (uid) => cache.absences.some((a) => a.user_id === uid && a.start_date <= date && a.end_date >= date);
    const person = (uid, extra) => ({ user_id: uid, display_name: users.get(uid)?.display_name, role: users.get(uid)?.role, ...extra });

    const people = [];
    const absentPeople = [];
    const swappedOut = [];
    const openOffers = [];
    for (const a of cache.assignments.filter((x) => x.weekday === weekday && x.period_id === period.id)) {
      if (!users.has(a.user_id)) continue;
      const offer = cache.offers.find((o) => o.assignment_id === a.id && o.date === date);
      if (absent(a.user_id)) {
        absentPeople.push(person(a.user_id, { assignment_id: a.id }));
      } else if (offer?.taken_by && users.has(offer.taken_by)) {
        swappedOut.push(person(a.user_id, { assignment_id: a.id, taken_by_name: users.get(offer.taken_by).display_name }));
        if (!absent(offer.taken_by)) people.push(person(offer.taken_by, { status: 'swapped_in', offer_id: offer.id, for_name: users.get(a.user_id).display_name }));
      } else if (offer) {
        people.push(person(a.user_id, { status: 'offered', assignment_id: a.id, offer_id: offer.id }));
        openOffers.push(person(a.user_id, { offer_id: offer.id }));
      } else {
        people.push(person(a.user_id, { status: 'regular', assignment_id: a.id }));
      }
    }
    for (const e of cache.extras.filter((x) => x.date === date && x.period_id === period.id)) {
      if (users.has(e.user_id) && !absent(e.user_id) && !people.some((p) => p.user_id === e.user_id)) {
        people.push(person(e.user_id, { status: 'extra', extra_id: e.id }));
      }
    }
    const leaders = people.filter((p) => p.role === 'leader').length;
    const missing = Math.max(0, period.min_total - people.length);
    const leaderMissing = Math.max(0, period.min_leaders - leaders);
    return {
      period, people, absent: absentPeople, swapped_out: swappedOut, open_offers: openOffers,
      missing, leader_missing: leaderMissing, open: missing > 0 || leaderMissing > 0 || openOffers.length > 0,
    };
  }

  function loadCache(from, to) {
    const users = new Map(db.prepare('SELECT * FROM users WHERE disabled = 0').all()
      .filter((u) => auth.can(u, 'alarm.receive')).map((u) => [u.id, u]));
    return {
      users,
      assignments: db.prepare('SELECT * FROM duty_assignments').all(),
      absences: db.prepare('SELECT * FROM absences WHERE end_date >= ? AND start_date <= ?').all(from, to),
      offers: db.prepare('SELECT * FROM duty_offers WHERE date BETWEEN ? AND ?').all(from, to),
      extras: db.prepare('SELECT * FROM duty_extras WHERE date BETWEEN ? AND ?').all(from, to),
    };
  }

  // Plan für mehrere Tage; Wochenenden nur, wenn dort jemand eingeteilt ist.
  function plan(from, days) {
    const to = dateStr(new Date(parseDate(from).getTime() + (days - 1) * DAY_MS));
    const cache = loadCache(from, to);
    const allPeriods = periods();
    const weekendDays = new Set(cache.assignments.map((a) => a.weekday).filter((d) => d > 5));
    const out = [];
    for (let i = 0; i < days; i += 1) {
      const date = dateStr(new Date(parseDate(from).getTime() + i * DAY_MS));
      const weekday = weekdayOf(date);
      if (weekday > 5 && !weekendDays.has(weekday) && !cache.extras.some((e) => e.date === date)) continue;
      const holiday = holidayOn(date);
      out.push({
        date, weekday, holiday: holiday ? holiday.name : null,
        slots: holiday ? [] : allPeriods.map((p) => slot(date, p, cache)),
      });
    }
    return out;
  }

  // Wer hat in diesem Moment Dienst? Grundlage der Alarmierung.
  function onDutyIds(now) {
    const date = dateStr(now);
    if (holidayOn(date)) return new Set();
    const t = timeStr(now);
    const cache = loadCache(date, date);
    const ids = new Set();
    for (const p of periods().filter((x) => x.start_time <= t && x.end_time > t)) {
      for (const person of slot(date, p, cache).people) ids.add(person.user_id);
    }
    return ids;
  }

  // Erinnerung am Morgen: einmal pro Schultag an alle, die heute Dienst haben.
  function dueReminders(now) {
    const today = dateStr(now);
    if (timeStr(now) < getSetting(db, 'reminder_time', '07:30')) return [];
    if (getSetting(db, 'last_reminder_date') === today) return [];
    setSetting(db, 'last_reminder_date', today);
    const [day] = plan(today, 1);
    if (!day || day.holiday) return [];
    const byUser = new Map();
    for (const s of day.slots) {
      for (const p of s.people) {
        if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
        byUser.get(p.user_id).push(`${s.period.name} (${s.period.start_time}–${s.period.end_time})`);
      }
    }
    return [...byUser.entries()].map(([userId, list]) => ({ userId, text: `Heute Dienst: ${list.join(', ')}` }));
  }

  return { periods, plan, onDutyIds, dueReminders, holidayOn };
}

module.exports = { createDutyService, dateStr, timeStr, parseDate, weekdayOf, isValidDate, TIME_RE, DAY_MS };

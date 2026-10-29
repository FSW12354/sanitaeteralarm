'use strict';
/* Sanitäteralarm – Web-App für Sanitäter, Alarmierungssender und Admin. */

const WEEKDAYS = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const URGENCIES = [
  { key: 'red', label: 'Rot, sofort', hint: 'Lebensgefahr möglich. Alarm an alle.' },
  { key: 'yellow', label: 'Gelb, dringend', hint: 'Zeitnah Hilfe nötig. Erst der Dienst, dann alle.' },
  { key: 'green', label: 'Grün, nicht dringend', hint: 'z. B. Pflaster, Kühlpack. Nur der Dienst.' },
];

const state = {
  me: null, permissions: [], lists: { locations: [], injuries: [] }, alarms: new Map(),
  tab: null, ws: null, lastBeat: 0, draft: null, watching: null, handled: new Set(),
  chats: new Map(), unread: new Map(), drafts: {}, openChats: new Set(),
  dutySection: 'plan', dutyWeekday: 1, dutyFrom: null,
};
const ROLE_NAMES = { medic: 'Sanitäter', leader: 'Gruppenführer/in', sender: 'Alarmierungssender', admin: 'Admin' };

// --- Hilfsfunktionen --------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/login') {
    state.me = null;
    renderLogin();
    throw new Error('Bitte anmelden');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Fehler ${res.status}`);
  return data;
}

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

const can = (p) => state.permissions.includes(p);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '');
const dateTime = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const pill = (u, label) => h('span', { class: `pill ${u}` }, label);
const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message);
  }
};

// --- Alarmton ---------------------------------------------------------------
// Ein Ton läuft, solange ein offener Alarm auf dem Bildschirm steht.
let audio = null;
function startSound() {
  try {
    audio = audio || { ctx: new (window.AudioContext || window.webkitAudioContext)(), timer: null };
    if (audio.timer) return;
    audio.ctx.resume();
    const beep = () => {
      const o = audio.ctx.createOscillator();
      const g = audio.ctx.createGain();
      o.type = 'square';
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g).connect(audio.ctx.destination);
      o.start();
      o.frequency.setValueAtTime(660, audio.ctx.currentTime + 0.25);
      o.stop(audio.ctx.currentTime + 0.5);
    };
    beep();
    audio.timer = setInterval(beep, 900);
    navigator.vibrate?.([400, 200, 400]);
  } catch { /* Ton ist nicht überall erlaubt */ }
}
function stopSound() {
  if (audio?.timer) clearInterval(audio.timer);
  if (audio) audio.timer = null;
}
// iOS erlaubt Ton erst nach einer Berührung: Audio beim ersten Antippen freischalten.
document.addEventListener('touchend', () => {
  if (!audio) {
    try {
      audio = { ctx: new (window.AudioContext || window.webkitAudioContext)(), timer: null };
      audio.ctx.resume();
    } catch { /* ignorieren */ }
  }
}, { once: true });

// --- Start ------------------------------------------------------------------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const me = await api('/me');
    state.me = me.user;
    state.permissions = me.permissions;
    state.vapid = me.vapidPublicKey;
  } catch {
    return renderLogin();
  }
  state.lists = await api('/lists');
  for (const a of await api('/alarms?active=1')) state.alarms.set(a.id, a);
  connect();
  renderShell();
  checkIncoming();
}

function renderLogin() {
  document.getElementById('top').hidden = true;
  document.getElementById('tabs').hidden = true;
  const main = document.getElementById('main');
  const user = h('input', { autocomplete: 'username', autocapitalize: 'none' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  main.replaceChildren(h('div', { class: 'card' },
    h('h1', {}, 'Sanitäteralarm'),
    h('p', { class: 'hint' }, 'Einmal anmelden. Das Gerät bleibt danach angemeldet.'),
    h('form', {
      onsubmit: guard(async (e) => {
        e.preventDefault();
        await api('/login', { method: 'POST', body: { username: user.value, password: pass.value } });
        location.reload();
      }),
    },
    h('label', {}, 'Benutzername'), user,
    h('label', {}, 'Passwort'), pass,
    h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn', type: 'submit' }, 'Anmelden'))),
  ));
}

function tabsFor() {
  const tabs = [];
  if (can('alarm.send')) tabs.push(['send', 'Alarm senden']);
  tabs.push(['alarms', 'Alarme']);
  if (can('chat.general')) tabs.push(['chat', 'Chat']);
  if (can('duty.view_own')) tabs.push(['mine', 'Mein Dienst']);
  if (can('users.manage')) tabs.push(['users', 'Benutzer']);
  if (can('duty.manage')) tabs.push(['duty', 'Dienstplan']);
  if (can('lists.manage')) tabs.push(['lists', 'Orte & Verletzungen']);
  if (can('log.view') || can('settings.manage')) tabs.push(['admin', 'Protokoll & Einstellungen']);
  tabs.push(['account', 'Konto']);
  return tabs;
}

function renderShell() {
  document.getElementById('top').hidden = false;
  document.getElementById('who').replaceChildren(
    h('div', {}, state.me.display_name), h('div', {}, state.me.role_label),
  );
  const tabs = tabsFor();
  if (!state.tab) state.tab = tabs[0][0];
  render();
  renderNav();
}

function unreadFor(tab) {
  let n = 0;
  for (const [key, count] of state.unread) {
    if (tab === 'chat' ? key === 'general' : key !== 'general' && state.alarms.has(key)) n += count;
  }
  return n;
}

function renderNav() {
  const nav = document.getElementById('tabs');
  nav.hidden = false;
  nav.replaceChildren(...tabsFor().map(([key, label]) => {
    const n = ['chat', 'alarms'].includes(key) ? unreadFor(key) : 0;
    return h('button', {
      class: state.tab === key ? 'active' : '',
      onclick: () => { state.tab = key; state.watching = null; renderShell(); },
    }, label, n ? h('span', { class: 'badge' }, n) : null);
  }));
}

function render() {
  const main = document.getElementById('main');
  // Ein Chat-Eingabefeld behält beim Neuzeichnen Text und Fokus.
  const focusKey = document.activeElement?.dataset?.draft;
  const show = (el) => {
    main.replaceChildren(el);
    if (focusKey) main.querySelector(`[data-draft="${focusKey}"]`)?.focus();
    scrollChats();
  };
  const views = {
    send: viewSend, alarms: viewAlarms, chat: viewChat, mine: viewMine, users: viewUsers,
    duty: viewDuty, lists: viewLists, admin: viewAdmin, account: viewAccount,
  };
  const out = (views[state.tab] || viewAlarms)();
  if (out instanceof Promise) {
    out.then(show).catch((err) => toast(err.message));
  } else {
    show(out);
  }
}

// --- Echtzeit ---------------------------------------------------------------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => { state.lastBeat = Date.now(); setOffline(false); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    state.lastBeat = Date.now();
    if (msg.type === 'heartbeat') return;
    if (msg.type === 'chat' || msg.type === 'chat_delete') return onChat(msg);
    if (msg.type === 'notice') {
      toast(`${msg.title}: ${msg.body}`);
      if (['mine', 'duty'].includes(state.tab)) render();
      return;
    }
    const a = msg.alarm;
    if (a.ended_at) state.alarms.delete(a.id);
    else state.alarms.set(a.id, a);
    if (msg.type === 'alarm') state.handled.delete(a.id);
    if (msg.type === 'no_response') toast('Keine Zusage! Bitte per Durchsage oder Telefon alarmieren.');
    checkIncoming();
    if (['alarms', 'send'].includes(state.tab)) render();
  };
  ws.onclose = () => {
    setOffline(true);
    setTimeout(async () => {
      // Nach einer Unterbrechung den Stand neu laden, damit nichts verpasst wird.
      try {
        state.alarms.clear();
        for (const a of await api('/alarms?active=1')) state.alarms.set(a.id, a);
        checkIncoming();
      } catch { /* weiter versuchen */ }
      connect();
    }, 3000);
  };
}

function setOffline(off) {
  document.getElementById('offline').hidden = !off;
}
setInterval(() => {
  if (state.ws && state.lastBeat && Date.now() - state.lastBeat > 75_000) setOffline(true);
}, 10_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me) {
    api('/alarms?active=1').then((list) => {
      state.alarms = new Map(list.map((a) => [a.id, a]));
      checkIncoming();
      render();
    }).catch(() => {});
  }
});

// --- Eingehender Alarm (Vollbild) ---------------------------------------------
function myRecipient(a) {
  return a.recipients.find((r) => r.user_id === state.me.id);
}

function checkIncoming() {
  const overlay = document.getElementById('overlay');
  const open = [...state.alarms.values()]
    .filter((a) => !a.ended_at && myRecipient(a) && !myRecipient(a).response && !state.handled.has(a.id))
    .sort((x, y) => x.created_at.localeCompare(y.created_at));
  if (open.length === 0) {
    overlay.hidden = true;
    stopSound();
    return;
  }
  const a = open[0];
  overlay.className = `u-${a.urgency}`;
  overlay.hidden = false;
  const reply = (response) => guard(async () => {
    const updated = await api(`/alarms/${a.id}/respond`, { method: 'POST', body: { response } });
    state.alarms.set(a.id, updated);
    state.handled.add(a.id);
    checkIncoming();
    if (response === 'coming') { state.tab = 'alarms'; renderShell(); }
  });
  overlay.replaceChildren(
    h('div', {},
      h('div', { class: 'mid' }, `${a.is_test ? 'TESTALARM · ' : ''}${a.urgency_label} · ${time(a.created_at)}`),
      h('div', { class: 'big' }, a.location),
      h('div', { class: 'mid' }, a.injury),
      a.note ? h('div', { class: 'mid' }, a.note) : null,
      a.sender_name ? h('div', { class: 'mid' }, `Gemeldet von ${a.sender_name}`) : null,
      open.length > 1 ? h('div', { class: 'mid' }, `+ ${open.length - 1} weitere Alarme`) : null),
    h('div', { class: 'actions' },
      h('button', { class: 'coming', onclick: reply('coming') }, 'Komme'),
      h('button', { class: 'decline', onclick: reply('declined') }, 'Kann nicht')),
  );
  startSound();
}

// --- Alarm senden -------------------------------------------------------------
function viewSend() {
  if (state.watching) return viewAlarmStatus(state.watching);
  if (!state.draft) {
    const own = state.lists.locations.find((l) => l.id === state.me.default_location_id);
    state.draft = { step: own ? 2 : 1, locationId: own?.id ?? null, room: '', injuryId: null, note: '', isTest: false };
  }
  const d = state.draft;
  const steps = h('div', { class: 'steps' }, [1, 2, 3].map((n) => h('span', { class: n <= d.step ? 'on' : '' })));
  const back = d.step > 1 ? h('button', { class: 'btn secondary small', onclick: () => { d.step -= 1; render(); } }, 'Zurück') : null;

  if (d.step === 1) {
    const byBuilding = new Map();
    for (const l of state.lists.locations) {
      if (!byBuilding.has(l.building)) byBuilding.set(l.building, []);
      byBuilding.get(l.building).push(l);
    }
    return h('div', {}, steps, h('h1', {}, '1. Wo?'),
      [...byBuilding.entries()].map(([b, locs]) => h('div', {},
        h('h2', {}, b),
        h('div', { class: 'tiles' }, locs.map((l) => h('button', {
          class: 'tile',
          onclick: () => { d.locationId = l.id; d.step = 2; render(); },
        }, l.name))))));
  }

  const loc = state.lists.locations.find((l) => l.id === d.locationId);
  if (d.step === 2) {
    const room = h('input', { value: d.room, placeholder: 'Raumnummer (optional)', oninput: (e) => { d.room = e.target.value; } });
    return h('div', {}, steps,
      h('div', { class: 'row' }, h('h1', {}, '2. Was ist passiert?'), back),
      h('p', { class: 'hint' }, `Ort: ${loc ? `${loc.building} – ${loc.name}` : '?'} `,
        h('button', { class: 'btn secondary small', onclick: () => { d.step = 1; render(); } }, 'Ort ändern')),
      room,
      h('div', { class: 'tiles', style: 'margin-top:12px' }, state.lists.injuries.map((i) => h('button', {
        class: 'tile',
        onclick: () => { d.injuryId = i.id; d.step = 3; render(); },
      }, i.name))));
  }

  const inj = state.lists.injuries.find((i) => i.id === d.injuryId);
  const note = h('input', { value: d.note, placeholder: 'Zusatz (optional), z. B. „Schüler ist ansprechbar“', oninput: (e) => { d.note = e.target.value; } });
  const send = (urgency) => guard(async () => {
    const alarm = await api('/alarms', {
      method: 'POST',
      body: { locationId: d.locationId, room: d.room, injuryId: d.injuryId, urgency, note: d.note, isTest: d.isTest },
    });
    state.alarms.set(alarm.id, alarm);
    state.draft = null;
    state.watching = alarm.id;
    render();
  });
  return h('div', {}, steps,
    h('div', { class: 'row' }, h('h1', {}, '3. Wie dringend?'), back),
    h('p', { class: 'hint' }, `${loc.building} – ${loc.name}${d.room ? `, Raum ${d.room}` : ''} · ${inj.name}`),
    note,
    can('alarm.test') ? h('label', {}, h('input', {
      type: 'checkbox', style: 'width:auto', checked: d.isTest, onchange: (e) => { d.isTest = e.target.checked; },
    }), ' Nur Testalarm') : null,
    h('div', { class: 'tiles', style: 'margin-top:12px' }, URGENCIES.map((u) => h('button', {
      class: `tile u-${u.key}`, onclick: send(u.key),
    }, u.label, h('small', {}, u.hint)))),
    h('p', { class: 'hint' }, 'Ein Antippen der Dringlichkeit sendet den Alarm sofort.'));
}

function viewAlarmStatus(id) {
  const a = state.alarms.get(id);
  const wrap = h('div', {});
  if (!a) {
    wrap.append(h('div', { class: 'card' }, 'Der Alarm ist beendet.'),
      h('button', { class: 'btn', onclick: () => { state.watching = null; render(); } }, 'Neuen Alarm senden'));
    return wrap;
  }
  return h('div', {}, alarmCard(a, true),
    h('button', { class: 'btn secondary', onclick: () => { state.watching = null; render(); } }, 'Weiteren Alarm senden'));
}

// --- Chat ---------------------------------------------------------------------
// Schlüssel: 'general' für den allgemeinen Chat, sonst die Alarm-ID.
const chatPath = (key) => (key === 'general' ? '/chat/general' : `/alarms/${key}/chat`);

function chatVisible(key) {
  if (document.visibilityState === 'hidden') return false;
  if (key === 'general') return state.tab === 'chat';
  return state.openChats.has(key) && ['alarms', 'send'].includes(state.tab);
}

function onChat(msg) {
  const key = msg.alarm_id ?? msg.message?.alarm_id ?? 'general';
  const list = state.chats.get(key);
  if (msg.type === 'chat_delete') {
    if (list) state.chats.set(key, list.filter((m) => m.id !== msg.id));
  } else {
    if (list && !list.some((m) => m.id === msg.message.id)) list.push(msg.message);
    if (msg.message.user_id !== state.me.id && !chatVisible(key)) {
      state.unread.set(key, (state.unread.get(key) || 0) + 1);
    }
  }
  drawChat(key);
  renderNav();
}

async function loadChat(key) {
  state.chats.set(key, await api(chatPath(key)));
  drawChat(key);
}

function scrollChats() {
  for (const el of document.getElementById('main').querySelectorAll('[data-chat]')) el.scrollTop = el.scrollHeight;
}

function drawChat(key) {
  const messages = state.chats.get(key);
  for (const el of document.getElementById('main').querySelectorAll(`[data-chat="${key}"]`)) {
    el.replaceChildren(...(messages === undefined ? [h('p', { class: 'hint' }, 'Lädt …')]
      : messages.length === 0 ? [h('p', { class: 'hint' }, 'Noch keine Nachrichten.')]
        : messages.map((m) => h('div', { class: m.user_id === state.me.id ? 'msg own' : 'msg' },
          h('div', { class: 'msg-head' },
            h('strong', {}, m.display_name || 'Gelöschter Benutzer'),
            m.role_label ? h('span', { class: 'muted' }, ` · ${m.role_label}`) : null,
            h('span', { class: 'muted' }, ` · ${time(m.created_at)}`),
            can('chat.moderate') ? h('button', {
              class: 'msg-del', title: 'Nachricht löschen',
              onclick: guard(async () => { await api(`/chat/${m.id}`, { method: 'DELETE' }); }),
            }, 'Löschen') : null),
          h('div', { class: 'msg-body' }, m.body)))));
    el.scrollTop = el.scrollHeight;
  }
}

function chatPanel(key, { canPost = true } = {}) {
  state.unread.delete(key);
  if (!state.chats.has(key)) loadChat(key).catch((err) => toast(err.message));
  const list = h('div', { class: 'chat-list', 'data-chat': key });
  const input = h('input', {
    'data-draft': String(key), value: state.drafts[key] || '', maxlength: 1000,
    placeholder: 'Nachricht schreiben', oninput: (e) => { state.drafts[key] = e.target.value; },
  });
  const panel = h('div', { class: 'chat' }, list,
    canPost ? h('form', {
      class: 'chat-form',
      onsubmit: guard(async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        await api(chatPath(key), { method: 'POST', body: { body: input.value } });
        state.drafts[key] = '';
        input.value = '';
      }),
    }, input, h('button', { class: 'btn small', type: 'submit' }, 'Senden')) : h('p', { class: 'hint' }, 'Der Einsatz ist beendet.'),
    canPost ? h('p', { class: 'hint' }, 'Keine Namen oder Gesundheitsdaten von Verletzten schreiben.') : null);
  queueMicrotask(() => drawChat(key));
  return panel;
}

function viewChat() {
  return h('div', {}, h('h1', {}, 'Chat'),
    h('p', { class: 'hint' }, 'Für alle im Sanitätsdienst. Nachrichten werden nach einer festen Frist automatisch gelöscht.'),
    chatPanel('general'));
}

// --- Alarmliste ---------------------------------------------------------------
function alarmCard(a, detailed = false) {
  const coming = a.recipients.filter((r) => r.response === 'coming');
  const declined = a.recipients.filter((r) => r.response === 'declined');
  const waiting = a.recipients.filter((r) => !r.response);
  const mine = myRecipient(a);
  const isSender = a.sender_id === state.me.id;
  const canControl = can('alarm.view_all') || isSender || mine?.response === 'coming';
  return h('div', { class: 'card', id: `alarm-${a.id}` },
    a.urgency === 'red' && (isSender || can('alarm.view_all'))
      ? h('div', { class: 'banner danger' }, 'Lebensgefahr? Sofort 112 rufen!') : null,
    a.no_response_at && coming.length === 0
      ? h('div', { class: 'banner danger' }, 'Keine Zusage! Bitte per Durchsage oder Telefon alarmieren.') : null,
    a.escalated_at ? h('div', { class: 'banner info' }, `Um ${time(a.escalated_at)} an alle Sanitäter weitergeleitet.`) : null,
    h('div', { class: 'row' },
      h('div', {}, pill(a.urgency, a.urgency_label), ' ', a.is_test ? pill('grey', 'Test') : null),
      h('div', { class: 'muted', style: 'text-align:right' }, time(a.created_at))),
    h('h2', {}, a.location),
    h('div', {}, a.injury, a.note ? ` · ${a.note}` : ''),
    h('p', { class: 'hint' }, `Gemeldet von ${a.sender_name || '?'}`),
    h('div', {}, h('strong', {}, `Kommen (${coming.length}): `), coming.map((r) => `${r.display_name} (${time(r.responded_at)})`).join(', ') || '–'),
    detailed || can('alarm.view_all') ? [
      h('div', {}, h('strong', {}, `Können nicht (${declined.length}): `), declined.map((r) => r.display_name).join(', ') || '–'),
      h('div', {}, h('strong', {}, `Noch keine Antwort (${waiting.length}): `), waiting.map((r) => r.display_name).join(', ') || '–'),
    ] : null,
    a.recipients.length === 0 ? h('div', { class: 'banner danger' }, 'Kein Sanitäter ist verfügbar! Bitte per Durchsage oder Telefon alarmieren.') : null,
    h('div', { style: 'margin-top:12px' },
      h('button', {
        class: 'btn secondary small',
        onclick: () => {
          if (state.openChats.has(a.id)) state.openChats.delete(a.id);
          else state.openChats.add(a.id);
          render();
          renderNav();
        },
      }, state.openChats.has(a.id) ? 'Einsatzchat schließen' : 'Einsatzchat',
      state.unread.get(a.id) && !state.openChats.has(a.id) ? h('span', { class: 'badge' }, state.unread.get(a.id)) : null),
      state.openChats.has(a.id) ? chatPanel(a.id, { canPost: !a.ended_at }) : null),
    h('div', { class: 'row', style: 'margin-top:12px' },
      mine && !a.ended_at ? h('button', {
        class: 'btn secondary small',
        onclick: guard(async () => {
          state.alarms.set(a.id, await api(`/alarms/${a.id}/respond`, { method: 'POST', body: { response: mine.response === 'coming' ? 'declined' : 'coming' } }));
          render();
        }),
      }, mine.response === 'coming' ? 'Doch nicht' : 'Komme') : null,
      isSender || can('alarm.view_all') ? h('button', {
        class: 'btn secondary small',
        onclick: guard(async () => { await api(`/alarms/${a.id}/resend`, { method: 'POST' }); toast('Erneut gesendet'); }),
      }, 'Erneut senden') : null,
      canControl ? h('button', {
        class: 'btn danger small',
        onclick: guard(async () => {
          if (!confirm('Einsatz beenden?')) return;
          await api(`/alarms/${a.id}/end`, { method: 'POST' });
          state.alarms.delete(a.id);
          render();
        }),
      }, 'Einsatz beenden') : null));
}

function viewAlarms() {
  const list = [...state.alarms.values()].sort((x, y) => y.created_at.localeCompare(x.created_at));
  return h('div', {}, h('h1', {}, 'Laufende Alarme'),
    list.length === 0 ? h('p', { class: 'hint' }, 'Gerade gibt es keinen laufenden Alarm.') : list.map((a) => alarmCard(a)),
    can('alarm.receive') ? pushCard() : null);
}

// --- Mein Dienst --------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
};
const periodLabel = (p) => `${p.name} · ${p.start_time}–${p.end_time}`;
// Liegt ein Termin noch vor uns? Heute zählt bis zum Ende der Stunde oder Pause.
const upcoming = (date, period) => date > isoDate(new Date()) || (date === isoDate(new Date()) && period.end_time > nowTime());

function slotStatus(slot) {
  if (slot.missing > 0) return pill('red', `Fehlt ${slot.missing}`);
  if (slot.leader_missing > 0) return pill('yellow', 'Gruppenführer fehlt');
  if (slot.open_offers.length > 0) return pill('yellow', 'Termin abgegeben');
  return pill('green', 'Besetzt');
}

function dateRangeForm(onSave, extra = [], { withReason = true } = {}) {
  const from = h('input', { type: 'date', value: isoDate(new Date()) });
  const to = h('input', { type: 'date', value: isoDate(new Date()) });
  const reason = h('input', { placeholder: 'Grund (optional), z. B. Klassenfahrt', maxlength: 100 });
  return h('div', {},
    extra,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('label', {}, 'von', from), h('label', {}, 'bis', to)),
    withReason ? h('div', { style: 'margin-top:8px' }, reason) : null,
    h('div', { style: 'margin-top:8px' }, h('button', {
      class: 'btn', onclick: guard(async () => { await onSave({ start: from.value, end: to.value, reason: reason.value }); render(); }),
    }, 'Eintragen')));
}

async function viewMine() {
  const [plan, absences] = await Promise.all([api('/duty/plan?days=14'), api('/absences')]);
  const me = state.me;
  const mine = [];
  const open = [];
  for (const day of plan) {
    for (const slot of day.slots) {
      if (!upcoming(day.date, slot.period)) continue;
      const own = slot.people.find((p) => p.user_id === me.id);
      if (own) mine.push({ day, slot, own });
      else if (can('alarm.receive') && slot.open) open.push({ day, slot });
    }
  }
  const myRow = ({ day, slot, own }) => h('div', { class: 'list-item' },
    h('div', {}, h('strong', {}, dayLabel(day.date)), ' ', periodLabel(slot.period),
      own.status === 'swapped_in' ? h('div', { class: 'muted' }, `übernommen von ${own.for_name}`) : null,
      own.status === 'extra' ? h('div', { class: 'muted' }, 'zusätzlich übernommen') : null,
      own.status === 'offered' ? h('div', { class: 'muted' }, 'abgegeben, noch nicht übernommen') : null),
    own.status === 'regular' ? h('button', {
      class: 'btn secondary small',
      onclick: guard(async () => {
        await api('/duty/offers', { method: 'POST', body: { assignmentId: own.assignment_id, date: day.date } });
        toast('Termin abgegeben. Andere Sanitäter sehen ihn jetzt unter „Offene Dienste“.');
        render();
      }),
    }, 'Abgeben') : null,
    own.status === 'offered' ? h('button', {
      class: 'btn secondary small',
      onclick: guard(async () => { await api(`/duty/offers/${own.offer_id}`, { method: 'DELETE' }); render(); }),
    }, 'Zurückziehen') : null,
    own.status === 'extra' ? h('button', {
      class: 'btn secondary small',
      onclick: guard(async () => { await api(`/duty/extras/${own.extra_id}`, { method: 'DELETE' }); render(); }),
    }, 'Austragen') : null);
  const openRow = ({ day, slot }) => h('div', { class: 'list-item' },
    h('div', {}, h('strong', {}, dayLabel(day.date)), ' ', periodLabel(slot.period), ' ', slotStatus(slot),
      slot.open_offers.length ? h('div', { class: 'muted' }, `abgegeben von ${slot.open_offers.map((o) => o.display_name).join(', ')}`) : null),
    h('button', {
      class: 'btn small',
      onclick: guard(async () => {
        if (slot.open_offers.length) await api(`/duty/offers/${slot.open_offers[0].offer_id}/take`, { method: 'POST' });
        else await api('/duty/extras', { method: 'POST', body: { date: day.date, periodId: slot.period.id } });
        toast('Dienst übernommen');
        render();
      }),
    }, 'Übernehmen'));
  return h('div', {},
    h('h1', {}, 'Mein Dienst'),
    h('div', { class: 'card' },
      h('strong', {}, me.available ? 'Du bist verfügbar.' : 'Du bist nicht verfügbar.'),
      h('p', { class: 'hint' }, 'Nicht verfügbar z. B. während einer Klassenarbeit. Dann bekommst du keine Alarme.'),
      h('button', {
        class: me.available ? 'btn secondary' : 'btn',
        onclick: guard(async () => {
          await api('/me/availability', { method: 'PUT', body: { available: !me.available } });
          me.available = !me.available;
          render();
        }),
      }, me.available ? 'Auf „nicht verfügbar“ setzen' : 'Wieder verfügbar')),
    h('div', { class: 'card' },
      h('h2', {}, 'Meine nächsten Dienste'),
      mine.length === 0 ? h('p', { class: 'hint' }, 'In den nächsten zwei Wochen hast du keinen Dienst.') : mine.map(myRow)),
    can('alarm.receive') ? h('div', { class: 'card' },
      h('h2', {}, 'Offene Dienste'),
      h('p', { class: 'hint' }, 'Unterbesetzt oder von anderen abgegeben. Wer übernimmt, wird eingetragen; die Dienstplaner werden informiert.'),
      open.length === 0 ? h('p', { class: 'hint' }, 'Gerade ist alles besetzt.')
        // Abgegebene Termine zuerst: Dort wartet jemand auf eine Antwort.
        : [...open].sort((a, b) => (b.slot.open_offers.length > 0) - (a.slot.open_offers.length > 0)).slice(0, 15).map(openRow),
      open.length > 15 ? h('p', { class: 'hint' }, `und ${open.length - 15} weitere`) : null) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'Abwesenheiten'),
      h('p', { class: 'hint' }, 'Klassenfahrt, Praktikum oder Krankheit: In dieser Zeit hast du keinen Dienst und die Lücke wird sichtbar.'),
      absences.map((a) => h('div', { class: 'list-item' },
        h('div', {}, `${dayLabel(a.start_date)} – ${dayLabel(a.end_date)}`, a.reason ? h('span', { class: 'muted' }, ` · ${a.reason}`) : null),
        h('button', { class: 'btn secondary small', onclick: guard(async () => { await api(`/absences/${a.id}`, { method: 'DELETE' }); render(); }) }, 'Löschen'))),
      dateRangeForm((v) => api('/absences', { method: 'POST', body: v }))),
    pushCard());
}

// --- Mitteilungen (Web Push) ---------------------------------------------------
function pushCard() {
  const card = h('div', { class: 'card' }, h('h2', {}, 'Alarm bei gesperrtem Gerät'));
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    card.append(h('p', { class: 'hint' }, standalone
      ? 'Dieses Gerät unterstützt keine Mitteilungen. Nötig ist iOS 16.4 oder neuer.'
      : 'Auf dem iPhone: In Safari auf „Teilen“ tippen, dann „Zum Home-Bildschirm“. Danach die App vom Home-Bildschirm öffnen und hier Mitteilungen einschalten.'));
    return card;
  }
  if (Notification.permission === 'granted') {
    card.append(h('p', { class: 'hint' }, 'Mitteilungen sind eingeschaltet. Tipp: Den Fokus-Modus so einstellen, dass Sanitäteralarm durchkommt.'));
    // Anmeldung beim Server auffrischen, falls sie verloren ging.
    subscribePush().catch(() => {});
    return card;
  }
  card.append(
    h('p', { class: 'hint' }, 'Damit Alarme auch bei gesperrtem Bildschirm ankommen, Mitteilungen einschalten.'),
    h('button', { class: 'btn', onclick: guard(async () => { await subscribePush(true); toast('Mitteilungen eingeschaltet'); render(); }) }, 'Mitteilungen einschalten'),
  );
  return card;
}

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function subscribePush(ask = false) {
  if (ask) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt');
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(state.vapid) });
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

// --- Admin: Benutzer --------------------------------------------------------------
async function viewUsers() {
  const users = await api('/users');
  const locs = state.lists.locations;
  const f = {
    displayName: h('input', { placeholder: 'Name, z. B. Lea M.' }),
    username: h('input', { placeholder: 'Benutzername', autocapitalize: 'none' }),
    password: h('input', { placeholder: 'Startpasswort (mind. 8 Zeichen)' }),
    role: h('select', {}, Object.entries(ROLE_NAMES).map(([value, label]) => h('option', { value }, label))),
    loc: h('select', {}, h('option', { value: '' }, 'Standort (nur feste Sender-Geräte)'), locs.map((l) => h('option', { value: l.id }, `${l.building} – ${l.name}`))),
  };
  return h('div', {},
    h('h1', {}, 'Benutzer'),
    h('div', { class: 'card' }, users.map((u) => h('div', { class: 'list-item' },
      h('div', {}, h('strong', {}, u.display_name), ' ', h('span', { class: 'muted' }, `${u.username} · ${u.role_label}`),
        u.disabled ? [' ', pill('grey', 'gesperrt')] : null,
        u.role !== 'sender' && !u.available ? [' ', pill('grey', 'nicht verfügbar')] : null),
      h('div', { class: 'row', style: 'flex:none' },
        h('select', {
          onchange: guard(async (e) => { await api(`/users/${u.id}`, { method: 'PUT', body: { role: e.target.value } }); render(); }),
        }, Object.entries(ROLE_NAMES).map(([r, label]) => h('option', { value: r, selected: u.role === r }, label))),
        h('button', {
          class: 'btn secondary small',
          onclick: guard(async () => {
            const pw = prompt(`Neues Passwort für ${u.display_name} (mind. 8 Zeichen):`);
            if (!pw) return;
            await api(`/users/${u.id}`, { method: 'PUT', body: { password: pw } });
            toast('Passwort geändert, Gerät wurde abgemeldet');
          }),
        }, 'Passwort'),
        h('button', {
          class: 'btn secondary small',
          onclick: guard(async () => { await api(`/users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } }); render(); }),
        }, u.disabled ? 'Entsperren' : 'Sperren'))))),
    h('div', { class: 'card' },
      h('h2', {}, 'Neuen Benutzer anlegen'),
      f.displayName, h('div', { style: 'height:8px' }), f.username, h('div', { style: 'height:8px' }), f.password,
      h('div', { style: 'height:8px' }), f.role, h('div', { style: 'height:8px' }), f.loc,
      h('div', { style: 'margin-top:12px' }, h('button', {
        class: 'btn',
        onclick: guard(async () => {
          await api('/users', {
            method: 'POST',
            body: { displayName: f.displayName.value, username: f.username.value, password: f.password.value, role: f.role.value, defaultLocationId: f.loc.value ? Number(f.loc.value) : null },
          });
          toast('Benutzer angelegt');
          render();
        }),
      }, 'Anlegen'))));
}

// --- Dienstplan (Gruppenführer und Admin) -------------------------------------------
const DUTY_SECTIONS = [['plan', 'Übersicht'], ['week', 'Wochenplan'], ['raster', 'Schulraster'], ['absent', 'Abwesenheiten'], ['holidays', 'Ferien']];

async function viewDuty() {
  const section = state.dutySection;
  const nav = h('div', { class: 'segmented' }, DUTY_SECTIONS.map(([key, label]) => h('button', {
    class: section === key ? 'active' : '', onclick: () => { state.dutySection = key; render(); },
  }, label)));
  const body = await ({ plan: dutyPlan, week: dutyWeek, raster: dutyRaster, absent: dutyAbsences, holidays: dutyHolidays }[section])();
  return h('div', {}, h('h1', {}, 'Dienstplan'), nav, body);
}

// Montag der Woche, in der ein Datum liegt
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

async function dutyPlan() {
  if (!state.dutyFrom) state.dutyFrom = isoDate(mondayOf(new Date()));
  const plan = await api(`/duty/plan?from=${state.dutyFrom}&days=7`);
  const shift = (days) => {
    const [y, m, d] = state.dutyFrom.split('-').map(Number);
    state.dutyFrom = isoDate(new Date(y, m - 1, d + days));
    render();
  };
  const gaps = plan.reduce((n, day) => n + day.slots.filter((x) => x.missing > 0 || x.leader_missing > 0).length, 0);
  return h('div', {},
    h('div', { class: 'row', style: 'margin:12px 0' },
      h('button', { class: 'btn secondary small', style: 'flex:none', onclick: () => shift(-7) }, '‹ Woche'),
      h('strong', { style: 'text-align:center' }, `ab ${dayLabel(state.dutyFrom)}`),
      h('button', { class: 'btn secondary small', style: 'flex:none', onclick: () => shift(7) }, 'Woche ›')),
    h('p', { class: 'hint' }, gaps ? `${gaps} unterbesetzte Dienste in dieser Woche.` : 'Diese Woche ist alles besetzt.'),
    plan.map((day) => h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, dayLabel(day.date)),
      day.holiday ? h('div', { class: 'banner info' }, `${day.holiday}: kein Dienst`) : day.slots
        // Stunden ohne Vorgabe und ohne Eintrag ausblenden, damit die Lücken auffallen.
        .filter((slot) => slot.period.min_total > 0 || slot.people.length || slot.absent.length)
        .map((slot) => h('div', { class: 'list-item' },
        h('div', {},
          h('div', {}, h('strong', {}, slot.period.name), h('span', { class: 'muted' }, ` ${slot.period.start_time}–${slot.period.end_time}`)),
          h('div', {}, slot.people.map((p) => p.display_name + (p.role === 'leader' ? ' (GF)' : '')
            + (p.status === 'swapped_in' ? ` (für ${p.for_name})` : p.status === 'extra' ? ' (zusätzlich)' : p.status === 'offered' ? ' (abgegeben)' : '')).join(', ') || '–'),
          slot.absent.length ? h('div', { class: 'muted' }, `abwesend: ${slot.absent.map((p) => p.display_name).join(', ')}`) : null),
        slotStatus(slot))))));
}

async function dutyWeek() {
  const [periods, assignments, people] = await Promise.all([api('/periods'), api('/duty/assignments'), api('/duty/people')]);
  const day = state.dutyWeekday;
  const dayNav = h('div', { class: 'segmented' }, [1, 2, 3, 4, 5].map((d) => h('button', {
    class: d === day ? 'active' : '', onclick: () => { state.dutyWeekday = d; render(); },
  }, WEEKDAYS[d].slice(0, 2))));
  return h('div', {},
    h('p', { class: 'hint' }, 'Regelmäßige Dienste, gelten jede Woche. Einzelne Termine geben Sanitäter selbst ab oder übernehmen sie.'),
    dayNav,
    h('div', { class: 'card' }, periods.map((p) => {
      const here = assignments.filter((a) => a.weekday === day && a.period_id === p.id);
      const select = h('select', {}, h('option', { value: '' }, '+ eintragen'),
        people.filter((u) => !here.some((a) => a.user_id === u.id)).map((u) => h('option', { value: u.id }, `${u.display_name} (${u.role_label})`)));
      select.addEventListener('change', guard(async () => {
        if (!select.value) return;
        await api('/duty/assignments', { method: 'POST', body: { weekday: day, periodId: p.id, userId: Number(select.value) } });
        render();
      }));
      return h('div', { class: 'list-item' },
        h('div', {},
          h('strong', {}, p.name), h('span', { class: 'muted' }, ` ${p.start_time}–${p.end_time} · mind. ${p.min_total}${p.min_leaders ? `, davon ${p.min_leaders} GF` : ''}`),
          h('div', { class: 'chips' }, here.map((a) => h('span', { class: 'chip' }, a.display_name, h('button', {
            title: 'Austragen', onclick: guard(async () => { await api(`/duty/assignments/${a.id}`, { method: 'DELETE' }); render(); }),
          }, '×'))))),
        select);
    })));
}

async function dutyRaster() {
  const periods = await api('/periods');
  const row = (p) => {
    const f = {
      name: h('input', { value: p?.name ?? '', placeholder: 'z. B. 1. große Pause' }),
      start: h('input', { type: 'time', value: p?.start_time ?? '' }),
      end: h('input', { type: 'time', value: p?.end_time ?? '' }),
      kind: h('select', {}, h('option', { value: 'lesson', selected: p?.kind === 'lesson' }, 'Stunde'), h('option', { value: 'break', selected: p?.kind === 'break' }, 'Pause')),
      min: h('input', { type: 'number', min: 0, max: 20, value: p?.min_total ?? 1 }),
      gf: h('input', { type: 'number', min: 0, max: 20, value: p?.min_leaders ?? 0 }),
    };
    const body = () => ({ name: f.name.value, start: f.start.value, end: f.end.value, kind: f.kind.value, minTotal: Number(f.min.value), minLeaders: Number(f.gf.value) });
    return h('div', { class: 'raster-row' },
      f.name, h('div', { class: 'row' }, h('label', {}, 'Beginn', f.start), h('label', {}, 'Ende', f.end), h('label', {}, 'Art', f.kind)),
      h('div', { class: 'row' }, h('label', {}, 'mind. Personen', f.min), h('label', {}, 'davon Gruppenführer', f.gf)),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn small',
          onclick: guard(async () => {
            await api(p ? `/periods/${p.id}` : '/periods', { method: p ? 'PUT' : 'POST', body: body() });
            toast('Gespeichert');
            render();
          }),
        }, p ? 'Speichern' : 'Hinzufügen'),
        p ? h('button', {
          class: 'btn secondary small',
          onclick: guard(async () => {
            if (!confirm(`„${p.name}“ und alle Dienste darin löschen?`)) return;
            await api(`/periods/${p.id}`, { method: 'DELETE' });
            render();
          }),
        }, 'Löschen') : null));
  };
  return h('div', {},
    h('p', { class: 'hint' }, 'Stunden und Pausen eurer Schule mit der Mindestbesetzung. Gilt für alle Wochentage.'),
    h('div', { class: 'card' }, periods.map(row)),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Neue Stunde oder Pause'), row(null)));
}

async function dutyAbsences() {
  const [absences, people] = await Promise.all([api('/absences?all=1'), api('/duty/people')]);
  const who = h('select', {}, people.map((u) => h('option', { value: u.id }, u.display_name)));
  return h('div', {},
    h('div', { class: 'card' },
      absences.length === 0 ? h('p', { class: 'hint' }, 'Keine aktuellen Abwesenheiten.') : absences.map((a) => h('div', { class: 'list-item' },
        h('div', {}, h('strong', {}, a.display_name), ` ${dayLabel(a.start_date)} – ${dayLabel(a.end_date)}`, a.reason ? h('span', { class: 'muted' }, ` · ${a.reason}`) : null),
        h('button', { class: 'btn secondary small', onclick: guard(async () => { await api(`/absences/${a.id}`, { method: 'DELETE' }); render(); }) }, 'Löschen')))),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Abwesenheit eintragen'),
      dateRangeForm((v) => api('/absences', { method: 'POST', body: { ...v, userId: Number(who.value) } }), [who])));
}

async function dutyHolidays() {
  const holidays = await api('/holidays');
  const name = h('input', { placeholder: 'z. B. Weihnachtsferien' });
  return h('div', {},
    h('p', { class: 'hint' }, 'An Ferientagen gibt es keinen Dienst. Alarme gehen dann an alle verfügbaren Sanitäter.'),
    h('div', { class: 'card' },
      holidays.length === 0 ? h('p', { class: 'hint' }, 'Noch keine Ferien eingetragen.') : holidays.map((x) => h('div', { class: 'list-item' },
        h('div', {}, h('strong', {}, x.name), ` ${dayLabel(x.start_date)} – ${dayLabel(x.end_date)}`),
        h('button', { class: 'btn secondary small', onclick: guard(async () => { await api(`/holidays/${x.id}`, { method: 'DELETE' }); render(); }) }, 'Löschen')))),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Ferien eintragen'),
      dateRangeForm((v) => api('/holidays', { method: 'POST', body: { name: name.value, start: v.start, end: v.end } }), [name], { withReason: false })));
}

// --- Admin: Orte und Verletzungsarten ---------------------------------------------
async function viewLists() {
  const [locs, injuries] = await Promise.all([api('/locations'), api('/injuries')]);
  const refresh = async () => { state.lists = await api('/lists'); render(); };
  const toggle = (route, row) => h('button', {
    class: 'btn secondary small',
    onclick: guard(async () => { await api(`/${route}/${row.id}`, { method: 'PUT', body: { active: !row.active } }); await refresh(); }),
  }, row.active ? 'Ausblenden' : 'Einblenden');
  const rename = (route, row, fields) => h('button', {
    class: 'btn secondary small',
    onclick: guard(async () => {
      const body = {};
      for (const [key, label] of fields) {
        const v = prompt(label, row[key]);
        if (v === null) return;
        body[key] = v;
      }
      await api(`/${route}/${row.id}`, { method: 'PUT', body });
      await refresh();
    }),
  }, 'Ändern');
  const lb = h('input', { placeholder: 'Gebäude, z. B. Hauptgebäude' });
  const ln = h('input', { placeholder: 'Bereich, z. B. 1. Obergeschoss' });
  const inj = h('input', { placeholder: 'Verletzungsart' });
  return h('div', {},
    h('h1', {}, 'Orte & Verletzungsarten'),
    h('p', { class: 'hint' }, 'Ausgeblendete Einträge erscheinen nicht mehr beim Alarmieren, bleiben aber im Protokoll erhalten.'),
    h('div', { class: 'card' }, h('h2', {}, 'Orte'),
      locs.map((l) => h('div', { class: 'list-item' },
        h('div', { class: l.active ? '' : 'muted' }, `${l.building} – ${l.name}`),
        h('div', { class: 'row', style: 'flex:none' }, rename('locations', l, [['building', 'Gebäude'], ['name', 'Bereich']]), toggle('locations', l)))),
      h('div', { class: 'row', style: 'margin-top:12px' }, lb, ln),
      h('div', { style: 'margin-top:8px' }, h('button', {
        class: 'btn', onclick: guard(async () => { await api('/locations', { method: 'POST', body: { building: lb.value, name: ln.value } }); await refresh(); }),
      }, 'Ort hinzufügen'))),
    h('div', { class: 'card' }, h('h2', {}, 'Verletzungsarten'),
      injuries.map((i) => h('div', { class: 'list-item' },
        h('div', { class: i.active ? '' : 'muted' }, i.name),
        h('div', { class: 'row', style: 'flex:none' }, rename('injuries', i, [['name', 'Verletzungsart']]), toggle('injuries', i)))),
      h('div', { style: 'margin-top:12px' }, inj),
      h('div', { style: 'margin-top:8px' }, h('button', {
        class: 'btn', onclick: guard(async () => { await api('/injuries', { method: 'POST', body: { name: inj.value } }); await refresh(); }),
      }, 'Verletzungsart hinzufügen'))));
}

// --- Admin: Protokoll und Einstellungen ----------------------------------------------
async function viewAdmin() {
  const [all, settings] = await Promise.all([api('/alarms'), can('settings.manage') ? api('/settings') : null]);
  const out = h('div', {}, h('h1', {}, 'Protokoll & Einstellungen'));
  if (can('log.view')) {
    out.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', {}, 'Einsatzprotokoll'), h('a', { class: 'btn secondary small', href: '/api/log.csv', style: 'flex:none;text-decoration:none' }, 'Als CSV exportieren')),
      all.length === 0 ? h('p', { class: 'hint' }, 'Noch keine Einsätze.') : h('table', {},
        h('tr', {}, h('th', {}, 'Zeit'), h('th', {}, 'Ort / Verletzung'), h('th', {}, 'Zusage')),
        all.map((a) => {
          const first = a.recipients.filter((r) => r.response === 'coming').map((r) => r.responded_at).sort()[0];
          return h('tr', {},
            h('td', {}, dateTime(a.created_at), h('br'), pill(a.urgency, a.urgency_label), a.is_test ? [' ', pill('grey', 'Test')] : null),
            h('td', {}, a.location, h('br'), h('span', { class: 'muted' }, a.injury)),
            h('td', {}, first ? `nach ${Math.round((new Date(first) - new Date(a.created_at)) / 1000)} s` : 'keine'));
        }))));
  }
  if (settings) {
    const esc = h('input', { type: 'number', value: settings.escalate_seconds });
    const nr = h('input', { type: 'number', value: settings.no_response_seconds });
    const sy = h('input', { value: settings.school_year_end, placeholder: 'MM-TT' });
    const cr = h('input', { type: 'number', value: settings.chat_retention_days });
    const rt = h('input', { type: 'time', value: settings.reminder_time });
    out.append(h('div', { class: 'card' },
      h('h2', {}, 'Einstellungen'),
      h('label', {}, 'Gelb: an alle weiterleiten nach … Sekunden ohne Zusage'), esc,
      h('label', {}, 'Hinweis „Durchsage oder Telefon“ nach … Sekunden ohne Zusage'), nr,
      h('label', {}, 'Schuljahresende (MM-TT): Einsatzprotokolle davor werden gelöscht'), sy,
      h('label', {}, 'Allgemeinen Chat löschen nach … Tagen'), cr,
      h('label', {}, 'Erinnerung an den heutigen Dienst um'), rt,
      h('div', { style: 'margin-top:12px' }, h('button', {
        class: 'btn',
        onclick: guard(async () => {
          await api('/settings', {
            method: 'PUT',
            body: { escalate_seconds: Number(esc.value), no_response_seconds: Number(nr.value), school_year_end: sy.value, chat_retention_days: Number(cr.value), reminder_time: rt.value },
          });
          toast('Gespeichert');
        }),
      }, 'Speichern'))));

    // Rechte der Gruppenführer/innen: Der Admin entscheidet, was diese Ebene darf.
    const boxes = Object.entries(settings.permission_labels)
      .filter(([p]) => !settings.admin_only.includes(p))
      .map(([p, label]) => {
        const box = h('input', { type: 'checkbox', value: p, checked: settings.leader_permissions.includes(p), style: 'width:auto' });
        return [box, h('label', { class: 'check' }, box, ` ${label}`)];
      });
    out.append(h('div', { class: 'card' },
      h('h2', {}, 'Rechte der Gruppenführer/innen'),
      h('p', { class: 'hint' }, 'Benutzer verwalten und Systemeinstellungen bleiben dem Admin vorbehalten.'),
      boxes.map(([, label]) => label),
      h('div', { style: 'margin-top:12px' }, h('button', {
        class: 'btn',
        onclick: guard(async () => {
          const leader_permissions = boxes.filter(([box]) => box.checked).map(([box]) => box.value);
          await api('/settings', { method: 'PUT', body: { leader_permissions } });
          toast('Rechte gespeichert');
        }),
      }, 'Rechte speichern'))));
  }
  return out;
}

// --- Konto -----------------------------------------------------------------------
function viewAccount() {
  const oldPw = h('input', { type: 'password', autocomplete: 'current-password' });
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
  return h('div', {},
    h('h1', {}, 'Konto'),
    h('div', { class: 'card' },
      h('p', {}, `${state.me.display_name} (${state.me.username}) · ${state.me.role_label}`),
      h('h2', {}, 'Passwort ändern'),
      h('label', {}, 'Altes Passwort'), oldPw,
      h('label', {}, 'Neues Passwort (mind. 8 Zeichen)'), newPw,
      h('div', { style: 'margin-top:12px' }, h('button', {
        class: 'btn',
        onclick: guard(async () => {
          await api('/me/password', { method: 'PUT', body: { oldPassword: oldPw.value, newPassword: newPw.value } });
          toast('Passwort geändert');
          oldPw.value = '';
          newPw.value = '';
        }),
      }, 'Ändern'))),
    can('alarm.receive') ? pushCard() : null,
    h('div', { class: 'card' }, h('button', {
      class: 'btn secondary',
      onclick: guard(async () => { await api('/logout', { method: 'POST' }); location.reload(); }),
    }, 'Abmelden')));
}

boot();

'use strict';
/* Seite hinter dem QR-Code im Raum: ohne Anmeldung den Sanitätsdienst rufen. */

const qrToken = location.pathname.split('/').pop();
const qrState = { info: null, injuryId: null, alarm: null, error: null, busy: false, timer: null };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

async function qrApi(path, method = 'GET', body) {
  const res = await fetch(`/api/qr/${encodeURIComponent(qrToken)}${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Fehler ${res.status}`);
  return data;
}

function statusText(a) {
  if (a.ended) return ['ok', 'Der Einsatz ist beendet.'];
  if (a.coming > 0) return ['ok', a.coming === 1 ? 'Ein Sanitäter ist unterwegs.' : `${a.coming} Sanitäter sind unterwegs.`];
  if (a.no_response) return ['warn', 'Noch keine Zusage. Bitte Sekretariat anrufen oder eine Lehrkraft holen. Bei Lebensgefahr 112.'];
  if (a.escalated) return ['wait', 'Noch keine Zusage. Jetzt sind alle Sanitäter alarmiert.'];
  return ['wait', 'Der Sanitätsdienst ist alarmiert. Bitte warten.'];
}

function renderQr() {
  const main = document.getElementById('qr');
  const { info, alarm, error } = qrState;
  if (error && !info) {
    main.replaceChildren(el('div', { class: 'banner warn' }, error));
    return;
  }
  if (!info) {
    main.replaceChildren(el('p', { class: 'hint' }, 'Lädt …'));
    return;
  }
  if (alarm) {
    const [kind, text] = statusText(alarm);
    main.replaceChildren(el('div', {},
      el('h1', {}, 'Sanitäter gerufen'),
      el('p', { class: 'qr-room' }, info.label),
      el('div', { class: `qr-status ${kind}` }, text),
      el('p', { class: 'hint' }, 'Bleib bei der verletzten Person. Diese Seite aktualisiert sich von selbst.'),
      error ? el('div', { class: 'banner warn' }, error) : null,
    ));
    return;
  }
  const send = el('button', {
    class: 'qr-call', disabled: qrState.busy,
    onclick: async () => {
      qrState.busy = true;
      renderQr();
      try {
        qrState.alarm = await qrApi('/alarm', 'POST', { injuryId: qrState.injuryId });
        qrState.error = null;
        poll();
      } catch (err) {
        qrState.error = err.message;
      }
      qrState.busy = false;
      renderQr();
    },
  }, qrState.busy ? 'Wird gesendet …' : 'Sanitäter rufen');
  main.replaceChildren(el('div', {},
    el('p', { class: 'qr-room' }, info.label),
    el('div', { class: 'banner warn' }, 'Bei Lebensgefahr zuerst 112 anrufen.'),
    send,
    el('h2', {}, 'Was ist passiert? (freiwillig)'),
    el('div', { class: 'qr-injuries' }, info.injuries.map((i) => el('button', {
      class: `chip${qrState.injuryId === i.id ? ' active' : ''}`,
      onclick: () => { qrState.injuryId = qrState.injuryId === i.id ? null : i.id; renderQr(); },
    }, i.name))),
    error ? el('div', { class: 'banner warn' }, error) : null,
  ));
}

function poll() {
  clearInterval(qrState.timer);
  qrState.timer = setInterval(async () => {
    try {
      qrState.alarm = await qrApi(`/alarm/${qrState.alarm.id}`);
      qrState.error = null;
      if (qrState.alarm.ended) clearInterval(qrState.timer);
    } catch {
      qrState.error = 'Keine Verbindung zum Server. Bitte Sekretariat anrufen.';
    }
    renderQr();
  }, 3000);
}

(async () => {
  renderQr();
  try {
    qrState.info = await qrApi('');
    qrState.alarm = qrState.info.alarm;
    if (qrState.alarm && !qrState.alarm.ended) poll();
  } catch (err) {
    qrState.error = err.message;
  }
  renderQr();
})();

'use strict';
const crypto = require('node:crypto');

// Rechte sind einzelne Berechtigungen, nicht fest an Rollen gebunden.
// Der Admin hat immer alle Rechte, auch solche, die künftig dazukommen.
const PERMISSIONS = {
  'alarm.receive': 'Alarm empfangen und quittieren',
  'alarm.send': 'Alarm auslösen',
  'alarm.view_all': 'Alle laufenden Alarme sehen',
  'alarm.test': 'Testalarm auslösen',
  'duty.view_own': 'Eigenen Dienstplan sehen',
  'duty.manage': 'Dienstplan erstellen und ändern',
  'availability.set': 'Verfügbarkeit setzen',
  'users.manage': 'Benutzer und Rollen verwalten',
  'lists.manage': 'Orte und Verletzungsarten pflegen',
  'log.view': 'Einsatzprotokoll einsehen und exportieren',
  'settings.manage': 'Systemeinstellungen',
  'chat.general': 'Allgemeiner Chat',
  'chat.moderate': 'Chatnachrichten löschen',
};

// Startwerte für Gruppenführer/innen; der Admin kann sie in den Einstellungen ändern.
const LEADER_DEFAULTS = [
  'alarm.receive', 'alarm.send', 'alarm.view_all', 'duty.view_own', 'duty.manage',
  'availability.set', 'log.view', 'chat.general', 'chat.moderate',
];
// Diese Rechte bleiben dem Admin vorbehalten.
const ADMIN_ONLY = ['users.manage', 'settings.manage'];

const ROLE_PERMISSIONS = {
  medic: ['alarm.receive', 'duty.view_own', 'availability.set', 'chat.general'],
  leader: [...LEADER_DEFAULTS],
  sender: ['alarm.send'],
  admin: null, // null = alle
};

const ROLE_LABELS = { medic: 'Sanitäter', leader: 'Gruppenführer/in', sender: 'Alarmierungssender', admin: 'Admin' };

function setLeaderPermissions(list) {
  const valid = [...new Set(list)].filter((p) => PERMISSIONS[p] && !ADMIN_ONLY.includes(p));
  ROLE_PERMISSIONS.leader = valid;
  return valid;
}

function can(user, permission) {
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role];
  return perms === null || (Array.isArray(perms) && perms.includes(permission));
}

function permissionsOf(user) {
  return Object.keys(PERMISSIONS).filter((p) => can(user, p));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
  PERMISSIONS,
  ROLE_LABELS,
  LEADER_DEFAULTS,
  ADMIN_ONLY,
  setLeaderPermissions,
  can,
  permissionsOf,
  hashPassword,
  verifyPassword,
  newToken,
};

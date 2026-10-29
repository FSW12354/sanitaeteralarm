# Sanitäteralarm

Alarmierung von Schulsanitätern im Schul-WLAN. Wer einen Notfall meldet, wählt Ort, Verletzungsart und Dringlichkeit; die diensthabenden Sanitäter bekommen den Alarm auf iPhone oder iPad und sagen mit einem Tippen zu oder ab.

Das Konzept dazu: [Konzept: Alarmierungssystem für Schulsanitäter](https://claude.ai/artifact/2w6WQ6E779Rq2T4CmWjLbe). Dieser Stand ist der **Prototyp (Phase 2)**.

## Was der Prototyp kann

| Rolle | Funktionen |
| --- | --- |
| Alarmierungssender | Alarm in drei Schritten (Ort mit optionaler Raumnummer, Verletzungsart, Dringlichkeit), Live-Ansicht der Zusagen, erneut senden, Einsatz beenden |
| Sanitäter | Vollbild-Alarm mit Ton, „Komme“ / „Kann nicht“, verfügbar / nicht verfügbar, eigener Wochendienstplan, Einsatzchat, allgemeiner Chat, Mitteilungen bei gesperrtem Gerät |
| Gruppenführer/in | eine Ebene unter dem Admin; Rechte stellt der Admin unter „Protokoll & Einstellungen“ ein. Startwerte: wie Sanitäter, dazu Alarm auslösen, alle Einsätze sehen und steuern, Dienstplan pflegen, Protokoll sehen, Chatnachrichten löschen |
| Admin | alles oben, dazu Benutzer und Rollen, Rechte der Gruppenführer, Orte und Verletzungsarten, Testalarm, Einstellungen |

Chats:

- **Einsatzchat** an jedem Alarm für Empfänger, Sender, Gruppenführer und Admin; wird mit dem Einsatzprotokoll zum Schuljahresende gelöscht.
- **Allgemeiner Chat** für den Sanitätsdienst (nicht für Sender-Geräte); wird nach 30 Tagen gelöscht (einstellbar).
- Chatnachrichten lösen keinen Alarmton und keine Mitteilung aus, nur einen Zähler am Reiter.

Alarmregeln (Zeiten in den Einstellungen änderbar):

- **Rot:** sofort an alle verfügbaren Sanitäter, beim Sender erscheint „112 rufen?“.
- **Gelb:** an den Dienst; nach 60 Sekunden ohne Zusage an alle.
- **Grün:** nur an den Dienst.
- Ist gerade niemand im Dienst, geht jeder Alarm an alle verfügbaren Sanitäter.
- Bei Rot und Gelb wird der Sender nach 2 Minuten ohne Zusage aufgefordert, per Durchsage oder Telefon zu alarmieren.
- Einsatzprotokolle werden zum Schuljahresende (Standard: 31.07.) automatisch gelöscht. Namen von Verletzten werden nicht gespeichert.

Rechte sind intern einzelne Berechtigungen (`src/auth.js`). Der Admin hat immer alle Rechte, auch künftige.

## Installation

Voraussetzung: Node.js 22.13 oder neuer (z. B. auf einem Raspberry Pi 5 oder Mini-PC im Schulnetz).

```sh
npm install
ADMIN_NAME="Bruce" npm start
```

Beim ersten Start wird ein Admin-Konto `admin` angelegt und das Passwort in der Konsole ausgegeben. Bitte nach der ersten Anmeldung unter „Konto“ ändern.

Umgebungsvariablen:

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `PORT` | Port des Servers | `8443` |
| `DATA_DIR` | Ordner für die Datenbank | `./data` |
| `TLS_CERT`, `TLS_KEY` | Pfade zu Zertifikat und Schlüssel für HTTPS | – (dann nur HTTP) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME` | erstes Admin-Konto | `admin`, zufällig, `Admin` |
| `PUSH_CONTACT` | Kontaktadresse für den Push-Dienst | `mailto:admin@schule.local` |
| `TZ` | Zeitzone für den Dienstplan | Systemzeit, empfohlen `Europe/Berlin` |

## iPhone und iPad

Ein gesperrtes iPhone bekommt Alarme nur über **Web Push** (ab iOS 16.4). Dafür gilt:

1. Der Server muss über **HTTPS mit einem Zertifikat laufen, dem die iPhones vertrauen**, z. B. unter einem festen Namen wie `sanialarm.schule.de`. Ein selbst signiertes Zertifikat funktioniert nur, wenn es auf jedem Gerät installiert und vertraut wird.
2. Der Server braucht **ausgehenden Internetzugang zu Apples Push-Dienst** (`*.push.apple.com`, Port 443). Der Inhalt ist Ende-zu-Ende verschlüsselt; Apple sieht nur verschlüsselte Daten.
3. Jeder Sanitäter öffnet die Adresse in Safari, tippt auf **Teilen → Zum Home-Bildschirm**, öffnet die App vom Home-Bildschirm und tippt unter „Mein Dienst“ auf **Mitteilungen einschalten**.
4. Empfehlung: Im Fokus-Modus Sanitäteralarm als erlaubte App eintragen.

Grenzen: Web Push klingelt nicht, wenn das iPhone stumm geschaltet ist. Ist die App geöffnet, spielt sie einen eigenen Alarmton. Ein Alarm trotz Stummschaltung ginge nur mit einer eigenen iOS-App und einer Sondergenehmigung von Apple („kritische Hinweise“). Das soll der Pilot klären.

## Entwicklung

```sh
npm test
```

Aufbau:

- `src/server.js` – Start, HTTPS, Eskalationsprüfung alle 5 Sekunden
- `src/app.js` – HTTP-API und WebSocket
- `src/alarms.js` – Alarmregeln, Eskalation, Löschfrist
- `src/notifier.js` – Verteilung über WebSocket und Web Push
- `src/auth.js` – Rollen, Berechtigungen, Passwörter
- `src/db.js` – SQLite-Datenbank (`node:sqlite`), Startlisten für Orte und Verletzungsarten
- `public/` – Web-App (ohne Build-Schritt)

## Noch nicht im Prototyp

- Dienstplan nach Schulraster, Mindestbesetzung, Abwesenheiten, Ferien, Diensttausch (Vorschlag steht im Konzept)
- Einsatznotiz beim Abschließen

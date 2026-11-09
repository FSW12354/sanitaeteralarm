# Sanitäteralarm

Alarmierung von Schulsanitätern im Schul-WLAN. Wer einen Notfall meldet, wählt Ort, Verletzungsart und Dringlichkeit; die diensthabenden Sanitäter bekommen den Alarm auf iPhone oder iPad und sagen mit einem Tippen zu oder ab.

Das Konzept dazu: [Konzept: Alarmierungssystem für Schulsanitäter](https://claude.ai/artifact/2w6WQ6E779Rq2T4CmWjLbe). Dieser Stand ist der **Prototyp (Phase 2)**.

## Was der Prototyp kann

| Rolle | Funktionen |
| --- | --- |
| Alarmierungssender | Alarm in drei Schritten (Ort mit optionaler Raumnummer, Verletzungsart, Dringlichkeit), Live-Ansicht der Zusagen, erneut senden, Einsatz beenden |
| Sanitäter | Vollbild-Alarm mit Ton, „Komme“ / „Kann nicht“, verfügbar / nicht verfügbar, eigene Dienste, Termine abgeben und übernehmen, Abwesenheiten, Einsatzchat, allgemeiner Chat, Mitteilungen bei gesperrtem Gerät |
| Gruppenführer/in | eine Ebene unter dem Admin; Rechte stellt der Admin unter „Protokoll & Einstellungen“ ein. Startwerte: wie Sanitäter, dazu Alarm auslösen, alle Einsätze sehen und steuern, Dienstplan pflegen, Protokoll sehen, Chatnachrichten löschen |
| Admin | alles oben, dazu Benutzer und Rollen, Rechte der Gruppenführer, Orte und Verletzungsarten, Testalarm, Einstellungen |

Chats:

- **Einsatzchat** an jedem Alarm für Empfänger, Sender, Gruppenführer und Admin; wird mit dem Einsatzprotokoll zum Schuljahresende gelöscht.
- **Allgemeiner Chat** für den Sanitätsdienst (nicht für Sender-Geräte); wird nach 30 Tagen gelöscht (einstellbar).
- Chatnachrichten lösen keinen Alarmton und keine Mitteilung aus, nur einen Zähler am Reiter.

Alarmregeln (Zeiten in den Einstellungen änderbar):

- **Rot:** sofort an alle verfügbaren Sanitäter, beim Sender erscheint „112 rufen?“.
- **Gelb und Grün:** zuerst an den Dienst. Sagt dort nach 60 Sekunden niemand zu, geht der Alarm an alle verfügbaren Sanitäter. Sagen alle aus dem Dienst ab („Kann nicht“), geht er sofort an alle.
- Ist gerade niemand im Dienst, geht jeder Alarm an alle verfügbaren Sanitäter.
- Bei Rot und Gelb wird der Sender nach 2 Minuten ohne Zusage aufgefordert, per Durchsage oder Telefon zu alarmieren.
- Einsatzprotokolle werden zum Schuljahresende (Standard: 31.07.) automatisch gelöscht. Namen von Verletzten werden nicht gespeichert.

Alarm per QR-Code:

- Der Admin legt unter „Orte & Verletzungen“ für jeden Raum einen QR-Code an (Ort + Raumnummer) und druckt alle Codes als A4-Aushänge aus.
- Wer den Code im Schul-WLAN scannt, sieht den Raum und tippt „Sanitäter rufen“, ohne Anmeldung. Die Verletzungsart kann man freiwillig antippen.
- Der Alarm ist Gelb: Er geht sofort an die Diensthabenden und ohne Zusage nach 60 s an alle. Die Seite zeigt, ob jemand kommt; nach 2 Minuten ohne Zusage fordert sie auf, das Sekretariat anzurufen. Admin und Gruppenführer bekommen den Hinweis „Keine Zusage“.
- Das Sekretariat (alle Alarmierungssender-Konten) sieht Alarme per QR-Code live unter „Alarme“, bekommt eine Mitteilung und nach 2 Minuten ohne Zusage die Aufforderung zur Durchsage. Es wird nicht selbst alarmiert.
- Missbrauchsschutz: Erneutes Scannen während eines offenen Alarms löst keinen zweiten aus, höchstens 5 Alarme pro Code und Stunde. Ein Code lässt sich ausschalten oder durch einen neuen ersetzen; der alte Ausdruck ist dann ungültig.

Abzeichen in der Kopfzeile:

- Admin: gelber Stern vor „Sanitäteralarm“.
- Gruppenführer/innen: drei gelbe Balken hinter dem Schriftzug.
- Zwei gelbe Balken vergibt der Admin unter „Benutzer“ an einzelne Sanitäter.

Dienstplan:

- **Tagesdienst**: jeden Schultag (Mo–Fr) von 08:00 bis 14:30 Uhr, mindestens 2 Sanitäter. Im **Wochenplan** wählt der Dienstplaner pro Wochentag die Sanitäter aus einem Auswahlmenü. Unter **Dienstzeiten** lassen sich Uhrzeit und Mindestbesetzung ändern oder weitere Zeiten anlegen.
- **Abwesenheiten** (Klassenfahrt, Praktikum, Krankheit) tragen Sanitäter selbst ein; Dienstplaner auch für andere. Abwesende haben keinen Dienst, die Lücke wird sichtbar.
- **Ferien**: kein Dienst; Alarme gehen dann an alle verfügbaren Sanitäter.
- **Diensttausch**: Sanitäter geben einen einzelnen Termin ab, ein anderer übernimmt ihn. Bis dahin bleibt der Termin beim Abgebenden. Dienstplaner werden informiert.
- **Offene Dienste**: unterbesetzte oder abgegebene Termine der nächsten zwei Wochen; mit „Übernehmen“ trägt man sich ein.
- **Erinnerung**: An Schultagen um 07:30 Uhr (einstellbar) eine Mitteilung an alle, die heute Dienst haben.
- „Im Dienst“ für die Alarmierung heißt: zur aktuellen Uhrzeit eingeteilt, nicht abwesend, kein Ferientag.

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
| `PUBLIC_URL` | Adresse in den QR-Codes, z. B. `https://sanialarm.schule.de` | Adresse, unter der der Admin die Seite aufruft |

## iPhone und iPad

Ein gesperrtes iPhone bekommt Alarme nur über **Web Push** (ab iOS 16.4). Dafür gilt:

1. Der Server muss über **HTTPS mit einem Zertifikat laufen, dem die iPhones vertrauen**, z. B. unter einem festen Namen wie `sanialarm.schule.de`. Ein selbst signiertes Zertifikat funktioniert nur, wenn es auf jedem Gerät installiert und vertraut wird.
2. Der Server braucht **ausgehenden Internetzugang zu Apples Push-Dienst** (`*.push.apple.com`, Port 443). Der Inhalt ist Ende-zu-Ende verschlüsselt; Apple sieht nur verschlüsselte Daten.
3. Jeder Sanitäter öffnet die Adresse in Safari, tippt auf **Teilen → Zum Home-Bildschirm**, öffnet die App vom Home-Bildschirm und tippt unter „Mein Dienst“ auf **Mitteilungen einschalten**.
4. Empfehlung: Im Fokus-Modus Sanitäteralarm als erlaubte App eintragen.

Grenzen: Web Push klingelt nicht, wenn das iPhone stumm geschaltet ist. Ist die App geöffnet, spielt sie einen eigenen Alarmton. Ein Alarm trotz Stummschaltung ginge nur mit einer eigenen iOS-App und einer Sondergenehmigung von Apple („kritische Hinweise“). Das soll der Pilot klären.

## PC im Sekretariat (Windows)

1. In Microsoft Edge die Adresse des Sanitäteralarms öffnen und mit dem Sekretariats-Konto anmelden.
2. Menü „…“ → „Apps“ → „Diese Website als App installieren“. Danach unter `edge://apps` bei der App „Beim Anmelden automatisch starten“ einschalten.
3. Unter „Konto“ die **Kompaktansicht** einschalten (oder einmal `/?kompakt` aufrufen): ein schmales Fenster nur mit den laufenden Alarmen. Die Zahl laufender Alarme steht am Symbol in der Taskleiste.
4. In der Kompaktansicht „Mitteilungen einschalten“ tippen: Neue QR-Alarme und „Keine Zusage“ erscheinen dann auch als Windows-Mitteilung (braucht ausgehenden Internetzugang des PCs, wie jede Web-Push-Mitteilung). Ist das Fenster offen, kommen Anzeige und Hinweiston auch ohne Internet über das Schulnetz.
5. In der Kompaktansicht kann das Sekretariat direkt **Alarm auslösen** (gleicher Ablauf wie „Alarm senden“) und mit **Einsatz beenden** jeden Alarm schließen, den es sieht: eigene Alarme und alle Alarme per QR-Code. Das regelt das Recht „Sichtbare Alarme beenden“ (`alarm.end`), das die Rolle Alarmierungssender hat.
6. Optional mit Microsoft PowerToys „Immer im Vordergrund“ (Win+Strg+T) das Fenster oben halten.

## Entwicklung

```sh
npm test
```

Aufbau:

- `src/server.js` – Start, HTTPS, Eskalationsprüfung alle 5 Sekunden
- `src/app.js` – HTTP-API und WebSocket
- `src/alarms.js` – Alarmregeln, Eskalation, Löschfrist
- `src/duty.js` – Dienstplan: wer wann Dienst hat, Erinnerungen
- `src/notifier.js` – Verteilung über WebSocket und Web Push
- `src/auth.js` – Rollen, Berechtigungen, Passwörter
- `src/db.js` – SQLite-Datenbank (`node:sqlite`), Startlisten für Orte und Verletzungsarten
- `public/` – Web-App (ohne Build-Schritt)

## Noch nicht im Prototyp

- Dienstplan Stufe 3: Fairness-Zähler und PDF-Export
- Einsatznotiz beim Abschließen

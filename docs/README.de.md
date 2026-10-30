# LogShip Druckbox – Kurzanleitung

Die Druckbox verbindet Ihre Etiketten- und A4-Drucker mit LogShip. Sie braucht nur Strom, ein
LAN-Kabel und Internetzugang nach außen (HTTPS). Es werden **keine** Ports geöffnet und **kein** VPN
benötigt.

## 1. Anschließen
1. LAN-Kabel in die Box und in Ihren Switch/Router stecken.
2. Zebra-Etikettendrucker per USB an die Box anschließen und einschalten.
3. Netzteil anschließen. Die Box startet in ca. 30 Sekunden.

Die Box ist von LogYou bereits mit Ihrer LogShip-Instanz verbunden („enrolled“). Falls nicht:
im Browser `http://logship-print.local:8080` öffnen und Instanz-URL + Enrolment-Code eintragen
(beides erzeugen Sie in LogShip unter *Einstellungen → Drucker → Print-Agents*).

## 2. Drucker
- **USB-Zebra-Drucker** werden automatisch als `labelprinter-1`, `labelprinter-2`, … angelegt.
- **Netzwerkdrucker / A4-Laser:** `http://logship-print.local:631/admin` → *Drucker hinzufügen*
  (Benutzer `logship`, Passwort siehe Übergabeblatt). Driverless-/IPP-Everywhere-Drucker werden
  automatisch gefunden.
- In LogShip erscheinen alle Warteschlangen der Box unter *Einstellungen → Drucker → Print-Agents*.
  Mit **Anlegen** wird daraus ein LogShip-Drucker; im Druckerformular legen Sie pro Drucker fest,
  dass er über die Box druckt. Etikettengröße wird vom Gerät übernommen.

## 3. Betrieb
- Statusseite: `http://logship-print.local:8080` (Verbindung, Warteschlangen, letzte Aufträge, Testseite).
- Updates (Sicherheit + Agent) installiert die Box nachts selbst. Ein Neustart erfolgt nur, wenn
  nötig, zwischen 03:00 und 03:30 Uhr und nur, wenn keine Druckaufträge offen sind.
- Druckerkonfiguration wird jede Nacht in Ihrer LogShip-Instanz gesichert.
- **Stromausfall:** Die Box startet selbst wieder; wartende Aufträge werden danach gedruckt.

## 4. Wenn etwas nicht druckt
1. Leuchtet der Drucker, ist Papier/Etikettenrolle drin? → `lpstat`-Button in LogShip zeigt den Status.
2. Statusseite `:8080`: „verbunden“? Wenn nicht: LAN-Kabel, Internet, Router.
3. In LogShip *Print-Agents*: Gerät „online“? Aufträge mit Status *fehlgeschlagen* → Grund steht daneben,
   **Erneut drucken** wiederholt den Auftrag.
4. Box neu starten (Stecker ziehen ist erlaubt – die Box ist dafür ausgelegt).
5. Support LogYou: Button **Fernwartung 8 h** in LogShip gibt uns zeitlich begrenzt Zugriff auf die Box –
   nur auf die Box, nicht auf Ihr Netzwerk.

# PictoChat 2.0 – Sicherheitsmodell und Freigabesperren

**Stand:** Experimenteller lokaler Rust-Relay mit gemeinsamem, manuell ausgetauschtem 256-Bit-AES-GCM-Schlüssel. **Nicht produktionsreif.**

## Sicherheitsgrenzen

| Bedrohung | Aktuelle Maßnahme | Nicht gelöst |
| --- | --- | --- |
| Unbefugter Raumbeitritt | HMAC-SHA256-Bearertoken pro Raum; Token nicht im URL-Pfad | Tokenkopie ermöglicht Zutritt; keine Teilnehmeridentität oder individuelle Sperre |
| Server liest Chatinhalte | Browser ver-/entschlüsselt Text und Skizzen lokal via Web Crypto AES-256-GCM | Ein manipuliert ausgelieferter Client kann den Schlüssel abgreifen; der Server kontrolliert derzeit den ausgelieferten JS-Code |
| Man-in-the-Middle | Bind ausschließlich an localhost | Kein TLS und keine überprüfbare Code-Integrität bei Fremdhosting; keine sichere Freigabe über das Netz |
| Inhalte aus anderen Räumen | Raum-ID ist in AES-GCM-AAD eingebunden | Kein automatischer Schlüsselaustausch oder Gruppenmitgliedschaftsprotokoll |
| Replay | Browser prüft zuletzt gesehene AES-GCM-IVs in begrenztem RAM | Kein Replay-Schutz nach Neustart oder außerhalb des Speicherfensters |
| Manipulierte Nachrichten | AES-GCM-Authentifizierung im Browser | Kenntnis des gemeinsamen Gruppenschlüssels ermöglicht gültige Nachrichten und Imitation |
| Ressourcenmissbrauch | 16 Plätze pro Raum, 128 Verbindungen, 256 Räume, 20 Pakete/s pro Sitzung, 16 KiB je Frame | IP-basierte Fairness und ausgefeiltes Abuse-Management fehlen |
| Datenpersistenz | Keine Chatdatenbank; begrenztes RAM-Relay, Browser nutzt keinen Chat-LocalStorage | RAM, Swap, Coredumps, Reverse-Proxies, Browser-Cache, Screenshots, vom Nutzer gespeicherte PDFs |
| Drittanbieter | Browser lädt Skripte vom selben Ursprung; restriktive CSP | Browser-Extensions und kompromittierte Endgeräte sind außerhalb des Kontrollbereichs |

## Kryptografisches Zwischenprotokoll (v1)

- **Schlüsselerzeugung:** CSPRNG; manuell zwischen Mitgliedern über einen **anderen, sicheren Kanal** teilen.
- **Nachrichtenhülle:** Version 0x01 | 12 zufällige IV-Bytes | AES-GCM-Chiffrat inkl. 16-Byte-Tag.
- **Zusatzdaten:** UTF-8-Kodierung von `pictochat-psk-v1:` + 32-stelliger Raum-ID.
- **Server:** Nur Größen- und Versionskontrolle. Das ist ausdrücklich **keine** kryptografische Validierung.
- **Endgeräte:** Authentifizierung durch GCM-Tag, anschließend JSON- und Zeichnungsvalidierung.
- **Wiederholungen:** Im Client flüchtiges IV-LRU mit bis zu 2048 Einträgen; kein dauerhafter Schutz.
- **Schwäche:** PSK kann nicht einzelne Mitglieder ausschließen, keine Forward Secrecy, kein Schutz gegen Gruppenmitglieder, kein überprüfbares Schlüssel- oder Identitätsmanagement.

## Freigabesperren

1. Getrennte, überprüfbare Geräte- und Teilnehmeridentitäten; sichere Einladung und Revokation.
2. Gruppenprotokoll mit Mitgliedschaftsepochen, Forward Secrecy und erneuter Schlüsselbildung nach Änderung der Mitglieder; MLS prüfen statt selbst kryptografische Ratchets zu erfinden.
3. Sichere Verteilung des Frontends und überprüfbare Schlüssel/Code-Integrität; TLS auf allen entfernten Verbindungen.
4. Replay- und Nachrichtenreihenfolge-Konzept mit unabhängigen Teilnehmern und reconnect-toleranter Zustandsverwaltung.
5. Explizites Verhalten bei Offline-Clients (keine Nachrichtenaufbewahrung bedeutet keinen garantierten Nachversand).
6. Bedrohungsmodell verifizieren, Penetrationstest und externe Codeprüfung durchführen.
7. CI: Rust/Clippy, Browser-Web-Crypto-Tests und *echter* WebSocket-Integrationstest mit zwei Clients inklusive Zeichnungen, Unicode, manipulierten Paketen und falschem Raumtoken.
8. UI-Tests auf Desktop und Touch-Geräten; Barrierefreiheit und korrekter PDF-Export einschließlich Unicode und Zeichnungen.

**Wichtig:** Ein erfolgreicher CI-Lauf belegt nur die definierten Tests. Er ist kein Sicherheitszertifikat für private Kommunikation.

# PictoChat 2.0 – Sicherheitsmodell und Freigabesperren

**Stand 6. November 2026:** experimenteller lokaler Rust-Relay mit temporären Raumtickets, clientseitiger AES-256-GCM-V2-Verschlüsselung und flüchtigen P-256-Absendersignaturen. Separater getesteter OpenMLS-V3-Clientkern, **nicht** in den Browser integriert. **Nicht produktionsreif.**

## Produktprinzip: ausschließlich flüchtige Identitäten

Kein permanentes Benutzerkonto, keine Geräte-ID über Sitzungen hinweg, keine zentrale Benutzer- oder Chatdatenbank. Jede Browsersitzung erzeugt eigene temporäre Schlüssel. Eine erneute Sitzung ist bewusst ein neuer Teilnehmer und muss im Chatraum neu zugelassen werden. Wiedererkennung über Tage ist weder vorgesehen noch möglich. Verlässliche Authentifizierung **innerhalb** einer Sitzung und die Mitgliedschaft im aktuellen MLS-Gruppenepoch bleiben dennoch notwendig.

## Grenzen und Gefährdungen

| Risiko | Gegenwärtige Maßnahme | Verbleibendes Risiko |
| --- | --- | --- |
| Unbefugter Raumbeitritt | HMAC-SHA256-Bearertoken je 32-hex-Raum-ID; stateless POST /new-room stellt sechs Stunden gültige Einladungen aus | Jeder Tokeninhaber kann innerhalb der Gültigkeit beitreten, auch nachdem ein Raum leer war; klassische CLI-Raumtickets verfallen bisher nur bei Root-Key-Rotation |
| Server liest Nachrichten | Browser verschlüsselt Text/Skizzen mit AES-256-GCM, signiert mit kurzlebigem P-256-Schlüssel | Ausgelieferter JavaScript-Code wird vom Server kontrolliert; manipulierte Builds/Extensions/Endgeräte kompromittieren die Geheimhaltung |
| Absenderimitation | Fingerprint-Pinning nach unabhängiger Prüfung, ECDSA-Signatur über raumgebundenen Inhalt | Keine geprüfte Verzeichnis- oder MLS-Mitgliedschaftsverwaltung im tatsächlichen Browser |
| Kryptografische Mitgliedschaft | OpenMLS 0.9.2: Add, Welcome, Commit, Epoch, Remove und Weiterkommunikation in eigenständigen Rust-Tests | Browser nutzt weiterhin V2, nicht MLS V3; Schlüssel fehlen im echten UI-Gruppenprotokoll |
| Man-in-the-Middle | Nur localhost-Bind, Origin-Prüfung | Kein TLS/öffentliches Hosting; fremde Origins sind keine vollständige Authentifizierung |
| Replay | 2048-IV-Fenster pro Browser-Verbindung, MLS-Client blockiert nach markiertem Transportverlust | Kein sicherer Reconnect im Browser; Angriffe bei State-Verlust außerhalb des Fensters möglich |
| Datenpersistenz | Kein serverseitiger Chatverlauf; bounded RAM-Broadcast; Browser ohne localStorage/IndexedDB | RAM, Swap, Crashdumps, Browser-Caches, Kopien, Druck/PDF, Screenshots können Inhalte halten |
| Ressourcen | 256 Räume, 16 Verbindungen/Raum, 128 insgesamt, 20 Frames/s, 16 KiB/Frame | Keine IP-Fairness, kein vollständiges Abuse-/DDoS-Konzept |
| Vorzeitige Bereitstellung | CI für Relay, Legacy, Browser, TypeScript und OpenMLS | Kein unabhängiger Security-Audit oder vollständig geprüfter Produktionsbuild |

## Aktuelle Protokolle

**Browser V2:** `0x02 | 12-Byte-GCM-IV | Chiffrat inkl. 128-Bit-GCM-Tag`; AAD ist `pictochat-signed-v2:` plus Raum-ID. In der verschlüsselten JSON-Nachricht liegen Sitzungspublickey, ECDSA-Signatur und Chat-/Zeichnungsdaten. Der Client prüft Fingerprint und Signatur vor Darstellung. Manueller separater 256-Bit-Gruppenschlüssel: **keine Forward Secrecy**.

**OpenMLS V3:** `0x03 | Nachrichtentyp | MLS-TLS-Serialisierung` mit Application, Commit, Welcome, KeyPackage. Der Rust-Relay routet nur Framing und kann weder MLS-Identitäten verifizieren noch Inhalte entschlüsseln. Ein isolierter nativer OpenMLS-Client und reale WebSocket-Tests belegen die Gruppen-Kryptografie, **noch keine Endnutzer-Browserintegration**.

## Produktionsfreigabe – harte Sperren

1. **MLS im Client:** eigenständige endpointseitige WASM-/native MLS-Komponente, keine Gruppenschlüssel im Server, saubere Authentisierung flüchtiger Mitgliedschaften und validierte Welcome/Commit/KeyPackage-Abläufe.
2. **Unterbrechungen:** Nach unbekannter Commit-Lücke darf der Client nicht automatisch weiter senden; sicherer erneuter Beitritt ohne dauerhaft gespeicherte Chatnachrichten.
3. **Lieferung & Integrität:** reproduzierbarer Frontend-Build, sichere Abhängigkeiten und TLS bei jedem Nicht-Loopback-Betrieb; keine ungeprüften Inline-Skripte.
4. **Datenschutz:** definierte Löschung von RAM-Referenzen, keine Chatdatenbanken/Telemetrie, ausdrücklich optionaler benutzerinitiierter PDF-Export.
5. **Qualität:** Performance-/Last- und Browser-/Touch-Tests, vollständige Tastatur- und Unicode-Abnahme, reproduzierbare Dependency-Locks und Sicherheitsprüfungen.
6. **Externe Prüfung:** unabhängiger Code- und Threat-Model-Review vor Freigabe; PR bleibt bis dahin Draft und `master` unangetastet.

Grüne CI-Läufe zeigen nur, dass die getesteten Szenarien funktionieren. Sie sind **kein Nachweis allgemeiner E2EE-Sicherheit**.

# Clevermation Intelligence — Masterplan

> Deutsche Firmendaten-Plattform à la Palantir: Alle Unternehmen, ihre Vernetzung, ihre Historie — aus öffentlichen Quellen, sauber strukturiert, AI-ready.

**Status:** Brainstorming / PoC-Planung
**Ziel:** Proof of Concept, dass wir aus kostenlosen öffentlichen Quellen eine saubere, vernetzte Firmendatenbank aufbauen können. Spätere Integration in CleverSales.
**Erster Nutzer:** Clevermation intern (Karlson, Theo, Paul via Claude Code + simples Web-UI)
**Infrastruktur:** Dokploy Mac Mini (Docker, PostgreSQL + Apache AGE)
**Kosten MVP:** 0€/Monat

---

## 1. Vision

North Data hat gezeigt, dass deutsche Firmendaten extrem wertvoll sind — aber deren API kostet ab 500€/Monat, und man hat keinen Zugriff auf die Rohdaten.

Wir bauen uns die Datengrundlage selbst:
- **3,8M+ deutsche Unternehmen** als Basis
- **Vernetzungs-Graph**: Wer führt was, wer besitzt wen, wer sitzt wo zusammen
- **Event-Historie**: Was ist wann passiert — Gründungen, GF-Wechsel, Kapitaländerungen, Insolvenzen
- **Tägliche Updates**: Neue Gründungen, Statusänderungen, Insolvenz-Alerts

Daraus entstehen Sales-Signale die kein anderes Tool hat:
- Neugründungen nach Region/Branche = frische Prospects
- GF-Wechsel + Kapitalerhöhung = Expansions-Signal
- Beteiligungsketten = verstehe wer hinter einer Firma steht
- Netzwerk-Analyse = finde Entscheider die in mehreren relevanten Firmen sitzen

---

## 2. Architektur

### 2.1 Kern-Entscheidung: PostgreSQL + Apache AGE

Eine einzige Datenbank für alles — relationale Daten UND Graph-Queries:

```
┌─────────────────────────────────────────────────────┐
│              PostgreSQL + Apache AGE                  │
│                                                       │
│  ┌─────────────────┐  ┌───────────────────────────┐  │
│  │ Relationale      │  │ Graph (AGE/Cypher)         │  │
│  │ Tabellen         │  │                            │  │
│  │                  │  │ (Person)──gf_von──>(Firma) │  │
│  │ • entities       │  │ (Firma)──beteiligt──>(Firma)│  │
│  │ • events         │  │ (Person)──gesellschafter──>│  │
│  │ • entity_ids     │  │                            │  │
│  │ • sources        │  │ Cypher-Queries:            │  │
│  │ • import_runs    │  │ MATCH (p)-[*1..5]->(f)     │  │
│  └────────┬─────────┘  └──────────┬────────────────┘  │
│           │      SQL + Cypher     │                    │
│           └──── kombinierbar ─────┘                    │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ Später: pgvector für Embeddings/AI               │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Warum AGE statt separate Graph-DB:**
- Es IST PostgreSQL — kein zweiter Server, kein Sync-Problem
- Docker-Image `apache/age` läuft auf ARM (Mac Mini) out-of-the-box
- SQL und Cypher in derselben Query kombinierbar (Graph-Traversal → JOIN auf Finanzdaten)
- Relationale Tabellen für Events/Details + Graph für Vernetzung = Best of Both Worlds
- Später pgvector für AI-Embeddings in derselben Instanz

### 2.2 Drei-Schichten-Datenmodell

```
┌─────────────────────────────────────────────────┐
│  Schicht 3: Graph (Apache AGE)                   │
│  "Wer ist mit wem verbunden?"                    │
│                                                   │
│  Nodes:  :Firma, :Person                         │
│  Edges:  :geschaeftsfuehrer_von                  │
│          :gesellschafter_von {anteil: %}          │
│          :vorstand_von                            │
│          :prokurist_von                           │
│          :beteiligung_an {anteil: %}              │
│          :liquidator_von                          │
│                                                   │
│  Queries: Multi-Hop-Traversals, Netzwerk-Analyse │
├─────────────────────────────────────────────────┤
│  Schicht 2: Events (relationale Tabellen)        │
│  "Was ist wann passiert?"                        │
│                                                   │
│  Event-Typen:                                     │
│  • firma_gegruendet        • gf_bestellt         │
│  • firma_umfirmiert        • gf_abberufen        │
│  • firma_geloescht         • kapital_geaendert   │
│  • firma_sitz_geaendert    • insolvenz_eroeffnet │
│  • gesellschafter_geaendert • insolvenz_aufgehoben│
│  • jahresabschluss_eingereicht                    │
│  • marke_registriert                              │
│                                                   │
│  Jedes Event hat: Timestamp, Payload, Raw-Text,  │
│  Quelle → Pattern-Erkennung für Sales-Signale    │
├─────────────────────────────────────────────────┤
│  Schicht 1: Entities (relationale Tabellen)      │
│  "Was existiert?"                                │
│                                                   │
│  entities: id, type, canonical_name, data (JSONB) │
│  entity_identifiers: register_nr, LEI, USt-ID    │
│  sources: provider, fetched_at, document_id       │
│  import_runs: Tracking aller Imports              │
└─────────────────────────────────────────────────┘
```

### 2.3 Warum Event-basiert (der Palantir-Trick)

Statt nur den aktuellen Zustand zu speichern, speichern wir **jede Veränderung als Event**:

```
2024-03-15 | firma:HRB-123456 | gf_bestellt     | person:max-mustermann
2025-01-10 | firma:HRB-123456 | gf_abberufen    | person:max-mustermann
2025-01-10 | firma:HRB-123456 | gf_bestellt     | person:lisa-mueller
2025-04-01 | firma:HRB-123456 | kapital_erhoeht | 25000 → 100000 EUR
```

**Vorteile:**
- Aktueller Zustand ist immer ableitbar (neueste Events)
- Muster erkennbar: "GF-Wechsel + Kapitalerhöhung = häufig Expansion"
- Kein Datenverlust — jede Veränderung ist ein Sales-Signal
- LLMs können später die Event-Historie als Context bekommen
- Zeitreisen: "Wie sah das Netzwerk vor 2 Jahren aus?"

---

## 3. Datenbank-Schema

### 3.1 Relationale Tabellen

```sql
-- Kern-Entitäten (Firmen, Personen)
CREATE TABLE entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('firma', 'person')),
    canonical_name  TEXT NOT NULL,
    
    -- Quellspezifische Daten als JSONB (flexibel pro Quelle)
    data            JSONB NOT NULL DEFAULT '{}',
    -- Firma: { rechtsform, gegenstand, stammkapital, waehrung, status,
    --          sitz, bundesland, plz, gruendungsdatum }
    -- Person: { vorname, nachname, geburtsdatum, geburtsort }
    
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Volltextsuche
    search_vector   tsvector GENERATED ALWAYS AS (
        to_tsvector('german', canonical_name || ' ' || coalesce(data->>'sitz', ''))
    ) STORED
);

CREATE INDEX idx_entities_type ON entities (entity_type);
CREATE INDEX idx_entities_name ON entities (canonical_name);
CREATE INDEX idx_entities_search ON entities USING GIN (search_vector);
CREATE INDEX idx_entities_data ON entities USING GIN (data);

-- Identifier-Mapping (eine Entity kann viele IDs aus verschiedenen Quellen haben)
CREATE TABLE entity_identifiers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    id_type         TEXT NOT NULL,
    -- 'register_nr', 'lei', 'ust_id', 'steuernummer', 'offeneregister_id'
    id_value        TEXT NOT NULL,
    qualifier       TEXT,
    -- Bei register_nr: Gerichtsname, z.B. "Amtsgericht Hamburg"
    source          TEXT NOT NULL,
    
    UNIQUE (id_type, id_value, qualifier)
);

CREATE INDEX idx_identifiers_lookup ON entity_identifiers (id_type, id_value);
CREATE INDEX idx_identifiers_entity ON entity_identifiers (entity_id);

-- Events (alles was passiert)
CREATE TABLE events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    -- 'firma_gegruendet', 'firma_umfirmiert', 'firma_geloescht',
    -- 'firma_sitz_geaendert', 'gf_bestellt', 'gf_abberufen',
    -- 'kapital_geaendert', 'gesellschafter_geaendert',
    -- 'insolvenz_eroeffnet', 'insolvenz_aufgehoben',
    -- 'jahresabschluss_eingereicht', 'marke_registriert'
    
    event_date      DATE,
    payload         JSONB NOT NULL DEFAULT '{}',
    -- gf_bestellt: { person_entity_id, funktion: "Geschäftsführer" }
    -- kapital_geaendert: { vorher: 25000, nachher: 100000, waehrung: "EUR" }
    -- insolvenz: { aktenzeichen, gericht, art: "Eröffnung" }
    
    raw_text        TEXT,
    -- Original-Bekanntmachungstext für LLM-Context
    
    source          TEXT NOT NULL,
    source_doc_id   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_entity ON events (entity_id);
CREATE INDEX idx_events_type ON events (event_type);
CREATE INDEX idx_events_date ON events (event_date DESC);
CREATE INDEX idx_events_type_date ON events (event_type, event_date DESC);

-- Quellen-Tracking (wann wurde was importiert)
CREATE TABLE import_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL,
    -- 'offeneregister', 'gleif', 'registerbekanntmachungen',
    -- 'insolvenzbekanntmachungen', 'handelsregister', 'bundesanzeiger'
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running',
    -- 'running', 'completed', 'failed'
    stats           JSONB DEFAULT '{}',
    -- { entities_created: 1234, entities_updated: 567, events_created: 890 }
    error           TEXT
);
```

### 3.2 Graph-Schema (Apache AGE)

```sql
-- Graph erstellen
SELECT create_graph('firmen_graph');

-- Node Labels (automatisch beim ersten CREATE)
-- :Firma  { entity_id, name, register_nr, rechtsform, sitz, status }
-- :Person { entity_id, name }

-- Edge Labels
-- :geschaeftsfuehrer_von  { seit, bis, funktion }
-- :gesellschafter_von     { anteil_prozent, seit, bis }
-- :vorstand_von           { seit, bis, funktion }
-- :prokurist_von          { seit, bis }
-- :beteiligung_an         { anteil_prozent, seit, bis }
-- :liquidator_von         { seit, bis }
```

**Sync-Strategie Entity ↔ Graph:**
- `entities`-Tabelle ist die Single Source of Truth
- Graph-Nodes spiegeln Entities mit `entity_id`-Property
- Graph-Edges werden aus Events abgeleitet (z.B. Event `gf_bestellt` → Edge `:geschaeftsfuehrer_von`)
- Bei jedem Import: erst Entity/Event in relationale Tabellen, dann Graph aktualisieren
- So kann man bei Bedarf den Graph komplett aus Events rebuilden

---

## 4. Datenquellen

### 4.1 Phase 1 — Bulk-Import (einmalig, Tag 1)

#### OffeneRegister.de
- **URL:** https://offeneregister.de
- **Format:** JSONL (~250 MB) oder SQLite (~740 MB)
- **Lizenz:** CC BY 4.0 (Nennung OpenCorporates)
- **Liefert:** ~3,8M Firmen mit Name, Sitz, Rechtsform, Register-Nr, vertretungsberechtigte Personen
- **Import-Logik:**
  1. JSONL herunterladen
  2. Pro Eintrag: Entity (Firma) anlegen, Identifier (Register-Nr) setzen
  3. Personen aus `officers`-Feld extrahieren → Person-Entities + Graph-Edges
  4. Deduplizierung: Gleiche Person (Name + Geburtsdatum) über mehrere Firmen = eine Entity
- **Entity-Resolution:** Register-Nr (`Gericht + Art + Nummer`) als Primärschlüssel
- **Erwartete Dauer:** ~30-60min für Full Import

#### GLEIF (Global LEI Foundation)
- **URL:** https://api.gleif.org/api/v1/ + Bulk-Download
- **Format:** REST-API (JSON) + tägliche Bulk-Files (XML/CSV)
- **Lizenz:** Open Data, keine Einschränkungen
- **Liefert:** ~70k+ deutsche Firmen mit LEI, Name, Rechtsform, Adresse, **Ownership-Beziehungen (Level 2)**
- **Import-Logik:**
  1. Bulk-Download (nur deutsche LEIs, Filter: `entity.legalAddress.country=DE`)
  2. Pro LEI: Bestehende Entity matchen über Register-Nr (GLEIF liefert `entity.registeredAs`)
  3. Wenn kein Match: Fuzzy-Match über Name + Sitz, oder neue Entity anlegen
  4. Level 2 Relationships: `directParent` + `ultimateParent` → Graph-Edges `:beteiligung_an`
- **Besonderheit:** GLEIF liefert internationale Eigentümerstrukturen — wer die deutsche Tochter einer US-Firma ist

### 4.2 Phase 2 — Tägliche Updates (Cronjobs)

#### Registerbekanntmachungen (handelsregister.de)
- **URL:** https://www.handelsregister.de → Registerbekanntmachungen
- **Methode:** Web-Scraping (gleiche Session-Mechanik wie unsere handelsregister-api)
- **Rate Limit:** 60 Requests/Stunde (Session-basiert)
- **Liefert:** Neueintragungen, Veränderungen, Löschungen — tagesaktuell
- **Enthält:** Bekanntmachungstext mit Firmenname, Gericht, Register-Nr, Art der Änderung, Freitext
- **Import-Logik:**
  1. Täglich alle Bekanntmachungen seit letztem Import abrufen
  2. Register-Nr extrahieren → Entity matchen
  3. Bekanntmachungstext parsen → Event-Typ ableiten
  4. Event speichern + ggf. Graph-Edges aktualisieren
- **Parsing-Challenge:** Bekanntmachungen sind Fließtext, brauchen Regex/Pattern-Matching:
  ```
  "Als Geschäftsführer bestellt: Max Mustermann, *01.03.1985, Hamburg"
  → Event: gf_bestellt, Person: Max Mustermann, Geburtsdatum: 1985-03-01
  
  "Als nicht mehr Geschäftsführer ausgeschieden: Lisa Mueller"
  → Event: gf_abberufen, Person: Lisa Mueller
  
  "Stammkapital: 100.000,00 EUR" (vorher: "Stammkapital: 25.000,00 EUR")
  → Event: kapital_geaendert, vorher: 25000, nachher: 100000
  ```
- **Frequenz:** 1x täglich (morgens, ca. 5:00)
- **Erwartetes Volumen:** ~500-2.000 Bekanntmachungen pro Tag

#### Insolvenzbekanntmachungen
- **URL:** https://neu.insolvenzbekanntmachungen.de
- **Methode:** Web-Scraping
- **Liefert:** Insolvenzeröffnungen, -aufhebungen, Restschuldbefreiungen — tagesaktuell
- **Enthält:** Schuldner (Name/Firma, Sitz), Aktenzeichen, Gericht, Art
- **Import-Logik:**
  1. Täglich neue Bekanntmachungen abrufen
  2. Firmen-Entity matchen (Name + Sitz, ggf. Fuzzy)
  3. Event `insolvenz_eroeffnet` / `insolvenz_aufgehoben` speichern
  4. Entity-Status auf `insolvenz` setzen
- **Besonderheit:** Löschung nach 6 Monaten (Personen) / 3 Jahren (Firmen) — daher selbst archivieren
- **Frequenz:** 1x täglich

#### GLEIF Delta-Updates
- **URL:** https://api.gleif.org/api/v1/ → Delta-Files (8h/24h/7d)
- **Methode:** REST-API Download
- **Liefert:** Geänderte LEIs seit letztem Download
- **Import-Logik:** Nur geänderte Einträge verarbeiten, Ownership-Graph aktualisieren
- **Frequenz:** 1x täglich

### 4.3 Phase 3 — On-Demand Enrichment (bei Bedarf)

#### Handelsregister SI (Strukturierter Registerinhalt)
- **Methode:** Unsere bestehende `handelsregister-api` + Browser-Scraping für SI-Dokument
- **Liefert:** Maschinenlesbare Detaildaten: Gegenstand, Kapital, alle Vertretungsberechtigten
- **Trigger:** Wenn User/Claude eine Firma im Detail abfragt
- **Rate Limit:** 60 Req/h — daher kein Bulk, nur On-Demand
- **Caching:** Einmal geholt → in `entities.data` gespeichert

#### BZSt USt-ID-Prüfung
- **URL:** https://evatr.bff-online.de
- **Methode:** XML-RPC-API (kostenlos, keine Registrierung)
- **Liefert:** Bestätigung ob USt-ID gültig + optional Name/Adresse
- **Trigger:** Bei Prospecting-Listen-Export — validiert ob Firma noch aktiv
- **Besonderheit:** Nur Einzelabfragen, kein Bulk

#### Bundesanzeiger (spätere Phase)
- **URL:** https://www.bundesanzeiger.de
- **Methode:** Web-Scraping (rechtlich grenzwertig, AGB-Verstoß möglich)
- **Liefert:** Jahresabschlüsse (Bilanz, GuV), HGB-Offenlegungen
- **Relevanz:** Umsatz-/Gewinnschätzungen, Firmengröße
- **Status:** Für MVP nicht eingeplant — rechtliche Situation klären

#### DPMA Markenregister (spätere Phase)
- **URL:** https://register.dpma.de
- **Methode:** Web-Recherche
- **Liefert:** Marken, Inhaber, Nizza-Klassen
- **Relevanz:** Welche Firmen halten Marken — Innovationsindikator

#### Lobbyregister Bundestag (spätere Phase)
- **URL:** https://www.lobbyregister.bundestag.de
- **Liefert:** Organisationen mit politischer Aktivität, Finanzaufwand
- **Relevanz:** Nische — welche Firmen sind politisch vernetzt

#### Transparenzregister (spätere Phase)
- **URL:** https://www.transparenzregister.de
- **Liefert:** Wirtschaftlich Berechtigte (>25% Anteile)
- **Relevanz:** Ownership-Daten, ergänzt GLEIF
- **Einschränkung:** Registrierung nötig, Einzelabfragen

---

## 5. Entity Resolution

Das schwierigste technische Problem: Dieselbe Firma/Person heißt in jeder Quelle anders.

### 5.1 Strategie: Register-Nummer als Anker

```
Eindeutigkeitsschlüssel Firma:
  (Registergericht + Registerart + Registernummer)
  z.B. "Amtsgericht Berlin (Charlottenburg) | HRB | 44343"
  
Eindeutigkeitsschlüssel Person:
  (Nachname + Vorname + Geburtsdatum)  — wenn vorhanden
  (Nachname + Vorname + Wohnort)       — Fallback
```

### 5.2 Matching-Kaskade beim Import

```
Neue Daten kommen rein (z.B. aus GLEIF):
  1. Exakter Match über Register-Nr? → Merge
  2. Exakter Match über LEI? → Merge  
  3. Exakter Match über USt-ID? → Merge
  4. Fuzzy Match: Name-Normalisierung + Sitz?
     "GASAG AG" ≈ "Gasag Aktiengesellschaft" (nach Normalisierung)
     → Confidence Score > 0.9? → Merge
     → 0.7-0.9? → Als "possible_match" markieren, manuell prüfen
     → < 0.7? → Neue Entity
  5. Keine Übereinstimmung → Neue Entity
```

### 5.3 Name-Normalisierung

```
Eingabe:         "Gasag Berliner Gaswerke Aktiengesellschaft"
Schritt 1:       Lowercase → "gasag berliner gaswerke aktiengesellschaft"
Schritt 2:       Rechtsform-Suffix entfernen → "gasag berliner gaswerke"
                 (AG, GmbH, UG, e.V., e.K., KG, OHG, ...)
Schritt 3:       Sonderzeichen/Umlaute normalisieren → "gasag berliner gaswerke"
Schritt 4:       Stoppwörter entfernen → "gasag berliner gaswerke"
Ergebnis:        "gasag berliner gaswerke" → Vergleich per Trigram-Similarity
```

PostgreSQL `pg_trgm`-Extension für Fuzzy-Matching:
```sql
SELECT similarity('gasag berliner gaswerke', 'gasag ag') → 0.35 (niedrig)
SELECT similarity('gasag ag', 'gasag aktiengesellschaft') → 0.52 (mittel, nach Normalisierung höher)
```

### 5.4 Konflikte

Wenn zwei Quellen unterschiedliche Daten für dieselbe Entity liefern:
- **Priorität:** Handelsregister > OffeneRegister > GLEIF > Bundesanzeiger
- Alle Werte behalten in `data` JSONB (pro Quelle ein Key)
- `canonical_name` = Wert aus höchstprioritärer Quelle
- Konflikte loggen für manuelle Prüfung

---

## 6. Interfaces

### 6.1 CLI (Claude-Code-optimiert)

Das CLI ist das primäre Interface — Theo, Karlson und Paul nutzen Claude Code. Claude soll das CLI wie ein Tool einsetzen können.

```bash
# === Suche ===
firmendb search "Clevermation"
firmendb search --rechtsform GmbH --ort Hamburg --gruendung-nach 2023
firmendb search --rechtsform GmbH --bundesland Hamburg --status aktiv --limit 50 --json

# === Firmenprofil ===
firmendb profil HRB-44343                    # Per Register-Nr
firmendb profil --name "GASAG AG"            # Per Name (Fuzzy)
firmendb profil --lei 529900ABC123           # Per LEI
# Ausgabe: Name, Register, Status, Sitz, Rechtsform, Kapital, GFs,
#          Gesellschafter, Beteiligungen, letzte Events, Quellen

# === Netzwerk / Vernetzung ===
firmendb netzwerk person:UUID               # Alle Firmen dieser Person
firmendb netzwerk firma:UUID --tiefe 2      # 2-Hop Vernetzung
firmendb netzwerk firma:UUID --typ beteiligung  # Nur Beteiligungskette
# Ausgabe: Textuelle Darstellung des Netzwerks
# Max Mustermann
#   ├── GF von: GASAG AG (Berlin, HRB 44343)
#   ├── GF von: GASAG Solution Plus GmbH (Berlin, HRB 108908)
#   └── 100% Gesellschafter: Mustermann Holding GmbH (Hamburg, HRB 99999)
#       └── 51% Beteiligung: GASAG AG

# === Events / Alerts ===
firmendb events --typ firma_gegruendet --nach 2026-05-01 --ort Hamburg
firmendb events --typ insolvenz_eroeffnet --nach 2026-05-20
firmendb events firma:UUID                   # Alle Events einer Firma
firmendb events --heute                      # Alles von heute

# === Statistiken ===
firmendb stats                               # DB-Übersicht
firmendb stats --neugruendungen 30d          # Gründungen letzte 30 Tage
firmendb stats --top-gf 20                   # Personen mit meisten GF-Positionen

# === Import / Pipeline ===
firmendb import offeneregister               # Bulk-Import
firmendb import gleif                        # GLEIF Bulk-Import
firmendb update registerbekanntmachungen     # Tägliches Update
firmendb update insolvenz                    # Insolvenz-Update
firmendb update gleif-delta                  # GLEIF Delta-Update
firmendb enrich firma:UUID                   # On-Demand Detail-Enrichment
```

### 6.2 Web-UI (minimal, Bun.serve)

Einfaches Frontend für nicht-technische Nutzung:

- **Suchseite**: Freitextsuche + Filter (Rechtsform, Ort, Status, Gründungsjahr)
- **Firmenprofil**: Alle Daten auf einer Seite, Event-Timeline
- **Netzwerk-Ansicht**: Interaktiver Graph (D3.js force-directed) mit Personen und Firmen
- **Dashboard**: Neueste Gründungen, Insolvenz-Alerts, DB-Statistiken, letzter Import

Kein Login, kein Auth — rein intern.

### 6.3 API (für CleverSales-Integration)

REST-API Endpunkte parallel zum CLI:
```
GET  /api/search?q=...&rechtsform=...&ort=...
GET  /api/entity/:id
GET  /api/entity/:id/network?depth=2
GET  /api/entity/:id/events
GET  /api/events?type=...&since=...
GET  /api/stats
```

JSON-Responses. Kein Auth im PoC — später API-Key oder JWT.

---

## 7. Tech-Stack

| Komponente | Technologie | Warum |
|---|---|---|
| Runtime | **Bun** | Schnell, TypeScript-nativ, unser Standard |
| Sprache | **TypeScript** (strict) | Typsicherheit, bessere DX |
| Datenbank | **PostgreSQL 18 + Apache AGE** | Graph + Relational in einem, ARM Docker |
| DB-Client | **Bun.sql** (built-in Postgres) | Kein extra Package nötig |
| HTML-Parsing | **cheerio** | Bereits im Projekt, bewährt |
| Web-Server | **Bun.serve()** | Built-in, HTML-Imports, kein Express/Vite |
| Graph-UI | **D3.js** (force-directed) | Standard für interaktive Netzwerk-Graphen |
| Deployment | **Docker Compose auf Dokploy** | PostgreSQL + App als Container |

---

## 8. Projektstruktur

```
clevermation-intelligence/
├── src/
│   ├── db/
│   │   ├── schema.sql              # PostgreSQL + AGE Schema
│   │   ├── connection.ts           # DB-Client (Bun.sql)
│   │   ├── graph.ts                # AGE/Cypher Helper-Funktionen
│   │   └── migrations/             # Inkrementelle Schema-Änderungen
│   ├── importers/
│   │   ├── offeneregister.ts       # Bulk-Import aus JSONL
│   │   ├── gleif.ts                # GLEIF API + Bulk
│   │   ├── bekanntmachungen.ts     # Registerbekanntmachungen-Scraper
│   │   ├── insolvenz.ts            # Insolvenz-Scraper
│   │   └── handelsregister.ts      # Bestehender HR-Scraper (On-Demand)
│   ├── resolver/
│   │   ├── entity-resolver.ts      # Entity Resolution / Dedup
│   │   └── name-normalizer.ts      # Firmen-/Personennamen normalisieren
│   ├── queries/
│   │   ├── search.ts               # Volltextsuche + Filter
│   │   ├── profile.ts              # Firmenprofil zusammenstellen
│   │   ├── network.ts              # Graph-Traversal (Cypher)
│   │   └── events.ts               # Event-Abfragen
│   ├── cli.ts                      # CLI-Interface
│   ├── server.ts                   # Bun.serve() Web-UI + REST-API
│   └── types.ts                    # Gemeinsame Types
├── web/
│   ├── index.html                  # Suche + Dashboard
│   ├── profil.html                 # Firmenprofil
│   ├── netzwerk.html               # Graph-Ansicht
│   └── frontend.ts                 # Client-JS
├── scripts/
│   ├── initial-import.sh           # Erst-Setup (Download + Import)
│   └── daily-update.sh             # Cronjob-Skript
├── docker-compose.yml              # PostgreSQL/AGE + App
├── docs/
│   └── MASTERPLAN.md               # Dieses Dokument
└── package.json
```

---

## 9. Import-Pipeline Detail

### 9.1 OffeneRegister-Import (Bulk, einmalig)

```
1. Download JSONL von offeneregister.de (~250 MB)
2. Streaming-Parse (Zeile für Zeile, kein RAM-Problem)
3. Pro Zeile:
   a. Firma-Entity erstellen:
      - canonical_name aus company.name
      - data: { rechtsform, status, sitz, register_art, register_nr, ... }
   b. entity_identifier anlegen:
      - register_nr: (gericht + art + nummer)
   c. Personen extrahieren (aus officers[]):
      - Name, Rolle (director/secretary/...), Start/End-Datum
      - Person-Entity erstellen (oder bestehende matchen per Name+Geb.)
      - Graph-Edge anlegen: Person --[rolle]--> Firma
   d. Event anlegen: firma_gegruendet (wenn Gründungsdatum vorhanden)
4. Batch-Insert (1000er Chunks für Performance)
5. Graph-Rebuild: Alle Relationen nochmal als AGE-Edges
6. Statistiken loggen in import_runs
```

**Erwartete Dauer:** 30-60min
**Storage:** ~2-3 GB (Entities + Identifiers + Personen + Graph)

### 9.2 Registerbekanntmachungen-Update (täglich)

```
1. Letzte Import-Run abfragen → Datum seit letztem Update
2. Bekanntmachungen-Suche auf handelsregister.de:
   - Zeitraum: seit letztem Update bis heute
   - Alle Registerarten, alle Gerichte
   - Max 60 Req/h → bei ~2000 Bekanntmachungen pro Tag braucht man
     mehrere Seiten à 100 Ergebnisse
3. Pro Bekanntmachung:
   a. Register-Nr extrahieren → Entity matchen
   b. Bekanntmachungstyp erkennen:
      - "Neueintragung" → firma_gegruendet
      - "Veränderung" → Fließtext parsen (GF, Kapital, Sitz, ...)
      - "Löschung" → firma_geloescht
   c. Event anlegen mit raw_text
   d. Graph-Edges aktualisieren (neuer GF → neue Edge)
4. Statistiken loggen
```

### 9.3 Fließtext-Parsing (Bekanntmachungen)

Die Bekanntmachungstexte folgen einem semi-strukturierten Format:

```
Muster-Regex-Bibliothek:

GF bestellt:
  /(?:als|zum)\s+geschäftsführer(?:in)?\s+bestellt:\s*(.+?)(?:,\s*\*(\d{2}\.\d{2}\.\d{4}))?/i

GF abberufen:
  /(?:nicht mehr|ausgeschieden)\s+(?:als\s+)?geschäftsführer/i

Kapitaländerung:
  /stammkapital:\s*([\d.,]+)\s*(EUR|€)/i

Sitzverlegung:
  /sitz(?:verlegung)?\s+(?:von\s+\w+\s+)?nach\s+(\w+)/i

Umfirmierung:
  /(?:neue firma|jetzt|nunmehr|geändert in):\s*(.+?)(?:\.|$)/i

Insolvenz:
  /insolvenzverfahren\s+(?:wird\s+)?eröffnet/i

Liquidation:
  /(?:die gesellschaft ist aufgelöst|liquidation)/i
```

**Für MVP:** Basis-Patterns, Rest als `event_type: 'aenderung_unbekannt'` mit `raw_text`. Parsing verbessern wir iterativ.

---

## 10. Ressourcen-Abschätzung (Mac Mini)

| Ressource | Bedarf | Mac Mini hat |
|---|---|---|
| Storage | ~5-10 GB (DB + Indices + Graph) | 256+ GB SSD |
| RAM (PostgreSQL) | ~2-4 GB (shared_buffers + work_mem) | 16-32 GB |
| RAM (AGE Graph) | ~1-2 GB (Graph im Memory-Cache) | s.o. |
| RAM (Bun App) | ~200 MB | s.o. |
| CPU (Import) | Kurze Peaks bei Bulk-Import | Apple Silicon M-Serie |
| CPU (Daily) | Minimal (Scraping + Insert) | s.o. |

**Fazit:** Mac Mini ist mehr als ausreichend.

---

## 11. Phasenplan

### Phase 1: Fundament (Woche 1-2)
- [ ] Docker Compose mit PostgreSQL + AGE aufsetzen
- [ ] Schema anlegen (Tabellen + Graph)
- [ ] DB-Client + Cypher-Helper in TypeScript
- [ ] Entity-Resolver Grundgerüst
- [ ] OffeneRegister Bulk-Import
- [ ] Basis-CLI: `search`, `profil`, `stats`

### Phase 2: Graph + Netzwerk (Woche 3)
- [ ] GLEIF-Import (Bulk + Ownership)
- [ ] Graph-Edges aus OffeneRegister-Personen aufbauen
- [ ] CLI: `netzwerk` mit Graph-Traversal
- [ ] Netzwerk-Visualisierung (D3.js)

### Phase 3: Live-Updates (Woche 4)
- [ ] Registerbekanntmachungen-Scraper
- [ ] Fließtext-Parser für Events
- [ ] Insolvenz-Scraper
- [ ] CLI: `events`, `update`-Commands
- [ ] Cronjob-Setup auf Dokploy

### Phase 4: UI + Polish (Woche 5)
- [ ] Web-UI: Suche, Profil, Dashboard
- [ ] REST-API Endpunkte
- [ ] GLEIF Delta-Updates
- [ ] On-Demand Enrichment (HR Detail-Scraping)

### Später (nach PoC-Validierung)
- [ ] Bundesanzeiger-Integration (Finanzdaten)
- [ ] DPMA Markenregister
- [ ] pgvector + Embeddings für Semantic Search
- [ ] AI-generierte Company Profiles
- [ ] Branchen-Klassifizierung aus Unternehmensgegenstand
- [ ] Integration in CleverSales
- [ ] USt-ID-Validierung für Prospecting-Listen

---

## 12. Risiken & Mitigations

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| OffeneRegister-Daten veraltet/lückenhaft | Hoch | Mittel | Tägliche Updates via Registerbekanntmachungen füllen Lücken |
| Handelsregister ändert Webseite | Mittel | Hoch | Browser-basierter Scraper (agent-browser) als Fallback |
| Rate Limit zu restriktiv für tägliche Updates | Mittel | Mittel | Priorisierung: Nur neue Bekanntmachungen, nicht Full-Crawl |
| Entity Resolution Fehler (falsche Merges) | Hoch | Mittel | Konservativ matchen (nur bei hoher Confidence), manueller Review |
| AGE-Extension Bugs/Inkompatibilität | Niedrig | Hoch | Fallback: Recursive CTEs für Graph-Queries |
| Rechtliche Bedenken Scraping | Mittel | Hoch | Nur öffentliche Daten, Rate Limits respektieren, kein Bundesanzeiger im MVP |
| Mac Mini RAM zu knapp | Niedrig | Mittel | PostgreSQL-Tuning (shared_buffers begrenzen), ggf. auf Hetzner migrieren |

---

## 13. Erfolgskriterien PoC

Der PoC ist erfolgreich wenn:

1. **Datenbasis steht**: 3,8M+ Firmen durchsuchbar mit < 100ms Response-Time
2. **Vernetzung funktioniert**: 2-Hop-Netzwerk-Query liefert korrekte Ergebnisse in < 500ms
3. **Events fließen**: Tägliche Registerbekanntmachungen werden automatisch importiert
4. **Entity Resolution stimmt**: < 5% falsche Merges bei Stichproben
5. **Nutzbar für Sales**: Karlson/Theo können über Claude Code sinnvolle Prospect-Listen generieren
6. **Kosten = 0€**: Läuft komplett auf bestehender Infrastruktur

---

## Anhang A: Beispiel-Queries für Sales-Use-Cases

```sql
-- "Alle GmbHs in Hamburg, gegründet nach 2023, noch aktiv"
SELECT e.canonical_name, e.data->>'sitz' as sitz, 
       e.data->>'stammkapital' as kapital,
       e.data->>'gruendungsdatum' as gruendung
FROM entities e
WHERE e.entity_type = 'firma'
  AND e.data->>'rechtsform' = 'GmbH'
  AND e.data->>'sitz' ILIKE '%Hamburg%'
  AND e.data->>'status' = 'aktiv'
  AND (e.data->>'gruendungsdatum')::date > '2023-01-01'
ORDER BY e.data->>'gruendungsdatum' DESC;
```

```sql
-- "Neue Gründungen diese Woche in NRW"
SELECT e.canonical_name, ev.event_date, ev.raw_text
FROM events ev
JOIN entities e ON e.id = ev.entity_id
WHERE ev.event_type = 'firma_gegruendet'
  AND ev.event_date >= current_date - interval '7 days'
  AND e.data->>'bundesland' = 'Nordrhein-Westfalen'
ORDER BY ev.event_date DESC;
```

```cypher
-- "Netzwerk: Alle Firmen die über max. 2 Hops mit GASAG AG verbunden sind"
-- (AGE/Cypher)
MATCH path = (start:Firma {name: 'GASAG AG'})-[*1..2]-(connected)
RETURN DISTINCT connected.name, connected.sitz, length(path) as hops
ORDER BY hops, connected.name
```

```sql
-- "Top 20 Personen mit den meisten GF-Positionen" (SQL + Cypher hybrid)
SELECT person_name, firma_count FROM (
  SELECT * FROM cypher('firmen_graph', $$
    MATCH (p:Person)-[:geschaeftsfuehrer_von]->(f:Firma)
    RETURN p.name as person_name, count(f) as firma_count
    ORDER BY firma_count DESC
    LIMIT 20
  $$) as (person_name agtype, firma_count agtype)
) sub;
```

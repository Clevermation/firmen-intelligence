# Clevermation Intelligence — MASTERPLAN V3: Die Enrichment-Pipeline

> Wie wir aus 5,3M Firmennamen eine vollständige Sales-Intelligence-DB machen.
> Drei Datenebenen: Relational → Graph → Semantic (Embeddings)

---

## 1. Übersicht: Drei Datenebenen

```
┌─────────────────────────────────────────────────────────────────┐
│                    SUCHE / ICP-MATCHING                          │
│                                                                   │
│  "Finde Firmen die auf LinkedIn aktiv sind                        │
│   aber Verbesserungspotential haben"                              │
│                                                                   │
│         ┌──── pgvector Semantic Search ────┐                      │
│         │  BGE-M3 Embeddings (1024 dim)    │                      │
│         │  Vorfilter: Top 500 Kandidaten   │                      │
│         └──────────┬───────────────────────┘                      │
│                    │                                              │
│         ┌──────────▼───────────────────────┐                      │
│         │  Claude Re-Ranker (Haiku/Opus)   │                      │
│         │  Nuanciertes Scoring + Begründung│                      │
│         │  "Hat LinkedIn, postet selten,    │                      │
│         │   kein Thought-Leadership → 87/100│                      │
│         └──────────┬───────────────────────┘                      │
│                    │                                              │
│         ┌──────────▼───────────────────────┐                      │
│         │  Entscheider + Kontaktdaten      │                      │
│         │  Graph: Firma → GF → Telefon     │                      │
│         └──────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Was wir JETZT haben (Rohdaten)

```
entities (5,3M Firmen, 17k Personen)
├── canonical_name: "GASAG AG"
├── data (JSONB):
│   ├── rechtsform: "AG"
│   ├── sitz: "Berlin"
│   ├── bundesland: "Berlin"
│   ├── status: "aktiv"
│   ├── registerArt: "HRB"
│   ├── registerNummer: "44343"
│   ├── gericht: "Berlin (Charlottenburg)"
│   ├── adresse: "Henriette-Herz-Platz 4, 10178 Berlin"
│   └── or_company_number: "F1103R_HRB44343"
└── (Personen haben: name, wohnort, vorname, nachname)
```

**Problem:** Nur Stammdaten. Kein Inhalt. Keine Semantik. Kein Kontext.

---

## 3. Die Enrichment-Pipeline (5 Stufen)

### Stufe 1: Kostenlose Quellen-Aggregation (kein LLM nötig)

**Was:** Daten aus allen 16 Importern in die relationale DB ziehen.
**Wie:** Die bestehenden Import-Endpoints triggern.
**Ergebnis:** Angereicherte JSONB-Daten pro Firma.

```
entities.data NACH Stufe 1:
{
  // Stammdaten (OffeneRegister) — HABEN WIR
  "rechtsform": "AG", "sitz": "Berlin", "status": "aktiv",

  // Bundesanzeiger → Finanzen
  "umsatz": 2100000000, "mitarbeiter": 2500, "bilanzsumme": 4800000000,
  "geschaeftsjahr": "2024",

  // Impressum-Scraper → Kontakt
  "website": "https://gasag.de",
  "kontakt_email": "info@gasag.de",
  "kontakt_telefon": "+49 30 7872-0",
  "impressum_gf": ["Stefan Müller", "Dr. Lisa Weber"],

  // BA Jobbörse → Wachstumssignale
  "offene_stellen": 7,
  "stellen_kategorien": ["IT", "Marketing", "Engineering"],

  // Kununu → Arbeitgeber-Reputation
  "kununu_rating": 3.8, "kununu_reviews": 127,

  // Wappalyzer → Tech-Stack
  "tech_stack": ["WordPress", "Google Analytics", "Salesforce", "SAP"],
  "tech_cms": "WordPress", "tech_crm": "Salesforce",

  // Trustpilot → Kunden-Reputation
  "trustpilot_rating": 3.2, "trustpilot_reviews": 89,

  // DPMA → Innovation
  "patent_count": 12, "marken_count": 3,

  // VIES → Validierung
  "ust_id_valid": true
}
```

**Dauer:** ~1-2 Tage für Top-500k Firmen (Rate-Limits der Quellen).
**Kosten:** 0€

### Stufe 2: Graph-Edges aufbauen (kein LLM nötig)

**Was:** Beziehungen zwischen Entities in Apache AGE erstellen.
**Wie:** Aus den Officers-Daten, GLEIF-Ownership, Impressum-GFs.
**Ergebnis:** Navigierbarer Vernetzungs-Graph.

```
Graph-Edges NACH Stufe 2:

Person ──geschaeftsfuehrer_von──→ Firma
  "Stefan Müller" ──gf──→ "GASAG AG" (seit 2021)
  "Stefan Müller" ──gf──→ "GASAG Beteiligungs-GmbH"

Person ──gesellschafter_von──→ Firma
  "Holding XY" ──51%──→ "GASAG AG"

Firma ──tochter_von──→ Firma
  "GASAG Solution Plus GmbH" ──tochter──→ "GASAG AG"

Person ──arbeitet_bei──→ Firma (aus Stellenangeboten/Team-Seiten)
Firma ──nutzt_technologie──→ Technologie (aus Wappalyzer)
Firma ──wettbewerber_von──→ Firma (aus Branche + Region)
```

**Dauer:** ~1 Tag (SQL-Queries + AGE-Inserts)
**Kosten:** 0€

### Stufe 3: LLM-Enrichment — Firmenprofil generieren (Claude Haiku)

**Was:** Aus allen Rohdaten ein semantisches Firmenprofil erstellen.
**Wie:** Claude Haiku 4.5 über Agent SDK mit Token-Rotation (2 Accounts).
**Ergebnis:** 200-500 Wörter strukturierter Profiltext pro Firma.

```
PROMPT an Claude Haiku:
───────────────────────
Du bist ein B2B-Sales-Analyst. Erstelle ein semantisches Firmenprofil
aus diesen Rohdaten. Fokus auf: Was macht die Firma? Wie digital sind
sie? Welche Pain Points könnten sie haben? Wie ist ihre Online-Präsenz?

ROHDATEN:
{entities.data als JSON}

AUSGABE-FORMAT:
1. Kerngeschäft und Positionierung (2-3 Sätze)
2. Digitalisierungsgrad und Tech-Stack (2-3 Sätze)
3. Online-Präsenz und Marketing-Reife (2-3 Sätze)
4. Wachstumssignale und aktuelle Entwicklungen (2-3 Sätze)
5. Potentielle Pain Points und Herausforderungen (2-3 Sätze)
6. Entscheider und Organisationsstruktur (1-2 Sätze)
───────────────────────

ERGEBNIS (gespeichert als entities.data.semantic_profile):

"GASAG AG ist ein traditionsreicher Berliner Energieversorger
(AG, ~2500 MA, ~2.1 Mrd EUR Umsatz) mit Fokus auf Gasversorgung,
Fernwärme und zunehmend erneuerbare Energien. Das Unternehmen
betreibt mehrere Tochtergesellschaften für Windenergie und
dezentrale Energielösungen.

Der Tech-Stack zeigt einen mittleren Digitalisierungsgrad:
SAP und Salesforce sind im Einsatz, die Website läuft auf
WordPress. Auffällig ist das Fehlen moderner Marketing-Automation-
Tools trotz vorhandenem Salesforce CRM.

Die LinkedIn-Präsenz ist ausbaufähig: 12k Follower aber nur
2 Posts pro Monat, überwiegend Employer Branding, kein
Thought Leadership. Kununu 3.8/5 ist solide aber nicht herausragend.

7 offene Stellen im IT- und Marketing-Bereich deuten auf
digitalen Ausbau hin. 2 neue Smart-Grid-Patente zeigen
Innovationsaktivität.

Potentielle Pain Points: Social-Media-Strategie und Content
deutlich unter Branchenniveau, Marketing-Automation nicht
ausgeschöpft, Fachkräftemangel IT.

GF: Stefan Müller (seit 2021, ex-Vattenfall),
CTO: Dr. Lisa Weber (seit 2023, Digital-Transformation)."
```

**Prioritäts-Reihenfolge für LLM-Enrichment:**
1. Firmen mit Mitarbeiterzahl > 50 (haben Budget für B2B-Services)
2. Firmen mit offenen Stellen (aktiv investierend)
3. Firmen mit Website aber schwacher Online-Präsenz (Pain Point erkennbar)
4. GmbHs und AGs (nicht e.V., nicht KG)

**Kapazitäts-Rechnung:**
- Claude Haiku: ~0.5-1s pro Firma (Input ~500 Tokens, Output ~300 Tokens)
- 2 Accounts × 80% Usage-Limit = ~3.000-5.000 Calls/Stunde geschätzt
- 500k Firmen ÷ 4.000/h = **125 Stunden ≈ 5 Tage**
- Token-Rotation: Wenn Account 1 bei 80% 5h-Window → Switch zu Account 2

**Kosten:** 0€ (Claude Max Abo, kein API-Billing)

### Stufe 4: Embedding-Generierung (BGE-M3 via TEI)

**Was:** Das semantic_profile jedes Firmenprofils als Vektor speichern.
**Wie:** BGE-M3 über TEI auf clever-server-01, Ergebnis in pgvector.
**Ergebnis:** 1024-dimensionaler Vektor pro Firma für Similarity Search.

```sql
-- pgvector Extension + Spalte
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Index für schnelle Similarity Search
CREATE INDEX IF NOT EXISTS idx_entities_embedding
  ON entities USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 1000);

-- Suche: "Firmen mit LinkedIn-Verbesserungspotential"
SELECT canonical_name, data->>'sitz',
       1 - (embedding <=> query_embedding) as similarity
FROM entities
WHERE entity_type = 'firma'
  AND embedding IS NOT NULL
ORDER BY embedding <=> query_embedding
LIMIT 50;
```

**Kapazitäts-Rechnung (BGE-M3 auf Ryzen 9, ~300 Wörter Input):**
- ~170ms pro Embedding im Batch
- 500k Firmen × 170ms = **24 Stunden ≈ 1 Tag**
- Speicher: 500k × 1024 dim × 4 byte = **~2 GB** in pgvector

**Kosten:** 0€ (self-hosted)

### Stufe 5: Claude Re-Ranker + Outreach (Claude Opus, on-demand)

**Was:** Für eine konkrete Suchanfrage die Top-50 Treffer intelligent bewerten.
**Wie:** Claude Opus (bestes Reasoning) über Agent SDK.
**Ergebnis:** ICP-Score (0-100) + Begründung + Outreach-Entwurf.

```
PROMPT an Claude Opus:
───────────────────────
Bewerte diese Firma als potentiellen Kunden.

UNSER ICP (Ideal Customer Profile):
- Mittelstand (50-500 MA)
- Braucht Hilfe bei LinkedIn/Social Media
- Hat Budget (Umsatz > 5M)
- Hat Entscheider identifiziert

FIRMENPROFIL:
{semantic_profile}

AUFGABEN:
1. ICP-Score (0-100) mit Begründung
2. Identifizierte Pain Points
3. Bester Ansprechpartner + Kontaktweg
4. Personalisierter Outreach-Entwurf (3 Sätze)
───────────────────────
```

**Wird NUR on-demand ausgeführt** — wenn ein User sucht, nicht als Bulk.
**Kosten:** 0€ (Claude Max Abo)

---

## 4. Vorsortierung: Welche Firmen zuerst?

Nicht alle 5,3M Firmen sind relevant für B2B Sales. Priorisierung:

### Tier 1: Sofort enrichen (~50k Firmen)
```sql
SELECT id, canonical_name FROM entities
WHERE entity_type = 'firma'
  AND data->>'status' = 'aktiv'
  AND data->>'rechtsform' IN ('GMBH', 'AG', 'UG (HAFTUNGSBESCHRÄNKT)')
  AND (data->>'mitarbeiter')::int > 50
ORDER BY (data->>'mitarbeiter')::int DESC;
```
Kriterien: Aktiv + GmbH/AG/UG + >50 Mitarbeiter

### Tier 2: Nächste Welle (~200k Firmen)
```sql
-- Firmen mit offenen Stellen (= aktiv investierend)
SELECT id FROM entities
WHERE data->>'offene_stellen' IS NOT NULL
  AND (data->>'offene_stellen')::int > 0;

-- Firmen mit Website (= minimal digital)
SELECT id FROM entities
WHERE data->>'website' IS NOT NULL;
```

### Tier 3: Rest (~5M Firmen)
Bulk-Embedding mit Basis-Daten, kein LLM-Enrichment.
Werden nur bei Semantic Search als Treffer angezeigt.

---

## 5. Token-Rotation für Claude Agent SDK

```
┌─────────────────────────────────────┐
│         Token Rotator               │
│                                     │
│  Account 1 (Theo)    Account 2      │
│  ┌──────────────┐  ┌──────────────┐ │
│  │ 5h Session   │  │ 5h Session   │ │
│  │ Limit: 80%   │  │ Limit: 80%   │ │
│  │              │  │              │ │
│  │ 7d Weekly    │  │ 7d Weekly    │ │
│  │ Limit: 80%   │  │ Limit: 80%   │ │
│  └──────┬───────┘  └──────┬───────┘ │
│         │                  │        │
│         └──── Rotation ────┘        │
│                                     │
│  Logik:                             │
│  1. Check 5h-Usage Account 1       │
│  2. Wenn < 80% → nutze Account 1   │
│  3. Wenn >= 80% → Switch Account 2 │
│  4. Wenn beide >= 80% → PAUSE      │
│  5. Alle 5 Min: Usage-API checken  │
│                                     │
│  7d-Weekly:                         │
│  Same Logik, aber wenn ein Account  │
│  >= 80% 7d → Account gesperrt      │
│  bis nächste Woche                  │
└─────────────────────────────────────┘
```

---

## 6. Gesamt-Pipeline: Zeitplan

| Phase | Was | Dauer | Abhängig von |
|---|---|---|---|
| **Tag 1** | Stufe 1: Alle Importer für Tier-1 triggern (50k) | 4-6h | — |
| **Tag 1-2** | Stufe 2: Graph-Edges aufbauen (Officers, GLEIF) | 12-24h | Stufe 1 |
| **Tag 2-7** | Stufe 3: LLM-Enrichment Tier-1 (50k × Haiku) | 5 Tage | Stufe 1 |
| **Tag 3-4** | Stufe 4: Embeddings Tier-1 (50k × BGE-M3) | 2-3h | Stufe 3 |
| **Tag 7+** | Stufe 3+4: Tier-2 (200k × Haiku + BGE-M3) | 2-3 Wochen | Tier 1 fertig |
| **On-demand** | Stufe 5: Re-Ranking + Outreach (Opus) | 5-10s/Anfrage | — |

---

## 7. Infrastruktur

```
clever-server-01 (Ryzen 9, 60GB RAM, 1.7TB SSD)
├── Docker Compose (Dokploy)
│   ├── db: Apache AGE (PostgreSQL 18 + pgvector)
│   ├── app: Bun Server (API + UI)
│   ├── tei: TEI mit BGE-M3 (Embedding-Service)
│   └── ollama: Optional für Haiku-artige Tasks
│
├── Claude Agent SDK (2 Accounts, Token-Rotation)
│   ├── Haiku 4.5: Firmenprofil-Generierung (Bulk)
│   └── Opus: Re-Ranking + Outreach (on-demand)
│
└── Cronjobs
    ├── Täglich: Registerbekanntmachungen, Insolvenz, GLEIF-Delta
    ├── Wöchentlich: BA Jobs, Kununu, Trustpilot
    └── Monatlich: Bundesanzeiger, DPMA, Wappalyzer, Impressum
```

---

## 8. Ergebnis: Was der Sales-User sieht

```
User sucht: "Mittelständische Unternehmen in Hamburg die ihre
             LinkedIn-Präsenz verbessern müssen"

→ Schritt 1: BGE-M3 Semantic Search → 500 Kandidaten (< 1 Sekunde)
→ Schritt 2: SQL-Filter (aktiv, GmbH/AG, >20 MA) → 120 Firmen
→ Schritt 3: Claude Opus Re-Ranker → Top 20 mit ICP-Score

ERGEBNIS:
┌──────────────────────────────────────────────────────────┐
│ #1  TechVision GmbH                        Score: 94/100 │
│ Hamburg | 85 MA | IT-Beratung | 12M Umsatz               │
│                                                           │
│ Pain Point: LinkedIn 3.2k Follower aber nur 1x/Monat,    │
│ kein Content außer Stellenanzeigen. Sucht Marketing Mgr.  │
│                                                           │
│ Entscheider: Thomas Bergmann (GF)                         │
│ 📞 +49 40 123456-0  ✉️ t.bergmann@techvision.de           │
│ 🔗 linkedin.com/in/tbergmann                              │
│                                                           │
│ [Outreach generieren] [Profil öffnen] [Zum CRM]          │
└──────────────────────────────────────────────────────────┘
```

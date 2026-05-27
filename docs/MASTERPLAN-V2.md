# Clevermation Intelligence — Masterplan V2

> Von Firmen-Intelligence zu einer DE-Palantir Knowledge-Intelligence-Plattform.
> Ziel: ALLES über jedes deutsche Unternehmen und jede Person in deutschen Unternehmen wissen.

**Status:** PoC funktional (5,3M Firmen + Personen, Live auf intelligence.clevermationgroup.com)
**Vision:** Wissensaggregator für den deutschen Markt — alle öffentlichen Quellen vereint

---

## 1. Vision: DE Palantir

Palantir bringt alle Wissensquellen zusammen und macht sie navigierbar. Wir machen das Gleiche für den deutschen B2B-Markt:

- **Jede Firma** mit allen verfügbaren Daten: Finanzen, Mitarbeiter, Technologie, Bewertungen, Patente, Stellenangebote, Fördermittel, Ausschreibungen
- **Jede Person** mit allen Firmen-Verbindungen, Rollen, Historie
- **Vernetzung** visuell navigierbar: Wer gehört wem, wer führt was, wer arbeitet wo
- **Historie** als Timeline: Was hat sich wann geändert? Wachstums- und Warnsignale erkennen
- **Echtzeit-Updates** aus allen Quellen: Neue Gründungen, Insolvenzen, GF-Wechsel, Stellenangebote

---

## 2. Datenquellen-Katalog (nach Priorität)

### Priorität 1 — Sofort machbar, hoher Wert

| # | Quelle | Daten | Zugang | Was es bringt |
|---|--------|-------|--------|---------------|
| 1 | **Bundesanzeiger** | Jahresabschlüsse, Bilanzen, GuV, Mitarbeiterzahl | `bundesAPI/deutschland` Python-Paket, kostenlos | Finanzdaten für jede publizierungspflichtige Firma |
| 2 | **Impressum-Scraper** (eigen) | GF, Adresse, Telefon, E-Mail, USt-ID | Eigener Crawler, kostenlos | Aktuelle Kontaktdaten direkt von der Firmenwebseite |
| 3 | **BA Jobsuche-API** | Stellenangebote | bund.dev, offizielle API, kostenlos | Wachstumsindikator: Wer stellt ein? |
| 4 | **DPMA + EPO** | Patente, Marken, Designs | DPMAconnect (200€ einmalig) + EPO OPS (kostenlos) | Innovations-Score: Wer erfindet? |
| 5 | **TED API** | EU-weite öffentliche Ausschreibungen | Kostenlose EU REST-API | Wer gewinnt öffentliche Aufträge? |
| 6 | **VIES** | USt-ID-Validierung | Kostenlose EU SOAP-API | Aktiv-Check + Firmenname/Adresse-Bestätigung |
| 7 | **Google Places API** | Bewertungen, Rating, Öffnungszeiten, Fotos | Free Tier, offizielle API | Online-Reputation, Standort-Verifizierung |
| 8 | **Open Legal Data** | Gerichtsentscheidungen | de.openlegaldata.io, kostenlos, mit API | Rechtliche Risiken: War die Firma in Prozesse verwickelt? |
| 9 | **Förderkatalog** | Bewilligte Förderprojekte mit Empfängern | foerderportal.bund.de, Scraping | Wer bekommt Förderung? = Innovations-Indikator |
| 10 | **North Data Free Tier** | Aggregierte Finanzdaten, Verflechtungen | 5.000 Req/Monat kostenlos | Datenanreicherung für die wichtigsten Firmen |

### Priorität 2 — Mittelfristig

| # | Quelle | Daten | Zugang |
|---|--------|-------|--------|
| 11 | **Kununu** | Arbeitgeberbewertungen, 5M+ Reviews | Scraping (Apify-Scraper) |
| 12 | **Wappalyzer** (Self-Hosted) | Tech-Stack einer Firmen-Website | Open Source, kostenlos |
| 13 | **RDAP/WHOIS** | Domain-Registrar, Ablaufdatum | Kostenlos |
| 14 | **OpenCorporates** | 200M+ Firmen weltweit | API, kostenlos für Open Data |
| 15 | **Wikidata SPARQL** | Bekannte Firmen: CEO, Branche, ISIN | Kostenlos |
| 16 | **EU Transparenzregister** | Lobbyisten, Beratungsfirmen | Bulk-Download |
| 17 | **BA Beschäftigungsstatistik** | Beschäftigte nach Region/Branche | Offizielle REST-API |
| 18 | **Common Crawl** | Impressum-Extraktion im Bulk | Kostenlos, Petabytes |
| 19 | **OpenJur** | 600.000+ Urteile | Kostenlos |
| 20 | **Trustpilot** | Kundenbewertungen | API (Business-Account) |

### Priorität 3 — Nice-to-have

| # | Quelle | Daten |
|---|--------|-------|
| 21 | **Indeed/Stepstone** | Stellenangebote (ergänzend zu BA) |
| 22 | **ProvenExpert** | Dienstleister-Bewertungen |
| 23 | **BuiltWith** | Historischer Tech-Stack |
| 24 | **IHK-Firmendatenbanken** | Firmensteckbriefe |
| 25 | **Handwerkskammer-Verzeichnisse** | Handwerksbetriebe |

### Nicht realistisch / Rechtlich problematisch
- **LinkedIn-Scraping**: DSGVO + ToS-Verstoß, nur über offizielle API (teuer)
- **Grundbuch**: Nur mit berechtigtem Interesse
- **Schufa/Creditreform**: Nur kostenpflichtig B2B

---

## 3. Datenmodell-Erweiterung

### Neue Entity-Types

```
entities.entity_type erweitern:
  'firma' | 'person' | 'patent' | 'marke' | 'ausschreibung' | 'foerderprojekt' | 'stellenangebot'
```

### Neue Daten pro Firma (JSONB)

```jsonc
{
  // Bestehend (OffeneRegister)
  "rechtsform": "GmbH",
  "sitz": "Hamburg",
  "status": "aktiv",
  "registerArt": "HRB",
  "registerNummer": "123456",

  // NEU: Finanzen (Bundesanzeiger)
  "umsatz": 12500000,
  "gewinn": 850000,
  "bilanzsumme": 8200000,
  "mitarbeiter": 85,
  "geschaeftsjahr": "2024",

  // NEU: Kontakt (Impressum-Scraper)
  "website": "https://firma.de",
  "telefon": "+49 40 12345678",
  "email": "info@firma.de",
  "impressum_gf": "Max Mustermann",

  // NEU: Online-Reputation (Google Places)
  "google_rating": 4.3,
  "google_reviews": 127,
  "google_place_id": "ChIJ...",

  // NEU: Technologie (Wappalyzer)
  "tech_stack": ["WordPress", "Google Analytics", "Stripe"],

  // NEU: Arbeitgeber (Kununu)
  "kununu_rating": 3.8,
  "kununu_reviews": 45,

  // NEU: Patente/Marken
  "patent_count": 12,
  "marken_count": 3,

  // NEU: Stellenangebote
  "offene_stellen": 7,
  "stellen_zuletzt_geaendert": "2026-05-20"
}
```

### Neue Event-Typen

```
'stellenangebot_erstellt'     — BA Jobsuche
'ausschreibung_gewonnen'      — TED API
'patent_erteilt'              — DPMA/EPO
'marke_registriert'           — DPMA
'foerderung_bewilligt'        — Förderkatalog
'jahresabschluss_veroeffentlicht' — Bundesanzeiger
'impressum_geaendert'         — Impressum-Scraper
'bewertung_erhalten'          — Google/Kununu
'gerichtsurteil'              — Open Legal Data
```

### Neue Relation-Typen (Graph)

```
:arbeitet_bei          Person → Firma (aus Stellenangebote/LinkedIn)
:hat_patent            Firma → Patent
:hat_marke             Firma → Marke
:beworben_auf          Firma → Ausschreibung
:foerderung_erhalten   Firma → Förderprojekt
:rechtsstreit_mit      Firma → Firma (aus Gerichtsurteilen)
```

---

## 4. Architektur-Erweiterung

```
┌───────────────────────────────────────────────────────────┐
│                    Intelligence Platform                    │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Data Layer   │  │ Graph Layer  │  │ AI Layer (Later) │  │
│  │              │  │              │  │                   │  │
│  │ PostgreSQL   │  │ Apache AGE   │  │ Embeddings       │  │
│  │ 5,3M Firmen  │  │ Vernetzung   │  │ Semantic Search  │  │
│  │ + Personen   │  │ Beteiligung  │  │ LLM Summaries    │  │
│  │ + Events     │  │ Ownership    │  │ Anomalie-Detect. │  │
│  │ + Patente    │  │              │  │                   │  │
│  │ + Marken     │  │              │  │                   │  │
│  │ + Stellen    │  │              │  │                   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────────┘  │
│         │                 │                  │               │
│  ┌──────┴─────────────────┴──────────────────┴────────────┐  │
│  │              Importer Pipeline (Cronjobs)               │  │
│  │                                                         │  │
│  │  OffeneRegister │ GLEIF │ Bundesanzeiger │ BA Jobs      │  │
│  │  DPMA │ TED │ Google Places │ Impressum-Crawler         │  │
│  │  Registerbekanntmachungen │ Insolvenzbekanntmachungen   │  │
│  │  Open Legal Data │ Förderkatalog │ Kununu │ Wappalyzer  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              Frontend (intelligence.clevermationgroup)    │  │
│  │                                                         │  │
│  │  Suche (Firmen + Personen) │ Firmenprofil │ Personen-   │  │
│  │  Graph-Explorer │ Dashboard │ Quellen │ API-Keys        │  │
│  │  Timeline │ Vergleich │ Alerts │ Export                  │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

---

## 5. Implementierungs-Roadmap

### Phase A: Basis (DONE)
- [x] 5,3M Firmen aus OffeneRegister
- [x] Personen-Entities aus Officers
- [x] GLEIF Ownership
- [x] Handelsregister-Live-Scraper
- [x] CLI + REST-API + Web-UI + Auth
- [x] Deployed auf intelligence.clevermationgroup.com

### Phase B: Kern-Anreicherung (nächste Session)
- [ ] Bundesanzeiger-Integration (Finanzdaten, Mitarbeiterzahl)
- [ ] Impressum-Scraper (Kontaktdaten, GF-Validierung)
- [ ] BA Jobsuche-API (Stellenangebote als Wachstums-Signal)
- [ ] Graph-Edges aus Personen-Officers vollständig aufbauen
- [ ] Firmenprofil als Vollseite mit D3.js Graph

### Phase C: Intelligence-Layer
- [ ] TED API (Ausschreibungen)
- [ ] DPMA/EPO (Patente + Marken)
- [ ] Google Places (Bewertungen, Rating)
- [ ] Förderkatalog (bewilligte Förderungen)
- [ ] Open Legal Data (Gerichtsentscheidungen)
- [ ] Cronj obs für tägliche Updates aller Quellen

### Phase D: AI + Advanced
- [ ] pgvector für Embeddings / Semantic Search
- [ ] Company Profiles auto-generiert per LLM
- [ ] Anomalie-Erkennung (ungewöhnliche Muster)
- [ ] Branchen-Klassifizierung per AI
- [ ] Vergleichs-View (Firma A vs. Firma B)
- [ ] Export-Funktionen (CSV, API für CleverSales)
- [ ] Alert-System (Benachrichtigung bei Änderungen)

### Phase E: Scale
- [ ] Kununu, Trustpilot (Bewertungen)
- [ ] Wappalyzer (Tech-Stack)
- [ ] Common Crawl (Impressum-Bulk)
- [ ] Integration in CleverSales
- [ ] Multi-Tenancy für B2B-Kunden

---

## 6. Kosten-Übersicht

| Quelle | Kosten/Monat | Phase |
|--------|-------------|-------|
| OffeneRegister | 0€ | A (done) |
| GLEIF | 0€ | A (done) |
| Handelsregister | 0€ | A (done) |
| Registerbekanntmachungen | 0€ | A (done) |
| Insolvenzbekanntmachungen | 0€ | A (done) |
| Bundesanzeiger | 0€ | B |
| BA Jobsuche | 0€ | B |
| Impressum-Scraper | 0€ | B |
| TED API | 0€ | C |
| VIES | 0€ | C |
| DPMA | 200€ einmalig | C |
| EPO OPS | 0€ | C |
| Google Places | 0€ (Free Tier) | C |
| Open Legal Data | 0€ | C |
| Förderkatalog | 0€ | C |
| North Data | 0€ (Free Tier 5k Req/Mo) | C |
| **Hosting (Mac Mini)** | **0€** | **alle** |
| **GESAMT Phase A-C** | **~200€ einmalig** | |

---

## 7. Erfolgskriterien

Die Plattform ist "DE Palantir"-ready wenn:

1. **Datentiefe**: Jede Firma hat Finanzen + Kontakt + Bewertungen + Patente + Stellen
2. **Vernetzung**: 2+ Hop Graph-Navigation zwischen Firmen und Personen funktioniert
3. **Aktualität**: Tägliche Updates aus mindestens 5 Quellen
4. **Historie**: Jede Änderung als Event mit Timestamp nachvollziehbar
5. **Suche**: Firmen UND Personen mit Autocomplete in < 200ms
6. **Nutzen**: Karlson kann innerhalb 2 Minuten einen Prospect komplett durchleuchten

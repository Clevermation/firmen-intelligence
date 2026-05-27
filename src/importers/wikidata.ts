import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

// SPARQL-Endpoint von Wikidata
const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// Batch-Größe für SPARQL-Paginierung (Wikidata hat 60s Timeout)
const BATCH_SIZE = 5000;

// Rate-Limit: Pause zwischen Requests in ms
const RATE_LIMIT_MS = 1500;

// Rechtsform-Suffixe zum Entfernen beim Matching
const LEGAL_SUFFIXES = [
  "GMBH & CO. KG",
  "GMBH & CO. KGAA",
  "GMBH & CO KG",
  "GMBH & CO KGAA",
  "GMBH & CO. OHG",
  "GMBH",
  "AG & CO. KGAA",
  "AG & CO KGAA",
  "AG",
  "SE & CO. KGAA",
  "SE & CO KGAA",
  "SE",
  "KG",
  "KGAA",
  "OHG",
  "UG",
  "UG (HAFTUNGSBESCHRÄNKT)",
  "E.V.",
  "EV",
  "EG",
  "E.G.",
  "MBH",
  "PARTG",
  "PARTG MBB",
  "GBMH",
  "GENOSSENSCHAFT",
  "STIFTUNG",
  "HOLDING",
  "GRUPPE",
  "GROUP",
  "DEUTSCHLAND",
  "GERMANY",
];

interface WikidataResult {
  item: { type: string; value: string };
  itemLabel: { type: string; value: string };
  website?: { type: string; value: string };
  employees?: { type: string; value: string };
  revenue?: { type: string; value: string };
  hqLabel?: { type: string; value: string };
}

interface SparqlResponse {
  results: {
    bindings: WikidataResult[];
  };
}

/**
 * Baut die SPARQL-Query für deutsche Unternehmen mit optionalen Properties.
 * Verwendet LIMIT/OFFSET für Paginierung wegen Wikidata-Timeout.
 */
function buildSparqlQuery(limit: number, offset: number): string {
  return `
SELECT ?item ?itemLabel ?website ?employees ?revenue ?hqLabel WHERE {
  ?item wdt:P17 wd:Q183 .
  ?item wdt:P31/wdt:P279* wd:Q4830453 .
  OPTIONAL { ?item wdt:P856 ?website }
  OPTIONAL { ?item wdt:P1128 ?employees }
  OPTIONAL { ?item wdt:P2139 ?revenue }
  OPTIONAL { ?item wdt:P159 ?hq . ?hq rdfs:label ?hqLabel . FILTER(LANG(?hqLabel) = "de") }
  FILTER(BOUND(?website) || BOUND(?employees) || BOUND(?revenue))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en" }
}
LIMIT ${limit} OFFSET ${offset}
  `.trim();
}

/**
 * Führt eine SPARQL-Query gegen den Wikidata-Endpoint aus.
 * Gibt die Bindings als Array zurück.
 */
async function executeSparqlQuery(query: string): Promise<WikidataResult[]> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "FirmenIntelligence/1.0 (https://clevermation.com; theo@clevermation.com)",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SPARQL-Fehler ${response.status}: ${text.substring(0, 500)}`);
  }

  const json = (await response.json()) as SparqlResponse;
  return json.results.bindings;
}

/**
 * Extrahiert die Q-Nummer (Wikidata-ID) aus einer Entity-URI.
 * z.B. "http://www.wikidata.org/entity/Q42" → "Q42"
 */
function extractQId(uri: string): string {
  const match = uri.match(/Q\d+$/);
  return match ? match[0] : uri;
}

/**
 * Normalisiert einen Firmennamen fürs Matching:
 * - Uppercase
 * - Rechtsform-Suffixe entfernen
 * - Überflüssige Leerzeichen/Satzzeichen bereinigen
 */
function normalizeName(name: string): string {
  let normalized = name.toUpperCase().trim();

  // Rechtsform-Suffixe entfernen (längste zuerst, damit "GMBH & CO. KG" vor "GMBH" greift)
  for (const suffix of LEGAL_SUFFIXES) {
    // Am Ende des Namens, optional mit Komma/Punkt davor
    const regex = new RegExp(`[,.]?\\s*${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    if (regex.test(normalized)) {
      normalized = normalized.replace(regex, "").trim();
      break; // Nur das erste passende Suffix entfernen
    }
  }

  // Doppelte Leerzeichen bereinigen
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Dedupliziert Wikidata-Ergebnisse nach Q-ID.
 * Bei mehreren Zeilen pro Item wird die mit den meisten Daten behalten.
 */
function deduplicateResults(results: WikidataResult[]): WikidataResult[] {
  const byQId = new Map<string, WikidataResult>();

  for (const result of results) {
    const qId = extractQId(result.item.value);
    const existing = byQId.get(qId);

    if (!existing) {
      byQId.set(qId, result);
      continue;
    }

    // Behalte den Eintrag mit mehr gebundenen Feldern
    const existingScore =
      (existing.website ? 1 : 0) + (existing.employees ? 1 : 0) + (existing.revenue ? 1 : 0) + (existing.hqLabel ? 1 : 0);
    const newScore =
      (result.website ? 1 : 0) + (result.employees ? 1 : 0) + (result.revenue ? 1 : 0) + (result.hqLabel ? 1 : 0);

    if (newScore > existingScore) {
      byQId.set(qId, result);
    }
  }

  return Array.from(byQId.values());
}

/**
 * Versucht, ein Wikidata-Ergebnis gegen die entities-Tabelle zu matchen.
 * Gibt die entity_id zurück, oder null wenn kein Match gefunden wurde.
 *
 * Matching-Strategie:
 * 1. Exakt: UPPER(canonical_name) = UPPER(name) UND sitz enthält hqLabel
 * 2. Fuzzy: canonical_name ILIKE '%name%' (nur wenn Name lang genug)
 */
async function matchEntity(
  db: ReturnType<typeof getDb>,
  name: string,
  sitz: string | null
): Promise<string | null> {
  const normalizedName = normalizeName(name);

  if (normalizedName.length < 3) return null; // Zu kurz für sinnvolles Matching

  const escapedName = escapeString(normalizedName);

  // Strategie 1: Exakter Name-Match + Sitz
  if (sitz && sitz.length > 1) {
    const escapedSitz = escapeString(sitz);
    const exactWithSitz = await db.unsafe(
      `SELECT id FROM entities
       WHERE entity_type = 'firma'
         AND UPPER(canonical_name) = '${escapedName}'
         AND data->>'sitz' ILIKE '%${escapedSitz}%'
       LIMIT 1`
    );
    if (exactWithSitz.length > 0) {
      return exactWithSitz[0].id as string;
    }
  }

  // Strategie 2: Exakter Name-Match ohne Sitz
  const exactNoSitz = await db.unsafe(
    `SELECT id FROM entities
     WHERE entity_type = 'firma'
       AND UPPER(canonical_name) = '${escapedName}'
     LIMIT 1`
  );
  if (exactNoSitz.length > 0) {
    return exactNoSitz[0].id as string;
  }

  // Strategie 3: Fuzzy-Match (nur wenn Name mindestens 5 Zeichen)
  if (normalizedName.length >= 5) {
    const fuzzy = await db.unsafe(
      `SELECT id FROM entities
       WHERE entity_type = 'firma'
         AND UPPER(canonical_name) ILIKE '%${escapedName}%'
       LIMIT 1`
    );
    if (fuzzy.length > 0) {
      return fuzzy[0].id as string;
    }
  }

  return null;
}

/**
 * Hauptfunktion: Importiert Wikidata-Daten für deutsche Unternehmen
 * und matcht sie gegen bestehende Firmen in der DB.
 */
export async function importWikidata() {
  const db = getDb();

  // Import-Run starten
  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('wikidata', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let matched = 0;
  let unmatched = 0;
  let websites = 0;
  let mitarbeiter = 0;
  let umsaetze = 0;
  let totalFetched = 0;

  console.log("[Wikidata] Starte Import deutscher Unternehmen via SPARQL...");

  try {
    // Phase 1: Alle Ergebnisse via SPARQL holen (paginiert)
    const allResults: WikidataResult[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      console.log(`[Wikidata] SPARQL-Abfrage: OFFSET ${offset}, LIMIT ${BATCH_SIZE}...`);

      const query = buildSparqlQuery(BATCH_SIZE, offset);
      const batch = await executeSparqlQuery(query);

      console.log(`[Wikidata] ${batch.length} Ergebnisse erhalten.`);
      allResults.push(...batch);
      totalFetched += batch.length;

      if (batch.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        offset += BATCH_SIZE;
        // Rate-Limit einhalten
        console.log(`[Wikidata] Warte ${RATE_LIMIT_MS}ms (Rate-Limit)...`);
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
      }
    }

    console.log(`[Wikidata] Insgesamt ${totalFetched} Zeilen geladen. Dedupliziere...`);

    // Phase 2: Deduplizieren nach Q-ID
    const unique = deduplicateResults(allResults);
    console.log(`[Wikidata] ${unique.length} eindeutige Unternehmen nach Deduplizierung.`);

    // Phase 3: Gegen DB matchen und anreichern
    console.log("[Wikidata] Starte Matching gegen entities-Tabelle...");

    for (let i = 0; i < unique.length; i++) {
      const result = unique[i];

      // Fortschritts-Logging alle 500 Einträge
      if (i > 0 && i % 500 === 0) {
        console.log(
          `[Wikidata] Fortschritt: ${i}/${unique.length} verarbeitet ` +
            `(${matched} Matches, ${unmatched} ohne Match)`
        );
      }

      const name = result.itemLabel.value;
      const sitz = result.hqLabel?.value ?? null;
      const qId = extractQId(result.item.value);

      // Überspringe Items deren Label eine Q-Nummer ist (kein echtes Label vorhanden)
      if (/^Q\d+$/.test(name)) {
        unmatched++;
        continue;
      }

      try {
        const entityId = await matchEntity(db, name, sitz);

        if (!entityId) {
          unmatched++;
          continue;
        }

        // Daten für das Update zusammenstellen
        const updateData: Record<string, unknown> = {
          wikidata_id: qId,
          wikidata_updated: new Date().toISOString(),
        };

        if (result.website?.value) {
          updateData.website = result.website.value;
          websites++;
        }

        if (result.employees?.value) {
          const employeeCount = parseInt(result.employees.value, 10);
          if (!isNaN(employeeCount) && employeeCount > 0) {
            updateData.mitarbeiter = employeeCount;
            mitarbeiter++;
          }
        }

        if (result.revenue?.value) {
          const revenueAmount = parseFloat(result.revenue.value);
          if (!isNaN(revenueAmount) && revenueAmount > 0) {
            updateData.umsatz = revenueAmount;
            umsaetze++;
          }
        }

        if (sitz) {
          updateData.wikidata_sitz = sitz;
        }

        await updateEntityData(entityId, updateData);
        matched++;
      } catch (e) {
        console.error(`[Wikidata] Fehler bei ${name} (${qId}):`, (e as Error).message);
      }
    }

    // Import-Run erfolgreich abschließen
    const stats = {
      total_fetched: totalFetched,
      unique_items: unique.length,
      matched,
      unmatched,
      websites,
      mitarbeiter,
      umsaetze,
    };

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify(stats)}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`\n[Wikidata] Import abgeschlossen!`);
    console.log(`  Gesamt abgerufen: ${totalFetched}`);
    console.log(`  Eindeutige Items: ${unique.length}`);
    console.log(`  Gematchte Firmen: ${matched}`);
    console.log(`  Ohne Match: ${unmatched}`);
    console.log(`  Websites angereichert: ${websites}`);
    console.log(`  Mitarbeiterzahlen angereichert: ${mitarbeiter}`);
    console.log(`  Umsätze angereichert: ${umsaetze}`);
  } catch (e) {
    // Import-Run als fehlgeschlagen markieren
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${escapeString((e as Error).message)}'
       WHERE id = '${runId}'`
    );
    console.error("[Wikidata] Import fehlgeschlagen:", (e as Error).message);
    throw e;
  }
}

// Direktaufruf wenn als Hauptmodul gestartet
if (import.meta.main) {
  await importWikidata();
  await closeDb();
}

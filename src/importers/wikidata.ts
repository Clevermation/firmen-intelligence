import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

// SPARQL-Endpoint von Wikidata
const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// Rate-Limit: Pause zwischen Requests in ms
const RATE_LIMIT_MS = 2000;

// Maximale Retries bei Timeout/Rate-Limit
const MAX_RETRIES = 3;

// Konkrete Firmen-Typ-QIDs (vermeidet teure P279*-Traversierung).
// Jeder Typ wird einzeln abgefragt — eine VALUES-Liste auf einmal läuft
// in den 60s-Timeout, pro Typ bleibt die Query klein und schnell.
const COMPANY_TYPES: Array<[string, string]> = [
  ["Q4830453", "Unternehmen"],
  ["Q6881511", "Enterprise"],
  ["Q783794", "Gesellschaft"],
  ["Q891723", "Börsennotiert"],
  ["Q18388277", "Technologie"],
  ["Q1589009", "Privatbesitz"],
  ["Q210167", "Software"],
  ["Q2085381", "Verlag"],
  ["Q786820", "Automobil"],
  ["Q507619", "Einzelhandel"],
  ["Q5621421", "Maschinenbau"],
  ["Q18043413", "Bauunternehmen"],
  ["Q4830453", "Unternehmen"],
];

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

// Innerer Aggregations-Block (gruppiert nur nach ?item) — verhindert
// kartesische Produkte. Das Label kommt im äußeren Block via Label-Service,
// da Blazegraph kein GROUP BY über Label-Service-Variablen erlaubt.
const AGG_INNER = `
    OPTIONAL { ?item wdt:P856 ?w }
    OPTIONAL { ?item wdt:P1128 ?e }
    OPTIONAL { ?item wdt:P2139 ?r }
    OPTIONAL { ?item wdt:P159 ?hqItem . ?hqItem rdfs:label ?hq . FILTER(LANG(?hq) = "de") }
  } GROUP BY ?item
}
SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". ?item rdfs:label ?itemLabel. }
}`.trim();

const AGG_SELECT = `SELECT ?item ?itemLabel ?website ?employees ?revenue ?hqLabel WHERE {
  { SELECT ?item (SAMPLE(?w) AS ?website) (MAX(?e) AS ?employees) (MAX(?r) AS ?revenue) (SAMPLE(?hq) AS ?hqLabel) WHERE {`;

/**
 * Query für seltene Properties (Mitarbeiter P1128, Umsatz P2139).
 * Verankert auf der seltenen Property → klein und schnell.
 */
function buildRarePropertyQuery(propertyId: string): string {
  return `${AGG_SELECT}
    ?item wdt:${propertyId} ?_anchor .
    ?item wdt:P17 wd:Q183 .
${AGG_INNER}`;
}

/**
 * Query für Webseiten (P856), verankert auf EINEM konkreten Firmen-Typ.
 */
function buildWebsiteQueryForType(typeQid: string): string {
  return `${AGG_SELECT}
    ?item wdt:P31 wd:${typeQid} .
    ?item wdt:P17 wd:Q183 .
    ?item wdt:P856 ?_site .
${AGG_INNER}`;
}

/**
 * Führt eine SPARQL-Query gegen den Wikidata-Endpoint aus.
 * Mit Retry + Backoff bei Timeout (504) oder Rate-Limit (429).
 */
async function executeSparqlQuery(query: string, label: string): Promise<WikidataResult[]> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": "FirmenIntelligence/1.0 (https://clevermation.com; theo@clevermation.com)",
        },
      });

      if (response.ok) {
        const json = (await response.json()) as SparqlResponse;
        return json.results.bindings;
      }

      // Bei Timeout/Rate-Limit: erneut versuchen mit Backoff
      if ((response.status === 504 || response.status === 429) && attempt < MAX_RETRIES) {
        const backoff = attempt * 5000;
        console.warn(`[Wikidata] ${label}: HTTP ${response.status}, Retry ${attempt}/${MAX_RETRIES} in ${backoff}ms...`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      const text = await response.text();
      throw new Error(`SPARQL-Fehler ${response.status}: ${text.substring(0, 300)}`);
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        const backoff = attempt * 5000;
        console.warn(`[Wikidata] ${label}: ${(e as Error).message}, Retry ${attempt}/${MAX_RETRIES}...`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }

  return [];
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
    // Phase 1: Drei separate, leichtgewichtige Queries ausführen.
    // Jede ist auf ihrer Property/Typ verankert → kein Timeout.
    const allResults: WikidataResult[] = [];

    // 1+2: Seltene Properties (Mitarbeiter, Umsatz) — verlässlich schnell
    const rareQueries: Array<{ label: string; query: string }> = [
      { label: "Mitarbeiter (P1128)", query: buildRarePropertyQuery("P1128") },
      { label: "Umsatz (P2139)", query: buildRarePropertyQuery("P2139") },
    ];

    for (const { label, query } of rareQueries) {
      console.log(`[Wikidata] SPARQL-Abfrage: ${label}...`);
      const batch = await executeSparqlQuery(query, label);
      console.log(`[Wikidata] ${label}: ${batch.length} Ergebnisse erhalten.`);
      allResults.push(...batch);
      totalFetched += batch.length;
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }

    // 3: Webseiten pro Firmen-Typ (fehlertolerant — ein Timeout killt nicht den Import)
    const seenTypes = new Set<string>();
    for (const [typeQid, typeName] of COMPANY_TYPES) {
      if (seenTypes.has(typeQid)) continue;
      seenTypes.add(typeQid);

      console.log(`[Wikidata] SPARQL-Abfrage: Webseiten/${typeName} (${typeQid})...`);
      try {
        const batch = await executeSparqlQuery(buildWebsiteQueryForType(typeQid), `Webseiten/${typeName}`);
        console.log(`[Wikidata] Webseiten/${typeName}: ${batch.length} Ergebnisse erhalten.`);
        allResults.push(...batch);
        totalFetched += batch.length;
      } catch (e) {
        console.warn(`[Wikidata] Webseiten/${typeName} übersprungen: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
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

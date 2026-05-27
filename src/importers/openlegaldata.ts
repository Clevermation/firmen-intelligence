/**
 * Open Legal Data Importer
 * Sucht Gerichtsurteile mit Bezug zu Firmen über die öffentliche API.
 *
 * API: https://de.openlegaldata.io/api/v1/cases/ (REST, kein Auth nötig)
 * Rate-Limiting: 1 Sekunde zwischen Requests.
 */
import { getDb, closeDb } from "../db/connection";
import { insertEvent, escapeString } from "../db/helpers";

const OLD_API = "https://de.openlegaldata.io/api/v1/cases/";

const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "FirmenIntelligence/1.0",
};

// Pause zwischen Requests
const REQUEST_DELAY_MS = 1000;

interface GerichtsUrteil {
  aktenzeichen: string;
  gericht: string;
  datum: string;
  typ: string;
  titel: string;
  url: string;
}

/**
 * Sucht Gerichtsurteile zu einer Firma über die Open Legal Data API
 */
async function sucheUrteile(firmenname: string): Promise<GerichtsUrteil[]> {
  const encodedName = encodeURIComponent(firmenname);
  const url = `${OLD_API}?search=${encodedName}&page_size=20&ordering=-date`;

  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      console.warn(`[OpenLegalData] HTTP ${response.status} für "${firmenname}"`);
      return [];
    }

    const json = (await response.json()) as {
      count?: number;
      results?: Array<{
        id?: number;
        file_number?: string;
        court?: { name?: string; slug?: string } | number;
        date?: string;
        type?: string;
        slug?: string;
        content?: string;
        ecli?: string;
        url?: string;
      }>;
    };

    if (!json.results?.length) return [];

    return json.results.map((r) => {
      const gerichtsName =
        typeof r.court === "object" ? r.court?.name ?? "Unbekannt" : `Gericht #${r.court}`;

      return {
        aktenzeichen: r.file_number ?? r.ecli ?? "",
        gericht: gerichtsName,
        datum: r.date ?? "",
        typ: r.type ?? "Urteil",
        titel: r.slug?.replace(/-/g, " ") ?? "Unbekannt",
        url: r.url ?? `https://de.openlegaldata.io/case/${r.id}`,
      };
    });
  } catch (e) {
    console.warn(`[OpenLegalData] Fehler bei Suche für "${firmenname}": ${(e as Error).message}`);
    return [];
  }
}

/**
 * Hauptfunktion: Importiert Gerichtsurteile für Firmen
 * @param entityIds - Optionale Liste spezifischer Entity-IDs
 */
export async function importOpenLegalData(entityIds?: string[]) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('openlegaldata', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let firmenVerarbeitet = 0;
  let urteileGefunden = 0;
  let eventsErstellt = 0;
  let fehler = 0;

  console.log("[OpenLegalData] Starte Import von Gerichtsurteilen...");

  try {
    // Firmen laden
    let firmen: { id: string; canonical_name: string }[];

    if (entityIds && entityIds.length > 0) {
      const idList = entityIds.map((id) => `'${escapeString(id)}'`).join(",");
      firmen = (await db.unsafe(
        `SELECT id, canonical_name FROM entities
         WHERE entity_type = 'firma' AND id IN (${idList})`
      )) as { id: string; canonical_name: string }[];
    } else {
      // Top-500 Firmen
      firmen = (await db.unsafe(
        `SELECT id, canonical_name FROM entities
         WHERE entity_type = 'firma'
           AND data->>'status' NOT IN ('aufgelöst', 'gelöscht')
         ORDER BY updated_at DESC
         LIMIT 500`
      )) as { id: string; canonical_name: string }[];
    }

    console.log(`[OpenLegalData] ${firmen.length} Firmen zum Durchsuchen geladen.`);

    for (const firma of firmen) {
      try {
        const urteile = await sucheUrteile(firma.canonical_name);
        firmenVerarbeitet++;

        for (const urteil of urteile) {
          urteileGefunden++;

          // Duplikat-Check über Aktenzeichen
          if (urteil.aktenzeichen) {
            const existing = await db.unsafe(
              `SELECT id FROM events
               WHERE entity_id = '${firma.id}'
                 AND event_type = 'gerichtsurteil'
                 AND payload->>'aktenzeichen' = '${escapeString(urteil.aktenzeichen)}'
               LIMIT 1`
            );
            if (existing.length > 0) continue;
          }

          // Event-Datum normalisieren
          let eventDate: string | null = null;
          if (urteil.datum && urteil.datum.match(/^\d{4}-\d{2}-\d{2}/)) {
            eventDate = urteil.datum.substring(0, 10);
          }

          await insertEvent(
            firma.id,
            "gerichtsurteil",
            eventDate,
            {
              aktenzeichen: urteil.aktenzeichen,
              gericht: urteil.gericht,
              typ: urteil.typ,
              titel: urteil.titel,
              url: urteil.url,
            },
            null,
            "openlegaldata"
          );
          eventsErstellt++;
        }

        // Fortschritt loggen
        if (firmenVerarbeitet % 50 === 0) {
          console.log(
            `[OpenLegalData] Fortschritt: ${firmenVerarbeitet}/${firmen.length} Firmen, ${urteileGefunden} Urteile, ${eventsErstellt} Events`
          );
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(
          `[OpenLegalData] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         firmen_verarbeitet: firmenVerarbeitet,
         urteile_gefunden: urteileGefunden,
         events_erstellt: eventsErstellt,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[OpenLegalData] Import abgeschlossen!`);
    console.log(`  Firmen verarbeitet: ${firmenVerarbeitet}`);
    console.log(`  Urteile gefunden: ${urteileGefunden}`);
    console.log(`  Events erstellt: ${eventsErstellt}`);
    console.log(`  Fehler: ${fehler}`);
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${(e as Error).message.replace(/'/g, "''")}' WHERE id = '${runId}'`
    );
    throw e;
  }
}

// Direkt ausführbar
if (import.meta.main) {
  const entityIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  await importOpenLegalData(entityIds.length > 0 ? entityIds : undefined);
  await closeDb();
}

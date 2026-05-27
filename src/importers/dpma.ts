/**
 * DPMA-Importer (Deutsches Patent- und Markenamt)
 * Sucht nach Patenten im DPMA-Register für Firmen aus der DB.
 *
 * Strategie: Scraping über die öffentliche Basis-Suche von DPMAregister.
 * Rate-Limiting: 2 Sekunden zwischen Requests.
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, insertEvent, escapeString } from "../db/helpers";

const BASE_URL = "https://register.dpma.de/DPMAregister/pat/basis";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

// Pause zwischen Requests (Rate-Limiting)
const REQUEST_DELAY_MS = 2000;

interface PatentEintrag {
  patentnummer: string;
  titel: string;
  anmeldedatum: string;
  status: string;
}

/**
 * Sucht Patente für eine Firma im DPMA-Register
 */
async function suchePatente(firmenname: string): Promise<PatentEintrag[]> {
  const encodedName = encodeURIComponent(firmenname);
  const url = `${BASE_URL}?AKZ=&PBD=&ABT=&BEZ=&ANM=${encodedName}&ERF=&VTR=&pageSize=25`;

  try {
    const response = await fetch(url, { headers: HEADERS, redirect: "follow" });
    if (!response.ok) {
      console.warn(`[DPMA] HTTP ${response.status} für "${firmenname}"`);
      return [];
    }

    const html = await response.text();
    return parsePatentErgebnisse(html);
  } catch (e) {
    console.warn(`[DPMA] Fehler bei Suche für "${firmenname}": ${(e as Error).message}`);
    return [];
  }
}

/**
 * Parst die Suchergebnisse des DPMA-Registers
 */
function parsePatentErgebnisse(html: string): PatentEintrag[] {
  const $ = cheerio.load(html);
  const ergebnisse: PatentEintrag[] = [];

  // Ergebnis-Tabelle durchgehen
  $("table.ergebnisTabelle tr, table.result tr, .result-row, table tbody tr").each((_, el) => {
    const zellen = $(el).find("td");
    if (zellen.length < 3) return;

    const text = $(el).text().trim();

    // Patentnummer-Muster: DE102023001234 o.ä.
    const nrMatch = text.match(/(?:DE|EP)\d{5,}/);
    if (!nrMatch) return;

    // Titel extrahieren (längste Zelle als Titel nehmen)
    let titel = "";
    let maxLen = 0;
    zellen.each((_, td) => {
      const t = $(td).text().trim();
      if (t.length > maxLen && !t.match(/^(?:DE|EP)\d/) && !t.match(/^\d{2}\.\d{2}\.\d{4}$/)) {
        maxLen = t.length;
        titel = t;
      }
    });

    // Datum suchen (DD.MM.YYYY)
    const datumMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
    const anmeldedatum = datumMatch
      ? datumMatch[1].split(".").reverse().join("-")
      : "";

    // Status suchen
    const statusMatch = text.match(
      /(?:erteilt|angemeldet|zurückgezogen|erloschen|zurückgewiesen|veröffentlicht)/i
    );

    ergebnisse.push({
      patentnummer: nrMatch[0],
      titel: titel || "Unbekannter Titel",
      anmeldedatum,
      status: statusMatch?.[0] ?? "unbekannt",
    });
  });

  return ergebnisse;
}

/**
 * Hauptfunktion: Importiert Patente für Firmen aus der DB
 * @param entityIds - Optionale Liste spezifischer Entity-IDs
 */
export async function importDPMA(entityIds?: string[]) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('dpma', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let firmenVerarbeitet = 0;
  let patenteGefunden = 0;
  let eventsErstellt = 0;
  let fehler = 0;

  console.log("[DPMA] Starte Patent-Import...");

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
      // Top-500 Firmen (aktive, nach letztem Update)
      firmen = (await db.unsafe(
        `SELECT id, canonical_name FROM entities
         WHERE entity_type = 'firma'
           AND data->>'status' NOT IN ('aufgelöst', 'gelöscht', 'insolvenz')
         ORDER BY updated_at DESC
         LIMIT 500`
      )) as { id: string; canonical_name: string }[];
    }

    console.log(`[DPMA] ${firmen.length} Firmen zum Durchsuchen geladen.`);

    for (const firma of firmen) {
      try {
        const patente = await suchePatente(firma.canonical_name);
        firmenVerarbeitet++;

        for (const patent of patente) {
          patenteGefunden++;

          // Duplikat-Check über Patentnummer
          const existing = await db.unsafe(
            `SELECT id FROM events
             WHERE entity_id = '${firma.id}'
               AND event_type = 'patent_erteilt'
               AND payload->>'patentnummer' = '${escapeString(patent.patentnummer)}'
             LIMIT 1`
          );

          if (existing.length > 0) continue;

          // Event erstellen
          await insertEvent(
            firma.id,
            "patent_erteilt",
            patent.anmeldedatum || null,
            {
              patentnummer: patent.patentnummer,
              titel: patent.titel,
              status: patent.status,
            },
            null,
            "dpma"
          );
          eventsErstellt++;
        }

        // patent_count auf Entity aktualisieren
        if (patente.length > 0) {
          const totalPatente = await db.unsafe(
            `SELECT count(*) as cnt FROM events
             WHERE entity_id = '${firma.id}' AND event_type = 'patent_erteilt'`
          );
          await updateEntityData(firma.id, {
            patent_count: parseInt(totalPatente[0].cnt as string, 10),
          });
        }

        // Fortschritt loggen
        if (firmenVerarbeitet % 50 === 0) {
          console.log(
            `[DPMA] Fortschritt: ${firmenVerarbeitet}/${firmen.length} Firmen, ${patenteGefunden} Patente, ${eventsErstellt} Events`
          );
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(`[DPMA] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`);
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         firmen_verarbeitet: firmenVerarbeitet,
         patente_gefunden: patenteGefunden,
         events_erstellt: eventsErstellt,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[DPMA] Import abgeschlossen!`);
    console.log(`  Firmen verarbeitet: ${firmenVerarbeitet}`);
    console.log(`  Patente gefunden: ${patenteGefunden}`);
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
  await importDPMA(entityIds.length > 0 ? entityIds : undefined);
  await closeDb();
}

/**
 * Förderkatalog-Importer
 * Scraped bewilligte Förderprojekte vom Förderkatalog des Bundes.
 *
 * URL: https://foerderportal.bund.de/foekat/
 * Strategie: Scraping der öffentlichen Suche.
 * Rate-Limiting: 2 Sekunden zwischen Requests.
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { insertEvent, escapeString } from "../db/helpers";

const FOEKAT_BASE = "https://foerderportal.bund.de/foekat";
const FOEKAT_SEARCH = `${FOEKAT_BASE}/jsp/SucheAction.do?actionMode=searchlist`;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

// Pause zwischen Requests
const REQUEST_DELAY_MS = 2000;

interface FoerderProjekt {
  projektname: string;
  zuwendungsempfaenger: string;
  foerdersumme: number | null;
  laufzeitVon: string;
  laufzeitBis: string;
  foerderkennzeichen: string;
}

/**
 * Sucht Förderprojekte für eine Firma im Förderkatalog
 */
async function sucheFoerderProjekte(firmenname: string): Promise<FoerderProjekt[]> {
  const encodedName = encodeURIComponent(firmenname);
  const url = `${FOEKAT_SEARCH}&zue=${encodedName}`;

  try {
    const response = await fetch(url, { headers: HEADERS, redirect: "follow" });
    if (!response.ok) {
      console.warn(`[Förderkatalog] HTTP ${response.status} für "${firmenname}"`);
      return [];
    }

    const html = await response.text();
    return parseFoerderErgebnisse(html);
  } catch (e) {
    console.warn(`[Förderkatalog] Fehler bei Suche für "${firmenname}": ${(e as Error).message}`);
    return [];
  }
}

/**
 * Parst die Suchergebnisse aus dem Förderkatalog-HTML
 */
function parseFoerderErgebnisse(html: string): FoerderProjekt[] {
  const $ = cheerio.load(html);
  const ergebnisse: FoerderProjekt[] = [];

  // Ergebnistabelle durchgehen
  $("table tr, .treffer, .result-row").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length < 20) return;

    // Förderkennzeichen-Muster (z.B. 01IS20042 oder 03SX123A)
    const fkzMatch = text.match(/(\d{2}[A-Z]{1,3}\d{4,}[A-Z]?)/);

    // Projektname: Zeile nach dem Förderkennzeichen oder erste lange Textpassage
    const zellen = $(el).find("td");
    let projektname = "";
    let zuwendungsempfaenger = "";
    let foerdersummeRaw = "";

    zellen.each((i, td) => {
      const t = $(td).text().trim();
      // Heuristik: Projektname ist typischerweise die längste Zelle
      if (t.length > projektname.length && !t.match(/^\d/) && !t.match(/^€/)) {
        zuwendungsempfaenger = projektname; // Vorherigen verschieben
        projektname = t;
      }
      // Betrag erkennen (mit € oder EUR)
      if (t.match(/[\d.,]+\s*(?:€|EUR)/i) || t.match(/^[\d.,]+$/)) {
        foerdersummeRaw = t;
      }
    });

    if (!projektname && !fkzMatch) return;

    // Fördersumme parsen
    let foerdersumme: number | null = null;
    if (foerdersummeRaw) {
      const cleaned = foerdersummeRaw.replace(/[€EUR\s]/gi, "").replace(/\./g, "").replace(",", ".");
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) foerdersumme = parsed;
    }

    // Laufzeit-Daten suchen (DD.MM.YYYY)
    const daten = text.match(/(\d{2}\.\d{2}\.\d{4})/g) ?? [];
    const laufzeitVon = daten[0] ? daten[0].split(".").reverse().join("-") : "";
    const laufzeitBis = daten[1] ? daten[1].split(".").reverse().join("-") : "";

    ergebnisse.push({
      projektname: projektname || "Unbekanntes Projekt",
      zuwendungsempfaenger: zuwendungsempfaenger || "",
      foerdersumme,
      laufzeitVon,
      laufzeitBis,
      foerderkennzeichen: fkzMatch?.[1] ?? "",
    });
  });

  return ergebnisse;
}

/**
 * Hauptfunktion: Importiert Förderprojekte für Firmen
 * @param entityIds - Optionale Liste spezifischer Entity-IDs
 */
export async function importFoerderkatalog(entityIds?: string[]) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('foerderkatalog', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let firmenVerarbeitet = 0;
  let projekteGefunden = 0;
  let eventsErstellt = 0;
  let fehler = 0;

  console.log("[Förderkatalog] Starte Import bewilligter Förderprojekte...");

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

    console.log(`[Förderkatalog] ${firmen.length} Firmen zum Durchsuchen geladen.`);

    for (const firma of firmen) {
      try {
        const projekte = await sucheFoerderProjekte(firma.canonical_name);
        firmenVerarbeitet++;

        for (const projekt of projekte) {
          projekteGefunden++;

          // Duplikat-Check über Förderkennzeichen
          if (projekt.foerderkennzeichen) {
            const existing = await db.unsafe(
              `SELECT id FROM events
               WHERE entity_id = '${firma.id}'
                 AND event_type = 'foerderung_bewilligt'
                 AND payload->>'foerderkennzeichen' = '${escapeString(projekt.foerderkennzeichen)}'
               LIMIT 1`
            );
            if (existing.length > 0) continue;
          }

          const payload: Record<string, unknown> = {
            projektname: projekt.projektname,
            foerderkennzeichen: projekt.foerderkennzeichen,
          };
          if (projekt.zuwendungsempfaenger) {
            payload.zuwendungsempfaenger = projekt.zuwendungsempfaenger;
          }
          if (projekt.foerdersumme !== null) {
            payload.foerdersumme = projekt.foerdersumme;
          }
          if (projekt.laufzeitBis) {
            payload.laufzeit_bis = projekt.laufzeitBis;
          }

          await insertEvent(
            firma.id,
            "foerderung_bewilligt",
            projekt.laufzeitVon || null,
            payload,
            null,
            "foerderkatalog"
          );
          eventsErstellt++;
        }

        // Fortschritt loggen
        if (firmenVerarbeitet % 50 === 0) {
          console.log(
            `[Förderkatalog] Fortschritt: ${firmenVerarbeitet}/${firmen.length} Firmen, ${projekteGefunden} Projekte, ${eventsErstellt} Events`
          );
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(
          `[Förderkatalog] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         firmen_verarbeitet: firmenVerarbeitet,
         projekte_gefunden: projekteGefunden,
         events_erstellt: eventsErstellt,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Förderkatalog] Import abgeschlossen!`);
    console.log(`  Firmen verarbeitet: ${firmenVerarbeitet}`);
    console.log(`  Projekte gefunden: ${projekteGefunden}`);
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
  await importFoerderkatalog(entityIds.length > 0 ? entityIds : undefined);
  await closeDb();
}

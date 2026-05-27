/**
 * Bundesanzeiger-Importer
 * Sucht nach Jahresabschlüssen deutscher Firmen auf bundesanzeiger.de
 * und extrahiert Finanzkennzahlen (Umsatz, Gewinn, Bilanzsumme, Mitarbeiterzahl).
 *
 * Strategie: Scraping über die öffentliche Suche von bundesanzeiger.de
 * (die offizielle API ist nur für registrierte Verlage zugänglich).
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, insertEvent, escapeString } from "../db/helpers";

const BASE_URL = "https://www.bundesanzeiger.de";
const SEARCH_URL = `${BASE_URL}/pub/de/suchergebnis`;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

// Pause zwischen Requests (Rate-Limiting)
const REQUEST_DELAY_MS = 2000;

interface Jahresabschluss {
  firmenname: string;
  geschaeftsjahr: string;
  umsatz: number | null;
  gewinn: number | null;
  bilanzsumme: number | null;
  mitarbeiterzahl: number | null;
  veroeffentlichungsDatum: string;
  rohtext: string;
}

/**
 * Sucht Jahresabschlüsse für eine Firma auf bundesanzeiger.de
 */
async function sucheJahresabschluesse(firmenname: string): Promise<Jahresabschluss[]> {
  const encodedName = encodeURIComponent(firmenname);
  const url = `${SEARCH_URL}?fulltext=${encodedName}&area=Jahresabschl%C3%BCsse&rows_per_page=10`;

  try {
    const response = await fetch(url, { headers: HEADERS, redirect: "follow" });
    if (!response.ok) {
      console.warn(`[Bundesanzeiger] HTTP ${response.status} für "${firmenname}"`);
      return [];
    }

    const html = await response.text();
    return parseJahresabschluesse(html, firmenname);
  } catch (e) {
    console.warn(`[Bundesanzeiger] Fehler bei Suche für "${firmenname}": ${(e as Error).message}`);
    return [];
  }
}

/**
 * Parst die Suchergebnisse und extrahiert Finanzkennzahlen
 */
function parseJahresabschluesse(html: string, firmenname: string): Jahresabschluss[] {
  const $ = cheerio.load(html);
  const ergebnisse: Jahresabschluss[] = [];

  // Suchergebnis-Einträge durchgehen
  $(".result_container .row, .publication_container, table.result_table tr, .content_block").each(
    (_, el) => {
      const text = $(el).text().trim();
      if (text.length < 30) return;

      // Nur Jahresabschlüsse filtern
      if (
        !text.match(
          /Jahresabschluss|Jahresfinanzbericht|Bilanz|Gewinn.*Verlust|GuV/i
        )
      )
        return;

      const abschluss = extrahiereKennzahlen(text, firmenname);
      if (abschluss) {
        ergebnisse.push(abschluss);
      }
    }
  );

  return ergebnisse;
}

/**
 * Extrahiert Finanzkennzahlen aus dem Rohtext eines Jahresabschlusses
 */
function extrahiereKennzahlen(text: string, firmenname: string): Jahresabschluss | null {
  // Geschäftsjahr erkennen (z.B. "Geschäftsjahr 2023" oder "01.01.2023 - 31.12.2023")
  const gjMatch =
    text.match(/Geschäftsjahr\s*(?:vom\s*)?(\d{4})/i) ??
    text.match(/(\d{2}\.\d{2}\.\d{4})\s*[-–]\s*(\d{2}\.\d{2}\.\d{4})/) ??
    text.match(/Jahresabschluss\s+(?:zum\s+\d{2}\.\d{2}\.)?(\d{4})/i);

  if (!gjMatch) return null;

  const geschaeftsjahr = gjMatch[2]
    ? gjMatch[2].slice(-4)
    : gjMatch[1].length === 4
    ? gjMatch[1]
    : gjMatch[1].slice(-4);

  // Umsatz
  const umsatzMatch = text.match(
    /(?:Umsatzerlöse|Umsatz|Gesamtleistung|Erlöse)[\s:]*([0-9.,]+)\s*(?:Tsd\.?\s*)?(?:EUR|€|TEUR|T€)/i
  );

  // Gewinn / Jahresüberschuss
  const gewinnMatch = text.match(
    /(?:Jahresüberschuss|Jahresfehlbetrag|Gewinn|Ergebnis\s+nach\s+Steuern|Bilanzgewinn)[\s:]*[-–]?\s*([0-9.,]+)\s*(?:Tsd\.?\s*)?(?:EUR|€|TEUR|T€)/i
  );

  // Bilanzsumme
  const bilanzMatch = text.match(
    /(?:Bilanzsumme|Summe\s+Aktiva|Gesamtvermögen)[\s:]*([0-9.,]+)\s*(?:Tsd\.?\s*)?(?:EUR|€|TEUR|T€)/i
  );

  // Mitarbeiterzahl
  const maMatch = text.match(
    /(?:Mitarbeiter|Beschäftigte|Arbeitnehmer|Angestellte)[\s:]*(?:ca\.?\s*)?(\d[\d.]*)/i
  );

  // Veröffentlichungsdatum
  const datumMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
  const veroeffentlichungsDatum = datumMatch
    ? datumMatch[1].split(".").reverse().join("-")
    : new Date().toISOString().split("T")[0];

  return {
    firmenname,
    geschaeftsjahr,
    umsatz: parseBetrag(umsatzMatch?.[1] ?? null, text.includes("TEUR") || text.includes("T€")),
    gewinn: parseBetrag(gewinnMatch?.[1] ?? null, text.includes("TEUR") || text.includes("T€")),
    bilanzsumme: parseBetrag(bilanzMatch?.[1] ?? null, text.includes("TEUR") || text.includes("T€")),
    mitarbeiterzahl: maMatch ? parseInt(maMatch[1].replace(/\./g, ""), 10) : null,
    veroeffentlichungsDatum,
    rohtext: text.substring(0, 3000),
  };
}

/**
 * Parst einen Geldbetrag aus deutschem Format (1.234.567,89) in Cent-freien Euro-Wert
 */
function parseBetrag(raw: string | null, isTausend: boolean): number | null {
  if (!raw) return null;
  // Punkte als Tausendertrenner entfernen, Komma zu Punkt
  const cleaned = raw.replace(/\./g, "").replace(",", ".");
  let value = parseFloat(cleaned);
  if (isNaN(value)) return null;
  if (isTausend) value *= 1000;
  return value;
}

/**
 * Hauptfunktion: Importiert Jahresabschlüsse für Firmen
 * @param entityIds - Optionale Liste spezifischer Entity-IDs. Wenn leer, werden Top-1000 Firmen genutzt.
 */
export async function importBundesanzeiger(entityIds?: string[]) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('bundesanzeiger', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let firmenVerarbeitet = 0;
  let abschluesseGefunden = 0;
  let eventsErstellt = 0;
  let fehler = 0;

  console.log("[Bundesanzeiger] Starte Import der Jahresabschlüsse...");

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
      // Top-1000 Firmen (nach Aktualisierungsdatum, aktive zuerst)
      firmen = (await db.unsafe(
        `SELECT id, canonical_name FROM entities
         WHERE entity_type = 'firma'
           AND data->>'status' NOT IN ('aufgelöst', 'gelöscht', 'insolvenz')
         ORDER BY updated_at DESC
         LIMIT 1000`
      )) as { id: string; canonical_name: string }[];
    }

    console.log(`[Bundesanzeiger] ${firmen.length} Firmen zum Durchsuchen geladen.`);

    for (const firma of firmen) {
      try {
        const abschluesse = await sucheJahresabschluesse(firma.canonical_name);
        firmenVerarbeitet++;

        for (const abschluss of abschluesse) {
          abschluesseGefunden++;

          // Duplikat-Check: Gibt es schon einen Event für dieses Geschäftsjahr?
          const existing = await db.unsafe(
            `SELECT id FROM events
             WHERE entity_id = '${firma.id}'
               AND event_type = 'jahresabschluss_veroeffentlicht'
               AND payload->>'geschaeftsjahr' = '${abschluss.geschaeftsjahr}'
             LIMIT 1`
          );

          if (existing.length > 0) continue;

          // Event erstellen
          const payload: Record<string, unknown> = {
            geschaeftsjahr: abschluss.geschaeftsjahr,
          };
          if (abschluss.umsatz !== null) payload.umsatz = abschluss.umsatz;
          if (abschluss.gewinn !== null) payload.gewinn = abschluss.gewinn;
          if (abschluss.bilanzsumme !== null) payload.bilanzsumme = abschluss.bilanzsumme;
          if (abschluss.mitarbeiterzahl !== null) payload.mitarbeiterzahl = abschluss.mitarbeiterzahl;

          await insertEvent(
            firma.id,
            "jahresabschluss_veroeffentlicht",
            abschluss.veroeffentlichungsDatum,
            payload,
            abschluss.rohtext,
            "bundesanzeiger"
          );
          eventsErstellt++;

          // Entity-Daten aktualisieren (neuester Abschluss gewinnt)
          const updateData: Record<string, unknown> = {};
          if (abschluss.umsatz !== null) updateData.letzter_umsatz = abschluss.umsatz;
          if (abschluss.gewinn !== null) updateData.letzter_gewinn = abschluss.gewinn;
          if (abschluss.bilanzsumme !== null) updateData.letzte_bilanzsumme = abschluss.bilanzsumme;
          if (abschluss.mitarbeiterzahl !== null) updateData.mitarbeiterzahl = abschluss.mitarbeiterzahl;
          if (Object.keys(updateData).length > 0) {
            updateData.letztes_geschaeftsjahr = abschluss.geschaeftsjahr;
            await updateEntityData(firma.id, updateData);
          }
        }

        // Fortschritt loggen
        if (firmenVerarbeitet % 50 === 0) {
          console.log(
            `[Bundesanzeiger] Fortschritt: ${firmenVerarbeitet}/${firmen.length} Firmen, ${abschluesseGefunden} Abschlüsse, ${eventsErstellt} Events`
          );
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(
          `[Bundesanzeiger] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         firmen_verarbeitet: firmenVerarbeitet,
         abschluesse_gefunden: abschluesseGefunden,
         events_erstellt: eventsErstellt,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Bundesanzeiger] Import abgeschlossen!`);
    console.log(`  Firmen verarbeitet: ${firmenVerarbeitet}`);
    console.log(`  Abschlüsse gefunden: ${abschluesseGefunden}`);
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
  await importBundesanzeiger(entityIds.length > 0 ? entityIds : undefined);
  await closeDb();
}

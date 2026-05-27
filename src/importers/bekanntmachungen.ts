/**
 * Registerbekanntmachungen-Scraper
 * Holt tägliche Neueintragungen, Änderungen, Löschungen vom Handelsregister.
 * Nutzt dieselbe Session-Mechanik wie der Handelsregister-Scraper.
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { insertEvent } from "../db/helpers";

const BASE_URL = "https://www.handelsregister.de";
const BEKANNT_URL = `${BASE_URL}/rp_web/registebekanntmachungen.xhtml`;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
};

function extractViewState(html: string): string {
  const $ = cheerio.load(html);
  return $('input[name="javax.faces.ViewState"]').first().attr("value") ?? "";
}

function extractSessionCookie(headers: Headers): string | null {
  const setCookie = headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    const match = cookie.match(/JSESSIONID=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

interface Bekanntmachung {
  registerNr: string;
  registerArt: string;
  gericht: string;
  firmenname: string;
  typ: string;
  datum: string;
  text: string;
}

export async function scrapeBekanntmachungen(dateSince?: string): Promise<Bekanntmachung[]> {
  const since = dateSince ?? new Date(Date.now() - 86400000).toISOString().split("T")[0];
  console.log(`[Bekanntmachungen] Scrape seit ${since}...`);

  // Seite laden
  const pageResp = await fetch(BEKANNT_URL, { headers: HEADERS, redirect: "follow" });
  if (!pageResp.ok) throw new Error(`Bekanntmachungs-Seite nicht erreichbar: ${pageResp.status}`);

  const html = await pageResp.text();
  const viewState = extractViewState(html);
  const sessionId = extractSessionCookie(pageResp.headers);

  if (!viewState) throw new Error("ViewState nicht gefunden");

  // Suchformular absenden (alle Bekanntmachungen seit Datum)
  const formData = new URLSearchParams({
    form: "form",
    "javax.faces.ViewState": viewState,
    "form:datum": since,
    "form:registerArt_input": "",
    "form:registergericht_input": "",
    "form:ergebnisseProSeite_input": "100",
    "form:btnSuche": "",
  });

  const searchHeaders: Record<string, string> = {
    ...HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: BEKANNT_URL,
  };
  if (sessionId) {
    searchHeaders.Cookie = `JSESSIONID=${sessionId}`;
  }

  const searchResp = await fetch(BEKANNT_URL, {
    method: "POST",
    headers: searchHeaders,
    body: formData.toString(),
    redirect: "follow",
  });

  if (!searchResp.ok) throw new Error(`Suche fehlgeschlagen: ${searchResp.status}`);

  const resultHtml = await searchResp.text();
  return parseBekanntmachungen(resultHtml);
}

function parseBekanntmachungen(html: string): Bekanntmachung[] {
  const $ = cheerio.load(html);
  const results: Bekanntmachung[] = [];

  // Bekanntmachungs-Einträge parsen
  $("table[role='grid'] tr[data-ri]").each((_, row) => {
    try {
      const cells = $(row).find("td");
      const text = $(row).text().trim();

      // Register-Nr extrahieren
      const regMatch = text.match(/(HRA|HRB|GnR|VR|PR|GsR)\s*(\d+)/);
      const firmenMatch = text.match(/Firma:\s*(.+?)(?:\n|$)/);
      const typMatch = text.match(/(Neueintragung|Veränderung|Löschung)/i);

      if (regMatch) {
        results.push({
          registerArt: regMatch[1],
          registerNr: regMatch[2],
          gericht: "", // Aus Kontext extrahieren
          firmenname: firmenMatch?.[1]?.trim() ?? "",
          typ: typMatch?.[1] ?? "Unbekannt",
          datum: new Date().toISOString().split("T")[0],
          text: text.substring(0, 2000),
        });
      }
    } catch {
      // Überspringe fehlerhafte Einträge
    }
  });

  return results;
}

function eventTypeFromBekanntmachung(typ: string): string {
  switch (typ.toLowerCase()) {
    case "neueintragung": return "firma_gegruendet";
    case "veränderung": return "firma_geaendert";
    case "löschung": return "firma_geloescht";
    default: return "bekanntmachung";
  }
}

export async function importBekanntmachungen(dateSince?: string) {
  const db = getDb();
  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('registerbekanntmachungen', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  try {
    const bekanntmachungen = await scrapeBekanntmachungen(dateSince);
    console.log(`[Bekanntmachungen] ${bekanntmachungen.length} Einträge gefunden.`);

    let eventsCreated = 0;
    for (const bm of bekanntmachungen) {
      // Entity über Register-Nr finden
      const idValue = `${bm.registerArt} ${bm.registerNr}`.trim();
      const entity = await db.unsafe(
        `SELECT entity_id FROM entity_identifiers
         WHERE id_type = 'register_nr' AND id_value LIKE '%${idValue}%'
         LIMIT 1`
      );

      if (entity.length > 0) {
        const entityId = entity[0].entity_id as string;
        await insertEvent(
          entityId,
          eventTypeFromBekanntmachung(bm.typ),
          bm.datum,
          { typ: bm.typ, registerNr: `${bm.registerArt} ${bm.registerNr}` },
          bm.text,
          "registerbekanntmachungen"
        );
        eventsCreated++;
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '{"found": ${bekanntmachungen.length}, "events_created": ${eventsCreated}}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Bekanntmachungen] ${eventsCreated} Events erstellt.`);
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${(e as Error).message.replace(/'/g, "''")}' WHERE id = '${runId}'`
    );
    throw e;
  }
}

if (import.meta.main) {
  const since = process.argv[2];
  await importBekanntmachungen(since);
  await closeDb();
}

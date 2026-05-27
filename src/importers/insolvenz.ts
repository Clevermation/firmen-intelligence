/**
 * Insolvenzbekanntmachungen-Scraper
 * Holt aktuelle Insolvenzmeldungen von insolvenzbekanntmachungen.de
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { insertEvent } from "../db/helpers";

const INSOLVENZ_URL = "https://neu.insolvenzbekanntmachungen.de/ap/suche.jsf";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

interface InsolvenzMeldung {
  schuldner: string;
  sitz: string;
  aktenzeichen: string;
  gericht: string;
  art: string;
  datum: string;
  text: string;
}

export async function scrapeInsolvenzMeldungen(dateSince?: string): Promise<InsolvenzMeldung[]> {
  const since = dateSince ?? new Date(Date.now() - 86400000).toISOString().split("T")[0];
  console.log(`[Insolvenz] Scrape Meldungen seit ${since}...`);

  // Suchseite laden
  const pageResp = await fetch(INSOLVENZ_URL, { headers: HEADERS, redirect: "follow" });
  if (!pageResp.ok) {
    console.error(`[Insolvenz] Seite nicht erreichbar: ${pageResp.status}`);
    return [];
  }

  const html = await pageResp.text();
  const $ = cheerio.load(html);
  const viewState = $('input[name="javax.faces.ViewState"]').first().attr("value") ?? "";
  const sessionCookies = pageResp.headers.getSetCookie?.() ?? [];
  const sessionMatch = sessionCookies.join(";").match(/JSESSIONID=([^;]+)/);
  const sessionId = sessionMatch?.[1];

  if (!viewState) {
    console.error("[Insolvenz] ViewState nicht gefunden");
    return [];
  }

  // Suche absenden
  const [year, month, day] = since.split("-");
  const formData = new URLSearchParams({
    "form": "form",
    "javax.faces.ViewState": viewState,
    "form:datum_tag": day,
    "form:datum_monat": month,
    "form:datum_jahr": year,
    "form:suchen": "",
  });

  const searchHeaders: Record<string, string> = {
    ...HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: INSOLVENZ_URL,
  };
  if (sessionId) searchHeaders.Cookie = `JSESSIONID=${sessionId}`;

  const searchResp = await fetch(INSOLVENZ_URL, {
    method: "POST",
    headers: searchHeaders,
    body: formData.toString(),
    redirect: "follow",
  });

  if (!searchResp.ok) {
    console.error(`[Insolvenz] Suche fehlgeschlagen: ${searchResp.status}`);
    return [];
  }

  const resultHtml = await searchResp.text();
  return parseInsolvenzMeldungen(resultHtml, since);
}

function parseInsolvenzMeldungen(html: string, datum: string): InsolvenzMeldung[] {
  const $ = cheerio.load(html);
  const results: InsolvenzMeldung[] = [];

  $(".insolvenz-eintrag, table tr, .result-item, li").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length < 20) return;

    // Firmennamen-Muster erkennen
    const firmaMatch = text.match(
      /(?:Schuldner|Firma|Gemeinschuldner):\s*(.+?)(?:\n|,\s*(?:Sitz|Adresse)|$)/i
    );
    const sitzMatch = text.match(/(?:Sitz|Ort|Adresse):\s*(.+?)(?:\n|,|$)/i);
    const azMatch = text.match(/(?:Aktenzeichen|Az\.?):\s*(\S+)/i);
    const gerichtMatch = text.match(/(?:Amtsgericht|AG|Insolvenzgericht)\s+(.+?)(?:\n|,|$)/i);
    const artMatch = text.match(
      /(Eröffnung|Aufhebung|Abweisung|Restschuldbefreiung|Insolvenzplan|Ankündigung)/i
    );

    if (firmaMatch) {
      results.push({
        schuldner: firmaMatch[1].trim(),
        sitz: sitzMatch?.[1]?.trim() ?? "",
        aktenzeichen: azMatch?.[1]?.trim() ?? "",
        gericht: gerichtMatch?.[1]?.trim() ?? "",
        art: artMatch?.[1] ?? "Unbekannt",
        datum,
        text: text.substring(0, 2000),
      });
    }
  });

  return results;
}

export async function importInsolvenzMeldungen(dateSince?: string) {
  const db = getDb();
  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('insolvenzbekanntmachungen', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  try {
    const meldungen = await scrapeInsolvenzMeldungen(dateSince);
    console.log(`[Insolvenz] ${meldungen.length} Meldungen gefunden.`);

    let eventsCreated = 0;
    let matched = 0;

    for (const m of meldungen) {
      // Firma in unserer DB finden (Fuzzy über Name + Sitz)
      const results = m.sitz
        ? await db.unsafe(
            `SELECT id FROM entities
             WHERE entity_type = 'firma'
               AND similarity(lower(canonical_name), lower('${m.schuldner.replace(/'/g, "''")}')) > 0.5
               AND data->>'sitz' ILIKE '%${m.sitz.replace(/'/g, "''")}%'
             ORDER BY similarity(lower(canonical_name), lower('${m.schuldner.replace(/'/g, "''")}')) DESC
             LIMIT 1`
          )
        : await db.unsafe(
            `SELECT id FROM entities
             WHERE entity_type = 'firma'
               AND similarity(lower(canonical_name), lower('${m.schuldner.replace(/'/g, "''")}')) > 0.7
             ORDER BY similarity(lower(canonical_name), lower('${m.schuldner.replace(/'/g, "''")}')) DESC
             LIMIT 1`
          );

      if (results.length > 0) {
        matched++;
        const entityId = results[0].id as string;

        const eventType = m.art === "Eröffnung"
          ? "insolvenz_eroeffnet"
          : m.art === "Aufhebung"
          ? "insolvenz_aufgehoben"
          : "insolvenz_meldung";

        await insertEvent(
          entityId,
          eventType,
          m.datum,
          { aktenzeichen: m.aktenzeichen, gericht: m.gericht, art: m.art },
          m.text,
          "insolvenzbekanntmachungen"
        );
        eventsCreated++;

        // Status aktualisieren
        if (m.art === "Eröffnung") {
          await db.unsafe(
            `UPDATE entities SET data = jsonb_set(data, '{status}', '"insolvenz"'), updated_at = now()
             WHERE id = '${entityId}'`
          );
        }
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '{"found": ${meldungen.length}, "matched": ${matched}, "events_created": ${eventsCreated}}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Insolvenz] ${matched} gematcht, ${eventsCreated} Events erstellt.`);
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
  await importInsolvenzMeldungen(since);
  await closeDb();
}

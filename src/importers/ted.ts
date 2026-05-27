/**
 * TED-Importer (Tenders Electronic Daily)
 * Importiert europäische Ausschreibungen mit Bezug zu deutschen Firmen.
 *
 * API: TED REST API v3.0 (öffentlich, kein Auth nötig)
 * Rate-Limiting: 1 Sekunde zwischen Requests.
 */
import { getDb, closeDb } from "../db/connection";
import { insertEvent, escapeString } from "../db/helpers";

const TED_API = "https://ted.europa.eu/api/v3.0/notices/search";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "FirmenIntelligence/1.0",
};

// Pause zwischen Requests
const REQUEST_DELAY_MS = 1000;

interface TedNotice {
  titel: string;
  auftraggeber: string;
  wert: number | null;
  waehrung: string;
  datum: string;
  tedId: string;
  cpvCode: string;
}

/**
 * Sucht deutsche Ausschreibungen im TED-System
 * @param page - Seitennummer (0-basiert)
 * @param pageSize - Ergebnisse pro Seite
 */
async function sucheTedAusschreibungen(
  page: number = 0,
  pageSize: number = 100
): Promise<{ notices: TedNotice[]; totalCount: number }> {
  try {
    const body = {
      query: "TD=[contract notice] AND CY=[DE]",
      pageSize,
      pageNum: page,
      scope: 3, // Aktive Ausschreibungen
      sortField: "PD",
      sortOrder: "desc",
    };

    const response = await fetch(TED_API, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.warn(`[TED] API-Fehler: HTTP ${response.status}`);
      return { notices: [], totalCount: 0 };
    }

    const json = (await response.json()) as {
      total?: number;
      results?: Array<{
        "ND"?: string[];
        "TI"?: string[];
        "AA"?: string[];
        "DI"?: string[];
        "DD"?: string[];
        "PD"?: string[];
        "CPV"?: string[];
        content?: {
          title?: string;
          contractingAuthority?: string;
          estimatedValue?: { amount?: number; currency?: string };
          publicationDate?: string;
          noticeId?: string;
          cpvCode?: string;
        };
        links?: { html?: string };
      }>;
    };

    const notices: TedNotice[] = (json.results ?? []).map((r) => {
      // TED API liefert Felder teils als Arrays, teils als Objekte
      const titel = r.content?.title ?? r["TI"]?.[0] ?? "Ohne Titel";
      const auftraggeber = r.content?.contractingAuthority ?? r["AA"]?.[0] ?? "Unbekannt";
      const wert = r.content?.estimatedValue?.amount ?? null;
      const waehrung = r.content?.estimatedValue?.currency ?? "EUR";
      const datum = r.content?.publicationDate ?? r["PD"]?.[0] ?? "";
      const tedId = r.content?.noticeId ?? r["ND"]?.[0] ?? "";
      const cpvCode = r.content?.cpvCode ?? r["CPV"]?.[0] ?? "";

      return { titel, auftraggeber, wert, waehrung, datum, tedId, cpvCode };
    });

    return { notices, totalCount: json.total ?? notices.length };
  } catch (e) {
    console.warn(`[TED] Fehler bei Suche: ${(e as Error).message}`);
    return { notices: [], totalCount: 0 };
  }
}

/**
 * Versucht eine Ausschreibung einer bestehenden Firma zuzuordnen
 */
async function matcheFirma(
  auftraggeber: string,
  db: ReturnType<typeof getDb>
): Promise<string | null> {
  if (!auftraggeber || auftraggeber === "Unbekannt") return null;

  const escaped = escapeString(auftraggeber);
  const results = await db.unsafe(
    `SELECT id FROM entities
     WHERE entity_type = 'firma'
       AND similarity(lower(canonical_name), lower('${escaped}')) > 0.5
     ORDER BY similarity(lower(canonical_name), lower('${escaped}')) DESC
     LIMIT 1`
  );

  return results.length > 0 ? (results[0].id as string) : null;
}

/**
 * Hauptfunktion: Importiert TED-Ausschreibungen
 * @param maxPages - Maximale Anzahl zu durchsuchender Seiten
 */
export async function importTED(maxPages: number = 10) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('ted', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let ausschreibungenGeladen = 0;
  let gematcht = 0;
  let eventsErstellt = 0;
  let fehler = 0;

  console.log("[TED] Starte Import deutscher Ausschreibungen...");

  try {
    for (let page = 0; page < maxPages; page++) {
      try {
        const { notices, totalCount } = await sucheTedAusschreibungen(page);

        if (notices.length === 0) {
          console.log(`[TED] Keine weiteren Ergebnisse auf Seite ${page + 1}.`);
          break;
        }

        ausschreibungenGeladen += notices.length;
        console.log(
          `[TED] Seite ${page + 1}: ${notices.length} Ausschreibungen (gesamt: ${totalCount})`
        );

        for (const notice of notices) {
          try {
            // Duplikat-Check über TED-ID
            if (notice.tedId) {
              const existing = await db.unsafe(
                `SELECT id FROM events
                 WHERE event_type = 'ausschreibung'
                   AND payload->>'ted_id' = '${escapeString(notice.tedId)}'
                 LIMIT 1`
              );
              if (existing.length > 0) continue;
            }

            // Firma zuordnen
            const entityId = await matcheFirma(notice.auftraggeber, db);
            if (!entityId) continue;

            gematcht++;

            // Datum normalisieren (YYYYMMDD → YYYY-MM-DD)
            let eventDate: string | null = null;
            if (notice.datum) {
              const d = notice.datum.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
              if (d.match(/^\d{4}-\d{2}-\d{2}$/)) eventDate = d;
            }

            const payload: Record<string, unknown> = {
              titel: notice.titel,
              auftraggeber: notice.auftraggeber,
              ted_id: notice.tedId,
              cpv_code: notice.cpvCode,
            };
            if (notice.wert !== null) {
              payload.wert = notice.wert;
              payload.waehrung = notice.waehrung;
            }

            await insertEvent(
              entityId,
              "ausschreibung",
              eventDate,
              payload,
              null,
              "ted"
            );
            eventsErstellt++;
          } catch (e) {
            fehler++;
            console.warn(`[TED] Fehler bei Notice "${notice.tedId}": ${(e as Error).message}`);
          }
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(`[TED] Fehler auf Seite ${page + 1}: ${(e as Error).message}`);
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         ausschreibungen_geladen: ausschreibungenGeladen,
         gematcht,
         events_erstellt: eventsErstellt,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[TED] Import abgeschlossen!`);
    console.log(`  Ausschreibungen geladen: ${ausschreibungenGeladen}`);
    console.log(`  Gematcht: ${gematcht}`);
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
  const maxPages = parseInt(process.argv[2] ?? "10", 10);
  await importTED(maxPages);
  await closeDb();
}

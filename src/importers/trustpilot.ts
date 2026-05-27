/**
 * Trustpilot-Importer
 * Scraped trustpilot.com nach Firmen-Bewertungen.
 * Extrahiert: Gesamt-Rating (TrustScore), Anzahl Bewertungen.
 *
 * Strategie: Firmenname → Domain extrahieren → trustpilot.com/review/<domain>
 * Falls keine Domain bekannt: Trustpilot-Suche als Fallback.
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

// Pause zwischen Requests (höfliches Scraping — Trustpilot hat aggressives Rate-Limiting)
const REQUEST_DELAY_MS = 2500;
// Timeout pro Request
const FETCH_TIMEOUT_MS = 12000;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

interface TrustpilotDaten {
  rating: number | null;
  reviewCount: number;
  trustScore: string | null; // z.B. "Hervorragend", "Gut" etc.
  domain: string | null;
}

/**
 * Extrahiert die Domain aus einer Website-URL.
 */
function extrahiereDomain(url: string): string | null {
  try {
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith("http")) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    const parsed = new URL(normalizedUrl);
    // www. entfernen für Trustpilot-Lookup
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Versucht eine Firma auf Trustpilot zu finden — erst über Domain, dann über Suche.
 */
async function scrapeTrustpilot(
  firmenname: string,
  websiteUrl: string | null
): Promise<TrustpilotDaten | null> {
  // 1. Versuch: Direkte Domain-basierte URL
  if (websiteUrl) {
    const domain = extrahiereDomain(websiteUrl);
    if (domain) {
      const result = await fetchTrustpilotProfile(
        `https://de.trustpilot.com/review/${domain}`
      );
      if (result) {
        return { ...result, domain };
      }

      // Auch ohne de-Subdomain versuchen
      const resultEn = await fetchTrustpilotProfile(
        `https://www.trustpilot.com/review/${domain}`
      );
      if (resultEn) {
        return { ...resultEn, domain };
      }
    }
  }

  // 2. Versuch: Trustpilot-Suche
  const searchResult = await sucheTrustpilot(firmenname);
  if (searchResult) {
    return searchResult;
  }

  return null;
}

/**
 * Lädt ein Trustpilot-Profil und extrahiert Bewertungsdaten.
 */
async function fetchTrustpilotProfile(
  url: string
): Promise<Omit<TrustpilotDaten, "domain"> | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();

    // Prüfen ob es eine echte Profilseite ist
    if (
      html.includes("This domain isn't registered on Trustpilot") ||
      html.includes("page you were looking for") ||
      !html.includes("trustpilot")
    ) {
      return null;
    }

    return extrahiereTrustpilotDaten(html);
  } catch {
    return null;
  }
}

/**
 * Sucht auf Trustpilot nach einem Firmennamen und gibt das erste Ergebnis zurück.
 */
async function sucheTrustpilot(
  firmenname: string
): Promise<TrustpilotDaten | null> {
  const searchUrl = `https://de.trustpilot.com/search?query=${encodeURIComponent(firmenname)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(searchUrl, {
      headers: HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Erstes Suchergebnis finden — Link zum Profil
    const firstResult = $('a[href*="/review/"]').first();
    if (!firstResult.length) return null;

    const profileHref = firstResult.attr("href");
    if (!profileHref) return null;

    // Domain aus dem Link extrahieren
    const domainMatch = profileHref.match(/\/review\/([^/?#]+)/);
    const domain = domainMatch ? domainMatch[1] : null;

    // Profil laden
    const profileUrl = profileHref.startsWith("http")
      ? profileHref
      : `https://de.trustpilot.com${profileHref}`;

    // Kurze Pause vor dem nächsten Request
    await new Promise((r) => setTimeout(r, 500));

    const profileResult = await fetchTrustpilotProfile(profileUrl);
    if (profileResult) {
      return { ...profileResult, domain };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extrahiert Bewertungsdaten aus dem Trustpilot-HTML.
 */
function extrahiereTrustpilotDaten(
  html: string
): Omit<TrustpilotDaten, "domain"> | null {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  let rating: number | null = null;
  let reviewCount = 0;
  let trustScore: string | null = null;

  // 1. JSON-LD Daten (zuverlässigste Quelle)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const jsonLd = JSON.parse($(el).text());

      // Direkt auf aggregateRating prüfen
      if (jsonLd.aggregateRating) {
        rating = parseFloat(jsonLd.aggregateRating.ratingValue) || rating;
        reviewCount =
          parseInt(jsonLd.aggregateRating.reviewCount) || reviewCount;
      }

      // Oder als LocalBusiness/Organization
      if (jsonLd["@graph"]) {
        for (const item of jsonLd["@graph"]) {
          if (item.aggregateRating) {
            rating =
              parseFloat(item.aggregateRating.ratingValue) || rating;
            reviewCount =
              parseInt(item.aggregateRating.reviewCount) || reviewCount;
          }
        }
      }
    } catch {
      // Ungültiges JSON-LD
    }
  });

  // 2. HTML-Attribute (data-rating etc.)
  if (rating === null) {
    const ratingEl = $('[data-rating]').first();
    if (ratingEl.length) {
      rating = parseFloat(ratingEl.attr("data-rating") ?? "") || null;
    }
  }

  // 3. Text-basierte Extraktion als Fallback
  if (rating === null) {
    const ratingMatch = text.match(
      /TrustScore\s+(\d[,.]?\d?)/i
    );
    if (ratingMatch) {
      rating = parseFloat(ratingMatch[1].replace(",", "."));
      if (rating < 1 || rating > 5) rating = null;
    }
  }

  if (reviewCount === 0) {
    // z.B. "Basierend auf 1.234 Bewertungen"
    const countMatch = text.match(
      /(?:Basierend auf|Based on|insgesamt)\s+([\d.,]+)\s*(?:Bewertung(?:en)?|reviews?)/i
    );
    if (countMatch) {
      reviewCount =
        parseInt(countMatch[1].replace(/[.,]/g, ""), 10) || 0;
    }
  }

  // TrustScore-Kategorie extrahieren
  const scoreMatch = text.match(
    /(?:Hervorragend|Gut|Befriedigend|Mangelhaft|Ungenügend|Excellent|Great|Average|Bad|Poor)/i
  );
  if (scoreMatch) {
    trustScore = scoreMatch[0];
  }

  // Nur zurückgeben wenn mindestens Rating oder Bewertungsanzahl gefunden
  if (rating === null && reviewCount === 0) {
    return null;
  }

  return { rating, reviewCount, trustScore };
}

/**
 * Hauptfunktion: Importiert Trustpilot-Bewertungen für Firmen.
 * @param entityIds - Optionale Liste spezifischer Entity-IDs
 */
export async function importTrustpilot(entityIds?: string[]) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('trustpilot', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let verarbeitet = 0;
  let erfolgreich = 0;
  let fehler = 0;

  console.log("[Trustpilot] Starte Bewertungs-Import...");

  try {
    let firmen: { id: string; canonical_name: string; data: Record<string, unknown> }[];

    if (entityIds?.length) {
      const idList = entityIds.map((id) => `'${escapeString(id)}'`).join(",");
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, data FROM entities
         WHERE id IN (${idList}) AND entity_type = 'firma'`
      )) as typeof firmen;
    } else {
      // Top-500 Firmen ohne Trustpilot-Daten
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, data FROM entities
         WHERE entity_type = 'firma'
           AND data->>'trustpilot_rating' IS NULL
           AND (data->>'status' IS NULL OR data->>'status' NOT IN ('aufgelöst', 'gelöscht'))
         ORDER BY updated_at DESC
         LIMIT 500`
      )) as typeof firmen;
    }

    console.log(`[Trustpilot] ${firmen.length} Firmen zu verarbeiten.`);

    for (const firma of firmen) {
      try {
        const data =
          typeof firma.data === "string" ? JSON.parse(firma.data) : firma.data;
        const websiteUrl =
          (data.website as string) ??
          (data.homepage as string) ??
          (data.url as string) ??
          null;

        const result = await scrapeTrustpilot(
          firma.canonical_name,
          websiteUrl
        );
        verarbeitet++;

        if (result) {
          const updateData: Record<string, unknown> = {
            trustpilot_gescraped: new Date().toISOString().split("T")[0],
          };

          if (result.rating !== null) {
            updateData.trustpilot_rating = result.rating;
          }
          if (result.reviewCount > 0) {
            updateData.trustpilot_reviews = result.reviewCount;
          }
          if (result.trustScore) {
            updateData.trustpilot_score = result.trustScore;
          }
          if (result.domain) {
            updateData.trustpilot_domain = result.domain;
          }

          await updateEntityData(firma.id, updateData);
          erfolgreich++;

          console.log(
            `[Trustpilot] "${firma.canonical_name}": ` +
              `Rating ${result.rating ?? "k.A."}, ` +
              `${result.reviewCount} Bewertungen` +
              (result.trustScore ? ` (${result.trustScore})` : "")
          );
        } else {
          // Markieren, dass Suche durchgeführt wurde
          await updateEntityData(firma.id, {
            trustpilot_gescraped: new Date().toISOString().split("T")[0],
            trustpilot_rating: null,
          });
        }
      } catch (e) {
        fehler++;
        console.warn(
          `[Trustpilot] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }

      // Fortschritt loggen
      if (verarbeitet % 25 === 0) {
        console.log(
          `[Trustpilot] Fortschritt: ${verarbeitet}/${firmen.length}, ${erfolgreich} gefunden, ${fehler} Fehler`
        );
      }

      // Rate-Limiting (aggressiv wegen Trustpilot-Schutz)
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({ verarbeitet, erfolgreich, fehler }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Trustpilot] Import abgeschlossen!`);
    console.log(`  Verarbeitet: ${verarbeitet}`);
    console.log(`  Gefunden: ${erfolgreich}`);
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
  const entityId = process.argv[2];
  if (entityId) {
    await importTrustpilot([entityId]);
  } else {
    console.log("[Trustpilot] Kein Entity-ID angegeben, starte Batch-Import (500 Firmen)...");
    await importTrustpilot();
  }
  await closeDb();
}

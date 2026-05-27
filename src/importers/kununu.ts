/**
 * Kununu-Importer
 * Scraped kununu.com nach Arbeitgeber-Bewertungen.
 * Extrahiert: Gesamt-Rating, Anzahl Bewertungen, Weiterempfehlungsrate.
 *
 * Strategie: Firmenname → URL-Slug generieren → kununu.com/de/<slug> abrufen
 * → HTML parsen mit cheerio für strukturierte Bewertungsdaten.
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

// Pause zwischen Requests (höfliches Scraping)
const REQUEST_DELAY_MS = 2000;
// Timeout pro Request
const FETCH_TIMEOUT_MS = 12000;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

interface KununuDaten {
  rating: number | null;
  reviewCount: number;
  weiterempfehlung: number | null; // Prozent
  branche: string | null;
  slug: string;
}

/**
 * Erzeugt einen kununu-kompatiblen URL-Slug aus dem Firmennamen.
 * kununu nutzt Kleinbuchstaben, Bindestriche, keine Sonderzeichen.
 */
function erzeugeSlug(firmenname: string): string {
  return firmenname
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/&/g, "und")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Versucht eine Firma auf kununu.com zu finden und Bewertungsdaten zu extrahieren.
 * Strategie: Direkt-URL versuchen, dann Suche als Fallback.
 */
async function scrapeKununu(firmenname: string): Promise<KununuDaten | null> {
  const slug = erzeugeSlug(firmenname);
  const searchUrl = `https://www.kununu.com/de/search#q=${encodeURIComponent(firmenname)}`;

  // Erst direkte URL versuchen (schneller, kein zusätzlicher Request)
  const directUrl = `https://www.kununu.com/de/${slug}`;
  const directResult = await fetchKununuProfile(directUrl);
  if (directResult) {
    return { ...directResult, slug };
  }

  // Fallback: Kurzform des Namens versuchen (ohne Rechtsform)
  const kurzname = firmenname
    .replace(/\b(GmbH|AG|SE|KG|OHG|e\.V\.|eG|UG|GmbH\s*&\s*Co\.\s*KG)\b/gi, "")
    .trim();
  if (kurzname !== firmenname) {
    const kurzSlug = erzeugeSlug(kurzname);
    const kurzUrl = `https://www.kununu.com/de/${kurzSlug}`;
    const kurzResult = await fetchKununuProfile(kurzUrl);
    if (kurzResult) {
      return { ...kurzResult, slug: kurzSlug };
    }
  }

  return null;
}

/**
 * Lädt ein kununu-Profil und extrahiert die Bewertungsdaten aus dem HTML.
 */
async function fetchKununuProfile(url: string): Promise<Omit<KununuDaten, "slug"> | null> {
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

    // Prüfen ob es eine echte Profilseite ist (nicht 404-Seite oder Redirect)
    if (!html.includes("kununu") || html.includes("Seite nicht gefunden")) {
      return null;
    }

    return extrahiereKununuDaten(html);
  } catch {
    return null;
  }
}

/**
 * Extrahiert Bewertungsdaten aus dem kununu-HTML.
 * Nutzt verschiedene Selektoren, da kununu das Layout regelmäßig ändert.
 */
function extrahiereKununuDaten(html: string): Omit<KununuDaten, "slug"> | null {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  let rating: number | null = null;
  let reviewCount = 0;
  let weiterempfehlung: number | null = null;
  let branche: string | null = null;

  // Rating extrahieren — verschiedene Muster
  // kununu zeigt Rating als z.B. "3,8" oder "4.2" an
  const ratingMatch = text.match(
    /(\d[,.]?\d?)\s*(?:von\s*5|\/\s*5|Sterne|Score)/i
  );
  if (ratingMatch) {
    rating = parseFloat(ratingMatch[1].replace(",", "."));
    if (rating < 1 || rating > 5) rating = null;
  }

  // Alternative: JSON-LD Daten (falls vorhanden)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const jsonLd = JSON.parse($(el).text());
      if (jsonLd.aggregateRating) {
        rating = parseFloat(jsonLd.aggregateRating.ratingValue) || rating;
        reviewCount = parseInt(jsonLd.aggregateRating.reviewCount) || reviewCount;
      }
      if (jsonLd["@type"] === "Organization" && jsonLd.aggregateRating) {
        rating = parseFloat(jsonLd.aggregateRating.ratingValue) || rating;
        reviewCount = parseInt(jsonLd.aggregateRating.reviewCount) || reviewCount;
      }
    } catch {
      // Ungültiges JSON-LD ignorieren
    }
  });

  // Bewertungsanzahl extrahieren
  if (reviewCount === 0) {
    const countMatch = text.match(
      /(\d[\d.]*)\s*(?:Bewertung(?:en)?|Reviews?|Erfahrung(?:en|sberichte)?)/i
    );
    if (countMatch) {
      reviewCount = parseInt(countMatch[1].replace(/\./g, ""), 10) || 0;
    }
  }

  // Weiterempfehlungsrate extrahieren
  const empfehlungMatch = text.match(
    /(\d{1,3})\s*%?\s*(?:empfehlen|Weiterempfehlung|würden.*empfehlen)/i
  );
  if (empfehlungMatch) {
    weiterempfehlung = parseInt(empfehlungMatch[1], 10);
    if (weiterempfehlung < 0 || weiterempfehlung > 100) weiterempfehlung = null;
  }

  // Branche extrahieren
  const brancheMatch = text.match(
    /Branche[:\s]+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[&/a-zäöüßA-ZÄÖÜ]+){0,4})/
  );
  if (brancheMatch) {
    branche = brancheMatch[1].trim();
  }

  // Nur zurückgeben wenn mindestens Rating ODER Bewertungsanzahl gefunden
  if (rating === null && reviewCount === 0) {
    return null;
  }

  return { rating, reviewCount, weiterempfehlung, branche };
}

/**
 * Hauptfunktion: Importiert Kununu-Bewertungen für Firmen.
 * @param entityIds - Optionale Liste spezifischer Entity-IDs
 */
export async function importKununu(entityIds?: string[]) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('kununu', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let verarbeitet = 0;
  let erfolgreich = 0;
  let fehler = 0;

  console.log("[Kununu] Starte Bewertungs-Import...");

  try {
    let firmen: { id: string; canonical_name: string; data: Record<string, unknown> }[];

    if (entityIds?.length) {
      // Spezifische Firmen laden
      const idList = entityIds.map((id) => `'${escapeString(id)}'`).join(",");
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, data FROM entities
         WHERE id IN (${idList}) AND entity_type = 'firma'`
      )) as typeof firmen;
    } else {
      // Top-500 Firmen ohne Kununu-Daten (bevorzugt aktive Firmen)
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, data FROM entities
         WHERE entity_type = 'firma'
           AND data->>'kununu_rating' IS NULL
           AND (data->>'status' IS NULL OR data->>'status' NOT IN ('aufgelöst', 'gelöscht'))
         ORDER BY updated_at DESC
         LIMIT 500`
      )) as typeof firmen;
    }

    console.log(`[Kununu] ${firmen.length} Firmen zu verarbeiten.`);

    for (const firma of firmen) {
      try {
        const result = await scrapeKununu(firma.canonical_name);
        verarbeitet++;

        if (result) {
          const updateData: Record<string, unknown> = {
            kununu_gescraped: new Date().toISOString().split("T")[0],
            kununu_slug: result.slug,
          };

          if (result.rating !== null) {
            updateData.kununu_rating = result.rating;
          }
          if (result.reviewCount > 0) {
            updateData.kununu_reviews = result.reviewCount;
          }
          if (result.weiterempfehlung !== null) {
            updateData.kununu_weiterempfehlung = result.weiterempfehlung;
          }
          if (result.branche) {
            updateData.kununu_branche = result.branche;
          }

          await updateEntityData(firma.id, updateData);
          erfolgreich++;

          console.log(
            `[Kununu] "${firma.canonical_name}": ` +
              `Rating ${result.rating ?? "k.A."}, ` +
              `${result.reviewCount} Bewertungen` +
              (result.weiterempfehlung !== null
                ? `, ${result.weiterempfehlung}% Weiterempfehlung`
                : "")
          );
        } else {
          // Auch markieren, dass wir es versucht haben (um Retry zu vermeiden)
          await updateEntityData(firma.id, {
            kununu_gescraped: new Date().toISOString().split("T")[0],
            kununu_rating: null,
          });
        }
      } catch (e) {
        fehler++;
        console.warn(
          `[Kununu] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }

      // Fortschritt loggen
      if (verarbeitet % 25 === 0) {
        console.log(
          `[Kununu] Fortschritt: ${verarbeitet}/${firmen.length}, ${erfolgreich} gefunden, ${fehler} Fehler`
        );
      }

      // Rate-Limiting
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({ verarbeitet, erfolgreich, fehler }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Kununu] Import abgeschlossen!`);
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
    await importKununu([entityId]);
  } else {
    console.log("[Kununu] Kein Entity-ID angegeben, starte Batch-Import (500 Firmen)...");
    await importKununu();
  }
  await closeDb();
}

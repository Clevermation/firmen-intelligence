/**
 * Google Places Importer
 * Holt Bewertungen und Ratings für Firmen über die Google Places API.
 *
 * Benötigt: GOOGLE_PLACES_API_KEY als Umgebungsvariable.
 * Rate-Limiting: 500ms zwischen Requests (API erlaubt mehr, aber defensiv).
 */
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

const PLACES_API_BASE = "https://maps.googleapis.com/maps/api/place";

// Pause zwischen Requests
const REQUEST_DELAY_MS = 500;

interface PlaceResult {
  placeId: string;
  rating: number | null;
  reviewCount: number;
  formattedAddress: string;
}

/**
 * Sucht eine Firma über die Google Places Text Search API
 */
async function suchePlaces(
  firmenname: string,
  ort: string,
  apiKey: string
): Promise<PlaceResult | null> {
  const query = ort ? `${firmenname} ${ort}` : firmenname;
  const encodedQuery = encodeURIComponent(query);
  const url = `${PLACES_API_BASE}/textsearch/json?query=${encodedQuery}&language=de&region=de&key=${apiKey}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[GooglePlaces] HTTP ${response.status} für "${firmenname}"`);
      return null;
    }

    const json = (await response.json()) as {
      status: string;
      results?: Array<{
        place_id: string;
        rating?: number;
        user_ratings_total?: number;
        formatted_address?: string;
      }>;
      error_message?: string;
    };

    if (json.status !== "OK" || !json.results?.length) {
      if (json.status === "REQUEST_DENIED") {
        console.error(`[GooglePlaces] API-Key ungültig: ${json.error_message}`);
      }
      return null;
    }

    const place = json.results[0];
    return {
      placeId: place.place_id,
      rating: place.rating ?? null,
      reviewCount: place.user_ratings_total ?? 0,
      formattedAddress: place.formatted_address ?? "",
    };
  } catch (e) {
    console.warn(`[GooglePlaces] Fehler bei Suche für "${firmenname}": ${(e as Error).message}`);
    return null;
  }
}

/**
 * Hauptfunktion: Importiert Google Places Daten für Firmen
 * @param entityIds - Optionale Liste spezifischer Entity-IDs
 */
export async function importGooglePlaces(entityIds?: string[]) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY nicht gesetzt. Bitte als Umgebungsvariable konfigurieren."
    );
  }

  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('google-places', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let firmenVerarbeitet = 0;
  let placesGefunden = 0;
  let aktualisiert = 0;
  let fehler = 0;

  console.log("[GooglePlaces] Starte Import...");

  try {
    // Firmen laden
    let firmen: { id: string; canonical_name: string; sitz: string }[];

    if (entityIds && entityIds.length > 0) {
      const idList = entityIds.map((id) => `'${escapeString(id)}'`).join(",");
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, COALESCE(data->>'sitz', '') as sitz FROM entities
         WHERE entity_type = 'firma' AND id IN (${idList})`
      )) as { id: string; canonical_name: string; sitz: string }[];
    } else {
      // Top-500 Firmen ohne bisherige Google-Daten
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, COALESCE(data->>'sitz', '') as sitz FROM entities
         WHERE entity_type = 'firma'
           AND data->>'status' NOT IN ('aufgelöst', 'gelöscht')
           AND (data->>'google_rating') IS NULL
         ORDER BY updated_at DESC
         LIMIT 500`
      )) as { id: string; canonical_name: string; sitz: string }[];
    }

    console.log(`[GooglePlaces] ${firmen.length} Firmen zum Durchsuchen geladen.`);

    for (const firma of firmen) {
      try {
        const result = await suchePlaces(firma.canonical_name, firma.sitz, apiKey);
        firmenVerarbeitet++;

        if (result) {
          placesGefunden++;

          // Entity-Daten aktualisieren
          const updateData: Record<string, unknown> = {
            google_place_id: result.placeId,
            google_reviews: result.reviewCount,
          };
          if (result.rating !== null) {
            updateData.google_rating = result.rating;
          }
          if (result.formattedAddress) {
            updateData.google_adresse = result.formattedAddress;
          }

          await updateEntityData(firma.id, updateData);
          aktualisiert++;
        }

        // Fortschritt loggen
        if (firmenVerarbeitet % 50 === 0) {
          console.log(
            `[GooglePlaces] Fortschritt: ${firmenVerarbeitet}/${firmen.length} Firmen, ${placesGefunden} gefunden`
          );
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(
          `[GooglePlaces] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         firmen_verarbeitet: firmenVerarbeitet,
         places_gefunden: placesGefunden,
         aktualisiert,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[GooglePlaces] Import abgeschlossen!`);
    console.log(`  Firmen verarbeitet: ${firmenVerarbeitet}`);
    console.log(`  Places gefunden: ${placesGefunden}`);
    console.log(`  Aktualisiert: ${aktualisiert}`);
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
  await importGooglePlaces(entityIds.length > 0 ? entityIds : undefined);
  await closeDb();
}

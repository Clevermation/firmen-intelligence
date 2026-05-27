/**
 * VIES USt-ID-Validierung
 * Validiert Umsatzsteuer-Identifikationsnummern über die EU-VIES-API.
 *
 * API: https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
 * Rate-Limiting: 500ms zwischen Requests.
 */
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

const VIES_API = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

// Pause zwischen Requests (EU-API ist empfindlich)
const REQUEST_DELAY_MS = 500;

interface ViesResult {
  valid: boolean;
  name: string;
  address: string;
  requestDate: string;
  countryCode: string;
  vatNumber: string;
}

/**
 * Validiert eine USt-ID über die VIES-API
 */
async function validiereUstId(countryCode: string, vatNumber: string): Promise<ViesResult | null> {
  try {
    const response = await fetch(VIES_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryCode, vatNumber }),
    });

    if (!response.ok) {
      console.warn(`[VIES] HTTP ${response.status} für ${countryCode}${vatNumber}`);
      return null;
    }

    const json = (await response.json()) as {
      valid?: boolean;
      name?: string;
      address?: string;
      requestDate?: string;
      countryCode?: string;
      vatNumber?: string;
      userError?: string;
    };

    if (json.userError) {
      console.warn(`[VIES] API-Fehler: ${json.userError}`);
      return null;
    }

    return {
      valid: json.valid ?? false,
      name: json.name ?? "",
      address: json.address ?? "",
      requestDate: json.requestDate ?? new Date().toISOString(),
      countryCode: json.countryCode ?? countryCode,
      vatNumber: json.vatNumber ?? vatNumber,
    };
  } catch (e) {
    console.warn(`[VIES] Fehler bei Validierung von ${countryCode}${vatNumber}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Extrahiert Ländercode und Nummer aus einer USt-ID
 * Beispiel: "DE123456789" → { countryCode: "DE", vatNumber: "123456789" }
 */
function parseUstId(ustId: string): { countryCode: string; vatNumber: string } | null {
  const cleaned = ustId.replace(/[\s.-]/g, "").toUpperCase();
  const match = cleaned.match(/^([A-Z]{2})(\d{5,12})$/);
  if (!match) return null;
  return { countryCode: match[1], vatNumber: match[2] };
}

/**
 * Hauptfunktion: Validiert USt-IDs für Firmen
 * @param entityId - Einzelne Entity-ID validieren (optional)
 */
export async function importVIES(entityId?: string) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('vies', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let firmenVerarbeitet = 0;
  let valideGefunden = 0;
  let invalideGefunden = 0;
  let fehler = 0;

  console.log("[VIES] Starte USt-ID-Validierung...");

  try {
    // Firmen laden
    let firmen: { id: string; canonical_name: string; ust_id: string }[];

    if (entityId) {
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, COALESCE(data->>'ust_id', '') as ust_id FROM entities
         WHERE id = '${escapeString(entityId)}'`
      )) as { id: string; canonical_name: string; ust_id: string }[];
    } else {
      // Alle Firmen mit USt-ID, die noch nicht validiert wurden
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, data->>'ust_id' as ust_id FROM entities
         WHERE entity_type = 'firma'
           AND data->>'ust_id' IS NOT NULL
           AND data->>'ust_id' != ''
           AND (data->>'ust_id_valid') IS NULL
         ORDER BY updated_at DESC
         LIMIT 500`
      )) as { id: string; canonical_name: string; ust_id: string }[];
    }

    console.log(`[VIES] ${firmen.length} Firmen mit USt-ID zum Validieren geladen.`);

    for (const firma of firmen) {
      try {
        if (!firma.ust_id) {
          console.warn(`[VIES] Keine USt-ID für "${firma.canonical_name}" (${firma.id})`);
          continue;
        }

        const parsed = parseUstId(firma.ust_id);
        if (!parsed) {
          console.warn(`[VIES] Ungültiges USt-ID-Format: "${firma.ust_id}" für "${firma.canonical_name}"`);
          await updateEntityData(firma.id, {
            ust_id_valid: false,
            ust_id_fehler: "Ungültiges Format",
            ust_id_geprueft_am: new Date().toISOString(),
          });
          fehler++;
          continue;
        }

        const result = await validiereUstId(parsed.countryCode, parsed.vatNumber);
        firmenVerarbeitet++;

        if (result) {
          const updateData: Record<string, unknown> = {
            ust_id_valid: result.valid,
            ust_id_geprueft_am: result.requestDate,
          };

          if (result.valid) {
            valideGefunden++;
            if (result.name) updateData.ust_id_name = result.name;
            if (result.address) updateData.ust_id_adresse = result.address;
          } else {
            invalideGefunden++;
          }

          await updateEntityData(firma.id, updateData);
        } else {
          fehler++;
        }

        // Fortschritt loggen
        if (firmenVerarbeitet % 50 === 0) {
          console.log(
            `[VIES] Fortschritt: ${firmenVerarbeitet}/${firmen.length}, valide: ${valideGefunden}, invalide: ${invalideGefunden}`
          );
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(`[VIES] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`);
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         firmen_verarbeitet: firmenVerarbeitet,
         valide: valideGefunden,
         invalide: invalideGefunden,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[VIES] Validierung abgeschlossen!`);
    console.log(`  Firmen verarbeitet: ${firmenVerarbeitet}`);
    console.log(`  Valide: ${valideGefunden}`);
    console.log(`  Invalide: ${invalideGefunden}`);
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
  await importVIES(entityId);
  await closeDb();
}

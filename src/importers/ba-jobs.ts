/**
 * BA Jobbörse-Importer
 * Nutzt die Jobsuche-API der Bundesagentur für Arbeit
 * um offene Stellenangebote pro Firma zu importieren.
 *
 * API: https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/app/jobs
 * OAuth: https://rest.arbeitsagentur.de/oauth/gettoken_cc
 */
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, insertEvent, escapeString } from "../db/helpers";

const OAUTH_URL = "https://rest.arbeitsagentur.de/oauth/gettoken_cc";
const JOBS_API_URL =
  "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/app/jobs";

// Client-Credentials für die öffentliche Jobbörse-API
// (öffentlich dokumentiert, kein Geheimnis)
const CLIENT_ID = "c003a37f-024f-462a-b36d-b001be4cd24a";
const CLIENT_SECRET = "32a39620-32b3-4f71-9571-e3ff4dccc870";

// Pause zwischen Requests (Rate-Limiting)
const REQUEST_DELAY_MS = 500;

interface OAuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expiresAt: number;
}

interface BAJobResult {
  stellenangebote?: BAJob[];
  maxErgebnisse?: number;
  page?: number;
}

interface BAJob {
  refnr: string;
  beruf: string;
  titel: string;
  arbeitgeber: string;
  arbeitsort?: {
    ort?: string;
    plz?: string;
    region?: string;
    land?: string;
  };
  eintrittsdatum?: string;
  aktuelleVeroeffentlichungsdatum?: string;
  modifikationsTimestamp?: string;
  arbeitszeitmodell?: string[];
  befristung?: string;
  ueberpilotenSuche?: boolean;
  externeUrl?: string;
}

let cachedToken: OAuthToken | null = null;

/**
 * Holt einen OAuth-Token von der BA-API (Client-Credentials-Flow)
 */
async function getOAuthToken(): Promise<string> {
  // Gecachten Token nutzen wenn noch gültig
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.access_token;
  }

  console.log("[BA-Jobs] Hole OAuth-Token...");

  const response = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`OAuth-Token-Fehler: ${response.status} ${await response.text()}`);
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  cachedToken = {
    ...tokenData,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
  };

  console.log("[BA-Jobs] OAuth-Token erhalten.");
  return cachedToken.access_token;
}

/**
 * Sucht Stellenangebote für einen Firmennamen
 */
async function sucheJobs(
  firmenname: string,
  token: string
): Promise<{ jobs: BAJob[]; total: number }> {
  // Firmennamen bereinigen für die Suche (Rechtsformzusätze entfernen)
  const suchname = firmenname
    .replace(/\s*(GmbH|AG|SE|KG|OHG|GbR|e\.?\s*K\.?|UG|mbH|Co\.?|KGaA|eG|e\.?\s*V\.?)\s*/gi, " ")
    .trim();

  const params = new URLSearchParams({
    was: suchname,
    size: "50",
    page: "1",
  });

  const url = `${JOBS_API_URL}?${params.toString()}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "OAuthAccessToken": token,
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn("[BA-Jobs] Rate-Limit erreicht, warte 5 Sekunden...");
        await new Promise((r) => setTimeout(r, 5000));
        return sucheJobs(firmenname, token);
      }
      console.warn(`[BA-Jobs] API-Fehler ${response.status} für "${suchname}"`);
      return { jobs: [], total: 0 };
    }

    const data = (await response.json()) as BAJobResult;
    const jobs = data.stellenangebote ?? [];
    const total = data.maxErgebnisse ?? jobs.length;

    // Nur Treffer behalten, die tatsächlich zum Arbeitgeber passen
    const relevantJobs = jobs.filter((job) => {
      if (!job.arbeitgeber) return false;
      const agLower = job.arbeitgeber.toLowerCase();
      const suchLower = suchname.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      // Mindestens ein relevantes Wort des Firmennamens muss im Arbeitgeber vorkommen
      return suchLower.some((wort) => agLower.includes(wort));
    });

    return { jobs: relevantJobs, total };
  } catch (e) {
    console.warn(`[BA-Jobs] Fehler bei Suche für "${suchname}": ${(e as Error).message}`);
    return { jobs: [], total: 0 };
  }
}

/**
 * Hauptfunktion: Importiert Stellenangebote für die Top-Firmen
 */
export async function importBAJobs() {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('ba-jobs', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let firmenVerarbeitet = 0;
  let stellenangeboteGefunden = 0;
  let eventsErstellt = 0;
  let fehler = 0;

  console.log("[BA-Jobs] Starte Import der Stellenangebote...");

  try {
    const token = await getOAuthToken();

    // Top-100 Firmen laden (nach Größe/Aktualität sortiert, aktive Firmen)
    const firmen = (await db.unsafe(
      `SELECT id, canonical_name FROM entities
       WHERE entity_type = 'firma'
         AND data->>'status' NOT IN ('aufgelöst', 'gelöscht', 'insolvenz')
       ORDER BY
         (data->>'mitarbeiterzahl')::int DESC NULLS LAST,
         updated_at DESC
       LIMIT 100`
    )) as { id: string; canonical_name: string }[];

    console.log(`[BA-Jobs] ${firmen.length} Firmen zum Durchsuchen geladen.`);

    for (const firma of firmen) {
      try {
        const { jobs, total } = await sucheJobs(firma.canonical_name, token);
        firmenVerarbeitet++;

        if (jobs.length === 0) {
          // Fortschritt loggen
          if (firmenVerarbeitet % 20 === 0) {
            console.log(
              `[BA-Jobs] Fortschritt: ${firmenVerarbeitet}/${firmen.length} Firmen`
            );
          }
          await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
          continue;
        }

        stellenangeboteGefunden += jobs.length;

        // Anzahl offener Stellen als JSONB-Update speichern
        await updateEntityData(firma.id, {
          offene_stellen: jobs.length,
          offene_stellen_gesamt: total,
          offene_stellen_stand: new Date().toISOString().split("T")[0],
        });

        // Einzelne Stellenangebote als Events speichern
        for (const job of jobs) {
          // Duplikat-Check über Referenznummer
          const existing = await db.unsafe(
            `SELECT id FROM events
             WHERE entity_id = '${firma.id}'
               AND event_type = 'stellenangebot'
               AND source_doc_id = '${escapeString(job.refnr)}'
             LIMIT 1`
          );

          if (existing.length > 0) continue;

          const eventDate =
            job.aktuelleVeroeffentlichungsdatum ??
            job.eintrittsdatum ??
            new Date().toISOString().split("T")[0];

          await insertEvent(
            firma.id,
            "stellenangebot",
            eventDate,
            {
              refnr: job.refnr,
              titel: job.titel,
              beruf: job.beruf,
              arbeitgeber: job.arbeitgeber,
              arbeitsort: job.arbeitsort?.ort ?? "",
              plz: job.arbeitsort?.plz ?? "",
              arbeitszeitmodell: job.arbeitszeitmodell?.join(", ") ?? "",
              befristung: job.befristung ?? "",
              externeUrl: job.externeUrl ?? "",
            },
            null,
            "ba-jobs"
          );
          eventsErstellt++;
        }

        // Fortschritt loggen
        if (firmenVerarbeitet % 10 === 0) {
          console.log(
            `[BA-Jobs] Fortschritt: ${firmenVerarbeitet}/${firmen.length} Firmen, ${stellenangeboteGefunden} Stellen, ${eventsErstellt} Events`
          );
        }

        // Rate-Limiting
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (e) {
        fehler++;
        console.warn(
          `[BA-Jobs] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         firmen_verarbeitet: firmenVerarbeitet,
         stellenangebote_gefunden: stellenangeboteGefunden,
         events_erstellt: eventsErstellt,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[BA-Jobs] Import abgeschlossen!`);
    console.log(`  Firmen verarbeitet: ${firmenVerarbeitet}`);
    console.log(`  Stellenangebote gefunden: ${stellenangeboteGefunden}`);
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
  await importBAJobs();
  await closeDb();
}

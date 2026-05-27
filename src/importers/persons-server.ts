/**
 * Server-seitiger Personen-Import aus OffeneRegister-JSONL (Streaming).
 *
 * Strategie:
 *   curl → bzcat → zeilenweise parsen → Officers extrahieren → Batch-Insert
 *
 * Erstellt Person-Entities (entity_type='person') und Events für die
 * Firma↔Person-Beziehung. Personen werden über Name+Stadt dedupliziert.
 */
import { getDb } from "../db/connection";
import { escapeString, escapeJsonForSql } from "../db/helpers";

const DOWNLOAD_URL =
  "https://daten.offeneregister.de/de_companies_ocdata.jsonl.bz2";
const BATCH_SIZE = 500;
const PROGRESS_INTERVAL = 50_000;

/**
 * Hauptfunktion: Streaming-Import von Personen aus OffeneRegister.
 * Läuft im Hintergrund — wird vom Server-Endpoint getriggert.
 */
export async function importPersons() {
  const db = getDb();

  // Hängende Person-Imports aufräumen
  await db.unsafe(
    `UPDATE import_runs SET status = 'failed', finished_at = now(), error = 'Automatisch abgebrochen (Neustart)'
     WHERE status = 'running' AND source LIKE '%persons%'`
  );

  console.log("[Persons] Starte Personen-Import (Streaming)...");

  const importRunResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('persons-server', 'running') RETURNING id`
  );
  const importRunId = importRunResult[0]?.id as string;

  const startTime = Date.now();
  let processed = 0;
  let personsCreated = 0;
  let personsSkipped = 0;
  let eventsCreated = 0;
  let firmenNotFound = 0;
  let errors = 0;

  // Person-Deduplizierung: Name+Stadt → entity_id
  const personCache = new Map<string, string>();

  try {
    // curl mit robusten Optionen (identisch zum Firmen-Import)
    const curl = Bun.spawn(
      [
        "curl",
        "-sS",
        "-L",
        "-f",
        "--speed-limit", "10000",
        "--speed-time", "60",
        "--retry", "5",
        "--retry-delay", "5",
        "--retry-max-time", "300",
        "--connect-timeout", "30",
        "--max-time", "7200",
        DOWNLOAD_URL,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const bzcat = Bun.spawn(["bzcat"], {
      stdin: curl.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });

    console.log("[Persons] Download + Dekompression gestartet...");

    const reader = bzcat.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Batch-Puffer für Personen und Events
    let personInserts: string[] = [];
    let eventInserts: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";

      for (const line of parts) {
        if (!line.trim()) continue;
        processed++;

        try {
          const c = JSON.parse(line);
          if (!c.officers?.length || !c.company_number) continue;

          // Firma-ID über or_company_number in JSONB-Daten finden
          const orNum = escapeString(c.company_number);
          const firma = await db.unsafe(
            `SELECT id FROM entities
             WHERE entity_type = 'firma'
               AND data->>'or_company_number' = '${orNum}'
             LIMIT 1`
          );

          if (firma.length === 0) {
            firmenNotFound++;
            continue;
          }
          const firmaId = firma[0].id as string;

          for (const officer of c.officers) {
            if (!officer.name || officer.type !== "person") continue;
            const personName = officer.name.trim();
            if (!personName) continue;

            const city = (officer.other_attributes?.city ?? "").trim();
            const cacheKey = `${personName.toLowerCase()}|${city.toLowerCase()}`;

            let personId = personCache.get(cacheKey);

            if (!personId) {
              // Person in DB suchen (exakte Übereinstimmung Name + Stadt)
              const nameEsc = escapeString(personName);
              const existing = city
                ? await db.unsafe(
                    `SELECT id FROM entities
                     WHERE entity_type = 'person'
                       AND lower(canonical_name) = lower('${nameEsc}')
                       AND data->>'wohnort' = '${escapeString(city)}'
                     LIMIT 1`
                  )
                : await db.unsafe(
                    `SELECT id FROM entities
                     WHERE entity_type = 'person'
                       AND lower(canonical_name) = lower('${nameEsc}')
                       AND (data->>'wohnort' IS NULL OR data->>'wohnort' = '')
                     LIMIT 1`
                  );

              if (existing.length > 0) {
                personId = existing[0].id as string;
                personsSkipped++;
              } else {
                // Neue Person anlegen
                const personData: Record<string, unknown> = {};
                if (city) personData.wohnort = city;
                if (officer.other_attributes?.firstname)
                  personData.vorname = officer.other_attributes.firstname;
                if (officer.other_attributes?.lastname)
                  personData.nachname = officer.other_attributes.lastname;

                const result = await db.unsafe(
                  `INSERT INTO entities (entity_type, canonical_name, data)
                   VALUES ('person', '${escapeString(personName)}', '${escapeJsonForSql(personData)}'::jsonb)
                   RETURNING id`
                );
                personId = result[0].id as string;
                personsCreated++;
              }
              personCache.set(cacheKey, personId);
            } else {
              personsSkipped++;
            }

            // Event als Relation: Person ↔ Firma
            const position = officer.position ?? "unbekannt";
            const eventPayload: Record<string, unknown> = {
              firma_id: firmaId,
              firma_name: c.name ?? "",
              position,
            };
            if (officer.start_date) eventPayload.seit = officer.start_date;
            if (officer.end_date) eventPayload.bis = officer.end_date;
            if (officer.other_attributes?.dismissed)
              eventPayload.abberufen = true;

            const payloadEsc = escapeJsonForSql(eventPayload);
            const dateSql = officer.start_date
              ? `'${escapeString(officer.start_date)}'`
              : "NULL";

            eventInserts.push(
              `('${personId}', 'person_rolle', ${dateSql}, '${payloadEsc}'::jsonb, NULL, 'offeneregister')`
            );
            eventsCreated++;

            // Events batch-weise einfügen
            if (eventInserts.length >= BATCH_SIZE) {
              await db.unsafe(
                `INSERT INTO events (entity_id, event_type, event_date, payload, raw_text, source)
                 VALUES ${eventInserts.join(",\n")}`
              );
              eventInserts = [];
            }
          }
        } catch {
          errors++;
        }

        // Fortschritt loggen
        if (processed % PROGRESS_INTERVAL === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = Math.round(processed / elapsed);
          console.log(
            `[Persons] ${processed.toLocaleString("de-DE")} Zeilen | ${personsCreated.toLocaleString("de-DE")} Personen | ${eventsCreated.toLocaleString("de-DE")} Events | ${firmenNotFound.toLocaleString("de-DE")} Firmen nicht gefunden | ${rate}/s`
          );
          await db.unsafe(
            `UPDATE import_runs SET stats = '${escapeJsonForSql({
              processed,
              personsCreated,
              personsSkipped,
              eventsCreated,
              firmenNotFound,
              errors,
              personCacheSize: personCache.size,
              rate_per_sec: rate,
              elapsed_seconds: Math.round(elapsed),
            })}'::jsonb WHERE id = '${importRunId}'`
          );
        }
      }
    }

    // Rest-Events einfügen
    if (eventInserts.length > 0) {
      await db.unsafe(
        `INSERT INTO events (entity_id, event_type, event_date, payload, raw_text, source)
         VALUES ${eventInserts.join(",\n")}`
      );
    }

    // Auf Prozess-Ende warten
    const curlExit = await curl.exited;
    const bzcatExit = await bzcat.exited;

    if (curlExit !== 0) {
      const stderrText = await new Response(curl.stderr).text();
      throw new Error(
        `curl beendet mit Exit-Code ${curlExit}: ${stderrText.slice(0, 500)}`
      );
    }
    if (bzcatExit !== 0) {
      const stderrText = await new Response(bzcat.stderr).text();
      throw new Error(
        `bzcat beendet mit Exit-Code ${bzcatExit}: ${stderrText.slice(0, 500)}`
      );
    }

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(
      `[Persons] Fertig! ${personsCreated.toLocaleString("de-DE")} Personen, ${eventsCreated.toLocaleString("de-DE")} Events in ${Math.round(elapsed)}s`
    );

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${escapeJsonForSql({
         processed,
         personsCreated,
         personsSkipped,
         eventsCreated,
         firmenNotFound,
         errors,
         personCacheSize: personCache.size,
         elapsed_seconds: Math.round(elapsed),
       })}'::jsonb WHERE id = '${importRunId}'`
    );
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Unbekannter Fehler";
    console.error(`[Persons] FEHLER: ${errorMsg}`);

    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${escapeString(errorMsg.slice(0, 1000))}',
       stats = '${escapeJsonForSql({
         processed,
         personsCreated,
         personsSkipped,
         eventsCreated,
         firmenNotFound,
         errors,
         personCacheSize: personCache.size,
         elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
       })}'::jsonb WHERE id = '${importRunId}'`
    );

    throw err;
  }
}

/**
 * Server-seitiger OffeneRegister-Import (v2 — robust, streaming).
 *
 * Strategie:
 *   curl (mit Speed-Limit, Retry, Timeout) → bzcat → zeilenweise parsen → Batch-Insert
 *
 * Kein Zwischenspeichern der vollen Datei nötig — alles wird gestreamt.
 * Fortschritt wird regelmäßig in import_runs geschrieben.
 */
import { getDb } from "../db/connection";
import { escapeString, escapeJsonForSql } from "../db/helpers";
import { extractRechtsform } from "../resolver/name-normalizer";

const DOWNLOAD_URL =
  "https://daten.offeneregister.de/de_companies_ocdata.jsonl.bz2";
const BATCH_SIZE = 1000;
const PROGRESS_INTERVAL = 50_000; // Fortschritt alle 50k Zeilen in DB schreiben

const BUNDESLAND_MAP: Record<string, string> = {
  "Baden-Württemberg": "Baden-Württemberg",
  "Baden-Wuerttemberg": "Baden-Württemberg",
  Bavaria: "Bayern",
  Berlin: "Berlin",
  Brandenburg: "Brandenburg",
  Bremen: "Bremen",
  Hamburg: "Hamburg",
  Hesse: "Hessen",
  "Lower Saxony": "Niedersachsen",
  "Mecklenburg-Western Pomerania": "Mecklenburg-Vorpommern",
  "Mecklenburg-Vorpommern": "Mecklenburg-Vorpommern",
  "North Rhine-Westphalia": "Nordrhein-Westfalen",
  "Rhineland-Palatinate": "Rheinland-Pfalz",
  Saarland: "Saarland",
  Saxony: "Sachsen",
  "Saxony-Anhalt": "Sachsen-Anhalt",
  "Schleswig-Holstein": "Schleswig-Holstein",
  Thuringia: "Thüringen",
};

/**
 * Hauptfunktion: Streaming-Import von OffeneRegister.
 * curl → bzcat → parse → batch-insert
 */
export async function importOffeneRegister() {
  const db = getDb();

  // Zuerst hängende Imports aufräumen
  await db.unsafe(
    `UPDATE import_runs SET status = 'failed', finished_at = now(), error = 'Automatisch abgebrochen (Neustart)'
     WHERE status = 'running' AND source LIKE '%offeneregister%'`
  );

  console.log("[Import] Starte OffeneRegister Streaming-Import...");

  const importRunResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('offeneregister-server', 'running') RETURNING id`
  );
  const importRunId = importRunResult[0]?.id as string;

  const startTime = Date.now();
  let processed = 0;
  let inserted = 0;
  let errors = 0;

  try {
    // curl mit robusten Optionen:
    //   --speed-limit 1000  → Abbruch wenn <1KB/s
    //   --speed-time 30     → ... für 30 Sekunden
    //   --retry 5           → 5 Versuche
    //   --retry-delay 5     → 5s zwischen Retries
    //   --connect-timeout 30
    //   --max-time 3600     → max 1h für den gesamten Download
    const curl = Bun.spawn(
      [
        "curl",
        "-sS", // silent aber Fehler anzeigen
        "-L", // Redirects folgen
        "-f", // Fail on HTTP errors
        "--speed-limit", "10000", // Min 10KB/s
        "--speed-time", "60", // Für 60s
        "--retry", "5",
        "--retry-delay", "5",
        "--retry-max-time", "300", // Max 5min für Retries
        "--connect-timeout", "30",
        "--max-time", "7200", // Max 2h gesamt
        DOWNLOAD_URL,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // bzcat liest von curl's stdout und dekomprimiert
    const bzcat = Bun.spawn(["bzcat"], {
      stdin: curl.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });

    console.log("[Import] Download + Dekompression gestartet (Streaming)...");

    // Zeilenweise lesen aus bzcat's stdout
    const reader = bzcat.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firmenBatch: string[] = [];

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
          const attrs = c.all_attributes ?? {};
          const data: Record<string, unknown> = {
            rechtsform: extractRechtsform(c.name ?? ""),
            sitz: attrs.registered_office ?? "",
            bundesland:
              BUNDESLAND_MAP[attrs.federal_state ?? ""] ??
              attrs.federal_state ??
              "",
            status:
              c.current_status === "currently registered"
                ? "aktiv"
                : c.current_status === "liquidation"
                  ? "in Liquidation"
                  : c.current_status ?? "unbekannt",
            registerArt: attrs._registerArt ?? "",
            registerNummer: attrs._registerNummer ?? "",
            gericht: attrs.registrar ?? "",
            adresse: c.registered_address || undefined,
            or_company_number: c.company_number,
            native_company_number: attrs.native_company_number || undefined,
          };
          if (c.previous_names?.length) {
            data.fruehere_namen = c.previous_names.map(
              (p: { company_name: string }) => p.company_name
            );
          }
          if (c.officers?.length) data.officer_count = c.officers.length;

          const name = escapeString(c.name ?? "Unbekannt");
          const jsonStr = escapeJsonForSql(data);
          firmenBatch.push(`('firma', '${name}', '${jsonStr}'::jsonb)`);
          inserted++;
        } catch {
          errors++;
        }

        // Batch-Insert
        if (firmenBatch.length >= BATCH_SIZE) {
          await db.unsafe(
            `INSERT INTO entities (entity_type, canonical_name, data) VALUES ${firmenBatch.join(",\n")}`
          );
          firmenBatch = [];
        }

        // Fortschritt loggen + in DB schreiben
        if (processed % PROGRESS_INTERVAL === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = Math.round(processed / elapsed);
          console.log(
            `[Import] ${processed.toLocaleString("de-DE")} verarbeitet (${rate}/s, ${inserted.toLocaleString("de-DE")} eingefügt, ${errors} Fehler)`
          );
          await db.unsafe(
            `UPDATE import_runs SET stats = '${escapeJsonForSql({
              processed,
              inserted,
              errors,
              rate_per_sec: rate,
              elapsed_seconds: Math.round(elapsed),
            })}'::jsonb WHERE id = '${importRunId}'`
          );
        }
      }
    }

    // Restliche Batch-Daten einfügen
    if (firmenBatch.length > 0) {
      await db.unsafe(
        `INSERT INTO entities (entity_type, canonical_name, data) VALUES ${firmenBatch.join(",\n")}`
      );
    }

    // Warte auf Prozess-Beendigung
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

    // Phase 2: Identifier
    console.log("[Import] Phase 2: Identifier erstellen...");
    await db.unsafe(`
      INSERT INTO entity_identifiers (entity_id, id_type, id_value, qualifier, source)
      SELECT e.id, 'register_nr',
             (e.data->>'registerArt') || ' ' || (e.data->>'registerNummer'),
             e.data->>'gericht', 'offeneregister'
      FROM entities e
      WHERE e.entity_type = 'firma'
        AND e.data->>'registerNummer' IS NOT NULL AND e.data->>'registerNummer' != ''
        AND e.data->>'gericht' IS NOT NULL AND e.data->>'gericht' != ''
      ON CONFLICT (id_type, id_value, qualifier) DO NOTHING
    `);

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(
      `[Import] Fertig! ${inserted.toLocaleString("de-DE")} Firmen in ${Math.round(elapsed)}s`
    );

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${escapeJsonForSql({
         processed,
         inserted,
         errors,
         elapsed_seconds: Math.round(elapsed),
       })}'::jsonb WHERE id = '${importRunId}'`
    );
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Unbekannter Fehler";
    console.error(`[Import] FEHLER: ${errorMsg}`);

    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${escapeString(errorMsg.slice(0, 1000))}',
       stats = '${escapeJsonForSql({
         processed,
         inserted,
         errors,
         elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
       })}'::jsonb WHERE id = '${importRunId}'`
    );

    throw err;
  }
}

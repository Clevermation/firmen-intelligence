/**
 * Server-seitiger OffeneRegister-Import.
 * Wird über /api/import/offeneregister getriggert.
 * Lädt die JSONL-Datei herunter und importiert sie.
 */
import { getDb } from "../db/connection";
import { escapeString, escapeJsonForSql } from "../db/helpers";
import { extractRechtsform } from "../resolver/name-normalizer";

const DOWNLOAD_URL = "https://daten.offeneregister.de/de_companies_ocdata.jsonl.bz2";
const BATCH_SIZE = 500;

const BUNDESLAND_MAP: Record<string, string> = {
  "Baden-Württemberg": "Baden-Württemberg", "Baden-Wuerttemberg": "Baden-Württemberg",
  Bavaria: "Bayern", Berlin: "Berlin", Brandenburg: "Brandenburg", Bremen: "Bremen",
  Hamburg: "Hamburg", Hesse: "Hessen", "Lower Saxony": "Niedersachsen",
  "Mecklenburg-Western Pomerania": "Mecklenburg-Vorpommern",
  "Mecklenburg-Vorpommern": "Mecklenburg-Vorpommern",
  "North Rhine-Westphalia": "Nordrhein-Westfalen",
  "Rhineland-Palatinate": "Rheinland-Pfalz", Saarland: "Saarland",
  Saxony: "Sachsen", "Saxony-Anhalt": "Sachsen-Anhalt",
  "Schleswig-Holstein": "Schleswig-Holstein", Thuringia: "Thüringen",
};

export async function importOffeneRegister() {
  const db = getDb();
  console.log("[Server-Import] Starte OffeneRegister-Download...");

  await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('offeneregister-server', 'running')`
  );

  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) throw new Error(`Download fehlgeschlagen: ${response.status}`);

  // Dekompress via bzcat
  const tmpBz2 = "/tmp/or_download.jsonl.bz2";
  const tmpJsonl = "/tmp/or_download.jsonl";
  await Bun.write(tmpBz2, response);
  console.log("[Server-Import] Download abgeschlossen, dekomprimiere...");

  const decompress = Bun.spawn(["bzcat", tmpBz2], { stdout: Bun.file(tmpJsonl) });
  await decompress.exited;
  console.log("[Server-Import] Dekompression fertig, starte Import...");

  const reader = Bun.file(tmpJsonl).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let firmenBatch: string[] = [];
  let processed = 0;
  let inserted = 0;
  let errors = 0;
  const startTime = Date.now();

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
          bundesland: BUNDESLAND_MAP[attrs.federal_state ?? ""] ?? attrs.federal_state ?? "",
          status: c.current_status === "currently registered" ? "aktiv" :
                  c.current_status === "liquidation" ? "in Liquidation" :
                  c.current_status ?? "unbekannt",
          registerArt: attrs._registerArt ?? "",
          registerNummer: attrs._registerNummer ?? "",
          gericht: attrs.registrar ?? "",
          adresse: c.registered_address || undefined,
          or_company_number: c.company_number,
          native_company_number: attrs.native_company_number || undefined,
        };
        if (c.previous_names?.length) {
          data.fruehere_namen = c.previous_names.map((p: { company_name: string }) => p.company_name);
        }
        if (c.officers?.length) data.officer_count = c.officers.length;

        const name = escapeString(c.name ?? "Unbekannt");
        const jsonStr = escapeJsonForSql(data);
        firmenBatch.push(`('firma', '${name}', '${jsonStr}'::jsonb)`);
        inserted++;
      } catch {
        errors++;
      }

      if (firmenBatch.length >= BATCH_SIZE) {
        await db.unsafe(
          `INSERT INTO entities (entity_type, canonical_name, data) VALUES ${firmenBatch.join(",\n")}`
        );
        firmenBatch = [];
      }

      if (processed % 100000 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`[Server-Import] ${processed.toLocaleString("de-DE")} (${Math.round(processed / elapsed)}/s)`);
      }
    }
  }

  if (firmenBatch.length > 0) {
    await db.unsafe(
      `INSERT INTO entities (entity_type, canonical_name, data) VALUES ${firmenBatch.join(",\n")}`
    );
  }

  // Identifier Phase
  console.log("[Server-Import] Phase 2: Identifier...");
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
  console.log(`[Server-Import] Fertig! ${inserted.toLocaleString("de-DE")} in ${Math.round(elapsed)}s`);

  await db.unsafe(
    `UPDATE import_runs SET status = 'completed', finished_at = now(),
     stats = '${escapeJsonForSql({ processed, inserted, errors, elapsed_seconds: Math.round(elapsed) })}'::jsonb
     WHERE source = 'offeneregister-server' AND status = 'running'`
  );

  // Cleanup
  try {
    const { unlinkSync } = require("fs");
    unlinkSync(tmpBz2);
    unlinkSync(tmpJsonl);
  } catch {}
}

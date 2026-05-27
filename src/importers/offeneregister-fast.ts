#!/usr/bin/env bun
/**
 * Schneller OffeneRegister-Importer.
 * Phase 1: Nur Firmen importieren (Batch-Insert, ~5.3M)
 * Phase 2: Personen + Graph-Edges können danach laufen
 */
import { getDb, closeDb } from "../db/connection";
import { escapeString, escapeJsonForSql } from "../db/helpers";
import { extractRechtsform } from "../resolver/name-normalizer";

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

const BATCH_SIZE = 500;

async function main() {
  const filePath = process.argv[2] ?? "data/de_companies.jsonl";
  const db = getDb();

  // Import-Run anlegen
  await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('offeneregister-fast', 'running')`
  );

  // Streaming-Lese für große Dateien
  const proc = Bun.spawn(["wc", "-l", filePath], { stdout: "pipe" });
  const wcOutput = await new Response(proc.stdout).text();
  const totalLines = parseInt(wcOutput.trim().split(/\s+/)[0], 10);

  console.log(`[Fast-Import] ${totalLines.toLocaleString("de-DE")} Zeilen zu verarbeiten`);

  let firmenBatch: string[] = [];
  let identBatch: string[] = [];
  let processed = 0;
  let inserted = 0;
  let errors = 0;
  const startTime = Date.now();

  const reader = Bun.file(filePath).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
      const registerArt = attrs._registerArt ?? "";
      const registerNummer = attrs._registerNummer ?? "";
      const gericht = attrs.registrar ?? "";
      const sitz = attrs.registered_office ?? "";
      const bundesland = BUNDESLAND_MAP[attrs.federal_state ?? ""] ?? attrs.federal_state ?? "";
      const rechtsform = extractRechtsform(c.name ?? "");
      const status = c.current_status === "currently registered" ? "aktiv" :
                     c.current_status === "liquidation" ? "in Liquidation" :
                     c.current_status ?? "unbekannt";

      const data: Record<string, unknown> = {
        rechtsform, sitz, bundesland, status, registerArt, registerNummer, gericht,
        adresse: c.registered_address || undefined,
        native_company_number: attrs.native_company_number || undefined,
        or_company_number: c.company_number,
      };

      if (c.previous_names?.length) {
        data.fruehere_namen = c.previous_names.map((p: { company_name: string }) => p.company_name);
      }

      // Officer-Count speichern für spätere Verarbeitung
      if (c.officers?.length) {
        data.officer_count = c.officers.length;
      }

      const name = escapeString(c.name ?? "Unbekannt");
      const jsonStr = escapeJsonForSql(data);
      firmenBatch.push(`('firma', '${name}', '${jsonStr}'::jsonb)`);

      // Identifier vorbereiten
      const firmaIdx = inserted + firmenBatch.length;
      if (registerNummer && gericht) {
        const idValue = escapeString(`${registerArt} ${registerNummer}`.trim());
        const qual = escapeString(gericht);
        identBatch.push(`(currval, 'register_nr', '${idValue}', '${qual}', 'offeneregister')`);
      }

      inserted++;
    } catch {
      errors++;
    }

    // Batch einfügen
    if (firmenBatch.length >= BATCH_SIZE) {
      await flushBatch(db, firmenBatch);
      firmenBatch = [];
      identBatch = [];
    }

    if (processed % 50000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = Math.round(processed / elapsed);
      const eta = Math.round((totalLines - processed) / rate);
      console.log(
        `[Fast-Import] ${processed.toLocaleString("de-DE")}/${totalLines.toLocaleString("de-DE")} (${rate}/s, ETA: ${Math.round(eta / 60)}min) | Fehler: ${errors}`
      );
    }
    }
  }

  // Rest einfügen
  if (firmenBatch.length > 0) {
    await flushBatch(db, firmenBatch);
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n[Fast-Import] Abgeschlossen in ${Math.round(elapsed)}s`);
  console.log(`  Verarbeitet: ${processed.toLocaleString("de-DE")}`);
  console.log(`  Eingefügt: ${inserted.toLocaleString("de-DE")}`);
  console.log(`  Fehler: ${errors}`);
  console.log(`  Rate: ${Math.round(inserted / elapsed)}/s`);

  // Import-Run aktualisieren
  await db.unsafe(
    `UPDATE import_runs SET status = 'completed', finished_at = now(),
     stats = '${escapeString(JSON.stringify({ processed, inserted, errors, elapsed_seconds: Math.round(elapsed) }))}'::jsonb
     WHERE source = 'offeneregister-fast' AND status = 'running'`
  );

  // Identifier in einem zweiten Durchlauf mit COPY-artigem Batch-Insert
  console.log("\n[Fast-Import] Phase 2: Register-Nr-Identifier...");
  const identResult = await db.unsafe(`
    INSERT INTO entity_identifiers (entity_id, id_type, id_value, qualifier, source)
    SELECT e.id, 'register_nr',
           (e.data->>'registerArt') || ' ' || (e.data->>'registerNummer'),
           e.data->>'gericht',
           'offeneregister'
    FROM entities e
    WHERE e.entity_type = 'firma'
      AND e.data->>'registerNummer' IS NOT NULL
      AND e.data->>'registerNummer' != ''
      AND e.data->>'gericht' IS NOT NULL
      AND e.data->>'gericht' != ''
    ON CONFLICT (id_type, id_value, qualifier) DO NOTHING
  `);
  console.log(`[Fast-Import] Identifier angelegt.`);

  // OR-Company-Number Identifier
  await db.unsafe(`
    INSERT INTO entity_identifiers (entity_id, id_type, id_value, qualifier, source)
    SELECT e.id, 'or_company_number', e.data->>'or_company_number', NULL, 'offeneregister'
    FROM entities e
    WHERE e.entity_type = 'firma'
      AND e.data->>'or_company_number' IS NOT NULL
      AND e.data->>'or_company_number' != ''
    ON CONFLICT (id_type, id_value, qualifier) DO NOTHING
  `);
  console.log(`[Fast-Import] OR-Company-Number-Identifier angelegt.`);

  await closeDb();
}

async function flushBatch(db: ReturnType<typeof getDb>, batch: string[]) {
  if (batch.length === 0) return;
  const values = batch.join(",\n");
  await db.unsafe(
    `INSERT INTO entities (entity_type, canonical_name, data) VALUES ${values}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

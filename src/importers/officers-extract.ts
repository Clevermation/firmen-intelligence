#!/usr/bin/env bun
/**
 * Phase 2: Officers/Personen aus OffeneRegister-JSONL extrahieren.
 * Setzt voraus, dass Firmen bereits importiert sind (offeneregister-fast.ts).
 * Erstellt Person-Entities und Graph-Edges (Person→Firma).
 */
import { getDb, initAGE, closeDb } from "../db/connection";
import { escapeString, escapeJsonForSql } from "../db/helpers";

const POSITION_TO_RELATION: Record<string, string> = {
  "Geschäftsführer": "geschaeftsfuehrer_von",
  "Geschäftsführerin": "geschaeftsfuehrer_von",
  "Vorstand": "vorstand_von",
  "Vorstandsmitglied": "vorstand_von",
  "Vorstandsvorsitzender": "vorstand_von",
  "Prokurist": "prokurist_von",
  "Prokuristin": "prokurist_von",
  "Liquidator": "liquidator_von",
  "Liquidatorin": "liquidator_von",
  "Inhaber": "inhaber_von",
  "Inhaberin": "inhaber_von",
  "Persönlich haftender Gesellschafter": "gesellschafter_von",
  "Persönlich haftende Gesellschafterin": "gesellschafter_von",
};

async function main() {
  const filePath = process.argv[2] ?? "data/de_companies.jsonl";
  const db = getDb();

  console.log("[Officers] Phase 2: Personen + Graph-Edges extrahieren");
  console.log(`[Officers] Lese ${filePath}...`);

  await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('officers-extract', 'running')`
  );

  const reader = Bun.file(filePath).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let processed = 0;
  let personsCreated = 0;
  let edgesCreated = 0;
  let firmenMatched = 0;
  let errors = 0;
  const startTime = Date.now();

  // Person-Lookup-Cache (Name+Stadt → ID)
  const personCache = new Map<string, string>();

  // Batch für Personen-Inserts
  let personBatch: string[] = [];
  const PERSON_BATCH_SIZE = 500;

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

        // Firma-ID finden über or_company_number
        const orNum = c.company_number;
        const firma = await db.unsafe(
          `SELECT entity_id FROM entity_identifiers
           WHERE id_type = 'or_company_number' AND id_value = '${escapeString(orNum)}'
           LIMIT 1`
        );

        if (firma.length === 0) continue;
        const firmaId = firma[0].entity_id as string;
        firmenMatched++;

        for (const officer of c.officers) {
          if (!officer.name || officer.type !== "person") continue;
          const personName = officer.name.trim();
          if (!personName) continue;

          const city = officer.other_attributes?.city ?? "";
          const cacheKey = `${personName.toLowerCase()}|${city.toLowerCase()}`;

          let personId = personCache.get(cacheKey);

          if (!personId) {
            // Person in DB suchen
            const existing = city
              ? await db.unsafe(
                  `SELECT id FROM entities
                   WHERE entity_type = 'person'
                     AND lower(canonical_name) = lower('${escapeString(personName)}')
                     AND data->>'wohnort' = '${escapeString(city)}'
                   LIMIT 1`
                )
              : await db.unsafe(
                  `SELECT id FROM entities
                   WHERE entity_type = 'person'
                     AND lower(canonical_name) = lower('${escapeString(personName)}')
                   LIMIT 1`
                );

            if (existing.length > 0) {
              personId = existing[0].id as string;
            } else {
              // Neue Person anlegen
              const personData: Record<string, unknown> = {};
              if (city) personData.wohnort = city;
              if (officer.other_attributes?.firstname) personData.vorname = officer.other_attributes.firstname;
              if (officer.other_attributes?.lastname) personData.nachname = officer.other_attributes.lastname;

              const nameEsc = escapeString(personName);
              const jsonEsc = escapeJsonForSql(personData);
              const result = await db.unsafe(
                `INSERT INTO entities (entity_type, canonical_name, data)
                 VALUES ('person', '${nameEsc}', '${jsonEsc}'::jsonb)
                 RETURNING id`
              );
              personId = result[0].id as string;
              personsCreated++;
            }
            personCache.set(cacheKey, personId);
          }

          // Graph-Edge anlegen
          const relType = POSITION_TO_RELATION[officer.position] ?? "verbunden_mit";
          try {
            await initAGE();
            const propsArr: string[] = [];
            if (officer.position) propsArr.push(`position: '${escapeString(officer.position)}'`);
            if (officer.start_date) propsArr.push(`seit: '${officer.start_date}'`);
            if (officer.end_date) propsArr.push(`bis: '${officer.end_date}'`);
            if (officer.other_attributes?.dismissed) propsArr.push(`abberufen: true`);
            const propsClause = propsArr.length > 0 ? ` {${propsArr.join(", ")}}` : "";

            await db.unsafe(
              `SELECT * FROM cypher('firmen_graph', $$
                MERGE (p {entity_id: '${personId}'})
                MERGE (f {entity_id: '${firmaId}'})
                CREATE (p)-[:${relType}${propsClause}]->(f)
              $$) as (e agtype)`
            );
            edgesCreated++;
          } catch {
            // Graph-Edge-Fehler nicht den Import blockieren lassen
          }
        }
      } catch {
        errors++;
      }

      if (processed % 100000 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = Math.round(processed / elapsed);
        console.log(
          `[Officers] ${processed.toLocaleString("de-DE")} verarbeitet | ${personsCreated.toLocaleString("de-DE")} Personen | ${edgesCreated.toLocaleString("de-DE")} Edges | ${firmenMatched.toLocaleString("de-DE")} Firmen gematcht | ${rate}/s`
        );
      }
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n[Officers] Abgeschlossen in ${Math.round(elapsed)}s`);
  console.log(`  Verarbeitet: ${processed.toLocaleString("de-DE")}`);
  console.log(`  Firmen gematcht: ${firmenMatched.toLocaleString("de-DE")}`);
  console.log(`  Personen erstellt: ${personsCreated.toLocaleString("de-DE")}`);
  console.log(`  Graph-Edges: ${edgesCreated.toLocaleString("de-DE")}`);
  console.log(`  Person-Cache-Size: ${personCache.size.toLocaleString("de-DE")}`);
  console.log(`  Fehler: ${errors}`);

  await db.unsafe(
    `UPDATE import_runs SET status = 'completed', finished_at = now(),
     stats = '${escapeJsonForSql({ processed, firmenMatched, personsCreated, edgesCreated, personCacheSize: personCache.size, errors, elapsed_seconds: Math.round(elapsed) })}'::jsonb
     WHERE source = 'officers-extract' AND status = 'running'`
  );

  await closeDb();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

import { getDb, initAGE, closeDb } from "../db/connection";
import { insertEntity, insertIdentifier } from "../db/helpers";
import { extractRechtsform } from "../resolver/name-normalizer";

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

const POSITION_TO_RELATION: Record<string, string> = {
  Geschäftsführer: "geschaeftsfuehrer_von",
  Geschäftsführerin: "geschaeftsfuehrer_von",
  Vorstand: "vorstand_von",
  Vorstandsmitglied: "vorstand_von",
  Prokurist: "prokurist_von",
  Prokuristin: "prokurist_von",
  Liquidator: "liquidator_von",
  Liquidatorin: "liquidator_von",
  Inhaber: "inhaber_von",
  Inhaberin: "inhaber_von",
  "Persönlich haftender Gesellschafter": "gesellschafter_von",
  "Persönlich haftende Gesellschafterin": "gesellschafter_von",
};

interface ORCompany {
  name: string;
  company_number: string;
  current_status: string;
  registered_address: string;
  all_attributes?: {
    registrar?: string;
    _registerArt?: string;
    _registerNummer?: string;
    native_company_number?: string;
    registered_office?: string;
    federal_state?: string;
  };
  officers?: OROffice[];
  previous_names?: { company_name: string }[];
}

interface OROffice {
  name: string;
  type: string;
  position: string;
  start_date?: string;
  end_date?: string;
  other_attributes?: {
    firstname?: string;
    lastname?: string;
    city?: string;
    dismissed?: boolean;
    flag?: string;
  };
}

export async function importOffeneRegister(filePath: string) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('offeneregister', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let entitiesCreated = 0;
  let personsCreated = 0;
  let edgesCreated = 0;
  let processed = 0;
  let errors = 0;

  console.log(`[OffeneRegister] Starte Import von ${filePath}`);

  try {
    const isCompressed = filePath.endsWith(".bz2");
    let lineStream: ReadableStream<string>;

    if (isCompressed) {
      const proc = Bun.spawn(["bzcat", filePath], { stdout: "pipe" });
      lineStream = proc.stdout as unknown as ReadableStream<string>;
    } else {
      lineStream = Bun.file(filePath).stream() as unknown as ReadableStream<string>;
    }

    const decoder = new TextDecoder();
    const reader = (lineStream as ReadableStream<Uint8Array>).getReader();
    let buffer = "";

    // Batch-Arrays
    const BATCH_SIZE = 500;
    let firmaBatch: unknown[][] = [];
    let identBatch: unknown[][] = [];
    let personBatch: unknown[][] = [];
    let edgeBatch: { fromId: string; toId: string; relType: string; props: Record<string, unknown> }[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        processed++;

        try {
          const company = JSON.parse(line) as ORCompany;
          const attrs = company.all_attributes ?? {};

          const registerArt = attrs._registerArt ?? "";
          const registerNummer = attrs._registerNummer ?? "";
          const gericht = attrs.registrar ?? "";
          const sitz = attrs.registered_office ?? "";
          const bundesland = BUNDESLAND_MAP[attrs.federal_state ?? ""] ?? attrs.federal_state ?? "";
          const rechtsform = extractRechtsform(company.name);
          const status = company.current_status === "currently registered" ? "aktiv" :
                         company.current_status === "liquidation" ? "in Liquidation" :
                         company.current_status ?? "unbekannt";

          const data: Record<string, unknown> = {
            rechtsform,
            sitz,
            bundesland,
            status,
            registerArt,
            registerNummer,
            gericht,
            adresse: company.registered_address || undefined,
            native_company_number: attrs.native_company_number || undefined,
            or_company_number: company.company_number,
          };

          if (company.previous_names?.length) {
            data.fruehere_namen = company.previous_names.map((p) => p.company_name);
          }

          // Firma einfügen
          const firmaId = await insertEntity("firma", company.name, data);
          entitiesCreated++;

          // Register-Nr Identifier
          if (registerNummer && gericht) {
            const idValue = `${registerArt} ${registerNummer}`.trim();
            await insertIdentifier(firmaId, "register_nr", idValue, gericht, "offeneregister");
          }

          // OR-Company-Number als Identifier
          if (company.company_number) {
            await insertIdentifier(firmaId, "or_company_number", company.company_number, null, "offeneregister");
          }

          // Officers (Personen) verarbeiten
          if (company.officers) {
            for (const officer of company.officers) {
              if (!officer.name || officer.type !== "person") continue;

              const personName = officer.name.trim();
              if (!personName) continue;

              const personData: Record<string, unknown> = {};
              if (officer.other_attributes?.city) personData.wohnort = officer.other_attributes.city;
              if (officer.other_attributes?.firstname) personData.vorname = officer.other_attributes.firstname;
              if (officer.other_attributes?.lastname) personData.nachname = officer.other_attributes.lastname;

              // Person finden oder erstellen (via Name + Wohnort)
              let personId: string;
              const city = officer.other_attributes?.city ?? "";
              const existingPerson = city
                ? await db.unsafe(
                    `SELECT id FROM entities
                     WHERE entity_type = 'person'
                       AND lower(canonical_name) = lower($1)
                       AND data->>'wohnort' = $2
                     LIMIT 1`,
                    [personName, city]
                  )
                : await db.unsafe(
                    `SELECT id FROM entities
                     WHERE entity_type = 'person'
                       AND lower(canonical_name) = lower($1)
                     LIMIT 1`,
                    [personName]
                  );

              if (existingPerson.length > 0) {
                personId = existingPerson[0].id as string;
              } else {
                personId = await insertEntity("person", personName, personData);
                personsCreated++;
              }

              // Graph-Edge für die Beziehung
              const relType = POSITION_TO_RELATION[officer.position] ?? "verbunden_mit";
              const props: Record<string, unknown> = {};
              if (officer.start_date) props.seit = officer.start_date;
              if (officer.end_date) props.bis = officer.end_date;
              if (officer.position) props.position = officer.position;
              if (officer.other_attributes?.dismissed) props.abberufen = true;

              edgeBatch.push({ fromId: personId, toId: firmaId, relType, props });
              edgesCreated++;
            }
          }
        } catch (e) {
          errors++;
          if (errors <= 10) {
            console.error(`[OffeneRegister] Fehler Zeile ${processed}:`, (e as Error).message);
          }
        }

        // Fortschritts-Log alle 10.000 Einträge
        if (processed % 10000 === 0) {
          console.log(
            `[OffeneRegister] ${processed} verarbeitet | ${entitiesCreated} Firmen | ${personsCreated} Personen | ${errors} Fehler`
          );
        }

        // Graph-Edges in Batches schreiben (alle 200)
        if (edgeBatch.length >= 200) {
          await flushGraphEdges(db, edgeBatch);
          edgeBatch = [];
        }
      }
    }

    // Rest verarbeiten
    if (buffer.trim()) {
      processed++;
    }
    if (edgeBatch.length > 0) {
      await flushGraphEdges(db, edgeBatch);
    }

    // Import-Run abschließen
    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = $1 WHERE id = $2`,
      [
        JSON.stringify({
          processed,
          entities_created: entitiesCreated,
          persons_created: personsCreated,
          edges_created: edgesCreated,
          errors,
        }),
        runId,
      ]
    );

    console.log(`[OffeneRegister] Import abgeschlossen!`);
    console.log(`  Verarbeitet: ${processed}`);
    console.log(`  Firmen erstellt: ${entitiesCreated}`);
    console.log(`  Personen erstellt: ${personsCreated}`);
    console.log(`  Graph-Edges: ${edgesCreated}`);
    console.log(`  Fehler: ${errors}`);
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(), error = $1 WHERE id = $2`,
      [(e as Error).message, runId]
    );
    throw e;
  }
}

async function flushGraphEdges(
  db: ReturnType<typeof getDb>,
  edges: { fromId: string; toId: string; relType: string; props: Record<string, unknown> }[]
) {
  await initAGE();

  for (const edge of edges) {
    try {
      const propsEntries = Object.entries(edge.props)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? `'${String(v).replace(/'/g, "''")}'` : v}`)
        .join(", ");
      const propsClause = propsEntries ? ` {${propsEntries}}` : "";

      await db.unsafe(
        `SELECT * FROM cypher('firmen_graph', $$
          MERGE (a {entity_id: '${edge.fromId}'})
          MERGE (b {entity_id: '${edge.toId}'})
          CREATE (a)-[:${edge.relType}${propsClause}]->(b)
        $$) as (e agtype)`
      );
    } catch {
      // Graph-Edge-Fehler überspringen, um Import nicht zu blockieren
    }
  }
}

// CLI-Aufruf
if (import.meta.main) {
  const filePath = process.argv[2] ?? "data/de_companies.jsonl.bz2";
  console.log(`Starte OffeneRegister-Import: ${filePath}`);
  await importOffeneRegister(filePath);
  await closeDb();
}

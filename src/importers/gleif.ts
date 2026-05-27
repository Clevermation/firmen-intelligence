import { getDb, initAGE, closeDb } from "../db/connection";
import { insertEntity, insertIdentifier } from "../db/helpers";

const GLEIF_API = "https://api.gleif.org/api/v1";

interface GLEIFRecord {
  type: string;
  id: string;
  attributes: {
    lei: string;
    entity: {
      legalName: { name: string };
      legalAddress: {
        addressLines: string[];
        city: string;
        region: string;
        country: string;
        postalCode: string;
      };
      headquartersAddress?: {
        addressLines: string[];
        city: string;
        region: string;
        country: string;
        postalCode: string;
      };
      registeredAs?: string;
      jurisdiction?: string;
      legalForm?: { id: string; other?: string };
      status: string;
      category?: string;
    };
    registration: {
      initialRegistrationDate: string;
      lastUpdateDate: string;
      status: string;
      nextRenewalDate?: string;
    };
  };
}

interface GLEIFRelationship {
  type: string;
  attributes: {
    relationship: {
      startNode: { id: string };
      endNode: { id: string };
      relationshipType: string;
      relationshipStatus: string;
    };
  };
}

export async function importGLEIF(maxPages: number = 100) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('gleif', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  let relationsCreated = 0;
  let page = 1;

  console.log("[GLEIF] Starte Import deutscher LEIs...");

  try {
    // Phase 1: Entitäten importieren
    let hasMore = true;
    while (hasMore && page <= maxPages) {
      const url = `${GLEIF_API}/lei-records?filter[entity.legalAddress.country]=DE&page[size]=200&page[number]=${page}`;
      console.log(`[GLEIF] Seite ${page}...`);

      const response = await fetch(url, {
        headers: { Accept: "application/vnd.api+json" },
      });

      if (!response.ok) {
        console.error(`[GLEIF] API-Fehler: ${response.status}`);
        break;
      }

      const json = (await response.json()) as { data: GLEIFRecord[]; links?: { next?: string } };

      for (const record of json.data) {
        try {
          const entity = record.attributes.entity;
          const addr = entity.legalAddress;
          const registerNr = entity.registeredAs ?? "";

          // Match über Register-Nr
          let entityId: string | null = null;
          if (registerNr) {
            const existing = await db.unsafe(
              `SELECT ei.entity_id FROM entity_identifiers ei
               WHERE ei.id_type = 'register_nr' AND ei.id_value LIKE '%' || '${registerNr.replace(/'/g, "''")}' || '%'
               LIMIT 1`
            );
            if (existing.length > 0) {
              entityId = existing[0].entity_id as string;
              // LEI hinzufügen
              await insertIdentifier(entityId, "lei", record.attributes.lei, null, "gleif");
              entitiesUpdated++;
              continue;
            }
          }

          // Neue Entity erstellen (wenn kein Match)
          const data: Record<string, unknown> = {
            rechtsform: entity.legalForm?.other ?? entity.legalForm?.id ?? "",
            sitz: addr.city,
            plz: addr.postalCode,
            adresse: addr.addressLines.join(", "),
            bundesland: addr.region ?? "",
            status: entity.status === "ACTIVE" ? "aktiv" : entity.status?.toLowerCase() ?? "unbekannt",
            lei: record.attributes.lei,
            registeredAs: registerNr,
            jurisdiction: entity.jurisdiction ?? "",
            erstRegistrierung: record.attributes.registration.initialRegistrationDate,
          };

          entityId = await insertEntity("firma", entity.legalName.name, data);
          entitiesCreated++;

          await insertIdentifier(entityId, "lei", record.attributes.lei, null, "gleif");
          if (registerNr) {
            await insertIdentifier(entityId, "register_nr_gleif", registerNr, null, "gleif");
          }
        } catch (e) {
          console.error(`[GLEIF] Fehler bei LEI ${record.attributes?.lei}:`, (e as Error).message);
        }
      }

      hasMore = !!json.links?.next;
      page++;

      // Rate-Limit: 1 Sekunde Pause zwischen Requests
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Phase 2: Ownership-Beziehungen (Level 2)
    console.log("[GLEIF] Importiere Ownership-Beziehungen...");
    let relPage = 1;
    let relHasMore = true;

    while (relHasMore && relPage <= 50) {
      const url = `${GLEIF_API}/lei-records?filter[entity.legalAddress.country]=DE&page[size]=200&page[number]=${relPage}`;

      try {
        const relUrl = `${GLEIF_API}/relationship-records?filter[relationship.startNode.entity.legalAddress.country]=DE&page[size]=200&page[number]=${relPage}`;
        const response = await fetch(relUrl, {
          headers: { Accept: "application/vnd.api+json" },
        });

        if (!response.ok) break;

        const json = (await response.json()) as { data: GLEIFRelationship[]; links?: { next?: string } };

        for (const rel of json.data) {
          try {
            const r = rel.attributes.relationship;
            if (r.relationshipStatus !== "ACTIVE") continue;

            const parentLei = r.startNode.id;
            const childLei = r.endNode.id;

            // Entitäten finden
            const parent = await db.unsafe(
              `SELECT entity_id FROM entity_identifiers WHERE id_type = 'lei' AND id_value = '${parentLei}' LIMIT 1`
            );
            const child = await db.unsafe(
              `SELECT entity_id FROM entity_identifiers WHERE id_type = 'lei' AND id_value = '${childLei}' LIMIT 1`
            );

            if (parent.length > 0 && child.length > 0) {
              await initAGE();
              const parentId = parent[0].entity_id as string;
              const childId = child[0].entity_id as string;

              await db.unsafe(
                `SELECT * FROM cypher('firmen_graph', $$
                  MERGE (a {entity_id: '${parentId}'})
                  MERGE (b {entity_id: '${childId}'})
                  CREATE (a)-[:beteiligung_an {quelle: 'gleif', typ: '${r.relationshipType}'}]->(b)
                $$) as (e agtype)`
              );
              relationsCreated++;
            }
          } catch {
            // Überspringe fehlerhafte Relationen
          }
        }

        relHasMore = !!json.links?.next;
        relPage++;
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        break;
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({ entities_created: entitiesCreated, entities_updated: entitiesUpdated, relations_created: relationsCreated, pages: page })}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[GLEIF] Import abgeschlossen!`);
    console.log(`  Neue Firmen: ${entitiesCreated}`);
    console.log(`  Aktualisiert (LEI hinzugefügt): ${entitiesUpdated}`);
    console.log(`  Ownership-Beziehungen: ${relationsCreated}`);
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(), error = '${(e as Error).message.replace(/'/g, "''")}' WHERE id = '${runId}'`
    );
    throw e;
  }
}

if (import.meta.main) {
  const maxPages = parseInt(process.argv[2] ?? "100", 10);
  await importGLEIF(maxPages);
  await closeDb();
}

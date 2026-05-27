import { getDb, initAGE } from "../db/connection";
import { normalizeCompanyName } from "./name-normalizer";

interface ResolveResult {
  entityId: string;
  isNew: boolean;
}

export async function resolveOrCreateFirma(opts: {
  name: string;
  registerNr?: string;
  registerArt?: string;
  gericht?: string;
  data?: Record<string, unknown>;
  source: string;
}): Promise<ResolveResult> {
  const db = getDb();

  // Schritt 1: Match über Register-Nr (eindeutigster Identifier)
  if (opts.registerNr && opts.gericht) {
    const qualifier = opts.gericht.trim();
    const idValue = `${opts.registerArt ?? ""}${opts.registerNr}`.trim();

    const existing = await db.unsafe(
      `SELECT e.id FROM entity_identifiers ei
       JOIN entities e ON e.id = ei.entity_id
       WHERE ei.id_type = 'register_nr' AND ei.id_value = $1 AND ei.qualifier = $2
       LIMIT 1`,
      [idValue, qualifier]
    );

    if (existing.length > 0) {
      const entityId = existing[0].id as string;
      await mergeEntityData(entityId, opts.data ?? {});
      return { entityId, isNew: false };
    }
  }

  // Schritt 2: Fuzzy-Match über normalisierten Namen + Sitz
  if (opts.name && opts.data?.sitz) {
    const normalized = normalizeCompanyName(opts.name);
    const fuzzy = await db.unsafe(
      `SELECT id, canonical_name, similarity(lower(canonical_name), $1) as sim
       FROM entities
       WHERE entity_type = 'firma'
         AND data->>'sitz' = $2
         AND similarity(lower(canonical_name), $1) > 0.6
       ORDER BY sim DESC
       LIMIT 1`,
      [normalized, opts.data.sitz as string]
    );

    if (fuzzy.length > 0 && (fuzzy[0].sim as number) > 0.8) {
      const entityId = fuzzy[0].id as string;
      await mergeEntityData(entityId, opts.data ?? {});
      return { entityId, isNew: false };
    }
  }

  // Schritt 3: Neue Entity anlegen
  const result = await db.unsafe(
    `INSERT INTO entities (entity_type, canonical_name, data)
     VALUES ('firma', $1, $2)
     RETURNING id`,
    [opts.name, JSON.stringify(opts.data ?? {})]
  );

  const entityId = result[0].id as string;

  // Identifier anlegen
  if (opts.registerNr && opts.gericht) {
    const idValue = `${opts.registerArt ?? ""}${opts.registerNr}`.trim();
    await db.unsafe(
      `INSERT INTO entity_identifiers (entity_id, id_type, id_value, qualifier, source)
       VALUES ($1, 'register_nr', $2, $3, $4)
       ON CONFLICT (id_type, id_value, qualifier) DO NOTHING`,
      [entityId, idValue, opts.gericht.trim(), opts.source]
    );
  }

  return { entityId, isNew: true };
}

export async function resolveOrCreatePerson(opts: {
  name: string;
  geburtsdatum?: string;
  geburtsort?: string;
  wohnort?: string;
  source: string;
}): Promise<ResolveResult> {
  const db = getDb();

  // Match über Name + Geburtsdatum (eindeutigster Identifier für Personen)
  if (opts.geburtsdatum) {
    const existing = await db.unsafe(
      `SELECT id FROM entities
       WHERE entity_type = 'person'
         AND lower(canonical_name) = lower($1)
         AND data->>'geburtsdatum' = $2
       LIMIT 1`,
      [opts.name.trim(), opts.geburtsdatum]
    );

    if (existing.length > 0) {
      return { entityId: existing[0].id as string, isNew: false };
    }
  }

  // Fallback: Name + Wohnort
  if (opts.wohnort) {
    const existing = await db.unsafe(
      `SELECT id, similarity(lower(canonical_name), lower($1)) as sim FROM entities
       WHERE entity_type = 'person'
         AND similarity(lower(canonical_name), lower($1)) > 0.9
         AND data->>'wohnort' = $2
       ORDER BY sim DESC
       LIMIT 1`,
      [opts.name.trim(), opts.wohnort]
    );

    if (existing.length > 0) {
      return { entityId: existing[0].id as string, isNew: false };
    }
  }

  // Neue Person
  const data: Record<string, unknown> = {};
  if (opts.geburtsdatum) data.geburtsdatum = opts.geburtsdatum;
  if (opts.geburtsort) data.geburtsort = opts.geburtsort;
  if (opts.wohnort) data.wohnort = opts.wohnort;

  const result = await db.unsafe(
    `INSERT INTO entities (entity_type, canonical_name, data)
     VALUES ('person', $1, $2)
     RETURNING id`,
    [opts.name.trim(), JSON.stringify(data)]
  );

  return { entityId: result[0].id as string, isNew: true };
}

export async function createGraphEdge(
  fromEntityId: string,
  toEntityId: string,
  relationType: string,
  properties: Record<string, unknown> = {}
) {
  const db = getDb();
  await initAGE();

  const propsString = Object.entries(properties)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `'${v}'` : v}`)
    .join(", ");

  const propsClause = propsString ? ` {${propsString}}` : "";

  // Erst sicherstellen, dass Nodes existieren
  await db.unsafe(
    `SELECT * FROM cypher('firmen_graph', $$
      MERGE (n {entity_id: '${fromEntityId}'})
    $$) as (v agtype)`
  );
  await db.unsafe(
    `SELECT * FROM cypher('firmen_graph', $$
      MERGE (n {entity_id: '${toEntityId}'})
    $$) as (v agtype)`
  );

  // Edge anlegen
  await db.unsafe(
    `SELECT * FROM cypher('firmen_graph', $$
      MATCH (a {entity_id: '${fromEntityId}'}), (b {entity_id: '${toEntityId}'})
      CREATE (a)-[:${relationType}${propsClause}]->(b)
    $$) as (e agtype)`
  );
}

async function mergeEntityData(entityId: string, newData: Record<string, unknown>) {
  if (Object.keys(newData).length === 0) return;
  const db = getDb();
  await db.unsafe(
    `UPDATE entities SET data = data || $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(newData), entityId]
  );
}

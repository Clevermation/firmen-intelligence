import { getDb } from "../db/connection";

export interface SearchFilters {
  query?: string;
  rechtsform?: string;
  ort?: string;
  bundesland?: string;
  status?: string;
  registerArt?: string;
  gruendungNach?: string;
  limit?: number;
  offset?: number;
}

export async function searchEntities(filters: SearchFilters) {
  const db = getDb();
  const conditions: string[] = ["e.entity_type = 'firma'"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters.query) {
    conditions.push(`e.search_vector @@ plainto_tsquery('german', $${paramIdx})`);
    params.push(filters.query);
    paramIdx++;
  }

  if (filters.rechtsform) {
    conditions.push(`e.data->>'rechtsform' ILIKE $${paramIdx}`);
    params.push(filters.rechtsform);
    paramIdx++;
  }

  if (filters.ort) {
    conditions.push(`e.data->>'sitz' ILIKE $${paramIdx}`);
    params.push(`%${filters.ort}%`);
    paramIdx++;
  }

  if (filters.bundesland) {
    conditions.push(`e.data->>'bundesland' ILIKE $${paramIdx}`);
    params.push(`%${filters.bundesland}%`);
    paramIdx++;
  }

  if (filters.status) {
    conditions.push(`e.data->>'status' = $${paramIdx}`);
    params.push(filters.status);
    paramIdx++;
  }

  if (filters.registerArt) {
    conditions.push(`e.data->>'registerArt' = $${paramIdx}`);
    params.push(filters.registerArt);
    paramIdx++;
  }

  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  const whereClause = conditions.join(" AND ");

  const countResult = await db.unsafe(
    `SELECT count(*) as total FROM entities e WHERE ${whereClause}`,
    params
  );

  const results = await db.unsafe(
    `SELECT e.id, e.canonical_name, e.data, e.first_seen_at, e.updated_at
     FROM entities e
     WHERE ${whereClause}
     ORDER BY e.canonical_name
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  return {
    total: parseInt(countResult[0].total as string, 10),
    results: results.map((r) => ({
      id: r.id,
      name: r.canonical_name,
      data: r.data as Record<string, unknown>,
      firstSeen: r.first_seen_at,
      updated: r.updated_at,
    })),
  };
}

export async function getEntityById(id: string) {
  const db = getDb();

  const entity = await db.unsafe(
    `SELECT e.*, array_agg(DISTINCT jsonb_build_object('type', ei.id_type, 'value', ei.id_value, 'qualifier', ei.qualifier)) as identifiers
     FROM entities e
     LEFT JOIN entity_identifiers ei ON ei.entity_id = e.id
     WHERE e.id = $1
     GROUP BY e.id`,
    [id]
  );

  if (entity.length === 0) return null;

  const events = await db.unsafe(
    `SELECT * FROM events WHERE entity_id = $1 ORDER BY event_date DESC NULLS LAST, created_at DESC LIMIT 50`,
    [id]
  );

  return {
    ...entity[0],
    events,
  };
}

export async function getStats() {
  const db = getDb();

  const entityCounts = await db.unsafe(`
    SELECT entity_type, count(*) as cnt FROM entities GROUP BY entity_type
  `);

  const eventCounts = await db.unsafe(`
    SELECT event_type, count(*) as cnt FROM events GROUP BY event_type ORDER BY cnt DESC
  `);

  const lastImports = await db.unsafe(`
    SELECT source, status, started_at, finished_at, stats
    FROM import_runs ORDER BY started_at DESC LIMIT 10
  `);

  const topRechtsformen = await db.unsafe(`
    SELECT data->>'rechtsform' as rechtsform, count(*) as cnt
    FROM entities WHERE entity_type = 'firma'
    GROUP BY data->>'rechtsform'
    ORDER BY cnt DESC LIMIT 10
  `);

  const topBundeslaender = await db.unsafe(`
    SELECT data->>'bundesland' as bundesland, count(*) as cnt
    FROM entities WHERE entity_type = 'firma'
    GROUP BY data->>'bundesland'
    ORDER BY cnt DESC LIMIT 16
  `);

  return {
    entities: Object.fromEntries(entityCounts.map((r) => [r.entity_type, parseInt(r.cnt as string, 10)])),
    events: Object.fromEntries(eventCounts.map((r) => [r.event_type, parseInt(r.cnt as string, 10)])),
    lastImports,
    topRechtsformen: topRechtsformen.map((r) => ({ rechtsform: r.rechtsform, count: parseInt(r.cnt as string, 10) })),
    topBundeslaender: topBundeslaender.map((r) => ({ bundesland: r.bundesland, count: parseInt(r.cnt as string, 10) })),
  };
}

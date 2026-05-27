import { SQL, sql } from "bun";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://firmendb:firmendb_dev_2026@localhost:5432/firmendb";

let _db: SQL | null = null;

export function getDb(): SQL {
  if (!_db) {
    _db = new SQL(DATABASE_URL);
  }
  return _db;
}

export async function closeDb() {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

export async function initAGE() {
  const db = getDb();
  await db.unsafe("LOAD 'age'");
  await db.unsafe(`SET search_path = ag_catalog, "$user", public`);
}

export async function cypher<T = Record<string, unknown>>(
  query: string,
  returnColumns: { name: string; type?: string }[]
): Promise<T[]> {
  const db = getDb();
  await initAGE();

  const columnDefs = returnColumns
    .map((c) => `${c.name} ${c.type ?? "agtype"}`)
    .join(", ");

  const fullQuery = `SELECT * FROM cypher('firmen_graph', $$ ${query} $$) as (${columnDefs})`;
  const result = await db.unsafe(fullQuery);
  return result as T[];
}

export async function rawQuery<T = Record<string, unknown>>(
  query: string
): Promise<T[]> {
  const db = getDb();
  return (await db.unsafe(query)) as T[];
}

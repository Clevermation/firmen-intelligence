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

// TEI-Endpunkt für Embedding-Generierung
const TEI_URL = process.env.TEI_URL ?? "http://localhost:8080";

/**
 * Stellt sicher, dass pgvector Extension, embedding-Spalte und Index existieren.
 * Idempotent — kann mehrfach aufgerufen werden.
 */
export async function ensureVector() {
  const db = getDb();
  console.log("[Vector] Prüfe/erstelle pgvector-Schema...");

  // pgvector Extension aktivieren
  await db.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

  // Embedding-Spalte hinzufügen (BGE-M3 = 1024 Dimensionen)
  await db.unsafe(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding vector(1024)`);

  // IVFFlat-Index für Kosinus-Ähnlichkeitssuche
  await db.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_entities_embedding
    ON entities USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 1000)
  `);

  console.log("[Vector] pgvector-Schema OK");
}

/** Optionen für die semantische Suche */
export interface SemanticSearchFilters {
  entityType?: "firma" | "person";
  minSimilarity?: number;
}

/**
 * Semantische Ähnlichkeitssuche über pgvector (Kosinus-Distanz).
 * Gibt Entities sortiert nach Ähnlichkeit zurück.
 */
export async function semanticSearch(
  queryEmbedding: number[],
  limit: number = 10,
  filters?: SemanticSearchFilters
) {
  const db = getDb();

  // Embedding als pgvector-Literal formatieren
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  // WHERE-Bedingungen aufbauen
  const conditions: string[] = ["embedding IS NOT NULL"];
  if (filters?.entityType) {
    conditions.push(`entity_type = '${filters.entityType}'`);
  }
  if (filters?.minSimilarity !== undefined) {
    // Kosinus-Distanz < (1 - minSimilarity) → Ähnlichkeit > minSimilarity
    conditions.push(`(1 - (embedding <=> '${embeddingLiteral}'::vector)) >= ${filters.minSimilarity}`);
  }

  const whereClause = conditions.join(" AND ");

  const result = await db.unsafe(`
    SELECT
      id,
      entity_type,
      canonical_name,
      data,
      1 - (embedding <=> '${embeddingLiteral}'::vector) AS similarity
    FROM entities
    WHERE ${whereClause}
    ORDER BY embedding <=> '${embeddingLiteral}'::vector
    LIMIT ${limit}
  `);

  return result as Array<{
    id: string;
    entity_type: string;
    canonical_name: string;
    data: Record<string, unknown>;
    similarity: number;
  }>;
}

/**
 * Generiert ein Embedding über den TEI-Service (BGE-M3).
 * Wirft einen Fehler wenn TEI nicht erreichbar ist.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${TEI_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: text, truncate: true }),
  });

  if (!response.ok) {
    throw new Error(`TEI Embedding fehlgeschlagen: ${response.status} ${response.statusText}`);
  }

  // TEI gibt ein Array von Embeddings zurück (eins pro Input)
  const embeddings = (await response.json()) as number[][];
  return embeddings[0];
}

/**
 * Stellt sicher, dass alle benötigten Tabellen und Indizes existieren.
 * Wird beim Server-Start aufgerufen — idempotent (IF NOT EXISTS überall).
 */
export async function ensureSchema() {
  const db = getDb();
  console.log("[Schema] Prüfe/erstelle DB-Schema...");

  // Extension für Trigramm-Suche
  await db.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  // Haupttabellen
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS entities (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type     TEXT NOT NULL CHECK (entity_type IN ('firma', 'person')),
      canonical_name  TEXT NOT NULL,
      data            JSONB NOT NULL DEFAULT '{}',
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (entity_type)`);
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_entities_data ON entities USING GIN (data)`);
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_entities_type_name ON entities (entity_type, canonical_name)`);

  // Trigramm-Index nur wenn Spalte vorhanden
  try {
    await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities USING gin (canonical_name gin_trgm_ops)`);
  } catch {
    console.log("[Schema] Trigramm-Index übersprungen (pg_trgm evtl. nicht verfügbar)");
  }

  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS entity_identifiers (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      id_type         TEXT NOT NULL,
      id_value        TEXT NOT NULL,
      qualifier       TEXT,
      source          TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (id_type, id_value, qualifier)
    )
  `);
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_identifiers_lookup ON entity_identifiers (id_type, id_value)`);
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_identifiers_entity ON entity_identifiers (entity_id)`);

  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS events (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL,
      event_date      DATE,
      payload         JSONB NOT NULL DEFAULT '{}',
      raw_text        TEXT,
      source          TEXT NOT NULL,
      source_doc_id   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_events_entity ON events (entity_id)`);
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type)`);
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_events_date ON events (event_date DESC)`);

  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS import_runs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source          TEXT NOT NULL,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at     TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
      stats           JSONB DEFAULT '{}',
      error           TEXT
    )
  `);

  // pgvector-Schema sicherstellen (embedding-Spalte + Index)
  await ensureVector();

  console.log("[Schema] DB-Schema OK");
}

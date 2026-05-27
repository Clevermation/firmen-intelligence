#!/bin/sh
set -e

echo "Initialisiere DB-Schema..."
until PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" > /dev/null 2>&1; do
  echo "Warte auf DB..."
  sleep 2
done

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null || true

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" <<'EOSQL'
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('firma', 'person')),
  canonical_name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('german', canonical_name || ' ' || coalesce(data->>'sitz', '') || ' ' || coalesce(data->>'gegenstand', ''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities USING gin (canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_search ON entities USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_entities_data ON entities USING GIN (data);
CREATE TABLE IF NOT EXISTS entity_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  id_type TEXT NOT NULL, id_value TEXT NOT NULL, qualifier TEXT,
  source TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id_type, id_value, qualifier)
);
CREATE INDEX IF NOT EXISTS idx_identifiers_lookup ON entity_identifiers (id_type, id_value);
CREATE INDEX IF NOT EXISTS idx_identifiers_entity ON entity_identifiers (entity_id);
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, event_date DATE,
  payload JSONB NOT NULL DEFAULT '{}', raw_text TEXT,
  source TEXT NOT NULL, source_doc_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events (entity_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_date ON events (event_date DESC);
CREATE TABLE IF NOT EXISTS import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  stats JSONB DEFAULT '{}', error TEXT
);
EOSQL

echo "Schema OK. Starte Server..."
cd /app
exec bun run src/server.ts

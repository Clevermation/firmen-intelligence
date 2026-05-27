/**
 * Enrichment-Status-Queries: Vorsortierung, Tier-Klassifizierung, Pipeline-Statistiken
 */
import { getDb } from "../db/connection";

export interface TierStats {
  tier1: number;
  tier2: number;
  tier3: number;
  withWebsite: number;
  withMitarbeiter: number;
  withUmsatz: number;
  withProfile: number;
  withEmbedding: number;
  totalActive: number;
}

/**
 * Berechnet Enrichment-Tier-Statistiken.
 * Tier 1: Hat Website + Officers >5 oder Wikidata-Daten oder Mitarbeiter >50
 * Tier 2: Hat Website oder offene Stellen
 * Tier 3: Rest (nur Stammdaten)
 */
export async function getEnrichmentStats(): Promise<TierStats> {
  const db = getDb();

  // Prüfe ob embedding-Spalte existiert
  const colCheck = await db.unsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'entities' AND column_name = 'embedding'
  `);
  const hasEmbedding = colCheck.length > 0;

  const result = await db.unsafe(`
    SELECT
      COUNT(*) FILTER (WHERE
        (data->>'website' IS NOT NULL AND data->>'website' != '')
        AND (
          (data->>'mitarbeiter' IS NOT NULL AND (data->>'mitarbeiter')::int > 50)
          OR data->>'wikidata_id' IS NOT NULL
        )
      ) as tier1,

      COUNT(*) FILTER (WHERE
        (data->>'website' IS NOT NULL AND data->>'website' != '')
        OR (data->>'offene_stellen' IS NOT NULL AND (data->>'offene_stellen')::int > 0)
      ) - COUNT(*) FILTER (WHERE
        (data->>'website' IS NOT NULL AND data->>'website' != '')
        AND (
          (data->>'mitarbeiter' IS NOT NULL AND (data->>'mitarbeiter')::int > 50)
          OR data->>'wikidata_id' IS NOT NULL
        )
      ) as tier2,

      COUNT(*) FILTER (WHERE data->>'website' IS NOT NULL AND data->>'website' != '') as with_website,
      COUNT(*) FILTER (WHERE data->>'mitarbeiter' IS NOT NULL) as with_mitarbeiter,
      COUNT(*) FILTER (WHERE data->>'umsatz' IS NOT NULL) as with_umsatz,
      COUNT(*) FILTER (WHERE data->>'semantic_profile' IS NOT NULL) as with_profile,
      ${hasEmbedding ? "COUNT(*) FILTER (WHERE embedding IS NOT NULL)" : "0"} as with_embedding,
      COUNT(*) as total_active

    FROM entities
    WHERE entity_type = 'firma'
      AND data->>'status' = 'aktiv'
      AND data->>'rechtsform' IN ('GMBH', 'AG', 'SE', 'UG (HAFTUNGSBESCHRÄNKT)', 'GMBH & CO. KG')
  `);

  const r = result[0];
  const tier1 = parseInt(r.tier1 as string, 10);
  const tier2 = Math.max(0, parseInt(r.tier2 as string, 10));
  const totalActive = parseInt(r.total_active as string, 10);

  return {
    tier1,
    tier2,
    tier3: totalActive - tier1 - tier2,
    withWebsite: parseInt(r.with_website as string, 10),
    withMitarbeiter: parseInt(r.with_mitarbeiter as string, 10),
    withUmsatz: parseInt(r.with_umsatz as string, 10),
    withProfile: parseInt(r.with_profile as string, 10),
    withEmbedding: parseInt(r.with_embedding as string, 10),
    totalActive,
  };
}

/**
 * Holt die letzten Import-Runs mit Details zu allen Quellen.
 */
export async function getImportOverview() {
  const db = getDb();

  // Prüfe ob embedding-Spalte existiert
  const colCheck = await db.unsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'entities' AND column_name = 'embedding'
  `);
  const hasEmbedding = colCheck.length > 0;

  // Letzte Runs pro Quelle
  const runs = await db.unsafe(`
    SELECT DISTINCT ON (source)
      source, status, started_at, finished_at, stats, error
    FROM import_runs
    ORDER BY source, started_at DESC
  `);

  // Quellen-KPIs aus den Daten
  const sourceKpis = await db.unsafe(`
    SELECT
      'wikidata' as source,
      COUNT(*) FILTER (WHERE data->>'wikidata_id' IS NOT NULL) as enriched_count
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'dns-discovery',
      COUNT(*) FILTER (WHERE data->>'website_source' = 'dns-discovery')
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'impressum-scraper',
      COUNT(*) FILTER (WHERE data->>'kontakt_email' IS NOT NULL OR data->>'kontakt_telefon' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'llm-enrichment',
      COUNT(*) FILTER (WHERE data->>'semantic_profile' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'embedding-pipeline',
      ${hasEmbedding ? "COUNT(*) FILTER (WHERE embedding IS NOT NULL)" : "0::bigint"}
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'ba-jobs',
      COUNT(*) FILTER (WHERE data->>'offene_stellen' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'kununu',
      COUNT(*) FILTER (WHERE data->>'kununu_rating' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'wappalyzer',
      COUNT(*) FILTER (WHERE data->>'tech_stack' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'trustpilot',
      COUNT(*) FILTER (WHERE data->>'trustpilot_rating' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'gleif',
      COUNT(*) FILTER (WHERE data->>'lei' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'dpma',
      COUNT(*) FILTER (WHERE data->>'patent_count' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'bundesanzeiger',
      COUNT(*) FILTER (WHERE data->>'bilanzsumme' IS NOT NULL OR data->>'umsatz' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'vies',
      COUNT(*) FILTER (WHERE data->>'ust_id_valid' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'ted',
      COUNT(*) FILTER (WHERE data->>'ausschreibungen' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'foerderkatalog',
      COUNT(*) FILTER (WHERE data->>'foerderprojekte' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
    UNION ALL
    SELECT
      'openlegaldata',
      COUNT(*) FILTER (WHERE data->>'gerichtsverfahren' IS NOT NULL)
    FROM entities WHERE entity_type = 'firma'
  `);

  return {
    runs: runs.map((r: any) => ({
      source: r.source,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      stats: r.stats,
      error: r.error,
    })),
    kpis: Object.fromEntries(
      sourceKpis.map((r: any) => [r.source, parseInt(r.enriched_count as string, 10)])
    ),
  };
}

/**
 * Tier-1 Firmen-IDs für Enrichment holen.
 */
export async function getTier1Firms(limit: number = 50000): Promise<string[]> {
  const db = getDb();

  const result = await db.unsafe(`
    SELECT id FROM entities
    WHERE entity_type = 'firma'
      AND data->>'status' = 'aktiv'
      AND data->>'rechtsform' IN ('GMBH', 'AG', 'SE', 'UG (HAFTUNGSBESCHRÄNKT)')
      AND (
        (data->>'website' IS NOT NULL AND data->>'website' != '')
        AND (
          (data->>'mitarbeiter' IS NOT NULL AND (data->>'mitarbeiter')::int > 50)
          OR data->>'wikidata_id' IS NOT NULL
        )
      )
    ORDER BY
      CASE WHEN data->>'mitarbeiter' IS NOT NULL THEN (data->>'mitarbeiter')::int ELSE 0 END DESC
    LIMIT ${limit}
  `);

  return result.map((r: any) => r.id as string);
}

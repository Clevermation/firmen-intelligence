/**
 * Embedding-Pipeline: BGE-M3 über TEI → pgvector
 * Batch-Embedding der semantischen Firmenprofile.
 */
import { getDb, closeDb, generateEmbedding, ensureVector } from "../db/connection";

const BATCH_SIZE = 32;
const PAUSE_BETWEEN_BATCHES_MS = 100;
const TEI_URL = process.env.TEI_URL ?? "http://localhost:8080";

/**
 * Generiert Embeddings für einen Batch von Texten über TEI (BGE-M3).
 * Nutzt den Batch-Endpoint für höheren Durchsatz.
 */
async function generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await fetch(`${TEI_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: texts, truncate: true }),
  });

  if (!response.ok) {
    throw new Error(`TEI Batch-Embedding fehlgeschlagen: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as number[][];
}

/**
 * Speichert ein Embedding in der entities-Tabelle.
 */
async function saveEmbedding(entityId: string, embedding: number[]): Promise<void> {
  const db = getDb();
  const embeddingLiteral = `[${embedding.join(",")}]`;
  await db.unsafe(
    `UPDATE entities SET embedding = '${embeddingLiteral}'::vector, updated_at = now()
     WHERE id = '${entityId}'`
  );
}

export interface EmbeddingStats {
  total: number;
  embedded: number;
  errors: number;
  avgTimeMs: number;
}

/**
 * Hauptpipeline: Embeddings für alle Firmen mit semantic_profile aber ohne Embedding generieren.
 */
export async function runEmbeddingPipeline(options?: {
  limit?: number;
  onlyTier1?: boolean;
}): Promise<EmbeddingStats> {
  const db = getDb();
  const limit = options?.limit ?? 100000;

  await ensureVector();

  // Import-Run starten
  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('embedding-pipeline', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  const stats: EmbeddingStats = {
    total: 0,
    embedded: 0,
    errors: 0,
    avgTimeMs: 0,
  };

  const timings: number[] = [];

  try {
    // Firmen mit semantic_profile aber ohne Embedding holen
    let query = `
      SELECT id, canonical_name, data->>'semantic_profile' as profile
      FROM entities
      WHERE entity_type = 'firma'
        AND data->>'semantic_profile' IS NOT NULL
        AND embedding IS NULL
    `;

    if (options?.onlyTier1) {
      query += `
        AND (
          (data->>'mitarbeiter' IS NOT NULL AND (data->>'mitarbeiter')::int > 50)
          OR data->>'website' IS NOT NULL
        )
      `;
    }

    query += ` ORDER BY CASE WHEN data->>'mitarbeiter' IS NOT NULL THEN (data->>'mitarbeiter')::int ELSE 0 END DESC
               LIMIT ${limit}`;

    const firms = await db.unsafe(query);
    stats.total = firms.length;

    console.log(`[Embedding] ${stats.total} Firmen zum Embedding gefunden`);

    if (stats.total === 0) {
      await db.unsafe(
        `UPDATE import_runs SET status = 'completed', finished_at = now(),
         stats = '{"total": 0, "embedded": 0}'::jsonb WHERE id = '${runId}'`
      );
      console.log("[Embedding] Keine Firmen zum Embedding gefunden");
      return stats;
    }

    // In Batches verarbeiten
    for (let i = 0; i < firms.length; i += BATCH_SIZE) {
      const batch = firms.slice(i, i + BATCH_SIZE);
      const startTime = Date.now();

      try {
        // Texte für Batch vorbereiten
        const texts = batch.map((firm: any) => {
          const profile = firm.profile as string;
          const name = firm.canonical_name as string;
          // Firmenname + Profil für besseres Embedding
          return `${name}\n\n${profile}`;
        });

        // Batch-Embedding generieren
        const embeddings = await generateBatchEmbeddings(texts);

        // Embeddings speichern
        for (let j = 0; j < batch.length; j++) {
          try {
            await saveEmbedding(batch[j].id as string, embeddings[j]);
            stats.embedded++;
          } catch (e) {
            console.error(`[Embedding] Speicher-Fehler für ${batch[j].canonical_name}:`, (e as Error).message);
            stats.errors++;
          }
        }
      } catch (e) {
        console.error(`[Embedding] Batch-Fehler bei Offset ${i}:`, (e as Error).message);
        stats.errors += batch.length;
      }

      const elapsed = Date.now() - startTime;
      timings.push(elapsed);

      // Fortschritt loggen
      if ((i + BATCH_SIZE) % (BATCH_SIZE * 10) === 0 || i + BATCH_SIZE >= firms.length) {
        const avgMs = timings.reduce((a, b) => a + b, 0) / timings.length;
        const remaining = Math.ceil((firms.length - i - BATCH_SIZE) / BATCH_SIZE) * avgMs;
        stats.avgTimeMs = Math.round(avgMs);

        console.log(
          `[Embedding] ${stats.embedded}/${stats.total} | ` +
          `${stats.errors} Fehler | ` +
          `~${Math.round(avgMs)}ms/Batch | ` +
          `~${Math.round(remaining / 60000)}min verbleibend`
        );
      }

      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_BATCHES_MS));
    }

    stats.avgTimeMs = timings.length > 0
      ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length)
      : 0;

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify(stats).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Embedding] Pipeline abgeschlossen!`);
    console.log(`  Embedded: ${stats.embedded}/${stats.total}`);
    console.log(`  Fehler: ${stats.errors}`);
    console.log(`  Durchschnitt: ${stats.avgTimeMs}ms/Batch`);

    return stats;
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${(e as Error).message.replace(/'/g, "''")}'
       WHERE id = '${runId}'`
    );
    console.error("[Embedding] Pipeline-Fehler:", e);
    throw e;
  }
}

/**
 * Einzelnes Embedding für eine Suchanfrage generieren.
 * Wird vom Semantic-Search-Endpoint genutzt.
 */
export async function embedQuery(query: string): Promise<number[]> {
  return generateEmbedding(query);
}

// ── CLI ──

if (import.meta.main) {
  const limit = parseInt(process.argv[2] ?? "1000", 10);
  const tier1Only = process.argv.includes("--tier1");
  await runEmbeddingPipeline({ limit, onlyTier1: tier1Only });
  await closeDb();
}

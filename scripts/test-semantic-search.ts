/**
 * Test der Semantic Search: natürlichsprachige Query → pgvector Cosine-Similarity
 */
import { generateEmbedding, getDb, closeDb } from "../src/db/connection";

const queries = [
  "Großer Lebensmittel-Einzelhändler mit vielen Filialen",
  "Energieversorger der erneuerbare Energien und Windkraft anbietet",
  "Mittelständisches Dienstleistungsunternehmen aus Hamburg",
];

const db = getDb();

for (const q of queries) {
  const emb = await generateEmbedding(q);
  const lit = `[${emb.join(",")}]`;
  const results = await db.unsafe(
    `SELECT canonical_name, 1 - (embedding <=> '${lit}'::vector) AS similarity
     FROM entities
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> '${lit}'::vector
     LIMIT 5`
  );
  console.log(`\nQUERY: ${q}`);
  for (const r of results) {
    console.log(`  ${(r.similarity as number).toFixed(3)}  ${r.canonical_name}`);
  }
}

await closeDb();

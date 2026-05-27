/**
 * LLM-Enrichment-Pipeline: Claude Haiku für semantische Firmenprofile
 * Nutzt OAuth-Token-Rotation über mehrere Accounts.
 */
import { getDb, closeDb } from "../db/connection";
import { updateEntityData } from "../db/helpers";

// ── Token-Konfiguration ──

interface AccountConfig {
  name: string;
  token: string;
  refreshToken: string;
  email: string;
  tier: number;
  usage5h: number;
  usage7d: number;
  lastUsed: number;
  blocked5h: boolean;
  blocked7d: boolean;
}

const ACCOUNTS_PATH =
  process.env.CLAUDE_ACCOUNTS_PATH ??
  "/Users/jonneschwegmann/Desktop/Jonne_Felix/Clevermation/Intern/Test-Projekte/claude-sdk-test/accounts.json";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_PARALLEL = 3;
const USAGE_LIMIT_5H = 0.8; // 80% vom 5h-Window
const USAGE_LIMIT_7D = 0.8; // 80% vom 7d-Window
const BATCH_SIZE = 50;

// ── Profil-Prompt ──

const SYSTEM_PROMPT = `Du bist ein B2B-Sales-Analyst. Erstelle semantische Firmenprofile aus Rohdaten.
Schreibe auf Deutsch, präzise und faktenbasiert. Keine Spekulation — nur was aus den Daten hervorgeht.`;

function buildUserPrompt(data: Record<string, unknown>, name: string): string {
  const fields = Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");

  return `Erstelle ein semantisches Firmenprofil für "${name}" aus diesen Rohdaten.

ROHDATEN:
${fields}

AUSGABE (300-500 Wörter, strukturiert):
1. Kerngeschäft und Positionierung (2-3 Sätze)
2. Digitalisierungsgrad und Tech-Stack (2-3 Sätze, wenn Daten vorhanden)
3. Online-Präsenz und Marketing-Reife (2-3 Sätze, wenn Daten vorhanden)
4. Wachstumssignale und aktuelle Entwicklungen (2-3 Sätze)
5. Potentielle Pain Points und Herausforderungen (2-3 Sätze)
6. Entscheider und Organisationsstruktur (1-2 Sätze, wenn Daten vorhanden)

Wenn für einen Abschnitt keine Daten vorliegen, überspringe ihn.`;
}

// ── Token-Rotation ──

let accounts: AccountConfig[] = [];

async function loadAccounts(): Promise<void> {
  const file = Bun.file(ACCOUNTS_PATH);
  const raw = await file.json() as Array<{
    name: string;
    token: string;
    refreshToken: string;
    email: string;
    tier: number;
  }>;

  // Nur Tier-20-Accounts für Bulk (Tier 5 hat zu wenig Kapazität)
  accounts = raw
    .filter((a) => a.tier >= 20)
    .map((a) => ({
      ...a,
      usage5h: 0,
      usage7d: 0,
      lastUsed: 0,
      blocked5h: false,
      blocked7d: false,
    }));

  console.log(`[LLM] ${accounts.length} Accounts geladen (Tier ≥ 20)`);
}

function getAvailableAccount(): AccountConfig | null {
  const available = accounts.filter((a) => !a.blocked5h && !a.blocked7d);
  if (available.length === 0) return null;

  // Wähle den Account mit der niedrigsten 5h-Usage
  available.sort((a, b) => a.usage5h - b.usage5h);
  return available[0];
}

async function callClaude(
  account: AccountConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": account.token,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    // Rate-Limit oder Overloaded
    if (response.status === 429 || response.status === 529) {
      console.warn(`[LLM] ${account.name}: Rate-Limit erreicht, blockiere 5h-Window`);
      account.blocked5h = true;
      setTimeout(() => {
        account.blocked5h = false;
        account.usage5h = 0;
        console.log(`[LLM] ${account.name}: 5h-Block aufgehoben`);
      }, 5 * 60 * 60 * 1000);
      return null;
    }

    // Token abgelaufen → Refresh versuchen
    if (response.status === 401) {
      console.warn(`[LLM] ${account.name}: Token abgelaufen, versuche Refresh...`);
      const refreshed = await refreshToken(account);
      if (!refreshed) return null;
      return callClaude(account, systemPrompt, userPrompt);
    }

    console.error(`[LLM] ${account.name}: API-Fehler ${response.status}: ${errorText.slice(0, 200)}`);
    return null;
  }

  const result = await response.json() as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  // Usage tracken
  const totalTokens = result.usage.input_tokens + result.usage.output_tokens;
  account.usage5h += totalTokens;
  account.usage7d += totalTokens;
  account.lastUsed = Date.now();

  const textBlock = result.content.find((c) => c.type === "text");
  return textBlock?.text ?? null;
}

async function refreshToken(account: AccountConfig): Promise<boolean> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
      }),
    });

    if (!response.ok) {
      console.error(`[LLM] Token-Refresh fehlgeschlagen für ${account.name}`);
      account.blocked5h = true;
      return false;
    }

    const data = await response.json() as { access_token: string; refresh_token?: string };
    account.token = data.access_token;
    if (data.refresh_token) account.refreshToken = data.refresh_token;
    console.log(`[LLM] Token erneuert für ${account.name}`);
    return true;
  } catch (e) {
    console.error(`[LLM] Refresh-Fehler: ${(e as Error).message}`);
    return false;
  }
}

// ── Enrichment-Pipeline ──

interface EnrichmentStats {
  total: number;
  enriched: number;
  skipped: number;
  errors: number;
  tokensUsed: number;
}

async function enrichEntity(
  entityId: string,
  name: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const account = getAvailableAccount();
  if (!account) {
    console.warn("[LLM] Kein Account verfügbar — alle blockiert. Pause...");
    return false;
  }

  const userPrompt = buildUserPrompt(data, name);
  const profile = await callClaude(account, SYSTEM_PROMPT, userPrompt);

  if (!profile) return false;

  await updateEntityData(entityId, {
    semantic_profile: profile,
    enrichment_model: MODEL,
    enriched_at: new Date().toISOString(),
  });

  return true;
}

export async function importLLMEnrichment(options?: {
  limit?: number;
  tierFilter?: string;
  minMitarbeiter?: number;
}) {
  const db = getDb();
  const limit = options?.limit ?? 1000;
  const minMA = options?.minMitarbeiter ?? 0;

  // Import-Run starten
  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('llm-enrichment', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  const stats: EnrichmentStats = {
    total: 0,
    enriched: 0,
    skipped: 0,
    errors: 0,
    tokensUsed: 0,
  };

  try {
    await loadAccounts();

    if (accounts.length === 0) {
      throw new Error("Keine verfügbaren Accounts (Tier ≥ 20) gefunden");
    }

    // Firmen holen die noch kein semantic_profile haben
    const firms = await db.unsafe(`
      SELECT id, canonical_name, data
      FROM entities
      WHERE entity_type = 'firma'
        AND data->>'status' = 'aktiv'
        AND data->>'semantic_profile' IS NULL
        AND data->>'rechtsform' IN ('GMBH', 'AG', 'SE', 'UG (HAFTUNGSBESCHRÄNKT)')
        ${minMA > 0 ? `AND (data->>'mitarbeiter')::int >= ${minMA}` : ""}
      ORDER BY
        CASE WHEN data->>'mitarbeiter' IS NOT NULL THEN (data->>'mitarbeiter')::int ELSE 0 END DESC,
        CASE WHEN data->>'website' IS NOT NULL THEN 0 ELSE 1 END,
        canonical_name
      LIMIT ${limit}
    `);

    stats.total = firms.length;
    console.log(`[LLM] ${stats.total} Firmen zum Enrichment gefunden`);

    // In Batches verarbeiten
    for (let i = 0; i < firms.length; i += MAX_PARALLEL) {
      const batch = firms.slice(i, i + MAX_PARALLEL);

      const results = await Promise.allSettled(
        batch.map((firm: any) =>
          enrichEntity(
            firm.id as string,
            firm.canonical_name as string,
            firm.data as Record<string, unknown>
          )
        )
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          stats.enriched++;
        } else if (result.status === "fulfilled" && !result.value) {
          // Account blockiert oder Fehler
          const account = getAvailableAccount();
          if (!account) {
            console.warn("[LLM] Alle Accounts blockiert — breche ab");
            stats.skipped = stats.total - stats.enriched - stats.errors;
            break;
          }
          stats.errors++;
        } else {
          stats.errors++;
        }
      }

      // Kein Account mehr verfügbar → aufhören
      if (!getAvailableAccount()) {
        console.warn("[LLM] Alle Accounts blockiert — beende vorzeitig");
        stats.skipped = stats.total - stats.enriched - stats.errors;
        break;
      }

      // Fortschritt loggen
      if ((i + MAX_PARALLEL) % BATCH_SIZE === 0 || i + MAX_PARALLEL >= firms.length) {
        const tokenSum = accounts.reduce((sum, a) => sum + a.usage5h, 0);
        stats.tokensUsed = tokenSum;
        console.log(
          `[LLM] ${stats.enriched}/${stats.total} enriched | ` +
          `${stats.errors} Fehler | ~${tokenSum.toLocaleString()} Tokens`
        );
      }

      // Kleine Pause zwischen Batches
      await new Promise((r) => setTimeout(r, 200));
    }

    // Token-Summe final
    stats.tokensUsed = accounts.reduce((sum, a) => sum + a.usage5h, 0);

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify(stats).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[LLM] Enrichment abgeschlossen!`);
    console.log(`  Enriched: ${stats.enriched}/${stats.total}`);
    console.log(`  Fehler: ${stats.errors}`);
    console.log(`  Tokens: ~${stats.tokensUsed.toLocaleString()}`);

    return stats;
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${(e as Error).message.replace(/'/g, "''")}'
       WHERE id = '${runId}'`
    );
    console.error("[LLM] Pipeline-Fehler:", e);
    throw e;
  }
}

// ── Batch-API Alternative (Anthropic Messages Batches) ──

export async function createBatchEnrichment(options?: { limit?: number }) {
  const db = getDb();
  const limit = options?.limit ?? 10000;

  // Firmen ohne Profil holen
  const firms = await db.unsafe(`
    SELECT id, canonical_name, data
    FROM entities
    WHERE entity_type = 'firma'
      AND data->>'status' = 'aktiv'
      AND data->>'semantic_profile' IS NULL
      AND data->>'rechtsform' IN ('GMBH', 'AG', 'SE', 'UG (HAFTUNGSBESCHRÄNKT)')
    ORDER BY
      CASE WHEN data->>'mitarbeiter' IS NOT NULL THEN (data->>'mitarbeiter')::int ELSE 0 END DESC
    LIMIT ${limit}
  `);

  console.log(`[Batch] ${firms.length} Firmen für Batch vorbereitet`);

  // Batch-Requests erstellen (JSONL-Format)
  const requests = firms.map((firm: any) => ({
    custom_id: firm.id,
    params: {
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: buildUserPrompt(firm.data as Record<string, unknown>, firm.canonical_name as string),
      }],
    },
  }));

  // In Chunks von 100k aufteilen (Batch API Limit)
  const chunkSize = 50000;
  const chunks = [];
  for (let i = 0; i < requests.length; i += chunkSize) {
    chunks.push(requests.slice(i, i + chunkSize));
  }

  console.log(`[Batch] ${chunks.length} Batch-Chunk(s) erstellt`);

  // Batch-Requests als JSONL-Dateien speichern
  for (let i = 0; i < chunks.length; i++) {
    const jsonl = chunks[i].map((r) => JSON.stringify(r)).join("\n");
    const outPath = `./data/batch-enrichment-${i + 1}.jsonl`;
    await Bun.write(outPath, jsonl);
    console.log(`[Batch] Chunk ${i + 1} gespeichert: ${outPath} (${chunks[i].length} Requests)`);
  }

  return { chunks: chunks.length, totalRequests: requests.length };
}

// ── CLI ──

if (import.meta.main) {
  const arg = process.argv[2];
  const limit = parseInt(process.argv[3] ?? "100", 10);

  if (arg === "batch") {
    await createBatchEnrichment({ limit });
  } else {
    await importLLMEnrichment({ limit });
  }
  await closeDb();
}

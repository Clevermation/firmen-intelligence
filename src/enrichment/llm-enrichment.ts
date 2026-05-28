/**
 * LLM-Enrichment-Pipeline: Claude Haiku für semantische Firmenprofile.
 *
 * Nutzt das Claude Agent SDK (query) mit Subscription-OAuth-Token.
 * WICHTIG: Subscription-Tokens (sk-ant-oat…) funktionieren NICHT mit der
 * direkten /v1/messages-API — nur über das Agent SDK / die claude-CLI.
 *
 * Token-Bereitstellung (in Reihenfolge der Präferenz):
 *  1. CLAUDE_CODE_OAUTH_TOKEN  — langlebiger Token aus `claude setup-token`
 *  2. CLAUDE_OAUTH_TOKENS      — kommagetrennt für Rotation über mehrere Accounts
 *  3. Umgebungs-Auth           — lokal via Keychain (nur für Tests)
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData } from "../db/helpers";

const MODEL = "haiku";
const MAX_PARALLEL = parseInt(process.env.LLM_PARALLEL ?? "3", 10);

const SYSTEM_PROMPT = `Du bist ein B2B-Sales-Analyst. Gib AUSSCHLIESSLICH den reinen Profiltext aus: keine Überschriften, keine Markdown-Formatierung, keine Aufzählungen, keine Meta-Hinweise, keine Rückfragen, keine Einleitung. Schreibe 4-6 zusammenhängende Sätze auf Deutsch, faktenbasiert — nur was aus den Rohdaten hervorgeht. Fokus: Kerngeschäft, Digitalisierungsgrad, Online-Präsenz, Wachstumssignale, mögliche Pain Points.`;

function buildPrompt(data: Record<string, unknown>, name: string): string {
  const fields = Object.entries(data)
    .filter(([k, v]) =>
      v !== null && v !== undefined && v !== "" &&
      !["semantic_profile", "embedding", "enriched_at", "enrichment_model"].includes(k)
    )
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");

  return `Erstelle ein semantisches B2B-Firmenprofil für "${name}" aus diesen Rohdaten:\n\n${fields}`;
}

// ── Token-Rotation ──

interface TokenSlot {
  token: string | undefined; // undefined = Umgebungs-Auth (Keychain)
  label: string;
  blocked: boolean;
}

function loadTokens(): TokenSlot[] {
  const slots: TokenSlot[] = [];

  // Mehrere Tokens (Rotation)
  if (process.env.CLAUDE_OAUTH_TOKENS) {
    const tokens = process.env.CLAUDE_OAUTH_TOKENS.split(",").map((t) => t.trim()).filter(Boolean);
    tokens.forEach((t, i) => slots.push({ token: t, label: `Token ${i + 1}`, blocked: false }));
  }

  // Einzelner Token
  if (slots.length === 0 && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    slots.push({ token: process.env.CLAUDE_CODE_OAUTH_TOKEN, label: "OAuth-Token", blocked: false });
  }

  // Fallback: Umgebungs-Auth (lokal via Keychain)
  if (slots.length === 0) {
    slots.push({ token: undefined, label: "Umgebungs-Auth", blocked: false });
  }

  return slots;
}

let tokenSlots: TokenSlot[] = [];
let rotationIdx = 0;

function nextToken(): TokenSlot | null {
  const available = tokenSlots.filter((s) => !s.blocked);
  if (available.length === 0) return null;
  const slot = available[rotationIdx % available.length];
  rotationIdx++;
  return slot;
}

/**
 * Generiert ein Firmenprofil über das Agent SDK.
 * Gibt den Profiltext zurück oder null bei Fehler.
 */
async function generateProfile(
  data: Record<string, unknown>,
  name: string
): Promise<string | null> {
  const slot = nextToken();
  if (!slot) return null;

  // Saubere Umgebung — Claude-Code-Session-Variablen entfernen
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE;
  delete env.ANTHROPIC_API_KEY;
  if (slot.token) env.CLAUDE_CODE_OAUTH_TOKEN = slot.token;

  try {
    const stream = query({
      prompt: buildPrompt(data, name),
      options: {
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
        model: MODEL,
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: env as Record<string, string>,
      },
    });

    let text = "";
    for await (const event of stream) {
      if (event.type === "assistant") {
        const msg = event as any;
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text") text = block.text;
        }
      }
      if (event.type === "result") {
        const r = event as any;
        if (typeof r.result === "string" && r.result.trim()) text = r.result;
      }
    }

    const cleaned = text.trim();
    return cleaned.length > 40 ? cleaned : null;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("429") || msg.includes("rate") || msg.includes("limit") || msg.includes("401")) {
      console.warn(`[LLM] ${slot.label}: blockiert (${msg.slice(0, 60)})`);
      slot.blocked = true;
    } else {
      console.error(`[LLM] Fehler (${slot.label}): ${msg.slice(0, 120)}`);
    }
    return null;
  }
}

// ── Pipeline ──

export interface EnrichmentStats {
  total: number;
  enriched: number;
  errors: number;
}

export async function importLLMEnrichment(options?: {
  limit?: number;
  minMitarbeiter?: number;
}): Promise<EnrichmentStats> {
  const db = getDb();
  const limit = options?.limit ?? 100;
  const minMA = options?.minMitarbeiter ?? 0;

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('llm-enrichment', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  const stats: EnrichmentStats = { total: 0, enriched: 0, errors: 0 };

  try {
    tokenSlots = loadTokens();
    rotationIdx = 0;
    console.log(`[LLM] ${tokenSlots.length} Token-Slot(s): ${tokenSlots.map((s) => s.label).join(", ")}`);

    // Tier-1-Firmen ohne Profil holen (Mitarbeiter DESC, dann mit Website)
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

    for (let i = 0; i < firms.length; i += MAX_PARALLEL) {
      const batch = firms.slice(i, i + MAX_PARALLEL);

      const results = await Promise.allSettled(
        batch.map(async (firm: any) => {
          const profile = await generateProfile(
            firm.data as Record<string, unknown>,
            firm.canonical_name as string
          );
          if (!profile) return false;
          await updateEntityData(firm.id as string, {
            semantic_profile: profile,
            enrichment_model: MODEL,
            enriched_at: new Date().toISOString(),
          });
          return true;
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled" && r.value) stats.enriched++;
        else stats.errors++;
      }

      // Alle Tokens blockiert → abbrechen
      if (tokenSlots.every((s) => s.blocked)) {
        console.warn("[LLM] Alle Token-Slots blockiert — beende vorzeitig");
        break;
      }

      if ((i + MAX_PARALLEL) % 30 === 0 || i + MAX_PARALLEL >= firms.length) {
        console.log(`[LLM] ${stats.enriched}/${stats.total} enriched | ${stats.errors} Fehler`);
      }
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify(stats).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[LLM] Abgeschlossen: ${stats.enriched}/${stats.total} enriched, ${stats.errors} Fehler`);
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

// ── CLI ──

if (import.meta.main) {
  const limit = parseInt(process.argv[2] ?? "10", 10);
  await importLLMEnrichment({ limit });
  await closeDb();
}

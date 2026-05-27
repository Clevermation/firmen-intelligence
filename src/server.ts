import index from "../web/index.html";
import { searchEntities, getEntityById, getStats } from "./queries/search";
import { getNetwork } from "./queries/network";
import { importOffeneRegister } from "./importers/offeneregister-fast-server";
import { importPersons } from "./importers/persons-server";
// ensureSchema() ist in db/connection.ts verfügbar, wird aber nicht beim
// Server-Start aufgerufen — das Schema wird durch schema-init im Compose erstellt.

const PORT = parseInt(process.env.PORT ?? "3000");

// ═══════════════════════════════════════════════════
// Auth — Email + Passwort (kein Magic-Link)
// Token-basierte Session-Verwaltung
// ═══════════════════════════════════════════════════

interface UserRecord {
  passwordHash: string;
  name: string;
  email: string;
}

interface TokenData {
  email: string;
  name: string;
  createdAt: number;
}

// Registrierte Benutzer
const USERS: Record<string, UserRecord> = {};
// Aktive Sessions (Token → User-Daten)
const TOKENS = new Map<string, TokenData>();
// Token-Lebensdauer: 7 Tage
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Initialisiert den Standard-Admin-Benutzer
 */
async function initUsers() {
  const defaultEmail = process.env.ADMIN_EMAIL ?? "developer@clevermation.com";
  const defaultPw = process.env.ADMIN_PASSWORD ?? "4!HyUHytvjtqM2YLeqRp";
  USERS[defaultEmail] = {
    passwordHash: await Bun.password.hash(defaultPw),
    name: "Developer",
    email: defaultEmail,
  };
  console.log(`Auth: Benutzer ${defaultEmail} initialisiert`);
}
await initUsers();

/**
 * Bereinigt abgelaufene Tokens
 */
function cleanupTokens() {
  const now = Date.now();
  for (const [token, data] of TOKENS) {
    if (now - data.createdAt > TOKEN_TTL_MS) {
      TOKENS.delete(token);
    }
  }
}
// Token-Bereinigung alle 30 Minuten
setInterval(cleanupTokens, 30 * 60 * 1000);

/**
 * Validiert einen Token und gibt die zugehörigen User-Daten zurück
 */
function validateToken(authHeader: string | null): TokenData | null {
  if (!authHeader) return null;
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;
  const data = TOKENS.get(token);
  if (!data) return null;
  if (Date.now() - data.createdAt > TOKEN_TTL_MS) {
    TOKENS.delete(token);
    return null;
  }
  return data;
}

// ═══════════════════════════════════════════════════
// CORS & Response-Helfer
// ═══════════════════════════════════════════════════

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders() });
}

function errorResponse(message: string, status: number) {
  return jsonResponse({ error: message }, status);
}

// ═══════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════

Bun.serve({
  port: PORT,
  routes: {
    // ── Startseite → HTML-Import ──
    "/": index,

    // ── Health-Check ──
    "/api/health": () =>
      jsonResponse({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      }),

    // ── Auth: Login ──
    "/api/auth/login": {
      POST: async (req) => {
        const body = (await req.json()) as {
          email?: string;
          password?: string;
        };

        if (!body.email || !body.password) {
          return errorResponse("Email und Passwort erforderlich", 400);
        }

        // Benutzer prüfen
        const user = USERS[body.email];
        if (!user) {
          // Konstante Antwortzeit um Timing-Angriffe zu erschweren
          await Bun.password.hash("dummy-timing-protection");
          return errorResponse("Ungültige Zugangsdaten", 401);
        }

        const valid = await Bun.password.verify(
          body.password,
          user.passwordHash
        );
        if (!valid) {
          return errorResponse("Ungültige Zugangsdaten", 401);
        }

        // Token generieren
        const token = `fi_${crypto.randomUUID().replace(/-/g, "")}`;
        TOKENS.set(token, {
          email: body.email,
          name: user.name,
          createdAt: Date.now(),
        });

        console.log(`Auth: Login erfolgreich für ${body.email}`);
        return jsonResponse({
          token,
          email: body.email,
          name: user.name,
        });
      },
    },

    // ── Auth: Aktuellen Benutzer prüfen ──
    "/api/auth/me": async (req) => {
      const user = validateToken(req.headers.get("Authorization"));
      if (!user) {
        return errorResponse("Nicht authentifiziert", 401);
      }
      return jsonResponse({ email: user.email, name: user.name });
    },

    // ── Auth: Logout ──
    "/api/auth/logout": {
      POST: async (req) => {
        const authHeader = req.headers.get("Authorization");
        if (authHeader) {
          const token = authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : authHeader;
          TOKENS.delete(token);
        }
        return jsonResponse({ message: "Abgemeldet" });
      },
    },

    // ── Firmen- & Personensuche ──
    "/api/search": async (req) => {
      const url = new URL(req.url);
      const result = await searchEntities({
        query: url.searchParams.get("q") || undefined,
        rechtsform: url.searchParams.get("rechtsform") || undefined,
        ort: url.searchParams.get("ort") || undefined,
        bundesland: url.searchParams.get("bundesland") || undefined,
        status: url.searchParams.get("status") || undefined,
        registerArt: url.searchParams.get("registerArt") || undefined,
        entityType: url.searchParams.get("entityType") || undefined,
        limit: parseInt(url.searchParams.get("limit") ?? "25", 10),
        offset: parseInt(url.searchParams.get("offset") ?? "0", 10),
      });
      return jsonResponse(result);
    },

    // ── Einzelne Entität ──
    "/api/entity/:id": async (req) => {
      const entity = await getEntityById(req.params.id);
      if (!entity) return errorResponse("Nicht gefunden", 404);
      return jsonResponse(entity);
    },

    // ── Netzwerk-Graph ──
    "/api/entity/:id/network": async (req) => {
      const url = new URL(req.url);
      const depth = parseInt(url.searchParams.get("depth") ?? "2", 10);
      const network = await getNetwork(req.params.id, Math.min(depth, 4));
      return jsonResponse(network);
    },

    // ── Autocomplete (schnell, prefix-basiert) ──
    "/api/autocomplete": async (req) => {
      const url = new URL(req.url);
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "8", 10), 20);
      if (q.length < 2) return jsonResponse([]);

      const db = (await import("./db/connection")).getDb();
      const escaped = q.replace(/'/g, "''").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const results = await db.unsafe(
        `SELECT id, entity_type, canonical_name,
                data->>'sitz' as sitz,
                data->>'wohnort' as wohnort,
                data->>'rechtsform' as rechtsform
         FROM entities
         WHERE lower(canonical_name) LIKE lower('${escaped}') || '%'
         ORDER BY entity_type, length(canonical_name)
         LIMIT ${limit}`
      );
      return jsonResponse(
        results.map((r: any) => ({
          id: r.id,
          entity_type: r.entity_type,
          canonical_name: r.canonical_name,
          sitz: r.sitz ?? r.wohnort ?? "",
          rechtsform: r.rechtsform ?? "",
        }))
      );
    },

    // ── Dashboard-Statistiken ──
    "/api/stats": async () => {
      const stats = await getStats();
      return jsonResponse(stats);
    },

    // ── Admin: Hängende Imports bereinigen ──
    "/api/admin/cleanup-imports": {
      POST: async () => {
        const db = (await import("./db/connection")).getDb();
        await db.unsafe(
          `UPDATE import_runs SET status = 'failed', finished_at = now(), error = 'Manuell abgebrochen'
           WHERE status = 'running'`
        );
        return jsonResponse({ message: "Hängende Imports aufgeräumt" });
      },
    },

    // ── Import: OffeneRegister ──
    "/api/import/offeneregister": {
      POST: async () => {
        const stats = await getStats();
        const firmenCount = stats.entities?.firma ?? 0;
        if (firmenCount > 100000) {
          return jsonResponse({
            message: "Import bereits ausgeführt",
            firmen: firmenCount,
          });
        }
        const running = (stats as any).lastImports?.some(
          (i: any) =>
            i.status === "running" && i.source?.includes("offeneregister")
        );
        if (running) {
          return jsonResponse({ message: "Import läuft bereits" });
        }
        importOffeneRegister().catch(console.error);
        return jsonResponse({
          message: "Import gestartet (Streaming-Modus), läuft im Hintergrund",
        });
      },
    },

    // ── Import: Identifier für alle Firmen erstellen (läuft im Hintergrund) ──
    "/api/import/identifiers": {
      POST: async () => {
        // Asynchron im Hintergrund ausführen (dauert bei 5M+ Firmen mehrere Minuten)
        (async () => {
          const db = (await import("./db/connection")).getDb();
          try {
            console.log("[Import] Identifier-Import gestartet...");

            // Register-Nr Identifier
            await db.unsafe(`
              INSERT INTO entity_identifiers (entity_id, id_type, id_value, qualifier, source)
              SELECT e.id, 'register_nr',
                     (e.data->>'registerArt') || ' ' || (e.data->>'registerNummer'),
                     e.data->>'gericht', 'offeneregister'
              FROM entities e
              WHERE e.entity_type = 'firma'
                AND e.data->>'registerNummer' IS NOT NULL AND e.data->>'registerNummer' != ''
                AND e.data->>'gericht' IS NOT NULL AND e.data->>'gericht' != ''
              ON CONFLICT (id_type, id_value, qualifier) DO NOTHING
            `);
            console.log("[Import] Register-Nr Identifier fertig");

            // OR-Company-Number Identifier
            await db.unsafe(`
              INSERT INTO entity_identifiers (entity_id, id_type, id_value, qualifier, source)
              SELECT e.id, 'or_company_number', e.data->>'or_company_number', NULL, 'offeneregister'
              FROM entities e
              WHERE e.entity_type = 'firma'
                AND e.data->>'or_company_number' IS NOT NULL AND e.data->>'or_company_number' != ''
              ON CONFLICT (id_type, id_value, qualifier) DO NOTHING
            `);

            const count = await db.unsafe("SELECT count(*) as c FROM entity_identifiers");
            console.log(`[Import] Identifier-Import abgeschlossen: ${count[0].c} Identifier insgesamt`);
          } catch (err) {
            console.error("[Import] Identifier-Fehler:", err);
          }
        })();

        return jsonResponse({
          message: "Identifier-Import gestartet, läuft im Hintergrund. Prüfe /api/stats für Fortschritt.",
        });
      },
    },

    // ── Import: Autocomplete-Index erstellen ──
    "/api/import/autocomplete-index": {
      POST: async () => {
        const db = (await import("./db/connection")).getDb();
        console.log("[Import] Autocomplete-Index wird erstellt...");

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS idx_entities_name_prefix
          ON entities (lower(canonical_name) text_pattern_ops)
        `);

        console.log("[Import] Autocomplete-Index erstellt.");
        return jsonResponse({ message: "Autocomplete-Index erstellt" });
      },
    },

    // ── Import: Personen aus OffeneRegister ──
    "/api/import/persons": {
      POST: async () => {
        const stats = await getStats();
        const personCount = stats.entities?.person ?? 0;
        if (personCount > 100000) {
          return jsonResponse({
            message: "Personen-Import bereits ausgeführt",
            personen: personCount,
          });
        }
        const running = (stats as any).lastImports?.some(
          (i: any) =>
            i.status === "running" && i.source?.includes("persons")
        );
        if (running) {
          return jsonResponse({ message: "Personen-Import läuft bereits" });
        }
        importPersons().catch(console.error);
        return jsonResponse({
          message: "Personen-Import gestartet (Streaming-Modus), läuft im Hintergrund",
        });
      },
    },

    // ── Import-Status ──
    "/api/import/status": async () => {
      const db = (await import("./db/connection")).getDb();
      const runs = await db.unsafe(`
        SELECT id, source, status, started_at, finished_at, stats, error
        FROM import_runs ORDER BY started_at DESC LIMIT 5
      `);
      const entityCount = await db.unsafe(
        `SELECT count(*) as cnt FROM entities WHERE entity_type = 'firma'`
      );
      return jsonResponse({
        firmenCount: parseInt(entityCount[0].cnt as string, 10),
        imports: runs,
      });
    },
  },

  // ── Fallback für nicht-gematchte Routen ──
  fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `\n  ⬡  Clevermation Intelligence Server\n  ⬡  Port: ${PORT}\n  ⬡  URL:  http://localhost:${PORT}\n`
);

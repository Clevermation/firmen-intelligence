import index from "../web/index.html";
import { searchEntities, getEntityById, getStats } from "./queries/search";
import { getNetwork } from "./queries/network";
import { importOffeneRegister } from "./importers/offeneregister-fast-server";

const PORT = parseInt(process.env.PORT ?? "3000");

// Simples User-System (Passwort-Hash via Bun.password)
const USERS: Record<string, { passwordHash: string; name: string }> = {};
const TOKENS = new Map<string, { email: string; name: string; createdAt: number }>();

async function initUsers() {
  const defaultEmail = process.env.ADMIN_EMAIL ?? "developer@clevermation.com";
  const defaultPw = process.env.ADMIN_PASSWORD ?? "4!HyUHytvjtqM2YLeqRp";
  USERS[defaultEmail] = {
    passwordHash: await Bun.password.hash(defaultPw),
    name: "Developer",
  };
  console.log(`Auth: User ${defaultEmail} initialisiert`);
}
await initUsers();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders() });
}

Bun.serve({
  port: PORT,
  routes: {
    "/": index,

    "/api/health": () =>
      jsonResponse({ status: "ok", timestamp: new Date().toISOString() }),

    "/api/auth/login": {
      POST: async (req) => {
        const body = (await req.json()) as { email?: string; password?: string };
        if (!body.email || !body.password) {
          return jsonResponse({ error: "Email und Passwort erforderlich" }, 400);
        }
        const user = USERS[body.email];
        if (!user) {
          return jsonResponse({ error: "Ungültige Zugangsdaten" }, 401);
        }
        const valid = await Bun.password.verify(body.password, user.passwordHash);
        if (!valid) {
          return jsonResponse({ error: "Ungültige Zugangsdaten" }, 401);
        }
        const token = `fi_${crypto.randomUUID().replace(/-/g, "")}`;
        TOKENS.set(token, { email: body.email, name: user.name, createdAt: Date.now() });
        return jsonResponse({ token, email: body.email, name: user.name });
      },
    },

    "/api/search": async (req) => {
      const url = new URL(req.url);
      const result = await searchEntities({
        query: url.searchParams.get("q") || undefined,
        rechtsform: url.searchParams.get("rechtsform") || undefined,
        ort: url.searchParams.get("ort") || undefined,
        bundesland: url.searchParams.get("bundesland") || undefined,
        status: url.searchParams.get("status") || undefined,
        registerArt: url.searchParams.get("registerArt") || undefined,
        limit: parseInt(url.searchParams.get("limit") ?? "25", 10),
        offset: parseInt(url.searchParams.get("offset") ?? "0", 10),
      });
      return jsonResponse(result);
    },

    "/api/entity/:id": async (req) => {
      const entity = await getEntityById(req.params.id);
      if (!entity) return jsonResponse({ error: "Nicht gefunden" }, 404);
      return jsonResponse(entity);
    },

    "/api/entity/:id/network": async (req) => {
      const url = new URL(req.url);
      const depth = parseInt(url.searchParams.get("depth") ?? "2", 10);
      const network = await getNetwork(req.params.id, Math.min(depth, 4));
      return jsonResponse(network);
    },

    "/api/stats": async () => {
      const stats = await getStats();
      return jsonResponse(stats);
    },

    "/api/import/offeneregister": {
      POST: async () => {
        const stats = await getStats();
        const firmenCount = stats.entities?.firma ?? 0;
        if (firmenCount > 100000) {
          return jsonResponse({ message: "Import bereits ausgeführt", firmen: firmenCount });
        }
        importOffeneRegister().catch(console.error);
        return jsonResponse({ message: "Import gestartet, läuft im Hintergrund" });
      },
    },
  },

  fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Firmen-Intelligence Server gestartet auf Port ${PORT}`);

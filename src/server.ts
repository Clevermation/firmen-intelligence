import index from "../web/index.html";
import { searchEntities, getEntityById, getStats } from "./queries/search";
import { getNetwork } from "./queries/network";
import { importOffeneRegister } from "./importers/offeneregister-fast-server";

const PORT = parseInt(process.env.PORT ?? "3000");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders() });
}

Bun.serve({
  port: PORT,
  routes: {
    "/": index,

    "/api/health": () => jsonResponse({ status: "ok", timestamp: new Date().toISOString() }),

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

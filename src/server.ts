import index from "../web/index.html";

const PORT = parseInt(process.env.PORT ?? "3000");

Bun.serve({
  port: PORT,
  routes: {
    "/": index,
    "/api/health": () => Response.json({ status: "ok", timestamp: new Date().toISOString() }),
  },
  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Firmen-Intelligence Server gestartet auf Port ${PORT}`);

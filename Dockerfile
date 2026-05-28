FROM oven/bun:1 AS base
WORKDIR /app

# curl + bzip2 für Streaming-Import von OffeneRegister
# nodejs + git: das Claude Agent SDK bündelt die claude-CLI (extractFromBunfs),
# die zur Laufzeit eine node-Runtime erwartet (für LLM-Enrichment)
RUN apt-get update -qq && apt-get install -y -qq curl bzip2 nodejs git ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY web/ ./web/
COPY index.ts ./

EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]

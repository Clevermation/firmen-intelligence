FROM oven/bun:1 AS base
WORKDIR /app

# curl + bzip2 für Streaming-Import von OffeneRegister
RUN apt-get update -qq && apt-get install -y -qq curl bzip2 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY web/ ./web/
COPY index.ts ./

EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]

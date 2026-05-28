# Apache AGE (PostgreSQL 18) + pgvector
# apache/age:latest ist aktuell PG18. pgvector kommt als fertiges PGDG-Paket
# (postgresql-18-pgvector) — kein Kompilieren nötig, exakt passende PG-Version.
FROM apache/age

RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-18-pgvector && \
    rm -rf /var/lib/apt/lists/*

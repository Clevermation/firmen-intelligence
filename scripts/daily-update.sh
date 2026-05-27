#!/bin/bash
# Tägliches Update: Registerbekanntmachungen + Insolvenz + GLEIF Delta
# Läuft als Cronjob, z.B. täglich um 5:00

set -e
cd "$(dirname "$0")/.."

echo "$(date '+%Y-%m-%d %H:%M:%S') [Daily Update] Start"

echo "1/3 Registerbekanntmachungen..."
bun run src/importers/bekanntmachungen.ts || echo "  Bekanntmachungen fehlgeschlagen"

echo "2/3 Insolvenzbekanntmachungen..."
bun run src/importers/insolvenz.ts || echo "  Insolvenz fehlgeschlagen"

echo "3/3 GLEIF Delta..."
bun run src/importers/gleif.ts 5 || echo "  GLEIF fehlgeschlagen"

echo "$(date '+%Y-%m-%d %H:%M:%S') [Daily Update] Fertig"

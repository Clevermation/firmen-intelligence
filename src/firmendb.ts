#!/usr/bin/env bun
import { closeDb } from "./db/connection";
import { searchEntities, getEntityById, getStats } from "./queries/search";
import { getNetwork } from "./queries/network";
import { importOffeneRegister } from "./importers/offeneregister";

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`) || args.includes(`-${name[0]}`);
}

const jsonOutput = hasFlag("json") || hasFlag("j");

async function main() {
  try {
    switch (command) {
      case "search": {
        // Query: alles nach "search" das kein Flag ist, aber auch keine Flag-Values
        const flagNames = ["rechtsform", "ort", "bundesland", "status", "register-art", "limit", "query"];
        const skipNext = new Set<number>();
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          if (arg.startsWith("--") && flagNames.includes(arg.slice(2))) {
            skipNext.add(i);
            skipNext.add(i + 1);
          }
          if (arg === "-j" || arg === "--json") skipNext.add(i);
        }
        const queryParts = args.slice(1).filter((_, i) => !skipNext.has(i + 1));
        const query = queryParts.join(" ") || flag("query");

        const result = await searchEntities({
          query: query || undefined,
          rechtsform: flag("rechtsform"),
          ort: flag("ort"),
          bundesland: flag("bundesland"),
          status: flag("status"),
          registerArt: flag("register-art"),
          limit: parseInt(flag("limit") ?? "25", 10),
        });

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${result.total} Treffer (zeige ${result.results.length}):\n`);
          for (const r of result.results) {
            const d = r.data;
            console.log(`  ${r.name}`);
            console.log(`    Register:   ${d.registerArt ?? ""} ${d.registerNummer ?? "—"}`);
            console.log(`    Sitz:       ${d.sitz ?? "—"} (${d.bundesland ?? "—"})`);
            console.log(`    Rechtsform: ${d.rechtsform ?? "—"}`);
            console.log(`    Status:     ${d.status ?? "—"}`);
            console.log(`    ID:         ${r.id}`);
            console.log();
          }
        }
        break;
      }

      case "profil": {
        const id = args[1];
        if (!id) {
          console.error("Nutzung: firmendb profil <entity-id>");
          process.exit(1);
        }
        const entity = await getEntityById(id);
        if (!entity) {
          console.error(`Entity ${id} nicht gefunden.`);
          process.exit(1);
        }

        if (jsonOutput) {
          console.log(JSON.stringify(entity, null, 2));
        } else {
          const d = entity.data as Record<string, unknown>;
          console.log(`\n${entity.canonical_name}`);
          console.log("=".repeat((entity.canonical_name as string).length));
          console.log(`  Typ:          ${entity.entity_type}`);
          console.log(`  Register:     ${d.registerArt ?? ""} ${d.registerNummer ?? "—"}`);
          console.log(`  Gericht:      ${d.gericht ?? "—"}`);
          console.log(`  Sitz:         ${d.sitz ?? "—"} (${d.bundesland ?? "—"})`);
          console.log(`  Rechtsform:   ${d.rechtsform ?? "—"}`);
          console.log(`  Status:       ${d.status ?? "—"}`);
          console.log(`  Adresse:      ${d.adresse ?? "—"}`);
          if (d.fruehere_namen) {
            console.log(`  Frühere Namen:`);
            for (const n of d.fruehere_namen as string[]) {
              console.log(`    - ${n}`);
            }
          }

          const events = (entity as Record<string, unknown>).events as Record<string, unknown>[];
          if (events?.length) {
            console.log(`\n  Events (${events.length}):`);
            for (const ev of events.slice(0, 20)) {
              console.log(`    ${ev.event_date ?? "?"} | ${ev.event_type} | ${ev.source}`);
            }
          }

          const ids = (entity as Record<string, unknown>).identifiers as Record<string, unknown>[];
          if (ids?.length) {
            console.log(`\n  Identifiers:`);
            for (const id of ids) {
              if (id.type) console.log(`    ${id.type}: ${id.value}${id.qualifier ? ` (${id.qualifier})` : ""}`);
            }
          }
        }
        break;
      }

      case "netzwerk": {
        const id = args[1];
        const depth = parseInt(flag("tiefe") ?? "2", 10);
        if (!id) {
          console.error("Nutzung: firmendb netzwerk <entity-id> [--tiefe 2]");
          process.exit(1);
        }

        const network = await getNetwork(id, depth);

        if (jsonOutput) {
          console.log(JSON.stringify(network, null, 2));
        } else {
          console.log(`\nNetzwerk (${network.nodes.length} Knoten, ${network.edges.length} Kanten):\n`);
          for (const node of network.nodes) {
            const icon = node.type === "firma" ? "🏢" : "👤";
            console.log(`  ${icon} ${node.name} (${node.entityId.substring(0, 8)}...)`);
          }
          console.log();
          for (const edge of network.edges) {
            const fromNode = network.nodes.find((n) => n.entityId === edge.from);
            const toNode = network.nodes.find((n) => n.entityId === edge.to);
            console.log(`  ${fromNode?.name ?? edge.from} --[${edge.relationType}]--> ${toNode?.name ?? edge.to}`);
          }
        }
        break;
      }

      case "events": {
        const db = (await import("./db/connection")).getDb();
        const entityId = args[1]?.startsWith("-") ? undefined : args[1];
        const eventType = flag("typ");
        const since = flag("nach");

        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (entityId) {
          conditions.push(`ev.entity_id = $${idx}`);
          params.push(entityId);
          idx++;
        }
        if (eventType) {
          conditions.push(`ev.event_type = $${idx}`);
          params.push(eventType);
          idx++;
        }
        if (since) {
          conditions.push(`ev.event_date >= $${idx}`);
          params.push(since);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const events = await db.unsafe(
          `SELECT ev.*, e.canonical_name
           FROM events ev
           JOIN entities e ON e.id = ev.entity_id
           ${where}
           ORDER BY ev.event_date DESC NULLS LAST
           LIMIT 50`,
          params
        );

        if (jsonOutput) {
          console.log(JSON.stringify(events, null, 2));
        } else {
          console.log(`${events.length} Events:\n`);
          for (const ev of events) {
            console.log(`  ${ev.event_date ?? "?"} | ${ev.event_type} | ${ev.canonical_name}`);
            if (ev.raw_text) console.log(`    ${(ev.raw_text as string).substring(0, 100)}`);
          }
        }
        break;
      }

      case "stats": {
        const stats = await getStats();
        if (jsonOutput) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log("\n📊 Firmen-Intelligence Statistiken\n");
          console.log("Entities:");
          for (const [type, count] of Object.entries(stats.entities)) {
            console.log(`  ${type}: ${(count as number).toLocaleString("de-DE")}`);
          }
          console.log("\nTop Rechtsformen:");
          for (const r of stats.topRechtsformen) {
            console.log(`  ${r.rechtsform || "(keine)"}: ${r.count.toLocaleString("de-DE")}`);
          }
          console.log("\nTop Bundesländer:");
          for (const b of stats.topBundeslaender) {
            console.log(`  ${b.bundesland || "(keine)"}: ${b.count.toLocaleString("de-DE")}`);
          }
          console.log("\nLetzte Imports:");
          for (const imp of stats.lastImports) {
            console.log(`  ${imp.source} | ${imp.status} | ${imp.started_at}`);
          }
        }
        break;
      }

      case "import": {
        switch (subcommand) {
          case "offeneregister": {
            const file = flag("file") ?? "data/de_companies.jsonl.bz2";
            await importOffeneRegister(file);
            break;
          }
          default:
            console.error(`Unbekannter Import: ${subcommand}`);
            console.error("Verfügbar: offeneregister, gleif");
            process.exit(1);
        }
        break;
      }

      default:
        console.log(`
firmendb — Deutsche Firmen-Intelligence CLI

Befehle:
  search <query>           Firmensuche (Volltext + Filter)
    --rechtsform GmbH      Nach Rechtsform filtern
    --ort Hamburg           Nach Sitz filtern
    --bundesland Bayern    Nach Bundesland filtern
    --status aktiv         Nach Status filtern
    --limit 25             Ergebnisse begrenzen

  profil <entity-id>       Vollständiges Firmenprofil

  netzwerk <entity-id>     Vernetzungs-Graph
    --tiefe 2              Traversal-Tiefe (Standard: 2)

  events [entity-id]       Event-Timeline
    --typ gruendung        Nach Event-Typ filtern
    --nach 2026-01-01      Ab Datum filtern

  stats                    DB-Statistiken

  import offeneregister    Bulk-Import OffeneRegister
    --file <path>          Pfad zur JSONL-Datei

Optionen:
  --json, -j               JSON-Ausgabe
`);
    }
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

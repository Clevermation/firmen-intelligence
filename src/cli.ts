#!/usr/bin/env bun
import { parseArgs } from "util";
import { search } from "./client";
import type { SearchOptions } from "./types";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    search: { type: "string", short: "s" },
    mode: { type: "string", short: "m", default: "all" },
    location: { type: "string", short: "l", default: "" },
    "register-type": { type: "string", default: "" },
    "register-number": { type: "string", default: "" },
    court: { type: "string", default: "" },
    deleted: { type: "boolean", default: false },
    phonetic: { type: "boolean", default: false },
    results: { type: "string", short: "n", default: "10" },
    json: { type: "boolean", short: "j", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help || !values.search) {
  console.log(`
handelsregister — Suche im deutschen Handelsregister

Nutzung:
  bun run src/cli.ts -s "Firmenname" [Optionen]

Optionen:
  -s, --search        Suchbegriff (Pflicht)
  -m, --mode          all | min | exact (Standard: all)
  -l, --location      Niederlassung/Sitz filtern
  --register-type     HRA | HRB | GnR | PR | VR | GsR
  --register-number   Registernummer
  --court             Registergericht-Code (z.B. K1101 = Hamburg)
  --deleted           Gelöschte Einträge einschließen
  --phonetic          Ähnlich klingende Namen einschließen
  -n, --results       Ergebnisse pro Seite: 10 | 25 | 50 | 100
  -j, --json          Ausgabe als JSON
  -h, --help          Diese Hilfe

Beispiele:
  bun run src/cli.ts -s "Deutsche Bahn"
  bun run src/cli.ts -s "Clevermation" --register-type HRB -j
  bun run src/cli.ts -s "Müller" -l "Hamburg" -n 50
`);
  process.exit(values.help ? 0 : 1);
}

const options: SearchOptions = {
  keywords: values.search,
  keywordMode: (values.mode as "all" | "min" | "exact") ?? "all",
  location: values.location,
  registerType: (values["register-type"] as SearchOptions["registerType"]) ?? "",
  registerNumber: values["register-number"],
  courtCode: values.court,
  includeDeleted: values.deleted,
  phonetic: values.phonetic,
  resultsPerPage: parseInt(values.results ?? "10", 10) as 10 | 25 | 50 | 100,
};

try {
  const result = await search(options);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.totalHits === 0) {
      console.log("Keine Treffer gefunden.");
    } else {
      console.log(`${result.totalHits} Treffer:\n`);
      for (const c of result.companies) {
        console.log(`  ${c.name}`);
        console.log(`    Register:  ${c.registerNumber || "—"}`);
        console.log(`    Gericht:   ${c.court}`);
        console.log(`    Land:      ${c.state}`);
        console.log(`    Status:    ${c.status}`);
        if (c.history.length > 0) {
          console.log(`    Historie:`);
          for (const h of c.history) {
            console.log(`      ${h.name} (${h.location})`);
          }
        }
        console.log();
      }
    }
  }
} catch (error) {
  console.error(`Fehler: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

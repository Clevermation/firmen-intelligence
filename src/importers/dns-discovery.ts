/**
 * DNS-Discovery-Importer
 * Findet Websites für Firmen ohne Website-Eintrag, indem aus dem Firmennamen
 * Domain-Varianten generiert und per DNS-Lookup + HTTP-Check geprüft werden.
 *
 * Strategie:
 * 1. Firmennamen normalisieren (Rechtsform entfernen, Umlaute konvertieren, Sonderzeichen raus)
 * 2. Domain-Varianten generieren (.de, .com, mit Bindestrichen)
 * 3. DNS A-Record prüfen (schnell, kein HTTP nötig)
 * 4. HTTP HEAD-Request zur Verifizierung (erreichbar?)
 * 5. Bei Treffer: Website in der DB speichern
 */
import { Resolver } from "dns/promises";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

// DNS-Resolver mit Timeout
const DNS_TIMEOUT_MS = 5000;
// HTTP-Verifizierungs-Timeout
const HTTP_TIMEOUT_MS = 3000;
// Parallelität pro Batch
const CONCURRENCY = 50;

// Rechtsformen die aus dem Firmennamen entfernt werden
const RECHTSFORM_PATTERNS = [
  /\bGmbH\s*&\s*Co\.?\s*KG\b/gi,
  /\bGmbH\s*&\s*Co\.?\s*OHG\b/gi,
  /\bUG\s*\(haftungsbeschränkt\)\b/gi,
  /\bUG\b/gi,
  /\bGmbH\b/gi,
  /\bAG\b/gi,
  /\bSE\b/gi,
  /\be\.?\s*K\.?\b/gi,
  /\bKG\b/gi,
  /\bOHG\b/gi,
  /\be\.?\s*V\.?\b/gi,
  /\beG\b/gi,
  /\bmbH\b/gi,
  /\bGbR\b/gi,
  /\bKGaA\b/gi,
  /\bInc\.?\b/gi,
  /\bLtd\.?\b/gi,
  /\bCo\.?\b/gi,
];

/**
 * Konvertiert Umlaute in ASCII-Äquivalente für Domain-Namen.
 */
function konvertiereUmlaute(text: string): string {
  return text
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "ae")
    .replace(/Ö/g, "oe")
    .replace(/Ü/g, "ue")
    .replace(/ß/g, "ss");
}

/**
 * Entfernt Rechtsform-Zusätze aus dem Firmennamen.
 */
function entferneRechtsform(name: string): string {
  let result = name;
  for (const pattern of RECHTSFORM_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

/**
 * Normalisiert einen Firmennamen zu einem Domain-tauglichen String.
 * Beispiel: "Müller Maschinenbau GmbH" → "muellermaschinenbau"
 */
function normalisiereFirmenname(name: string): { zusammen: string; woerter: string[] } {
  // Rechtsform entfernen
  let clean = entferneRechtsform(name);

  // Umlaute konvertieren
  clean = konvertiereUmlaute(clean);

  // Alles lowercase
  clean = clean.toLowerCase();

  // In Wörter aufteilen (nur alphanumerische Zeichen behalten)
  const woerter = clean
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

  // Zusammengefügt (ohne Trennzeichen)
  const zusammen = woerter.join("");

  return { zusammen, woerter };
}

/**
 * Generiert Domain-Varianten aus dem normalisierten Firmennamen.
 * - firmenname.de
 * - firmenname.com
 * - firmen-name.de (bei mehreren Wörtern, mit Bindestrichen)
 */
function generiereDomainVarianten(zusammen: string, woerter: string[]): string[] {
  if (!zusammen || zusammen.length < 2) return [];

  const varianten: string[] = [];

  // Zusammengeschrieben .de und .com
  varianten.push(`${zusammen}.de`);
  varianten.push(`${zusammen}.com`);

  // Mit Bindestrichen, nur wenn mehrere Wörter vorhanden
  if (woerter.length >= 2) {
    const mitBindestrichen = woerter.join("-");
    // Nur hinzufügen wenn sich die Variante unterscheidet
    if (mitBindestrichen !== zusammen) {
      varianten.push(`${mitBindestrichen}.de`);
    }
  }

  return varianten;
}

/**
 * Prüft per DNS ob eine Domain einen A-Record hat.
 * Gibt die IP-Adressen zurück oder null bei Fehler.
 */
async function pruefeDNS(domain: string): Promise<string[] | null> {
  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);

  try {
    // Timeout über AbortController (Bun/Node 18+ kompatibel)
    const result = await Promise.race([
      resolver.resolve4(domain),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("DNS_TIMEOUT")), DNS_TIMEOUT_MS)
      ),
    ]);

    if (result && Array.isArray(result) && result.length > 0) {
      return result;
    }
    return null;
  } catch {
    // ENOTFOUND, ETIMEOUT, SERVFAIL, etc. — einfach überspringen
    return null;
  }
}

/**
 * Prüft per HTTP HEAD ob die Domain tatsächlich eine erreichbare Website hat.
 * Gibt true zurück wenn der Server antwortet (auch bei Redirects).
 */
async function verifiziereHTTP(domain: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    const response = await fetch(`https://${domain}`, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; FirmenIntelligence/1.0; DNS-Discovery)",
      },
    });
    clearTimeout(timeout);

    // Erfolgreich wenn 2xx oder 3xx (Redirect bereits gefolgt)
    return response.status < 400;
  } catch {
    // Fallback: HTTP statt HTTPS versuchen
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

      const response = await fetch(`http://${domain}`, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; FirmenIntelligence/1.0; DNS-Discovery)",
        },
      });
      clearTimeout(timeout);

      return response.status < 400;
    } catch {
      return false;
    }
  }
}

/**
 * Prüft eine einzelne Firma: Domain-Varianten generieren, DNS prüfen, HTTP verifizieren.
 * Gibt die gefundene Domain zurück oder null.
 */
async function pruefeFirma(
  firmenname: string
): Promise<{ domain: string; verified: boolean } | null> {
  const { zusammen, woerter } = normalisiereFirmenname(firmenname);
  const varianten = generiereDomainVarianten(zusammen, woerter);

  if (varianten.length === 0) return null;

  for (const domain of varianten) {
    const dnsResult = await pruefeDNS(domain);
    if (dnsResult) {
      // DNS existiert — HTTP-Check zur Verifizierung
      const httpOk = await verifiziereHTTP(domain);
      return { domain, verified: httpOk };
    }
  }

  return null;
}

interface FirmaOhneWebsite {
  id: string;
  canonical_name: string;
  sitz: string | null;
}

/**
 * Hauptfunktion: DNS-Discovery für Firmen ohne Website.
 * Arbeitet in Batches mit konfigurierbarer Parallelität.
 *
 * @param batchSize - Wie viele Firmen parallel geprüft werden (Standard: 50)
 */
export async function importDNSDiscovery(batchSize: number = CONCURRENCY) {
  const db = getDb();

  // Import-Run anlegen
  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('dns-discovery', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let totalChecked = 0;
  let domainsFound = 0;
  let domainsVerified = 0;
  let errors = 0;

  console.log("[DNS] Starte DNS-Discovery für Firmen ohne Website...");

  try {
    // Alle aktiven GmbHs/AGs ohne Website laden
    const firmen = (await db.unsafe(`
      SELECT id, canonical_name, data->>'sitz' as sitz
      FROM entities
      WHERE entity_type = 'firma'
        AND data->>'status' = 'aktiv'
        AND data->>'rechtsform' IN ('GMBH', 'AG', 'SE', 'UG (HAFTUNGSBESCHRÄNKT)')
        AND (data->>'website' IS NULL OR data->>'website' = '')
      ORDER BY canonical_name
    `)) as FirmaOhneWebsite[];

    const total = firmen.length;
    console.log(`[DNS] ${total.toLocaleString("de-DE")} Firmen ohne Website gefunden.`);

    if (total === 0) {
      console.log("[DNS] Keine Firmen zu verarbeiten.");
      await db.unsafe(
        `UPDATE import_runs SET status = 'completed', finished_at = now(),
         stats = '{"total_checked": 0, "domains_found": 0, "domains_verified": 0, "errors": 0}'::jsonb
         WHERE id = '${runId}'`
      );
      return;
    }

    // In Batches verarbeiten
    for (let i = 0; i < total; i += batchSize) {
      const batch = firmen.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (firma) => {
          try {
            const result = await pruefeFirma(firma.canonical_name);

            if (result) {
              // Domain gefunden — in DB speichern
              const updateData: Record<string, unknown> = {
                website: `https://${result.domain}`,
                website_source: "dns-discovery",
                website_verified: result.verified,
                website_discovered_at: new Date().toISOString(),
              };

              await updateEntityData(firma.id, updateData);

              return { found: true, verified: result.verified, domain: result.domain, name: firma.canonical_name };
            }

            return { found: false, verified: false, domain: null, name: firma.canonical_name };
          } catch (e) {
            return { found: false, verified: false, domain: null, name: firma.canonical_name, error: (e as Error).message };
          }
        })
      );

      // Ergebnisse auswerten
      for (const result of results) {
        totalChecked++;

        if (result.status === "fulfilled") {
          const val = result.value;
          if (val.found) {
            domainsFound++;
            if (val.verified) {
              domainsVerified++;
            }
            console.log(
              `[DNS] ✓ "${val.name}" → ${val.domain}${val.verified ? " (verifiziert)" : " (nur DNS)"}`
            );
          }
          if (val.error) {
            errors++;
          }
        } else {
          errors++;
        }
      }

      // Fortschritt alle 1000 Firmen loggen (oder am Batch-Ende wenn nah dran)
      if (totalChecked % 1000 < batchSize || i + batchSize >= total) {
        const prozent = ((totalChecked / total) * 100).toFixed(1);
        console.log(
          `[DNS] ${totalChecked.toLocaleString("de-DE")}/${total.toLocaleString("de-DE")} geprüft (${prozent}%), ` +
            `${domainsFound.toLocaleString("de-DE")} gefunden, ` +
            `${domainsVerified.toLocaleString("de-DE")} verifiziert, ` +
            `${errors} Fehler`
        );

        // Zwischenstand in DB speichern
        const statsJson = JSON.stringify({
          total_checked: totalChecked,
          domains_found: domainsFound,
          domains_verified: domainsVerified,
          errors,
          progress_percent: parseFloat(prozent),
        }).replace(/'/g, "''");

        await db.unsafe(
          `UPDATE import_runs SET stats = '${statsJson}'::jsonb WHERE id = '${runId}'`
        );
      }
    }

    // Import-Run abschließen
    const finalStats = JSON.stringify({
      total_checked: totalChecked,
      domains_found: domainsFound,
      domains_verified: domainsVerified,
      errors,
    }).replace(/'/g, "''");

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${finalStats}'::jsonb WHERE id = '${runId}'`
    );

    console.log(`\n[DNS] Import abgeschlossen!`);
    console.log(`  Geprüft:     ${totalChecked.toLocaleString("de-DE")}`);
    console.log(`  Gefunden:    ${domainsFound.toLocaleString("de-DE")}`);
    console.log(`  Verifiziert: ${domainsVerified.toLocaleString("de-DE")}`);
    console.log(`  Fehler:      ${errors}`);
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${(e as Error).message.replace(/'/g, "''")}' WHERE id = '${runId}'`
    );
    throw e;
  }
}

// Direkt ausführbar via CLI
if (import.meta.main) {
  const batchSizeArg = process.argv[2];
  const batchSize = batchSizeArg ? parseInt(batchSizeArg, 10) : CONCURRENCY;

  if (batchSizeArg && isNaN(batchSize)) {
    console.error("[DNS] Ungültiger Batch-Size Parameter. Nutzung: bun run dns-discovery.ts [batchSize]");
    process.exit(1);
  }

  console.log(`[DNS] Starte mit Batch-Size ${batchSize}...`);
  await importDNSDiscovery(batchSize);
  await closeDb();
}

/**
 * Impressum-Scraper
 * Besucht die Websites von Firmen und extrahiert Impressum-Daten:
 * Geschäftsführer, Telefon, E-Mail, USt-ID.
 *
 * Strategie: Versucht /impressum, /imprint, /legal, /kontakt und
 * sucht alternativ nach Impressum-Links auf der Startseite.
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

// Typische Impressum-Pfade (absteigend nach Wahrscheinlichkeit)
const IMPRESSUM_PATHS = [
  "/impressum",
  "/imprint",
  "/legal",
  "/impressum.html",
  "/de/impressum",
  "/legal-notice",
  "/kontakt",
  "/ueber-uns/impressum",
  "/about/imprint",
  "/impressum/",
  "/de/impressum/",
];

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

// Pause zwischen Requests (höfliches Scraping)
const REQUEST_DELAY_MS = 1500;
// Timeout pro Request
const FETCH_TIMEOUT_MS = 10000;

interface ImpressumDaten {
  geschaeftsfuehrer: string[];
  telefon: string[];
  email: string[];
  ustId: string | null;
  handelsregister: string | null;
  adresse: string | null;
  quelleUrl: string;
}

/**
 * Versucht die Impressum-Seite einer Website zu finden und zu laden
 */
async function findeImpressum(baseUrl: string): Promise<{ html: string; url: string } | null> {
  // URL normalisieren
  let normalizedUrl = baseUrl.trim();
  if (!normalizedUrl.startsWith("http")) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  // Trailing Slash entfernen
  normalizedUrl = normalizedUrl.replace(/\/+$/, "");

  // Erst die bekannten Pfade probieren
  for (const path of IMPRESSUM_PATHS) {
    const url = `${normalizedUrl}${path}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(url, {
        headers: HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const html = await response.text();
        // Prüfen ob die Seite tatsächlich Impressum-Inhalt hat
        if (
          html.toLowerCase().includes("impressum") ||
          html.toLowerCase().includes("imprint") ||
          html.toLowerCase().includes("geschäftsführ") ||
          html.toLowerCase().includes("ust-id")
        ) {
          return { html, url };
        }
      }
    } catch {
      // Nächsten Pfad versuchen
    }
  }

  // Fallback: Startseite laden und nach Impressum-Link suchen
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(normalizedUrl, {
      headers: HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Nach Impressum-Link suchen
    let impressumLink: string | null = null;
    $("a").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().toLowerCase().trim();
      if (
        text.includes("impressum") ||
        text.includes("imprint") ||
        text.includes("legal notice") ||
        href.toLowerCase().includes("impressum") ||
        href.toLowerCase().includes("imprint")
      ) {
        impressumLink = href;
        return false; // cheerio each break
      }
    });

    if (impressumLink) {
      // Relativen Link auflösen
      const fullUrl = impressumLink.startsWith("http")
        ? impressumLink
        : `${normalizedUrl}${impressumLink.startsWith("/") ? "" : "/"}${impressumLink}`;

      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), FETCH_TIMEOUT_MS);

      const impResponse = await fetch(fullUrl, {
        headers: HEADERS,
        redirect: "follow",
        signal: controller2.signal,
      });
      clearTimeout(timeout2);

      if (impResponse.ok) {
        return { html: await impResponse.text(), url: fullUrl };
      }
    }
  } catch {
    // Website nicht erreichbar
  }

  return null;
}

/**
 * Extrahiert strukturierte Daten aus dem Impressum-HTML
 */
function extrahiereImpressumDaten(html: string, url: string): ImpressumDaten {
  const $ = cheerio.load(html);

  // Nur den Hauptinhalt extrahieren (ohne Navigation, Footer-Duplikate etc.)
  const mainContent =
    $("main").text() ||
    $("article").text() ||
    $(".content, .main-content, #content, #main").text() ||
    $("body").text();

  const text = mainContent.replace(/\s+/g, " ");

  // Geschäftsführer extrahieren
  const geschaeftsfuehrer: string[] = [];
  const gfPatterns = [
    /(?:Geschäftsführ(?:er|ung|erin)|Managing\s*Director|CEO|Vorstand|Inhaber(?:in)?|Vertretungsberecht)[\s:]*([A-ZÄÖÜ][a-zäöüß]+(?:\s+(?:von\s+|de\s+)?[A-ZÄÖÜ][a-zäöüß]+){1,3})/gi,
    /(?:vertreten\s+durch|gesetzlich\s+vertreten)[\s:]*([A-ZÄÖÜ][a-zäöüß]+(?:\s+(?:von\s+|de\s+)?[A-ZÄÖÜ][a-zäöüß]+){1,3})/gi,
  ];

  for (const pattern of gfPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim();
      // Keine Duplikate, keine zu kurzen Namen
      if (name.length > 5 && !geschaeftsfuehrer.includes(name)) {
        geschaeftsfuehrer.push(name);
      }
    }
  }

  // Telefonnummern extrahieren
  const telefon: string[] = [];
  const telPattern =
    /(?:Tel(?:efon|\.)?|Phone|Fon|Telefax|Fax)[\s.:]*(\+?\d[\d\s/()-]{6,20}\d)/gi;
  let telMatch: RegExpExecArray | null;
  while ((telMatch = telPattern.exec(text)) !== null) {
    const nr = telMatch[1].trim();
    if (!telefon.includes(nr)) telefon.push(nr);
  }

  // E-Mail-Adressen extrahieren
  const email: string[] = [];
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  let emailMatch: RegExpExecArray | null;
  while ((emailMatch = emailPattern.exec(text)) !== null) {
    const addr = emailMatch[0].toLowerCase();
    // Offensichtliche Tracking/System-Adressen filtern
    if (
      !addr.includes("wixpress") &&
      !addr.includes("sentry") &&
      !addr.includes("example") &&
      !addr.includes("webpack") &&
      !email.includes(addr)
    ) {
      email.push(addr);
    }
  }

  // USt-ID extrahieren
  const ustIdMatch = text.match(
    /(?:USt[.-]?\s*(?:Id[.-]?\s*Nr\.?|Identifikationsnummer)|VAT[\s.-]*(?:ID|Number|Nr))[\s.:]*([A-Z]{2}\s*\d[\d\s]{7,12}\d)/i
  );
  const ustId = ustIdMatch ? ustIdMatch[1].replace(/\s/g, "") : null;

  // Handelsregister extrahieren
  const hrMatch = text.match(
    /(?:Handelsregister|Register(?:gericht|eintrag)|HRB|HRA)[\s:]*([A-Za-z]+\s*(?:HRB|HRA)\s*\d+|(?:HRB|HRA)\s*\d+(?:\s*[A-Za-z]+)?)/i
  );
  const handelsregister = hrMatch ? hrMatch[1].trim() : null;

  // Adresse extrahieren (vereinfacht: PLZ + Ort-Muster)
  const adresseMatch = text.match(
    /(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[a-zäöüß]+)?)/
  );
  const adresse = adresseMatch
    ? `${adresseMatch[1]} ${adresseMatch[2]}`
    : null;

  return {
    geschaeftsfuehrer,
    telefon: telefon.slice(0, 5), // Max 5 Nummern
    email: email.slice(0, 5), // Max 5 Adressen
    ustId,
    handelsregister,
    adresse,
    quelleUrl: url,
  };
}

/**
 * Importiert Impressum-Daten für eine einzelne Firma
 */
export async function importImpressumFuerEntity(entityId: string): Promise<ImpressumDaten | null> {
  const db = getDb();

  // Entity laden und Website-URL bestimmen
  const entities = await db.unsafe(
    `SELECT id, canonical_name, data FROM entities
     WHERE id = '${escapeString(entityId)}' AND entity_type = 'firma'`
  );

  if (entities.length === 0) {
    console.warn(`[Impressum] Entity ${entityId} nicht gefunden oder keine Firma`);
    return null;
  }

  const entity = entities[0] as { id: string; canonical_name: string; data: Record<string, unknown> };
  const data = typeof entity.data === "string" ? JSON.parse(entity.data) : entity.data;

  // Website-URL aus verschiedenen Quellen versuchen
  const websiteUrl =
    (data.website as string) ??
    (data.homepage as string) ??
    (data.url as string) ??
    null;

  if (!websiteUrl) {
    console.warn(`[Impressum] Keine Website-URL für "${entity.canonical_name}"`);
    return null;
  }

  console.log(`[Impressum] Scrape Impressum von ${websiteUrl} für "${entity.canonical_name}"...`);

  const impressumPage = await findeImpressum(websiteUrl);
  if (!impressumPage) {
    console.warn(`[Impressum] Kein Impressum gefunden für "${entity.canonical_name}" (${websiteUrl})`);
    return null;
  }

  const daten = extrahiereImpressumDaten(impressumPage.html, impressumPage.url);

  // Daten in Entity aktualisieren
  const updateData: Record<string, unknown> = {
    impressum_gescraped: new Date().toISOString().split("T")[0],
    impressum_url: daten.quelleUrl,
  };

  if (daten.geschaeftsfuehrer.length > 0) {
    updateData.geschaeftsfuehrer = daten.geschaeftsfuehrer;
  }
  if (daten.telefon.length > 0) {
    updateData.telefon = daten.telefon;
  }
  if (daten.email.length > 0) {
    updateData.kontakt_email = daten.email;
  }
  if (daten.ustId) {
    updateData.ust_id = daten.ustId;
  }
  if (daten.handelsregister) {
    updateData.handelsregister_impressum = daten.handelsregister;
  }
  if (daten.adresse) {
    updateData.adresse_impressum = daten.adresse;
  }

  await updateEntityData(entityId, updateData);

  console.log(
    `[Impressum] Daten für "${entity.canonical_name}" gespeichert: ` +
      `${daten.geschaeftsfuehrer.length} GF, ${daten.telefon.length} Tel, ${daten.email.length} Email` +
      (daten.ustId ? `, USt-ID: ${daten.ustId}` : "")
  );

  return daten;
}

/**
 * Batch-Import: Scrapet Impressum für alle Firmen mit Website
 */
export async function importImpressumBatch(limit: number = 100) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('impressum-scraper', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let verarbeitet = 0;
  let erfolgreich = 0;
  let fehler = 0;

  console.log("[Impressum] Starte Batch-Import...");

  try {
    // Firmen mit Website laden, die noch kein Impressum-Scraping hatten
    const firmen = (await db.unsafe(
      `SELECT id, canonical_name, data FROM entities
       WHERE entity_type = 'firma'
         AND (data->>'website' IS NOT NULL OR data->>'homepage' IS NOT NULL OR data->>'url' IS NOT NULL)
         AND data->>'impressum_gescraped' IS NULL
         AND data->>'status' NOT IN ('aufgelöst', 'gelöscht')
       ORDER BY updated_at DESC
       LIMIT ${limit}`
    )) as { id: string; canonical_name: string; data: Record<string, unknown> }[];

    console.log(`[Impressum] ${firmen.length} Firmen mit Website zum Scrapen gefunden.`);

    for (const firma of firmen) {
      try {
        const result = await importImpressumFuerEntity(firma.id);
        verarbeitet++;
        if (result) erfolgreich++;
      } catch (e) {
        fehler++;
        console.warn(
          `[Impressum] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }

      // Fortschritt loggen
      if (verarbeitet % 10 === 0) {
        console.log(
          `[Impressum] Fortschritt: ${verarbeitet}/${firmen.length}, ${erfolgreich} erfolgreich, ${fehler} Fehler`
        );
      }

      // Rate-Limiting
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({
         verarbeitet,
         erfolgreich,
         fehler,
       }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Impressum] Batch-Import abgeschlossen!`);
    console.log(`  Verarbeitet: ${verarbeitet}`);
    console.log(`  Erfolgreich: ${erfolgreich}`);
    console.log(`  Fehler: ${fehler}`);
  } catch (e) {
    await db.unsafe(
      `UPDATE import_runs SET status = 'failed', finished_at = now(),
       error = '${(e as Error).message.replace(/'/g, "''")}' WHERE id = '${runId}'`
    );
    throw e;
  }
}

// Direkt ausführbar
if (import.meta.main) {
  const entityId = process.argv[2];
  if (entityId) {
    await importImpressumFuerEntity(entityId);
  } else {
    console.log("[Impressum] Kein Entity-ID angegeben, starte Batch-Import (100 Firmen)...");
    await importImpressumBatch(100);
  }
  await closeDb();
}

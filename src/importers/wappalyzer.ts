/**
 * Wappalyzer-Importer (Lightweight)
 * Erkennt den Technologie-Stack von Firmen-Websites anhand von:
 * - HTTP-Headern (X-Powered-By, Server, X-Generator etc.)
 * - HTML-Meta-Tags (generator, framework-Hinweise)
 * - Script/Link-Referenzen (CDN-URLs, bekannte Pfade)
 * - Cookie-Namen (bekannte Framework-Cookies)
 *
 * Kein externer Service nötig — reine Header- und HTML-Analyse.
 */
import * as cheerio from "cheerio";
import { getDb, closeDb } from "../db/connection";
import { updateEntityData, escapeString } from "../db/helpers";

// Pause zwischen Requests (höfliches Scraping)
const REQUEST_DELAY_MS = 1000;
// Timeout pro Request
const FETCH_TIMEOUT_MS = 10000;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

interface TechStackResult {
  technologies: string[];
  cms: string | null;
  framework: string | null;
  server: string | null;
  analyseUrl: string;
}

// ═══════════════════════════════════════════════════
// Technologie-Erkennungsregeln
// ═══════════════════════════════════════════════════

/** Header-basierte Erkennung */
const HEADER_RULES: { header: string; patterns: { regex: RegExp; tech: string }[] }[] = [
  {
    header: "x-powered-by",
    patterns: [
      { regex: /PHP/i, tech: "PHP" },
      { regex: /ASP\.NET/i, tech: "ASP.NET" },
      { regex: /Express/i, tech: "Express.js" },
      { regex: /Next\.js/i, tech: "Next.js" },
      { regex: /Nuxt/i, tech: "Nuxt.js" },
      { regex: /Phusion/i, tech: "Phusion Passenger" },
      { regex: /Servlet/i, tech: "Java Servlet" },
      { regex: /JSF/i, tech: "JavaServer Faces" },
      { regex: /WP\s*Engine/i, tech: "WP Engine" },
      { regex: /PleskLin/i, tech: "Plesk" },
    ],
  },
  {
    header: "server",
    patterns: [
      { regex: /nginx/i, tech: "nginx" },
      { regex: /Apache/i, tech: "Apache" },
      { regex: /cloudflare/i, tech: "Cloudflare" },
      { regex: /Microsoft-IIS/i, tech: "Microsoft IIS" },
      { regex: /LiteSpeed/i, tech: "LiteSpeed" },
      { regex: /Vercel/i, tech: "Vercel" },
      { regex: /Netlify/i, tech: "Netlify" },
      { regex: /openresty/i, tech: "OpenResty" },
      { regex: /Caddy/i, tech: "Caddy" },
      { regex: /envoy/i, tech: "Envoy" },
      { regex: /AmazonS3/i, tech: "Amazon S3" },
      { regex: /GSE/i, tech: "Google Frontend" },
    ],
  },
  {
    header: "x-generator",
    patterns: [
      { regex: /Drupal/i, tech: "Drupal" },
      { regex: /WordPress/i, tech: "WordPress" },
      { regex: /Joomla/i, tech: "Joomla" },
    ],
  },
];

/** HTML-Meta-Tag und Script-basierte Erkennung */
const HTML_RULES: { selector: string; attr?: string; patterns: { regex: RegExp; tech: string }[] }[] = [
  // Meta-Generator
  {
    selector: 'meta[name="generator"]',
    attr: "content",
    patterns: [
      { regex: /WordPress/i, tech: "WordPress" },
      { regex: /Drupal/i, tech: "Drupal" },
      { regex: /Joomla/i, tech: "Joomla" },
      { regex: /TYPO3/i, tech: "TYPO3" },
      { regex: /Wix\.com/i, tech: "Wix" },
      { regex: /Squarespace/i, tech: "Squarespace" },
      { regex: /Shopify/i, tech: "Shopify" },
      { regex: /Hugo/i, tech: "Hugo" },
      { regex: /Jekyll/i, tech: "Jekyll" },
      { regex: /Gatsby/i, tech: "Gatsby" },
      { regex: /Webflow/i, tech: "Webflow" },
      { regex: /Contao/i, tech: "Contao" },
      { regex: /Jimdo/i, tech: "Jimdo" },
      { regex: /PrestaShop/i, tech: "PrestaShop" },
      { regex: /Magento/i, tech: "Magento" },
      { regex: /Ghost/i, tech: "Ghost" },
      { regex: /Blogger/i, tech: "Blogger" },
    ],
  },
];

/** URL-Pattern-basierte Erkennung (in script src, link href etc.) */
const URL_PATTERNS: { regex: RegExp; tech: string }[] = [
  // JavaScript-Frameworks
  { regex: /react(?:\.production)?\.min\.js/i, tech: "React" },
  { regex: /vue(?:\.min)?\.js/i, tech: "Vue.js" },
  { regex: /angular(?:\.min)?\.js/i, tech: "Angular" },
  { regex: /svelte/i, tech: "Svelte" },
  { regex: /jquery(?:\.min)?\.js/i, tech: "jQuery" },
  { regex: /bootstrap/i, tech: "Bootstrap" },
  { regex: /tailwindcss|tailwind/i, tech: "Tailwind CSS" },

  // CMS / E-Commerce
  { regex: /wp-content|wp-includes/i, tech: "WordPress" },
  { regex: /sites\/default\/files/i, tech: "Drupal" },
  { regex: /media\/jui/i, tech: "Joomla" },
  { regex: /typo3conf|typo3temp/i, tech: "TYPO3" },
  { regex: /cdn\.shopify\.com/i, tech: "Shopify" },
  { regex: /static\.parastorage\.com/i, tech: "Wix" },
  { regex: /squarespace\.com/i, tech: "Squarespace" },
  { regex: /webflow\.com/i, tech: "Webflow" },
  { regex: /jimdo/i, tech: "Jimdo" },

  // Analytics & Marketing
  { regex: /google-analytics\.com|googletagmanager\.com|gtag/i, tech: "Google Analytics" },
  { regex: /facebook\.net\/.*fbevents|connect\.facebook/i, tech: "Facebook Pixel" },
  { regex: /hotjar\.com/i, tech: "Hotjar" },
  { regex: /matomo/i, tech: "Matomo" },
  { regex: /hubspot/i, tech: "HubSpot" },
  { regex: /cookiebot/i, tech: "Cookiebot" },
  { regex: /cookieconsent/i, tech: "Cookie Consent" },
  { regex: /usercentrics/i, tech: "Usercentrics" },
];

/** Cookie-basierte Erkennung */
const COOKIE_PATTERNS: { regex: RegExp; tech: string }[] = [
  { regex: /wordpress_logged_in|wp-/i, tech: "WordPress" },
  { regex: /PHPSESSID/i, tech: "PHP" },
  { regex: /JSESSIONID/i, tech: "Java" },
  { regex: /ASP\.NET_SessionId/i, tech: "ASP.NET" },
  { regex: /_shopify/i, tech: "Shopify" },
  { regex: /laravel_session/i, tech: "Laravel" },
];

/**
 * Analysiert eine Website und erkennt den Technologie-Stack.
 */
async function analysiereWebsite(url: string): Promise<TechStackResult | null> {
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith("http")) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  normalizedUrl = normalizedUrl.replace(/\/+$/, "");

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

    const technologies = new Set<string>();
    let cms: string | null = null;
    let framework: string | null = null;
    let server: string | null = null;

    // 1. Header analysieren
    for (const rule of HEADER_RULES) {
      const headerValue = response.headers.get(rule.header);
      if (headerValue) {
        for (const pattern of rule.patterns) {
          if (pattern.regex.test(headerValue)) {
            technologies.add(pattern.tech);
            if (rule.header === "server") {
              server = pattern.tech;
            }
          }
        }
      }
    }

    // Set-Cookie Header analysieren
    const cookies = response.headers.get("set-cookie") ?? "";
    for (const pattern of COOKIE_PATTERNS) {
      if (pattern.regex.test(cookies)) {
        technologies.add(pattern.tech);
      }
    }

    // 2. HTML analysieren
    const html = await response.text();
    const $ = cheerio.load(html);

    // Meta-Tags
    for (const rule of HTML_RULES) {
      $(rule.selector).each((_, el) => {
        const value = rule.attr ? $(el).attr(rule.attr) : $(el).text();
        if (value) {
          for (const pattern of rule.patterns) {
            if (pattern.regex.test(value)) {
              technologies.add(pattern.tech);
              // CMS erkennen
              if (
                ["WordPress", "Drupal", "Joomla", "TYPO3", "Wix",
                 "Squarespace", "Shopify", "Webflow", "Contao",
                 "Jimdo", "Ghost", "Blogger"].includes(pattern.tech)
              ) {
                cms = pattern.tech;
              }
            }
          }
        }
      });
    }

    // Script-Quellen und Link-Referenzen
    const allUrls: string[] = [];
    $("script[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) allUrls.push(src);
    });
    $("link[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href) allUrls.push(href);
    });

    // Auch Inline-Scripts durchsuchen (für Framework-Hinweise)
    const inlineScripts = $("script:not([src])").text();

    for (const u of allUrls) {
      for (const pattern of URL_PATTERNS) {
        if (pattern.regex.test(u)) {
          technologies.add(pattern.tech);
          // CMS-Erkennung aus URLs
          if (
            ["WordPress", "Drupal", "Joomla", "TYPO3", "Shopify",
             "Wix", "Squarespace", "Webflow", "Jimdo"].includes(pattern.tech)
          ) {
            cms = cms ?? pattern.tech;
          }
          // Framework-Erkennung
          if (
            ["React", "Vue.js", "Angular", "Svelte"].includes(pattern.tech)
          ) {
            framework = framework ?? pattern.tech;
          }
        }
      }
    }

    // Inline-Scripts auf Framework-Hinweise prüfen
    if (inlineScripts.includes("__NEXT_DATA__")) {
      technologies.add("Next.js");
      framework = framework ?? "Next.js";
    }
    if (inlineScripts.includes("__NUXT__")) {
      technologies.add("Nuxt.js");
      framework = framework ?? "Nuxt.js";
    }
    if (html.includes("data-reactroot") || html.includes("__reactFiber")) {
      technologies.add("React");
      framework = framework ?? "React";
    }

    if (technologies.size === 0) return null;

    return {
      technologies: Array.from(technologies).sort(),
      cms,
      framework,
      server,
      analyseUrl: normalizedUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Hauptfunktion: Importiert Technologie-Stack-Daten für Firmen mit Website.
 * @param entityIds - Optionale Liste spezifischer Entity-IDs
 */
export async function importWappalyzer(entityIds?: string[]) {
  const db = getDb();

  const runResult = await db.unsafe(
    `INSERT INTO import_runs (source, status) VALUES ('wappalyzer', 'running') RETURNING id`
  );
  const runId = runResult[0].id as string;

  let verarbeitet = 0;
  let erfolgreich = 0;
  let fehler = 0;

  console.log("[Wappalyzer] Starte Technologie-Erkennung...");

  try {
    let firmen: { id: string; canonical_name: string; data: Record<string, unknown> }[];

    if (entityIds?.length) {
      const idList = entityIds.map((id) => `'${escapeString(id)}'`).join(",");
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, data FROM entities
         WHERE id IN (${idList}) AND entity_type = 'firma'`
      )) as typeof firmen;
    } else {
      // Firmen mit Website ohne bisherige Tech-Analyse
      firmen = (await db.unsafe(
        `SELECT id, canonical_name, data FROM entities
         WHERE entity_type = 'firma'
           AND (data->>'website' IS NOT NULL OR data->>'homepage' IS NOT NULL OR data->>'url' IS NOT NULL)
           AND data->>'tech_stack' IS NULL
           AND (data->>'status' IS NULL OR data->>'status' NOT IN ('aufgelöst', 'gelöscht'))
         ORDER BY updated_at DESC
         LIMIT 500`
      )) as typeof firmen;
    }

    console.log(`[Wappalyzer] ${firmen.length} Firmen mit Website zu analysieren.`);

    for (const firma of firmen) {
      try {
        const data =
          typeof firma.data === "string" ? JSON.parse(firma.data) : firma.data;
        const websiteUrl =
          (data.website as string) ??
          (data.homepage as string) ??
          (data.url as string) ??
          null;

        if (!websiteUrl) {
          verarbeitet++;
          continue;
        }

        const result = await analysiereWebsite(websiteUrl);
        verarbeitet++;

        if (result) {
          const updateData: Record<string, unknown> = {
            tech_stack: result.technologies,
            tech_analysiert: new Date().toISOString().split("T")[0],
          };

          if (result.cms) {
            updateData.tech_cms = result.cms;
          }
          if (result.framework) {
            updateData.tech_framework = result.framework;
          }
          if (result.server) {
            updateData.tech_server = result.server;
          }

          await updateEntityData(firma.id, updateData);
          erfolgreich++;

          console.log(
            `[Wappalyzer] "${firma.canonical_name}": ${result.technologies.join(", ")}` +
              (result.cms ? ` (CMS: ${result.cms})` : "")
          );
        } else {
          // Markieren, dass Analyse durchgeführt wurde
          await updateEntityData(firma.id, {
            tech_stack: [],
            tech_analysiert: new Date().toISOString().split("T")[0],
          });
        }
      } catch (e) {
        fehler++;
        console.warn(
          `[Wappalyzer] Fehler bei "${firma.canonical_name}": ${(e as Error).message}`
        );
      }

      // Fortschritt loggen
      if (verarbeitet % 25 === 0) {
        console.log(
          `[Wappalyzer] Fortschritt: ${verarbeitet}/${firmen.length}, ${erfolgreich} analysiert, ${fehler} Fehler`
        );
      }

      // Rate-Limiting
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }

    await db.unsafe(
      `UPDATE import_runs SET status = 'completed', finished_at = now(),
       stats = '${JSON.stringify({ verarbeitet, erfolgreich, fehler }).replace(/'/g, "''")}'::jsonb
       WHERE id = '${runId}'`
    );

    console.log(`[Wappalyzer] Technologie-Erkennung abgeschlossen!`);
    console.log(`  Verarbeitet: ${verarbeitet}`);
    console.log(`  Technologien gefunden: ${erfolgreich}`);
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
    await importWappalyzer([entityId]);
  } else {
    console.log("[Wappalyzer] Kein Entity-ID angegeben, starte Batch-Analyse (500 Firmen)...");
    await importWappalyzer();
  }
  await closeDb();
}

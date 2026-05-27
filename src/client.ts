import * as cheerio from "cheerio";
import type {
  Company,
  Court,
  HistoryEntry,
  SearchOptions,
  SearchResult,
} from "./types";

const BASE_URL = "https://www.handelsregister.de";
const SEARCH_PATH = "/rp_web/normalesuche/welcome.xhtml";
const SEARCH_URL = `${BASE_URL}${SEARCH_PATH}`;

const KEYWORD_MODE_MAP = { all: "1", min: "2", exact: "3" } as const;

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
  Connection: "keep-alive",
};

function extractViewState(html: string): string {
  const $ = cheerio.load(html);
  const viewState = $(
    'input[name="javax.faces.ViewState"]'
  ).first().attr("value");
  if (!viewState) {
    throw new Error(
      "javax.faces.ViewState nicht gefunden — Seitenstruktur hat sich geändert"
    );
  }
  return viewState;
}

function extractSessionCookie(headers: Headers): string | null {
  const setCookie = headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    const match = cookie.match(/JSESSIONID=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

function parseCompanies(html: string): { companies: Company[]; totalHits: number } {
  const $ = cheerio.load(html);
  const companies: Company[] = [];

  const hitsMatch = html.match(/(\d+)-(\d+)\s+von\s+(\d+)\s+Treffer/);
  const totalHits = hitsMatch ? parseInt(hitsMatch[3], 10) : 0;

  const grid = $('table[role="grid"]').first();
  if (!grid.length) return { companies, totalHits };

  grid.find("tr[data-ri]").each((_, row) => {
    const $row = $(row);

    // Gericht + Registernummer aus der Header-Zeile der verschachtelten Panelgrid
    const courtLine = $row.find(".fontTableNameSize").first().text().trim();
    const regMatch = courtLine.match(
      /(HRA|HRB|GnR|VR|PR|GsR)\s*\d+(\s+[A-Z]{1,2})?(?!\w)/
    );

    // Bundesland = erstes Wort vor dem Amtsgericht
    const stateMatch = courtLine.match(/^(\S+)\s/);
    const state = stateMatch ? stateMatch[1] : "";

    // Gerichtsname extrahieren
    const courtMatch = courtLine.match(/Amtsgericht\s+(.+?)(?:\s+(?:HRA|HRB|GnR|VR|PR|GsR))/);
    const courtName = courtMatch ? `Amtsgericht ${courtMatch[1].trim()}` : courtLine;

    // Firmenname
    const name = $row.find(".marginLeft20").first().text().trim();

    // Sitz
    const sitz = $row.find(".sitzSuchErgebnisse").first().text().trim();

    // Status
    const statusEl = $row.find(".sitzSuchErgebnisse").parent().find("td").eq(1);
    let status = "";
    $row.find("td").each((__, td) => {
      const text = $(td).text().trim();
      if (text === "aktuell" || text === "gelöscht" || text === "Löschung angekündigt") {
        status = text;
      }
    });

    const company: Company = {
      name,
      court: courtName,
      registerType: regMatch ? regMatch[1] : "",
      registerNumber: regMatch ? regMatch[0].trim() : "",
      state: sitz || state,
      status,
      history: [],
    };

    // Historie: Zeilen mit nummeriertem Muster "1.) Name" + "1.) Ort"
    $row.find("tr").each((__, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 2) {
        const col1 = tds.eq(0).text().trim();
        const col2 = tds.eq(1).text().trim();
        const nameMatch = col1.match(/^\d+\.\)\s*(.+)/);
        const locMatch = col2.match(/^\d+\.\)\s*(.+)/);
        if (nameMatch && locMatch) {
          company.history.push({
            name: nameMatch[1],
            location: locMatch[1],
          });
        }
      }
    });

    companies.push(company);
  });

  return { companies, totalHits };
}

export function extractCourts(html: string): Court[] {
  const $ = cheerio.load(html);
  const courts: Court[] = [];
  $("#form\\:registergericht_input option").each((_, opt) => {
    const code = $(opt).attr("value") ?? "";
    const name = $(opt).text().trim();
    if (code) courts.push({ code, name });
  });
  return courts;
}

export async function search(options: SearchOptions): Promise<SearchResult> {
  const {
    keywords,
    keywordMode = "all",
    location = "",
    registerType = "",
    registerNumber = "",
    courtCode = "",
    includeDeleted = false,
    phonetic = false,
    resultsPerPage = 10,
  } = options;

  // Schritt 1: Suchseite laden → ViewState + Session-Cookie
  const pageResponse = await fetch(SEARCH_URL, {
    headers: DEFAULT_HEADERS,
    redirect: "follow",
  });

  if (!pageResponse.ok) {
    throw new Error(`Suchseite nicht erreichbar: ${pageResponse.status}`);
  }

  const pageHtml = await pageResponse.text();
  const viewState = extractViewState(pageHtml);
  const sessionId = extractSessionCookie(pageResponse.headers);

  // Schritt 2: Suchformular absenden
  const formData = new URLSearchParams({
    form: "form",
    "javax.faces.ViewState": viewState,
    suchTyp: "n",
    "form:schlagwoerter": keywords,
    "form:schlagwortOptionen": KEYWORD_MODE_MAP[keywordMode],
    "form:NiederlassungSitz": location,
    "form:registerArt_focus": "",
    "form:registerArt_input": registerType,
    "form:registerNummer": registerNumber,
    "form:registergericht_focus": "",
    "form:registergericht_input": courtCode,
    "form:ergebnisseProSeite_focus": "",
    "form:ergebnisseProSeite_input": String(resultsPerPage),
    "form:btnSuche": "",
  });

  if (includeDeleted) {
    formData.set("form:auchGeloeschte_input", "on");
  }
  if (phonetic) {
    formData.set("form:aenlichLautendeSchlagwoerterBoolChkbox_input", "on");
  }

  const searchHeaders: Record<string, string> = {
    ...DEFAULT_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: SEARCH_URL,
  };
  if (sessionId) {
    searchHeaders.Cookie = `JSESSIONID=${sessionId}`;
  }

  const searchResponse = await fetch(SEARCH_URL, {
    method: "POST",
    headers: searchHeaders,
    body: formData.toString(),
    redirect: "follow",
  });

  if (!searchResponse.ok) {
    throw new Error(`Suche fehlgeschlagen: ${searchResponse.status}`);
  }

  const resultHtml = await searchResponse.text();
  const { companies, totalHits } = parseCompanies(resultHtml);

  return { companies, totalHits, query: options };
}

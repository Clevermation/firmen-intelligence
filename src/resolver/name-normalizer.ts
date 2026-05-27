const RECHTSFORM_SUFFIXE = [
  "aktiengesellschaft",
  "gesellschaft mit beschränkter haftung",
  "gesellschaft mit beschraenkter haftung",
  "eingetragene genossenschaft",
  "kommanditgesellschaft auf aktien",
  "kommanditgesellschaft",
  "offene handelsgesellschaft",
  "gesellschaft bürgerlichen rechts",
  "eingetragener kaufmann",
  "eingetragene kauffrau",
  "partnerschaftsgesellschaft",
  "stiftung",
  "gmbh & co. kg",
  "gmbh & co. ohg",
  "gmbh & co kg",
  "ug (haftungsbeschränkt)",
  "ug (haftungsbeschraenkt)",
  "ug haftungsbeschränkt",
  "gmbh",
  "mbh",
  "ag",
  "ug",
  "kg",
  "ohg",
  "gbr",
  "e.k.",
  "e.v.",
  "e.g.",
  "eg",
  "ev",
  "ek",
  "kgaa",
  "se",
  "partg",
  "partg mbb",
  "ltd",
  "limited",
  "inc",
  "corp",
  "s.a.",
  "s.r.l.",
  "b.v.",
];

const RECHTSFORM_PATTERN = new RegExp(
  `\\b(${RECHTSFORM_SUFFIXE.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`,
  "i"
);

export function normalizeCompanyName(name: string): string {
  let normalized = name.trim().toLowerCase();
  normalized = normalized.replace(/\s+/g, " ");
  normalized = normalized.replace(/[„""]/g, '"');
  normalized = normalized.replace(/['']/g, "'");
  normalized = RECHTSFORM_PATTERN[Symbol.replace](normalized, "").trim();
  normalized = normalized.replace(/[,.\-/()'"]+$/g, "").trim();
  return normalized;
}

export function normalizePersonName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function extractRechtsform(name: string): string {
  const match = name.match(RECHTSFORM_PATTERN);
  return match ? match[1].toUpperCase().replace(/\./g, "") : "";
}

export function buildRegisterKey(
  gericht: string,
  registerArt: string,
  registerNummer: string
): string {
  const g = gericht.trim().toLowerCase().replace(/\s+/g, " ");
  const a = registerArt.trim().toUpperCase();
  const n = registerNummer.trim().replace(/\s+/g, "");
  return `${g}|${a}|${n}`;
}

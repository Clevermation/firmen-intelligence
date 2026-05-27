import { test, expect, describe } from "bun:test";
import { search } from "./client";

describe("handelsregister search", { timeout: 15_000 }, () => {
  test("findet bekannte Firma (GASAG)", async () => {
    const result = await search({ keywords: "GASAG AG", keywordMode: "exact" });
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.companies.length).toBeGreaterThan(0);

    const gasag = result.companies.find((c) => c.name.includes("GASAG AG"));
    expect(gasag).toBeDefined();
    expect(gasag!.registerType).toBe("HRB");
    expect(gasag!.state).toBe("Berlin");
    expect(gasag!.status).toBe("aktuell");
  });

  test("liefert 0 Treffer für unbekannte Firma", async () => {
    const result = await search({
      keywords: "XyzNichtExistierendeFirma12345",
      keywordMode: "exact",
    });
    expect(result.totalHits).toBe(0);
    expect(result.companies).toHaveLength(0);
  });

  test("keywordMode exact filtert korrekt", async () => {
    const result = await search({
      keywords: "GASAG AG",
      keywordMode: "exact",
    });
    expect(result.totalHits).toBeLessThanOrEqual(5);
  });

  test("registerType HRB filtert Registerart", async () => {
    const result = await search({
      keywords: "Gasag",
      keywordMode: "all",
      registerType: "HRB",
    });
    for (const c of result.companies) {
      expect(c.registerType).toBe("HRB");
    }
  });

  test("gibt query in result zurück", async () => {
    const opts = { keywords: "Test", keywordMode: "min" as const };
    const result = await search(opts);
    expect(result.query.keywords).toBe("Test");
    expect(result.query.keywordMode).toBe("min");
  });
});

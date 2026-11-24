import { describe, it, expect } from "bun:test";
import { frenchStems, frenchMatchQuery } from "../../src/lib/french-index";

describe("frenchStems", () => {
  it("stems each word, lowercase, with and without its accents", () => {
    expect(frenchStems("Factures IMPAYÉES")).toBe("factur impai impaye");
  });

  it("folds ligatures, curly apostrophes and decomposed accents", () => {
    expect(frenchStems("Œuvre")).toBe(frenchStems("oeuvre"));
    expect(frenchStems("l’équipe")).toBe(frenchStems("l'équipe"));
    expect(frenchStems("équipe")).toBe(frenchStems("équipe"));
  });

  it("drops elided articles and splits other apostrophes", () => {
    expect(frenchStems("l'équipe")).toBe("equip");
    expect(frenchMatchQuery("aujourd'hui")).toBe('"aujourd" AND "hui"');
  });

  it("is empty for text without words", () => {
    expect(frenchStems("  -- !! ")).toBe("");
  });
});

describe("frenchMatchQuery", () => {
  it("ANDs the words, each through any of its stems", () => {
    expect(frenchMatchQuery("impayé facture")).toBe('("impai" OR "impay") AND "factur"');
    expect(frenchMatchQuery("Réunions")).toBe('"reunion"');
    expect(frenchMatchQuery("impayées")).toBe('("impai" OR "impaye")');
  });

  it("never lets FTS5 syntax through", () => {
    expect(frenchMatchQuery('a"b* c:d')).toBe('"a" AND "b" AND "c" AND "d"');
  });

  it("matches nothing for an empty query", () => {
    expect(frenchMatchQuery("  ")).toBe('""');
  });
});

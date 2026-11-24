import { describe, it, expect } from "bun:test";
import { stemFrench } from "../../src/lib/french-stemmer";

// Every 8th word of Snowball's own French vocabulary with its expected stem
// (snowballstem/snowball-data french/voc.txt + output.txt, BSD licence).
const FIXTURE = new URL("../fixtures/snowball-french.tsv", import.meta.url);

describe("stemFrench", () => {
  it("matches Snowball's reference output", async () => {
    const lines = (await Bun.file(FIXTURE).text()).split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(2500);
    const wrong = lines
      .map((l) => l.split("\t"))
      .filter(([word, stem]) => stemFrench(word) !== stem)
      .map(([word, stem]) => `${word}: want ${stem}, got ${stemFrench(word)}`);
    expect(wrong).toEqual([]);
  });

  it("gives singular and plural, masculine and feminine one stem", () => {
    expect(new Set(["impayé", "impayée", "impayés", "impayées"].map(stemFrench))).toEqual(new Set(["impai"]));
    expect(stemFrench("factures")).toBe(stemFrench("facture"));
    expect(stemFrench("réunions")).toBe(stemFrench("réunion"));
  });

  it("drops elisions", () => {
    expect(stemFrench("l'équipe")).toBe(stemFrench("équipe"));
    expect(stemFrench("qu'il")).toBe("il");
    expect(stemFrench("l'")).toBe("l'");
  });
});

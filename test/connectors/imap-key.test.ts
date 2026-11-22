import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { messageKey } from "../../src/connectors/imap-key";

interface Vector { name: string; headers: string; account: string; folder: string; uidValidity: number; uid: number; key: string }
const file = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/triage-keys.json"), "utf-8")) as { vectors: Vector[] };

describe("key derivation equals the consumer's (shared vectors)", () => {
  for (const v of file.vectors) {
    it(v.name, () => {
      expect(messageKey(v.headers, v.account, v.folder, v.uidValidity, v.uid)).toBe(v.key);
    });
  }

  it("the vector file is not trivial", () => {
    expect(file.vectors.length).toBeGreaterThanOrEqual(12);
    expect(file.vectors.some((v) => v.key.startsWith("mid:"))).toBe(true);
    expect(file.vectors.some((v) => v.key.startsWith("imap:"))).toBe(true);
  });
});

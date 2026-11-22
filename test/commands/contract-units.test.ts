import { describe, it, expect } from "bun:test";
import { snippetOf, SNIPPET_MAX } from "../../src/commands/search-envelope";
import { parseLine, parseNdjson, toSeconds, ImportError } from "../../src/commands/import-parse";
import { importLines } from "../../src/commands/import";
import { checkReadSchema, DbNewerError, READ_SCHEMA } from "../../src/lib/contract";
import { VERSION } from "../../src/lib/version";
import pkg from "../../package.json";
import { TraulDB } from "../../src/db/database";

describe("snippet", () => {
  it("collapses whitespace and caps at 240 code points", () => {
    expect(snippetOf("a \n\n b")).toBe("a b");
    const s = snippetOf("é😀".repeat(300));
    expect(Array.from(s)).toHaveLength(SNIPPET_MAX);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("import parsing", () => {
  const ok = { type: "message", source_id: "mid:x", subject: "s", from: "f", sent_at: 1700000000, account: "a", folder: "INBOX", uidValidity: 1, uid: 2 };
  it("accepts ISO dates and epoch seconds", () => {
    expect(toSeconds("2026-10-01T00:00:00Z")).toBe(1790812800);
    expect(toSeconds(5)).toBe(5);
    expect(toSeconds("nope")).toBeNull();
  });
  it("rejects bad lines with the line number and no value", () => {
    for (const bad of ["{", "[]", '{"type":"x"}', JSON.stringify({ ...ok, uid: -1 }), JSON.stringify({ ...ok, source_id: "" })]) {
      expect(() => parseLine(bad, 3)).toThrow(ImportError);
    }
    expect(() => parseNdjson(JSON.stringify(ok) + "\n\n{bad")).toThrow("line 3");
  });
});

describe("importLines and the read schema", () => {
  it("is one transaction and idempotent", () => {
    const db = new TraulDB(":memory:");
    const lines = parseNdjson(JSON.stringify({ type: "message", source_id: "mid:x", subject: "", from: "", sent_at: 1, account: "a", folder: "F", uidValidity: 1, uid: 1 }));
    expect(importLines(db, lines)).toEqual({ imported: 1, existing: 0, cursors: 0 });
    expect(importLines(db, lines)).toEqual({ imported: 0, existing: 1, cursors: 0 });
    expect((db.db.query("SELECT content, author_name FROM messages").get() as any)).toEqual({ content: "mid:x", author_name: null });
  });
  it("checkReadSchema records ours and refuses a newer one", () => {
    const db = new TraulDB(":memory:");
    checkReadSchema(db);
    expect(db.getMeta("read_schema")).toBe(String(READ_SCHEMA));
    db.setMeta("read_schema", String(READ_SCHEMA + 1));
    expect(() => checkReadSchema(db)).toThrow(DbNewerError);
  });
});

describe("version", () => {
  it("equals package.json", () => { expect(VERSION).toBe(pkg.version); });
});

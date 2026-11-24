import { describe, it, expect, beforeEach } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { runMigrations } from "../../src/db/migrations";
import { FRENCH_INDEX_VERSION } from "../../src/lib/french-index";
import { importLines } from "../../src/commands/import";
import { parseNdjson } from "../../src/commands/import-parse";
import { getEmbedSettings } from "../../src/lib/embed-config";

const add = (db: TraulDB, id: string, content: string) =>
  db.upsertMessage({ source: "imap", source_id: id, channel_name: "INBOX", author_name: "a", content, sent_at: 1700000000 });
const found = (db: TraulDB, q: string) => db.ftsSearchAll(q, { limit: 10 }).map((m) => m.source_id).sort();

describe("French keyword search", () => {
  let db: TraulDB;

  beforeEach(() => {
    db = new TraulDB(":memory:");
    add(db, "m1", "Les factures impayées de décembre");
    add(db, "m2", "Réunion du conseil d'administration");
    add(db, "m3", "Hello world, the invoices were sent");
    add(db, "m4", "Œuvres complètes");
  });

  it("matches other French word endings", () => {
    expect(found(db, "impayé")).toEqual(["m1"]);
    expect(found(db, "facture impayée")).toEqual(["m1"]);
    expect(found(db, "réunions")).toEqual(["m2"]);
    expect(found(db, "oeuvre")).toEqual(["m4"]);
  });

  it("still ignores accents and case, and still finds English", () => {
    expect(found(db, "REUNION")).toEqual(["m2"]);
    expect(found(db, "decembre")).toEqual(["m1"]);
    expect(found(db, "invoice")).toEqual(["m3"]);
  });

  it("follows a changed message and forgets a deleted one", () => {
    add(db, "m1", "Plus rien à payer");
    expect(found(db, "impayé")).toEqual([]);
    expect(found(db, "payé")).toEqual(["m1"]);
    const id = db.db.query<{ id: number }, []>("SELECT id FROM messages WHERE source_id = 'm2'").get()!.id;
    db.deleteMessage(id);
    expect(found(db, "réunions")).toEqual([]);
  });

  it("indexes imported stubs by their subject", () => {
    const line = { type: "message", source_id: "mid:s", subject: "Relances impayées", from: "", sent_at: 1, account: "a", folder: "F", uidValidity: 1, uid: 1 };
    importLines(db, parseNdjson(JSON.stringify(line)));
    expect(found(db, "relance impayé")).toEqual(["mid:s"]);
  });

  it("is used by hybrid search for messages without a vector", () => {
    const zero = new Uint8Array(new Float32Array(getEmbedSettings().dims).buffer);
    expect(db.hybridSearchAll(zero, "impayé", { limit: 10 }).map((m) => m.source_id)).toEqual(["m1"]);
  });
});

describe("French index migration", () => {
  let db: TraulDB;

  beforeEach(() => {
    db = new TraulDB(":memory:");
    add(db, "m1", "Les factures impayées");
  });

  it("indexes messages an older traul wrote", () => {
    db.db.run("DELETE FROM messages_fr");
    expect(found(db, "impayé")).toEqual([]);
    runMigrations(db);
    expect(found(db, "impayé")).toEqual(["m1"]);
    expect(db.getMeta("french_index_version")).toBe(FRENCH_INDEX_VERSION);
  });

  it("rebuilds the index when its version changes", () => {
    runMigrations(db);
    db.db.run("UPDATE messages_fr SET stems = 'stale'");
    db.setMeta("french_index_version", "0");
    runMigrations(db);
    expect(found(db, "stale")).toEqual([]);
    expect(found(db, "impayé")).toEqual(["m1"]);
  });
});

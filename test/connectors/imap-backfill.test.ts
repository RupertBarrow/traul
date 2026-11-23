import { describe, it, expect, beforeEach } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { syncImap } from "../../src/connectors/imap-sync";
import { MemServer, factoryFor, mail, account, configWith } from "../helpers/mem-server";

let db: TraulDB;
beforeEach(() => { db = new TraulDB(":memory:"); process.env.IMAP_PASSWORD_A = "pw"; });

const stub = (id: string, uid: number, uidValidity = 7, extra: Record<string, unknown> = {}) => db.upsertMessage({
  source: "imap", source_id: `mid:${id}`, channel_id: "a", channel_name: "a/INBOX", author_name: "Alice", content: `Stub ${id}`,
  sent_at: 1_700_000_000 + uid,
  metadata: JSON.stringify({ v: 1, account: "a", folder: "INBOX", uidValidity, uid, subject: `Stub ${id}`, stub: true, ...extra }),
});
const row = (id: string) => db.db.query("SELECT * FROM messages WHERE source='imap' AND source_id=?").get(`mid:${id}`) as any;
const meta = (id: string) => JSON.parse(row(id).metadata);
const run = (srv: MemServer, over = {}) => syncImap(db, configWith([account("a")], over), { openSession: factoryFor({ "a.example.org": srv }) });
/** A server whose messages are already synced, so a run has only backfill to do. */
const synced = async (...msgs: ReturnType<typeof mail>[]) => {
  const srv = new MemServer({ INBOX: { uidValidity: 7, messages: msgs } });
  db.setSyncCursor("imap", "a|INBOX", JSON.stringify({ uidValidity: 7, lastUid: 100 }));
  return srv;
};

describe("backfill of stubs", () => {
  it("turns a stub into the full message", async () => {
    stub("s1@example.org", 3);
    const srv = await synced(mail(3, { id: "s1@example.org", subject: "Real subject", body: "Real body text" }));
    const r = await run(srv);
    expect(r.accounts[0].folders[0]).toMatchObject({ backfilled: 1, added: 0 });
    expect(row("s1@example.org").content).toBe("Real subject\n\nReal body text");
    expect(meta("s1@example.org").stub).toBeUndefined();
    expect(db.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  it("another message at that UID marks the stub gone, and it is not tried again", async () => {
    stub("s1@example.org", 3);
    const srv = await synced(mail(3, { id: "different@example.org" }));
    await run(srv);
    expect(meta("s1@example.org").stub).toBe("gone");
    expect(row("s1@example.org").content).toBe("Stub s1@example.org");
    srv.fetched = [];
    await run(srv);
    expect(srv.fetched).toEqual([]);
  });

  it("a UID that is gone marks the stub gone", async () => {
    stub("s1@example.org", 3);
    const r = await run(await synced());
    expect(meta("s1@example.org").stub).toBe("gone");
    expect(r.accounts[0].folders[0].gone).toBe(1);
  });

  it("a stub of another UIDVALIDITY is left alone", async () => {
    stub("old@example.org", 3, 6);
    const srv = await synced(mail(3, { id: "old@example.org" }));
    await run(srv);
    expect(srv.fetched).toEqual([]);
    expect(meta("old@example.org").stub).toBe(true);
  });

  it("is bounded by backfill_per_run and by the shared message budget", async () => {
    for (let i = 1; i <= 5; i++) stub(`s${i}@example.org`, i);
    const srv = await synced(...[1, 2, 3, 4, 5].map((i) => mail(i, { id: `s${i}@example.org` })));
    await run(srv, { backfill_per_run: 2 });
    expect(srv.fetched).toHaveLength(2);
    srv.fetched = [];
    await run(srv, { backfill_per_run: 5, max_messages_per_run: 1 });
    expect(srv.fetched).toHaveLength(1);
  });

  it("a stub never replaces a full message", () => {
    db.upsertMessage({ source: "imap", source_id: "mid:f@example.org", content: "Full\n\ntext", sent_at: 5, metadata: JSON.stringify({ v: 1, uid: 1 }) });
    db.upsertMessage({ source: "imap", source_id: "mid:f@example.org", content: "Stub", sent_at: 9, metadata: JSON.stringify({ v: 1, uid: 1, stub: true }) });
    expect(row("f@example.org").content).toBe("Full\n\ntext");
    expect(row("f@example.org").sent_at).toBe(5);
  });

  it("a full message updates every column of an existing row", () => {
    db.upsertMessage({ source: "imap", source_id: "mid:g@example.org", channel_name: "a/INBOX", author_name: "x", content: "Stub", sent_at: 1, metadata: JSON.stringify({ stub: true }) });
    db.upsertMessage({ source: "imap", source_id: "mid:g@example.org", channel_id: "a", channel_name: "a/Archive", thread_id: "t", author_id: "x@example.org", author_name: "X", content: "Full", sent_at: 2, metadata: JSON.stringify({ uid: 2 }) });
    expect(row("g@example.org")).toMatchObject({ channel_id: "a", channel_name: "a/Archive", thread_id: "t", author_id: "x@example.org", author_name: "X", content: "Full", sent_at: 2 });
  });

  it("other sources keep their upsert (content and metadata only)", () => {
    db.upsertMessage({ source: "slack", source_id: "s1", channel_name: "c1", content: "one", sent_at: 1 });
    db.upsertMessage({ source: "slack", source_id: "s1", channel_name: "c2", content: "two", sent_at: 2 });
    const r = db.db.query("SELECT channel_name, content, sent_at FROM messages WHERE source='slack'").get() as any;
    expect(r).toEqual({ channel_name: "c1", content: "two", sent_at: 1 });
  });
});

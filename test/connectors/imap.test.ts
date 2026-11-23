import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { syncImap } from "../../src/connectors/imap-sync";
import { imapConnector } from "../../src/connectors/imap";
import { validateImapConfig } from "../../src/lib/imap-config";
import { MemServer, factoryFor, mail, account, configWith } from "../helpers/mem-server";

let db: TraulDB;
beforeEach(() => {
  db = new TraulDB(":memory:");
  for (const n of ["A", "B", "C"]) process.env[`IMAP_PASSWORD_${n}`] = "pw";
});
afterEach(() => { for (const n of ["A", "B", "C"]) delete process.env[`IMAP_PASSWORD_${n}`]; });

const rows = () => db.db.query("SELECT * FROM messages WHERE source='imap' ORDER BY id").all() as any[];
const cursor = (key: string) => { const v = db.getSyncCursor("imap", key); return v ? JSON.parse(v) : null; };
const inbox = (uidValidity: number, ...messages: ReturnType<typeof mail>[]) => ({ INBOX: { uidValidity, messages } });
const run = (servers: Record<string, MemServer>, accs = [account("a")], over = {}, deps = {}) =>
  syncImap(db, configWith(accs, over), { openSession: factoryFor(servers), ...deps });

describe("first run", () => {
  it("fetches from sync_start, stores the columns of the read schema, sets the cursor", async () => {
    const srv = new MemServer(inbox(7,
      mail(1, { internalDate: "2026-08-01T00:00:00Z" }), // before sync_start: never found by the search
      mail(2, { id: "two@example.org", subject: "Réunion", body: "Bonjour", date: "Tue, 03 Nov 2026 10:00:00 +0100",
        extra: ["References: <root@example.org> <mid@example.org>", "List-Id: <l.example.org>"] })));
    const report = await run({ "a.example.org": srv });
    expect(srv.searches).toEqual(["since 2026-09-01"]);
    expect(srv.fetched).toEqual([2]);
    expect(report.accounts[0]).toMatchObject({ name: "a", status: "ok" });
    expect(report.accounts[0].folders[0]).toMatchObject({ folder: "INBOX", uidValidity: 7, lastUid: 2, added: 1, updated: 0 });
    const [r] = rows();
    expect(r).toMatchObject({
      source: "imap", source_id: "mid:two@example.org", channel_id: "a", channel_name: "a/INBOX", thread_id: "root@example.org",
      author_id: "alice@example.org", author_name: "Alice Example", content: "Réunion\n\nBonjour",
      sent_at: Date.parse("2026-11-03T09:00:00Z") / 1000,
    });
    expect(JSON.parse(r.metadata)).toMatchObject({
      v: 1, account: "a", folder: "INBOX", uidValidity: 7, uid: 2, messageId: "two@example.org", subject: "Réunion",
      from: "alice@example.org", to: ["bob@example.org"], date: "2026-11-03T09:00:00.000Z", listId: "<l.example.org>", listUnsubscribe: null,
    });
    expect(cursor("a|INBOX")).toEqual({ uidValidity: 7, lastUid: 2 });
  });

  it("falls back to INTERNALDATE, the locator key, and the subject alone when there is no text", async () => {
    const m = mail(4, { id: null, subject: "Only a subject", body: "", internalDate: "2026-10-05T12:00:00Z" });
    await run({ "a.example.org": new MemServer(inbox(9, m)) });
    const [r] = rows();
    expect(r.source_id).toBe("imap:a:INBOX:9:4");
    expect(r.content).toBe("Only a subject");
    expect(r.thread_id).toBe("imap:a:INBOX:9:4");
    expect(r.sent_at).toBe(Date.parse("2026-10-05T12:00:00Z") / 1000);
  });

  it("marks a message cut by the partial fetch as truncated", async () => {
    const srv = new MemServer(inbox(1, mail(1)));
    const open = srv.session;
    srv.session = function () { const s = open.call(srv); const f = s.fetch; s.fetch = async (u) => ({ ...(await f(u))!, truncated: true }); return s; };
    await run({ "a.example.org": srv });
    expect(JSON.parse(rows()[0].metadata).truncated).toBe(true);
  });
});

describe("incremental sync", () => {
  it("fetches only UIDs above the cursor", async () => {
    const srv = new MemServer(inbox(7, mail(1), mail(2)));
    await run({ "a.example.org": srv });
    srv.folders.INBOX.messages.push(mail(3), mail(4));
    srv.fetched = []; srv.searches = [];
    const r = await run({ "a.example.org": srv });
    expect(srv.searches).toEqual(["after 2"]);
    expect(srv.fetched).toEqual([3, 4]);
    expect(r.accounts[0].folders[0]).toMatchObject({ added: 2, lastUid: 4 });
    expect(rows()).toHaveLength(4);
  });

  it("a UIDVALIDITY change resets the cursor; messages keyed by Message-ID are upserted again, not duplicated", async () => {
    const srv = new MemServer(inbox(7, mail(1), mail(2)));
    await run({ "a.example.org": srv });
    srv.folders.INBOX = { uidValidity: 8, messages: [mail(1, { id: "m2@example.org" }), mail(2, { id: "m1@example.org" })] };
    srv.searches = [];
    const r = await run({ "a.example.org": srv });
    expect(srv.searches).toEqual(["since 2026-09-01"]);
    expect(r.accounts[0].folders[0]).toMatchObject({ uidValidity: 8, added: 0, updated: 2, lastUid: 2 });
    expect(rows()).toHaveLength(2);
    expect(cursor("a|INBOX")).toEqual({ uidValidity: 8, lastUid: 2 });
    expect(JSON.parse(rows().find((x) => x.source_id === "mid:m2@example.org").metadata).uidValidity).toBe(8);
  });

  it("a UID that is gone moves the cursor and stores nothing", async () => {
    const srv = new MemServer(inbox(7, mail(1), mail(2)));
    // uid 2 is listed by the search but cannot be fetched
    const sess = srv.session.bind(srv);
    srv.session = () => { const s = sess(); const fetch = s.fetch; s.fetch = async (u) => (u === 2 ? null : fetch(u)); return s; };
    const r = await run({ "a.example.org": srv });
    expect(r.accounts[0].folders[0]).toMatchObject({ added: 1, gone: 1, lastUid: 2 });
    expect(rows()).toHaveLength(1);
  });

  it("a moved message keeps its row (same Message-ID in another folder)", async () => {
    const srv = new MemServer({ INBOX: { uidValidity: 1, messages: [mail(1, { id: "mv@example.org" })] }, Archive: { uidValidity: 2, messages: [] } });
    const accs = [account("a", { folders: ["INBOX", "Archive"] })];
    await run({ "a.example.org": srv }, accs);
    srv.folders.INBOX.messages = [];
    srv.folders.Archive.messages = [mail(1, { id: "mv@example.org" })];
    await run({ "a.example.org": srv }, accs);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].channel_name).toBe("a/Archive");
    expect(JSON.parse(rows()[0].metadata)).toMatchObject({ folder: "Archive", uidValidity: 2 });
  });
});

describe("failures and atomicity", () => {
  it("a failing fetch stops the folder; the third run in a row skips the UID and goes on", async () => {
    const srv = new MemServer(inbox(7, mail(1), mail(2), mail(3)));
    srv.failFetch.add(2);
    const r1 = await run({ "a.example.org": srv });
    expect(r1.accounts[0].folders[0]).toMatchObject({ added: 1, lastUid: 1, skipped: 0, code: "timeout" });
    const r2 = await run({ "a.example.org": srv });
    expect(r2.accounts[0].folders[0]).toMatchObject({ lastUid: 1, skipped: 0 });
    expect(rows()).toHaveLength(1);
    const r3 = await run({ "a.example.org": srv });
    expect(r3.accounts[0].folders[0]).toMatchObject({ skipped: 1, added: 1, lastUid: 3 });
    expect(rows().map((x) => x.source_id)).toEqual(["mid:m1@example.org", "mid:m3@example.org"]);
  });

  it("a success in between resets the failure count", async () => {
    const srv = new MemServer(inbox(7, mail(1), mail(2)));
    srv.failFetch.add(2);
    await run({ "a.example.org": srv });
    await run({ "a.example.org": srv });
    srv.failFetch.clear();
    const r = await run({ "a.example.org": srv });
    expect(r.accounts[0].folders[0]).toMatchObject({ added: 1, skipped: 0, lastUid: 2 });
    expect(db.db.query("SELECT key FROM traul_meta WHERE key LIKE 'imap_fail:%'").all()).toEqual([]);
  });

  it("the row and the cursor are written in one transaction: a crash between them leaves neither", async () => {
    const srv = new MemServer(inbox(7, mail(1)));
    const crash = { beforeCursor: () => { throw new Error("crash"); } };
    await expect(run({ "a.example.org": srv }, [account("a")], {}, crash)).rejects.toThrow("crash");
    expect(rows()).toHaveLength(0);
    expect(cursor("a|INBOX")).toBeNull();
    await run({ "a.example.org": srv });
    expect(rows()).toHaveLength(1);
    expect(cursor("a|INBOX")).toEqual({ uidValidity: 7, lastUid: 1 });
  });

  it("two accounts, one failing: the other still runs", async () => {
    const srv = new MemServer(inbox(1, mail(1)));
    const r = await run({ "b.example.org": srv }, [account("a"), account("b")]);
    expect(r.accounts.map((a) => [a.name, a.status])).toEqual([["a", "unreachable"], ["b", "ok"]]);
    expect(rows()).toHaveLength(1);
  });

  it("an account without its secret is no_secret, and nothing is opened", async () => {
    delete process.env.IMAP_PASSWORD_A;
    const srv = new MemServer(inbox(1, mail(1)));
    const r = await run({ "a.example.org": srv });
    expect(r.accounts[0]).toMatchObject({ status: "no_secret", folders: [] });
    expect(srv.fetched).toEqual([]);
  });

  it("a missing folder is folder_failed and the next folder runs", async () => {
    const srv = new MemServer(inbox(1, mail(1)));
    const r = await run({ "a.example.org": srv }, [account("a", { folders: ["Nope", "INBOX"] })]);
    expect(r.accounts[0].status).toBe("folder_failed");
    expect(r.accounts[0].folders.map((f) => [f.folder, f.code ?? "ok"])).toEqual([["Nope", "folder_failed"], ["INBOX", "ok"]]);
    expect(rows()).toHaveLength(1);
  });
});

describe("budgets", () => {
  it("max_messages_per_run stops the run; the rest waits for the next", async () => {
    const srv = new MemServer(inbox(1, mail(1), mail(2), mail(3), mail(4), mail(5)));
    const r1 = await run({ "a.example.org": srv }, [account("a")], { max_messages_per_run: 2 });
    expect(r1.accounts[0].folders[0]).toMatchObject({ added: 2, lastUid: 2 });
    await run({ "a.example.org": srv }, [account("a")], { max_messages_per_run: 2 });
    expect(rows()).toHaveLength(4);
    await run({ "a.example.org": srv }, [account("a")], { max_messages_per_run: 2 });
    expect(rows()).toHaveLength(5);
  });

  it("the budget is shared by the accounts in turn", async () => {
    const a = new MemServer(inbox(1, mail(1), mail(2), mail(3)));
    const b = new MemServer(inbox(1, mail(1, { id: "b1@example.org" })));
    await run({ "a.example.org": a, "b.example.org": b }, [account("a"), account("b")], { max_messages_per_run: 2 });
    expect(a.fetched).toEqual([1, 2]);
    expect(b.fetched).toEqual([]);
  });

  it("max_run_seconds stops the run", async () => {
    const srv = new MemServer(inbox(1, mail(1), mail(2), mail(3)));
    let t = 0;
    const r = await run({ "a.example.org": srv }, [account("a")], { max_run_seconds: 10 }, { now: () => (t += 4000) });
    expect(srv.fetched.length).toBeLessThan(3);
    expect(srv.fetched.length).toBeGreaterThan(0);
    expect(r.accounts[0].folders[0].added).toBe(srv.fetched.length);
  });
});

describe("folders and logging", () => {
  it("resolves patterns with LIST, / being the separator", async () => {
    const srv = new MemServer({ INBOX: { uidValidity: 1, messages: [] }, "Clients/Acme": { uidValidity: 2, messages: [mail(1)] },
      "Clients/Beta": { uidValidity: 3, messages: [] }, Other: { uidValidity: 4, messages: [mail(1, { id: "o@example.org" })] } });
    const r = await run({ "a.example.org": srv }, [account("a", { folders: ["Clients/*"] })]);
    expect(r.accounts[0].folders.map((f) => f.folder)).toEqual(["Clients/Acme", "Clients/Beta"]);
    expect(rows()).toHaveLength(1);
  });

  it("logs counts and codes only: no subject, address or text", async () => {
    const lines: string[] = [];
    const [o, e] = [console.log, console.error];
    console.log = (...a) => lines.push(a.join(" ")); console.error = console.log;
    try {
      const cfg = configWith([account("a")]);
      const srv = new MemServer(inbox(1, mail(1, { subject: "TOP-SECRET-SUBJECT", body: "TOP-SECRET-BODY" })));
      await imapConnector.sync(db, cfg, { openSession: factoryFor({ "a.example.org": srv }) });
    } finally { console.log = o; console.error = e; }
    const all = lines.join("\n");
    expect(all).not.toMatch(/SECRET|alice|example\.org/i);
  });
});

describe("configuration", () => {
  it("accepts the documented shape", () => {
    expect(validateImapConfig(configWith([account("a"), account("b", { tls: "starttls" }), account("c", { host: "127.0.0.1", tls: "plain" })]).imap)).toEqual([]);
  });

  it("rejects bad names, secrets, ports, tls modes and remote plain", () => {
    const bad = configWith([
      account("a b"), account("c", { password_secret: "x y" }), account("d", { port: 0 }), account("e", { tls: "weird" as never }),
      account("f", { tls: "plain" }), account("g"), account("g"),
    ]).imap;
    const errs = validateImapConfig(bad).join("\n");
    for (const w of ["name", "password_secret", "port", "tls", "plain_remote", "duplicate"]) expect(errs).toContain(w);
  });

  it("the connector is named imap and needs an account", () => {
    expect(imapConnector.name).toBe("imap");
    expect(imapConnector.hasCredentials?.(configWith([]))).toBe(false);
    expect(imapConnector.hasCredentials?.(configWith([account("a")]))).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { FakeImap } from "../helpers/fake-imap";
import { mail } from "../helpers/mem-server";
import { buildExe, sandbox, supported, type Sandbox } from "./harness";

// FT-12: every command of docs/triage-fork/CONTRACT.md on the compiled executable, field by field.
let exe = "";
beforeAll(async () => { if (supported) exe = await buildExe(); }, 180_000);

let fake: FakeImap | undefined;
let ollama: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; ollama?.stop(true); ollama = undefined; });

const DIMS = 4;
type OllamaMode = "ok" | "missing" | "wrongdims";
function startOllama(mode: OllamaMode = "ok"): string {
  ollama = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = (await req.json()) as { input: string[] };
    if (mode === "missing") return Response.json({ error: 'model "test-embed" not found' }, { status: 404 });
    const dims = mode === "wrongdims" ? DIMS + 1 : DIMS;
    return Response.json({ embeddings: body.input.map((_, i) => Array.from({ length: dims }, (_, k) => 0.1 * (k + 1) + i)) });
  } });
  return `http://127.0.0.1:${ollama.port}`;
}

const imapCfg = (port: number, over = {}) => ({
  sync_start: "2026-09-01",
  accounts: [{ name: "a", host: "127.0.0.1", port, tls: "plain", user: "user", password_secret: "IMAP_PASSWORD_A", folders: ["INBOX"], ...over }],
});
const embCfg = (url: string) => ({ backend: "ollama", url, model: "test-embed", dims: DIMS, timeout_ms: 5000 });
const msgs = (...m: ReturnType<typeof mail>[]) => ({ INBOX: { uidValidity: 7, messages: m } });
const day = { internalDate: "2026-10-01T00:00:00Z" };

describe.skipIf(!supported)("traul --contract", () => {
  it("prints the numbers from an empty environment and creates no database", async () => {
    const sb = sandbox(exe);
    const r = await sb.run(["--contract"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.json).toEqual({ contract: 1, readSchema: 1, version: expect.any(String), commit: "testcommit", connectors: ["imap"] });
    expect(sb.hasDb()).toBe(false);
  });
});

describe.skipIf(!supported)("traul sync imap --json", () => {
  it("prints the report, field by field, and keeps stdout to one JSON value", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: msgs(mail(1, day), mail(2, day)) });
    const sb = sandbox(exe);
    sb.config({ imap: imapCfg(fake.port) });
    const r = await sb.run(["sync", "imap", "--json"]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.json).toEqual({ source: "imap", accounts: [{ name: "a", status: "ok", folders: [
      { folder: "INBOX", uidValidity: 7, lastUid: 2, added: 2, updated: 0, backfilled: 0, gone: 0, skipped: 0 } ] }] });
    expect(r.err).not.toContain("pass");
  });

  it("a failing account is a status, not an exit code", async () => {
    fake = await FakeImap.start({ tls: "plain", pass: "other", folders: msgs() });
    const sb = sandbox(exe);
    sb.config({ imap: imapCfg(fake.port) });
    const r = await sb.run(["sync", "imap", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.accounts[0]).toMatchObject({ name: "a", status: "auth_failed" });
  });

  it("exits 2 on a bad configuration, with nothing on stdout", async () => {
    const sb = sandbox(exe);
    sb.config({ imap: imapCfg(1, { name: "bad name" }) });
    const r = await sb.run(["sync", "imap", "--json"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).not.toBe("");
  });

  it("exits 3 on a database of a newer read schema", async () => {
    const sb = sandbox(exe);
    sb.config({ imap: imapCfg(1) });
    expect((await sb.run(["sql", "--write", "INSERT OR REPLACE INTO traul_meta(key, value) VALUES ('read_schema', '2')"])).code).toBe(0);
    const r = await sb.run(["sync", "imap", "--json"]);
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
  });
});

describe.skipIf(!supported)("traul embed --json", () => {
  async function withMessages(url: string): Promise<Sandbox> {
    fake = await FakeImap.start({ tls: "plain", folders: msgs(mail(1, { ...day, body: "alpha beta" }), mail(2, day)) });
    const sb = sandbox(exe);
    sb.config({ imap: imapCfg(fake.port), embeddings: embCfg(url) });
    await sb.run(["sync", "imap", "--json"]);
    return sb;
  }

  it("embeds, then reports pending 0", async () => {
    const sb = await withMessages(startOllama());
    const r = await sb.run(["embed", "--json", "--limit", "10"]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.json).toEqual({ state: "ok", embedded: 2, failed: 0, pending: 0, model: "test-embed", dims: DIMS });
  });

  it("--limit bounds the run and pending says what is left", async () => {
    const sb = await withMessages(startOllama());
    const r = await sb.run(["embed", "--json", "--limit", "1"]);
    expect(r.json).toMatchObject({ state: "ok", embedded: 1, pending: 1 });
  });

  it("ollama_down, model_missing, dims_mismatch: exit 0 and the state", async () => {
    const sb = await withMessages("http://127.0.0.1:1");
    expect((await sb.run(["embed", "--json"])).json).toMatchObject({ state: "ollama_down", embedded: 0, pending: 2 });
    ollama?.stop(true);
    sb.config({ imap: imapCfg(fake!.port), embeddings: embCfg(startOllama("missing")) });
    const m = await sb.run(["embed", "--json"]);
    expect(m.code).toBe(0);
    expect(m.json).toMatchObject({ state: "model_missing", embedded: 0 });
    ollama?.stop(true);
    sb.config({ imap: imapCfg(fake!.port), embeddings: embCfg(startOllama("wrongdims")) });
    expect((await sb.run(["embed", "--json"])).json).toMatchObject({ state: "dims_mismatch", embedded: 0, pending: 2 });
  });

  it("ollama_remote: a non-loopback URL is refused", async () => {
    const sb = await withMessages("http://192.0.2.10:11434");
    expect((await sb.run(["embed", "--json"])).json).toMatchObject({ state: "ollama_remote", embedded: 0 });
  });
});

describe.skipIf(!supported)("traul search --envelope", () => {
  const long = "word ".repeat(200);
  async function seeded(url: string): Promise<Sandbox> {
    fake = await FakeImap.start({ tls: "plain", folders: msgs(
      mail(1, { ...day, subject: "Facture janvier", body: "La facture est jointe" }),
      mail(2, { ...day, subject: "Long", body: long + "facture" })) });
    const sb = sandbox(exe);
    sb.config({ imap: imapCfg(fake.port), embeddings: embCfg(url) });
    await sb.run(["sync", "imap", "--json"]);
    return sb;
  }
  const search = (sb: Sandbox, q: string, ...extra: string[]) => sb.run(["search", "--envelope", "--query-stdin", ...extra], { stdin: q });

  it("vector ok: results carry every field, the snippet is capped, the query came from stdin", async () => {
    const sb = await seeded(startOllama());
    await sb.run(["embed", "--json"]);
    const r = await search(sb, "facture");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.json.vector).toBe("ok");
    expect(r.json.results.length).toBeGreaterThan(0);
    for (const x of r.json.results) {
      expect(Object.keys(x).sort()).toEqual(["author", "channel", "id", "rank", "snippet", "source", "source_id", "sent_at"].sort());
      expect(x).toMatchObject({ source: "imap", channel: "a/INBOX", author: "Alice Example" });
      expect(Array.from(x.snippet).length).toBeLessThanOrEqual(240);
      expect(Number.isNaN(Date.parse(x.sent_at))).toBe(false);
    }
  });

  it("--fts needs no Ollama; --content adds the text; --source and --limit apply", async () => {
    const sb = await seeded("http://127.0.0.1:1");
    const r = await search(sb, "facture", "--fts", "--content", "--source", "imap", "--limit", "1");
    expect(r.json.vector).toBe("unavailable");
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].content).toContain("facture");
    expect((await search(sb, "facture", "--fts", "--source", "slack")).json.results).toEqual([]);
  });

  it("vector unavailable (Ollama down) falls back to the keyword results", async () => {
    const sb = await seeded("http://127.0.0.1:1");
    const r = await search(sb, "facture");
    expect(r.code).toBe(0);
    expect(r.json.vector).toBe("unavailable");
    expect(r.json.results.length).toBe(2);
  });

  it("model_missing is said so, with keyword results", async () => {
    const sb = await seeded(startOllama("missing"));
    const r = await search(sb, "facture");
    expect(r.json.vector).toBe("model_missing");
    expect(r.json.results.length).toBe(2);
  });

  it("free text with FTS syntax characters does not break it", async () => {
    const sb = await seeded("http://127.0.0.1:1");
    const r = await search(sb, 'facture AND (" OR NEAR* -x:y', "--fts");
    expect(r.code).toBe(0);
    expect(Array.isArray(r.json.results)).toBe(true);
    expect((await search(sb, "  ")).json).toEqual({ vector: "unavailable", results: [] });
  });

  it("search --json without --envelope keeps today's array", async () => {
    const sb = await seeded("http://127.0.0.1:1");
    const r = await sb.run(["search", "facture", "--fts", "--json"]);
    expect(Array.isArray(r.json)).toBe(true);
    expect(r.json[0]).toHaveProperty("content");
  });
});

describe.skipIf(!supported)("traul import", () => {
  const msg = (uid: number, over = {}) => JSON.stringify({ type: "message", source_id: `mid:m${uid}@example.org`, subject: `S${uid}`, from: "alice@example.org",
    sent_at: "2026-10-01T00:00:00Z", account: "a", folder: "INBOX", uidValidity: 7, uid, ...over });
  const cursor = JSON.stringify({ type: "cursor", account: "a", folder: "INBOX", uidValidity: 7, lastUid: 5 });
  const count = async (sb: Sandbox) => (await sb.run(["sql", "SELECT COUNT(*) AS n FROM messages"])).json[0].n;

  it("inserts stubs and a cursor, counts what already exists, never overwrites", async () => {
    const sb = sandbox(exe);
    const first = await sb.run(["import", "--source", "imap", "--ndjson", "-"], { stdin: [msg(1), msg(2), cursor].join("\n") + "\n" });
    expect(first.code).toBe(0);
    expect(first.json).toEqual({ imported: 2, existing: 0, cursors: 1 });
    const again = await sb.run(["import", "--source", "imap", "--ndjson", "-"], { stdin: [msg(1, { subject: "changed" }), msg(3), cursor.replace("5", "9")].join("\n") });
    expect(again.json).toEqual({ imported: 1, existing: 1, cursors: 0 });
    const row = (await sb.run(["sql", "SELECT content, metadata FROM messages WHERE source_id = 'mid:m1@example.org'"])).json[0];
    expect(row.content).toBe("S1");
    expect(JSON.parse(row.metadata)).toMatchObject({ stub: true, uid: 1, uidValidity: 7, account: "a", folder: "INBOX" });
    const cur = (await sb.run(["sql", "SELECT cursor_value FROM sync_cursors WHERE source='imap' AND key='a|INBOX'"])).json[0];
    expect(JSON.parse(cur.cursor_value)).toEqual({ uidValidity: 7, lastUid: 5 });
  });

  it("a bad line exits 2 and writes nothing", async () => {
    const sb = sandbox(exe);
    const r = await sb.run(["import", "--source", "imap", "--ndjson", "-"], { stdin: [msg(1), "{not json", msg(2)].join("\n") });
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("line 2");
    expect(await count(sb)).toBe(0);
    const typeless = await sb.run(["import", "--source", "imap", "--ndjson", "-"], { stdin: msg(1, { uid: "x" }) });
    expect(typeless.code).toBe(2);
    expect(await count(sb)).toBe(0);
  });

  it("an imported stub is backfilled by the next sync", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: msgs(mail(1, { ...day, id: "m1@example.org", subject: "Real subject", body: "Real body" })) });
    const sb = sandbox(exe);
    sb.config({ imap: imapCfg(fake.port) });
    await sb.run(["import", "--source", "imap", "--ndjson", "-"], { stdin: [msg(1), JSON.stringify({ type: "cursor", account: "a", folder: "INBOX", uidValidity: 7, lastUid: 1 })].join("\n") });
    const r = await sb.run(["sync", "imap", "--json"]);
    expect(r.json.accounts[0].folders[0]).toMatchObject({ backfilled: 1, added: 0 });
    const row = (await sb.run(["sql", "SELECT content FROM messages"])).json[0];
    expect(row.content).toBe("Real subject\n\nReal body");
  });
});

describe.skipIf(!supported)("read schema 1", () => {
  it("has the columns Triage reads, and traul_meta(key, value)", async () => {
    const sb = sandbox(exe);
    const cols = (await sb.run(["sql", "SELECT name FROM pragma_table_info('messages')"])).json.map((c: { name: string }) => c.name);
    for (const c of ["id", "source", "source_id", "channel_id", "channel_name", "thread_id", "author_id", "author_name", "content", "sent_at", "metadata"]) {
      expect(cols).toContain(c);
    }
    const meta = (await sb.run(["sql", "SELECT name FROM pragma_table_info('traul_meta')"])).json.map((c: { name: string }) => c.name);
    expect(meta).toEqual(["key", "value"]);
    expect((await sb.run(["sql", "SELECT value FROM traul_meta WHERE key='read_schema'"])).json[0].value).toBe("1");
  });
});

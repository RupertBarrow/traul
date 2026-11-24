import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraulDB } from "../../src/db/database";
import { syncArchive } from "../../src/connectors/archive";
import { archiveConnector } from "../../src/connectors/archive-connector";
import { defaultImapConfig } from "../../src/lib/config";

let db: TraulDB;
let dir: string;
let server: Server | undefined;
let seen: { path?: string; token?: string; method?: string }[];
let answer: (res: import("node:http").ServerResponse) => void;

const item = (id: number, over: Record<string, unknown> = {}) => ({
  id, state: "todo", stateLabel: null, title: `Intake ${id}`, source: { key: "youtube", label: "YouTube" },
  sourceUrl: `https://www.example.org/watch?v=${id}`, sourceDate: { ms: 1759150800000 + id * 1000, dayOnly: false, kind: "added", text: "29/09" },
  destination: { key: "none", label: "—" }, result: null, revision: null, ...over,
});
const envelope = (items: unknown[], over: Record<string, unknown> = {}) =>
  ({ schema: "archive-items", version: 1, data: { home: "h", generatedAt: null, total: items.length, truncated: false, items, ...over } });
const json = (body: unknown, status = 200) => (res: import("node:http").ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
};

async function start(): Promise<number> {
  server = createServer((req, res) => { seen.push({ path: req.url, token: req.headers["x-reader-token"] as string, method: req.method }); answer(res); });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server!.address() as AddressInfo).port;
}
const config = (port: number, over: Record<string, unknown> = {}) => ({
  archive: { items_url: `http://127.0.0.1:${port}/reader/h/items`, token_file: join(dir, "token"), token_header: "X-Reader-Token", ...over },
  imap: defaultImapConfig(),
}) as any;
const rows = () => db.db.query("SELECT * FROM messages WHERE source='archive' ORDER BY source_id").all() as any[];

beforeEach(() => {
  db = new TraulDB(":memory:"); dir = mkdtempSync(join(tmpdir(), "traul-archive-")); seen = [];
  writeFileSync(join(dir, "token"), "secret-token\n"); chmodSync(join(dir, "token"), 0o600);
});
afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(null))); server = undefined; rmSync(dir, { recursive: true, force: true }); });

describe("archive sync", () => {
  it("stores title, link and date of each intake, keyed by its id, with one GET carrying the token", async () => {
    answer = json(envelope([item(38), item(45, { sourceUrl: null, source: { key: "voice-memos", label: "Voice Memos" } })]));
    const report = await syncArchive(db, config(await start()));
    expect(report).toEqual({ source: "archive", status: "ok", added: 2, updated: 0, removed: 0, skipped: 0 });
    expect(seen).toEqual([{ path: "/reader/h/items", token: "secret-token", method: "GET" }]);
    const [a, b] = rows();
    expect(a).toMatchObject({ source_id: "38", channel_id: "youtube", channel_name: "YouTube", content: "Intake 38\n\nhttps://www.example.org/watch?v=38", sent_at: 1759150838 });
    expect(JSON.parse(a.metadata)).toEqual({ v: 1, id: 38, url: "https://www.example.org/watch?v=38", dayOnly: false });
    expect(b).toMatchObject({ source_id: "45", channel_id: "voice-memos", content: "Intake 45" });
    expect(JSON.parse(a.metadata)).not.toHaveProperty("state");
  });

  it("updates a changed title and removes intakes that left the review window", async () => {
    const port = await start();
    answer = json(envelope([item(1), item(2)]));
    await syncArchive(db, config(port));
    answer = json(envelope([item(2, { title: "Renamed" })]));
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "ok", added: 0, updated: 1, removed: 1 });
    expect(rows().map((r) => [r.source_id, r.content.split("\n")[0]])).toEqual([["2", "Renamed"]]);
  });

  it("removes nothing when the answer is truncated", async () => {
    const port = await start();
    answer = json(envelope([item(1), item(2)]));
    await syncArchive(db, config(port));
    answer = json(envelope([item(2)], { truncated: true }));
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "ok", removed: 0 });
    expect(rows()).toHaveLength(2);
  });

  it("skips hostile items: bad id, empty title, non-http link, oversize title", async () => {
    answer = json(envelope([item(0), item(-1), { ...item(3), title: "" }, item(4, { sourceUrl: "javascript:alert(1)" }), item(5, { title: "x".repeat(5000) }), item(6, { source: { key: "../x", label: "X" } })]));
    const report = await syncArchive(db, config(await start()));
    expect(report).toMatchObject({ added: 2, skipped: 4 });
    const byId = Object.fromEntries(rows().map((r) => [r.source_id, r]));
    expect(byId["4"].content).toBe("Intake 4");
    expect(byId["5"].content.split("\n")[0].length).toBe(1000);
  });

  it("is not_configured when there is no URL, and makes no request", async () => {
    expect(await syncArchive(db, config(await start(), { items_url: "" }))).toMatchObject({ status: "not_configured" });
    expect(seen).toEqual([]);
  });

  it("refuses a token file that others can read, and an absent or empty one", async () => {
    const port = await start();
    chmodSync(join(dir, "token"), 0o644);
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "token_mode" });
    rmSync(join(dir, "token"));
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "no_token" });
    writeFileSync(join(dir, "token"), "  \n"); chmodSync(join(dir, "token"), 0o600);
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "no_token" });
    expect(seen).toEqual([]);
  });

  it("reports http_error, redirect and bad_answer, and keeps the stored rows", async () => {
    const port = await start();
    answer = json(envelope([item(1)]));
    await syncArchive(db, config(port));
    answer = json({ error: "nope" }, 401);
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "http_error" });
    answer = (res) => { res.writeHead(302, { location: "http://192.0.2.10/" }); res.end(); };
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "redirect" });
    answer = json({ schema: "archive-page", version: 1, data: { items: [] } });
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "bad_answer" });
    answer = (res) => { res.writeHead(200); res.end("{not json"); };
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "bad_answer" });
    expect(rows()).toHaveLength(1);
  });

  it("refuses an answer over 1 MiB", async () => {
    answer = (res) => { res.writeHead(200); res.end("x".repeat(1024 * 1024 + 1)); };
    expect(await syncArchive(db, config(await start()))).toMatchObject({ status: "too_large" });
  });

  it("times out a reader that never answers", async () => {
    answer = () => {};
    const report = await syncArchive(db, config(await start()), { timeoutMs: 100 });
    expect(report).toMatchObject({ status: "timeout" });
  });

  it("is unreachable when nothing listens, and never sends to a remote host", async () => {
    const port = await start();
    await new Promise((r) => server!.close(r)); server = undefined;
    expect(await syncArchive(db, config(port))).toMatchObject({ status: "unreachable" });
    expect(await syncArchive(db, config(port, { items_url: "http://192.0.2.10/x" }))).toMatchObject({ status: "bad_config" });
  });
});

describe("archive connector", () => {
  it("is named archive and has credentials only when a URL is set", () => {
    expect(archiveConnector.name).toBe("archive");
    expect(archiveConnector.hasCredentials!(config(1))).toBe(true);
    expect(archiveConnector.hasCredentials!(config(1, { items_url: "" }))).toBe(false);
  });
});

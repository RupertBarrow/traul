import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeImap } from "../helpers/fake-imap";
import { runImapCheck, runImapFolders } from "../../src/commands/imap";
import { ImapConfigError } from "../../src/lib/imap-config";
import { account, configWith } from "../helpers/mem-server";

let fake: FakeImap | undefined;
let dir: string;
const msgs = { INBOX: { uidValidity: 1, messages: [{ uid: 1, raw: "Subject: x\r\n\r\nbody" }] }, "Clients/Acme": { uidValidity: 2, messages: [] } };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "traul-imapcmd-")); process.env.IMAP_PASSWORD_A = "pass"; process.env.TRAUL_DB_PATH = join(dir, "traul.db"); });
afterEach(async () => { await fake?.close(); fake = undefined; rmSync(dir, { recursive: true, force: true }); delete process.env.IMAP_PASSWORD_A; delete process.env.TRAUL_DB_PATH; });

const cfg = (port: number, over = {}) => configWith([account("a", { host: "127.0.0.1", port, tls: "plain", user: "user", ...over })]);
const check = (port: number, over = {}, deps = {}) => runImapCheck(cfg(port, over), "a", deps);

describe("imap check", () => {
  it("ok, and it fetches nothing", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: msgs });
    expect(await check(fake.port)).toEqual({ account: "a", status: "ok" });
    const verbs = new Set(fake.log.map((l) => l.verb));
    for (const v of verbs) expect(["CAPABILITY", "LOGIN", "EXAMINE", "LOGOUT"]).toContain(v);
  });

  it("uses LIST for a pattern and examines what it finds", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: msgs });
    expect(await check(fake.port, { folders: ["Clients/*"] })).toEqual({ account: "a", status: "ok" });
    expect(fake.log.filter((l) => l.verb === "EXAMINE")).toHaveLength(1);
    expect(fake.log.map((l) => l.verb)).toContain("LIST");
  });

  it("auth_failed, folder_failed, unreachable, no_secret, timeout", async () => {
    fake = await FakeImap.start({ tls: "plain", pass: "other", folders: msgs });
    expect((await check(fake.port)).status).toBe("auth_failed");
    await fake.close();
    fake = await FakeImap.start({ tls: "plain", folders: msgs, hang: /^EXAMINE "Slow"/ });
    expect((await check(fake.port, { folders: ["Missing"] })).status).toBe("folder_failed");
    expect((await check(fake.port, { folders: ["Slow"] }, { commandTimeoutMs: 150 })).status).toBe("timeout");
    delete process.env.IMAP_PASSWORD_A;
    expect((await check(fake.port)).status).toBe("no_secret");
    process.env.IMAP_PASSWORD_A = "pass";
    const port = fake.port;
    await fake.close();
    expect((await check(port)).status).toBe("unreachable");
  });

  it("an unknown account or a bad configuration is a configuration error", async () => {
    await expect(runImapCheck(cfg(1), "zzz")).rejects.toBeInstanceOf(ImapConfigError);
    await expect(runImapCheck(cfg(1, { password_secret: "bad name" }), "a")).rejects.toBeInstanceOf(ImapConfigError);
  });

  it("opens no database", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: msgs });
    await check(fake.port);
    await runImapFolders(cfg(fake.port), "a");
    expect(existsSync(process.env.TRAUL_DB_PATH!)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("imap folders", () => {
  it("lists folder names", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: msgs });
    expect(await runImapFolders(cfg(fake.port), "a")).toEqual({ account: "a", folders: ["INBOX", "Clients/Acme"] });
  });
});

describe("the executable", () => {
  it("prints one JSON value with a code, creates no database, and names no host or user", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: msgs });
    const home = join(dir, "home");
    const conf = join(dir, "config.json");
    writeFileSync(conf, JSON.stringify({ imap: { accounts: [{ name: "a", host: "127.0.0.1", port: fake.port, tls: "plain", user: "user", password_secret: "IMAP_PASSWORD_A", folders: ["INBOX"] }] } }));
    const env = { PATH: process.env.PATH!, TRAUL_HOME: home, TRAUL_CONFIG_PATH: conf, IMAP_PASSWORD_A: "pass" };
    const p = Bun.spawn([process.execPath, "src/index.ts", "imap", "check", "--account", "a", "--json"], { cwd: join(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(JSON.parse(out)).toEqual({ account: "a", status: "ok" });
    expect(out).not.toMatch(/127\.0\.0\.1|user|pass/);
    expect(existsSync(home)).toBe(false);
    expect(p.exitCode).toBe(0);
  });
});

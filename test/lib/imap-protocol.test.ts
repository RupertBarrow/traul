import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeImap } from "../helpers/fake-imap";
import { openSession, imapDate, parseInternalDate } from "../../src/lib/imap/session";
import { openConnection, command, isAllowedCommand, ImapError } from "../../src/lib/imap/protocol";
import { utf7Decode, utf7Encode } from "../../src/lib/imap/utf7";

const BODY = "Subject: hi\r\nMessage-ID: <a@example.org>\r\n\r\nline one\r\nline two\r\n";
let fake: FakeImap | undefined;
let raw: Server | undefined;
afterEach(async () => { await fake?.close(); raw?.close(); fake = undefined; raw = undefined; });

const base = (port: number) => ({ host: "127.0.0.1", port, tls: "plain" as const, user: "user", password: "pass" });
const codeOf = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return (e as ImapError).code; } };

describe("session over a fake server", () => {
  it("greeting, login, list, examine, search and a literal fetch", async () => {
    fake = await FakeImap.start({
      tls: "plain",
      folders: { INBOX: { uidValidity: 77, messages: [{ uid: 5, raw: BODY, internalDate: "2026-11-03T09:00:00Z" }] }, "Envoy&AOk-s": { uidValidity: 8, messages: [] } },
    });
    const s = await openSession(base(fake.port));
    expect((await s.list()).map((f) => f.name)).toEqual(["INBOX", "Envoyés"]);
    expect(await s.examine("INBOX")).toBe(77);
    expect(await s.examine("Envoyés")).toBe(8);
    await s.examine("INBOX");
    expect(await s.searchSince(new Date("2026-11-01T00:00:00Z"))).toEqual([5]);
    expect(await s.searchAfter(5)).toEqual([]); // the server repeats the last UID; the client filters it
    expect(await s.searchAfter(2)).toEqual([5]);
    const f = await s.fetch(5);
    expect(f?.raw.toString("latin1")).toBe(BODY);
    expect(f?.internalDate).toBe("2026-11-03T00:00:00.000Z");
    expect(f?.truncated).toBe(false);
    expect(await s.fetch(99)).toBeNull();
    await s.close();
  });

  it("reads a literal that arrives in many small pieces", async () => {
    const big = "X-Pad: " + "a".repeat(3000) + "\r\n\r\n" + "body\r\n".repeat(500);
    fake = await FakeImap.start({ tls: "plain", chunk: 97, folders: { INBOX: { uidValidity: 1, messages: [{ uid: 1, raw: big }] } } });
    const s = await openSession(base(fake.port));
    await s.examine("INBOX");
    expect((await s.fetch(1))?.raw.toString("latin1")).toBe(big);
    await s.close();
  });

  it("flags a message cut by the partial fetch", async () => {
    fake = await FakeImap.start({ tls: "plain", folders: { INBOX: { uidValidity: 1, messages: [{ uid: 1, raw: "x".repeat(500) }] } } });
    const s = await openSession({ ...base(fake.port), maxBodyBytes: 200 });
    await s.examine("INBOX");
    const f = await s.fetch(1);
    expect(f?.raw.length).toBe(200);
    expect(f?.truncated).toBe(true);
    await s.close();
  });

  it("named errors: auth_failed, folder_failed, unreachable, timeout, plain_remote", async () => {
    fake = await FakeImap.start({ tls: "plain", pass: "right", folders: { INBOX: { uidValidity: 1, messages: [] } } });
    expect(await codeOf(openSession(base(fake.port)))).toBe("auth_failed");
    await fake.close();
    fake = await FakeImap.start({ tls: "plain", folders: { INBOX: { uidValidity: 1, messages: [] } }, hang: /^EXAMINE "Slow"/ });
    const s = await openSession({ ...base(fake.port), commandTimeoutMs: 150 });
    expect(await codeOf(s.examine("Nope"))).toBe("folder_failed");
    expect(await codeOf(s.examine("Slow"))).toBe("timeout");
    expect(await codeOf(openSession({ ...base(1), port: 1 }))).toBe("unreachable");
    expect(await codeOf(openSession({ ...base(1), host: "192.0.2.10" }))).toBe("plain_remote");
  });

  it("times out connecting to a server that never greets", async () => {
    raw = createServer(() => {});
    await new Promise<void>((r) => raw!.listen(0, "127.0.0.1", r));
    const port = (raw.address() as { port: number }).port;
    expect(await codeOf(openSession({ ...base(port), connectTimeoutMs: 150 }))).toBe("timeout");
  });

  it("refuses a literal above the cap", async () => {
    raw = createServer((sock) => {
      sock.write("* OK hi\r\n");
      sock.on("data", (d) => {
        for (const line of d.toString().split("\r\n").filter(Boolean)) {
          const [tag, verb] = line.split(" ");
          if (verb === "UID") sock.write(`* 1 FETCH (BODY[]<0> {999999999}\r\n`);
          else sock.write(`${verb === "CAPABILITY" ? "* CAPABILITY IMAP4rev1\r\n" : ""}${tag} OK done\r\n`);
        }
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => raw!.listen(0, "127.0.0.1", r));
    const s = await openSession({ ...base((raw.address() as { port: number }).port), maxBodyBytes: 100 });
    expect(await codeOf(s.fetch(1))).toBe("protocol");
  });
});

describe("verb allow-list", () => {
  it("allows only the read-only verbs", () => {
    for (const ok of ["CAPABILITY", "STARTTLS", "LOGOUT", 'LOGIN "u" "p"', 'LIST "" "*"', 'EXAMINE "INBOX"',
      "UID SEARCH SINCE 01-Sep-2026", "UID SEARCH UID 5:*", "UID FETCH 5 (INTERNALDATE BODY.PEEK[]<0.1000>)",
      "UID FETCH 5 (BODY.PEEK[HEADER.FIELDS (FROM TO)])"]) expect(isAllowedCommand(ok)).toBe(true);
    for (const bad of ['SELECT "INBOX"', "UID STORE 1 +FLAGS (\\Deleted)", "UID FETCH 5 (BODY[])", "UID FETCH 5 (RFC822)",
      "UID FETCH 5 (BODY[]<0.10>)", "UID FETCH 5 (BINARY[])", "UID COPY 5 Trash", "EXPUNGE", 'DELETE "x"', 'CREATE "x"',
      'RENAME "a" "b"', 'APPEND "x" {1}', "UID MOVE 5 Trash", 'EXAMINE "a"\r\nA2 EXPUNGE', "NOOP", "IDLE"]) {
      expect(isAllowedCommand(bad)).toBe(false);
    }
  });

  it("command() refuses anything else before writing", async () => {
    fake = await FakeImap.start({ tls: "plain" });
    const conn = await openConnection({ host: "127.0.0.1", port: fake.port, tls: "plain", maxLiteral: 1000 });
    expect(await codeOf(command(conn, 'SELECT "INBOX"'))).toBe("protocol");
    expect(await codeOf(command(conn, "UID STORE 1 +FLAGS (\\Seen)"))).toBe("protocol");
    expect(fake.log).toEqual([]);
    conn.socket.destroy();
  });

  it("the sources hold no verb that can change a mailbox", () => {
    for (const f of ["protocol.ts", "session.ts"]) {
      const text = readFileSync(join(import.meta.dir, "../../src/lib/imap", f), "utf-8");
      expect(text).not.toMatch(/\b(SELECT|STORE|APPEND|EXPUNGE|COPY|MOVE|DELETE|CREATE|RENAME)\b/);
    }
  });
});

describe("helpers", () => {
  it("modified UTF-7 folder names round trip", () => {
    expect(utf7Encode("Envoyés")).toBe("Envoy&AOk-s");
    expect(utf7Decode("Envoy&AOk-s")).toBe("Envoyés");
    expect(utf7Decode(utf7Encode("A&B/Привет"))).toBe("A&B/Привет");
    expect(utf7Encode("INBOX/Sent")).toBe("INBOX/Sent");
  });

  it("dates", () => {
    expect(imapDate(new Date("2026-09-01T12:00:00Z"))).toBe("01-Sep-2026");
    expect(parseInternalDate('INTERNALDATE " 3-Nov-2026 10:00:00 +0100"')).toBe("2026-11-03T09:00:00.000Z");
    expect(parseInternalDate("nothing")).toBeNull();
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import { FakeImap } from "../helpers/fake-imap";
import { openSession } from "../../src/lib/imap/session";
import { tlsOptions, isLoopbackHost, type ImapError } from "../../src/lib/imap/protocol";

let fake: FakeImap | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

const opts = (port: number, tls: "implicit" | "starttls" | "plain", host = "127.0.0.1") =>
  ({ host, port, tls, user: "user", password: "pass", connectTimeoutMs: 3000 });
const codeOf = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return (e as ImapError).code; } };

// Resolve any name to 127.0.0.1, answering in the shape the caller asked for.
const toLoopback = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
  o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never;

describe("tlsOptions", () => {
  it("sends no servername for an IP address, for a name it does", () => {
    for (const ip of ["127.0.0.1", "::1", "[::1]", "192.0.2.10", "2001:db8::1"]) {
      expect("servername" in tlsOptions(ip, 993)).toBe(false);
    }
    expect(tlsOptions("imap.example.org", 993).servername).toBe("imap.example.org");
    expect(tlsOptions("localhost", 993).servername).toBe("localhost");
  });

  it("verifies the certificate for everything except loopback", () => {
    expect(tlsOptions("imap.example.org", 993).rejectUnauthorized).toBe(true);
    expect(tlsOptions("192.0.2.10", 993).rejectUnauthorized).toBe(true);
    for (const h of ["localhost", "127.0.0.1", "127.5.6.7", "::1", "[::1]"]) {
      expect(isLoopbackHost(h)).toBe(true);
      expect(tlsOptions(h, 993).rejectUnauthorized).toBe(false);
    }
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("localhost.example.org")).toBe(false);
  });
});

describe("implicit TLS", () => {
  it("connects to a loopback bridge with a self-signed certificate and sends no SNI for 127.0.0.1", async () => {
    fake = await FakeImap.start({ tls: "implicit", folders: { INBOX: { uidValidity: 3, messages: [] } } });
    const s = await openSession(opts(fake.port, "implicit"));
    expect(await s.examine("INBOX")).toBe(3);
    expect(fake.sni).toEqual([]);
    await s.close();
  });

  it("keeps verification for a name that is not loopback (self-signed certificate refused)", async () => {
    fake = await FakeImap.start({ tls: "implicit" });
    expect(await codeOf(openSession({ ...opts(fake.port, "implicit", "mail.example.org"), lookup: toLoopback }))).toBe("tls_error");
  });

  it("sends no SNI for ::1", async () => {
    try { fake = await FakeImap.start({ tls: "implicit", host: "::1" }); } catch { return; }
    const s = await openSession(opts(fake.port, "implicit", "::1"));
    expect(fake.sni).toEqual([]);
    await s.close();
  });
});

describe("STARTTLS and LOGINDISABLED", () => {
  it("orders CAPABILITY, STARTTLS, CAPABILITY, LOGIN, with LOGIN only on the encrypted channel", async () => {
    fake = await FakeImap.start({ tls: "starttls", loginDisabled: true, folders: { INBOX: { uidValidity: 4, messages: [] } } });
    const s = await openSession(opts(fake.port, "starttls"));
    expect(fake.log).toEqual([
      { verb: "CAPABILITY", secure: false }, { verb: "STARTTLS", secure: false },
      { verb: "CAPABILITY", secure: true }, { verb: "LOGIN", secure: true },
    ]);
    expect(await s.examine("INBOX")).toBe(4);
    await s.close();
  });

  it("refuses to log in when the server does not offer STARTTLS", async () => {
    fake = await FakeImap.start({ tls: "plain" });
    expect(await codeOf(openSession(opts(fake.port, "starttls")))).toBe("tls_error");
    expect(fake.log.map((l) => l.verb)).not.toContain("LOGIN");
  });

  it("never sends LOGIN on a plain session that advertises LOGINDISABLED", async () => {
    fake = await FakeImap.start({ tls: "plain", loginDisabled: true });
    expect(await codeOf(openSession(opts(fake.port, "plain")))).toBe("tls_error");
    expect(fake.log.map((l) => l.verb)).toEqual(["CAPABILITY"]);
  });

  it("a refused STARTTLS is tls_error and no LOGIN is sent", async () => {
    fake = await FakeImap.start({ tls: "starttls", fail: /^STARTTLS/ });
    expect(await codeOf(openSession(opts(fake.port, "starttls")))).toBe("tls_error");
    expect(fake.log.map((l) => l.verb)).not.toContain("LOGIN");
  });
});

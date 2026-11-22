import { createServer as netServer, type Server, type Socket } from "node:net";
import { createServer as tlsServer, TLSSocket } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An in-process IMAP server for tests: synthetic mail only, a throwaway self-signed certificate. */

export interface FakeMessage { uid: number; raw: string | Buffer; internalDate?: string }
export interface FakeFolder { uidValidity: number; messages: FakeMessage[] }
export interface FakeOptions {
  tls?: "implicit" | "starttls" | "plain";
  user?: string;
  pass?: string;
  folders?: Record<string, FakeFolder>;
  /** Advertise LOGINDISABLED while the session is not encrypted. */
  loginDisabled?: boolean;
  /** Never answer a command whose text matches. */
  hang?: RegExp;
  /** Answer a command whose text matches with NO. */
  fail?: RegExp;
  /** Write every response in pieces of this many bytes. */
  chunk?: number;
  host?: string;
}

let certCache: { key: string; cert: string } | null = null;
export function testCert(): { key: string; cert: string } {
  if (certCache) return certCache;
  const dir = mkdtempSync(join(tmpdir(), "traul-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost"], { stdio: "ignore" });
  certCache = { key: readFileSync(join(dir, "k.pem"), "utf-8"), cert: readFileSync(join(dir, "c.pem"), "utf-8") };
  rmSync(dir, { recursive: true, force: true });
  return certCache;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export class FakeImap {
  /** Every command received: `{ verb, secure }`, credentials never recorded. */
  log: Array<{ verb: string; secure: boolean }> = [];
  connections = 0;
  port = 0;
  /** `servername` values seen in a TLS ClientHello (empty string when none). */
  sni: string[] = [];
  private server!: Server;
  constructor(readonly opts: FakeOptions = {}) {}

  static async start(opts: FakeOptions = {}): Promise<FakeImap> {
    const f = new FakeImap(opts);
    await f.listen();
    return f;
  }

  private listen(): Promise<void> {
    const onConn = (s: Socket) => this.accept(s);
    const cert = testCert();
    this.server = this.opts.tls === "implicit"
      ? tlsServer({ ...cert, SNICallback: (name, cb) => { this.sni.push(name); cb(null, undefined as never); } }, onConn)
      : netServer(onConn);
    return new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, this.opts.host ?? "127.0.0.1", () => {
      this.port = (this.server.address() as { port: number }).port;
      resolve();
    }); });
  }

  close(): Promise<void> {
    return new Promise((resolve) => { this.server.close(() => resolve()); (this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); });
  }

  private accept(initial: Socket): void {
    this.connections++;
    let sock: Socket = initial;
    let secure = this.opts.tls === "implicit";
    let buf = "";
    const send = (text: string | Buffer) => this.write(sock, text);
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const upgraded = this.handle(line, secure, send);
        if (upgraded) {
          sock.removeListener("data", onData);
          sock = new TLSSocket(sock, { isServer: true, ...testCert() });
          secure = true;
          sock.on("data", onData);
          sock.on("error", () => {});
        }
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
    send(`* OK [CAPABILITY ${this.caps(secure)}] ready\r\n`);
  }

  private caps(secure: boolean): string {
    const c = ["IMAP4rev1"];
    if (!secure && this.opts.tls === "starttls") c.push("STARTTLS");
    if (!secure && this.opts.loginDisabled) c.push("LOGINDISABLED");
    else c.push("AUTH=PLAIN");
    return c.join(" ");
  }

  private write(sock: Socket, text: string | Buffer): void {
    const buf = typeof text === "string" ? Buffer.from(text, "latin1") : text;
    const n = this.opts.chunk;
    if (!n) { sock.write(buf); return; }
    for (let o = 0; o < buf.length; o += n) setTimeout(() => sock.write(buf.subarray(o, o + n)), o / n);
  }

  /** Handle one command line; returns true when the connection must now be upgraded to TLS. */
  private handle(line: string, secure: boolean, send: (t: string | Buffer) => void): boolean {
    const [tag, ...rest] = line.split(" ");
    const cmd = rest.join(" ");
    const verb = /^UID (SEARCH|FETCH)/i.test(cmd) ? cmd.split(" ").slice(0, 2).join(" ").toUpperCase() : cmd.split(" ")[0].toUpperCase();
    this.log.push({ verb, secure });
    if (this.opts.hang?.test(cmd)) return false;
    if (this.opts.fail?.test(cmd)) { send(`${tag} NO refused\r\n`); return false; }
    const o = this.dispatch(verb, cmd, secure);
    if (o.upgrade) { send(`${tag} OK Begin TLS\r\n`); return true; }
    send(`${o.untagged}${tag} ${o.ok ? "OK" : "NO"} ${verb} done\r\n`);
    if (verb === "LOGOUT") setTimeout(() => send(""), 0);
    return false;
  }

  private dispatch(verb: string, cmd: string, secure: boolean): { ok: boolean; untagged: string; upgrade?: boolean } {
    const ok = (untagged = "") => ({ ok: true, untagged });
    switch (verb) {
      case "CAPABILITY": return ok(`* CAPABILITY ${this.caps(secure)}\r\n`);
      case "STARTTLS": return this.opts.tls === "starttls" && !secure ? { ok: true, untagged: "", upgrade: true } : { ok: false, untagged: "" };
      case "LOGIN": return this.login(cmd, secure);
      case "LIST": return ok(Object.keys(this.opts.folders ?? {}).map((n) => `* LIST (\\HasNoChildren) "/" ${q(n)}\r\n`).join(""));
      case "EXAMINE": return this.examine(cmd);
      case "UID SEARCH": return this.search(cmd);
      case "UID FETCH": return this.fetch(cmd);
      case "LOGOUT": return ok("* BYE bye\r\n");
      default: return { ok: false, untagged: "" };
    }
  }

  private login(cmd: string, secure: boolean) {
    const m = /^LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(cmd);
    const good = m && m[1] === (this.opts.user ?? "user") && m[2] === (this.opts.pass ?? "pass");
    const blocked = !secure && this.opts.loginDisabled;
    return { ok: !!good && !blocked, untagged: "" };
  }

  private current = "";
  private examine(cmd: string) {
    const name = /^EXAMINE "(.*)"$/.exec(cmd)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
    const f = this.opts.folders?.[name];
    if (!f) return { ok: false, untagged: "" };
    this.current = name;
    return { ok: true, untagged: `* 3 EXISTS\r\n* OK [UIDVALIDITY ${f.uidValidity}] ok\r\n` };
  }

  private folder(): FakeFolder | undefined { return this.opts.folders?.[this.current]; }

  private search(cmd: string) {
    const msgs = this.folder()?.messages ?? [];
    let uids: number[] = [];
    const since = /SINCE (\d+)-(\w+)-(\d+)/.exec(cmd);
    const range = /UID (\d+):\*/.exec(cmd);
    if (since) {
      const t = Date.UTC(+since[3], MONTHS.indexOf(since[2]), +since[1]);
      uids = msgs.filter((m) => Date.parse(m.internalDate ?? "2026-01-01T00:00:00Z") >= t).map((m) => m.uid);
    } else if (range) {
      uids = msgs.filter((m) => m.uid >= +range[1]).map((m) => m.uid);
      if (!uids.length && msgs.length) uids = [Math.max(...msgs.map((m) => m.uid))]; // real servers do this
    }
    return { ok: true, untagged: `* SEARCH ${uids.join(" ")}\r\n` };
  }

  private fetch(cmd: string) {
    const m = /^UID FETCH (\d+) \(INTERNALDATE BODY\.PEEK\[\]<0\.(\d+)>\)$/.exec(cmd);
    if (!m) return { ok: false, untagged: "" };
    const msg = this.folder()?.messages.find((x) => x.uid === +m[1]);
    if (!msg) return { ok: true, untagged: "" };
    const raw = Buffer.isBuffer(msg.raw) ? msg.raw : Buffer.from(msg.raw, "latin1");
    const part = raw.subarray(0, +m[2]);
    const d = new Date(msg.internalDate ?? "2026-01-01T00:00:00Z");
    const date = `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} 00:00:00 +0000`;
    const head = `* 1 FETCH (INTERNALDATE "${date}" BODY[]<0> {${part.length}}\r\n`;
    return { ok: true, untagged: head + part.toString("latin1") + ")\r\n" };
  }
}

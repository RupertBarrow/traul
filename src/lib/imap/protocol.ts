import { connect as tlsConnect } from "node:tls";
import { connect as netConnect, isIP, type Socket } from "node:net";
import type { LookupFunction } from "node:net";

/**
 * A minimal, read-only IMAP4rev1 engine: a line and literal reader over node:net / node:tls, one command in
 * flight, a connect timeout and a per-command timeout, a cap on a literal. Errors are CODES, never a host, a
 * user or a server line.
 */

export type ImapErrorCode =
  | "auth_failed" | "unreachable" | "tls_error" | "timeout" | "folder_failed"
  | "no_secret" | "plain_remote" | "protocol";

export class ImapError extends Error {
  /** True when the server answered the command with NO or BAD. */
  refused = false;
  constructor(readonly code: ImapErrorCode) {
    super(code);
    this.name = "ImapError";
  }
}

export type TlsMode = "implicit" | "starttls" | "plain";
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

const bare = (host: string) => String(host).toLowerCase().replace(/^\[|\]$/g, "");

/** A loopback host: a local bridge serves a self-signed certificate and its traffic never leaves the machine. */
export function isLoopbackHost(host: string): boolean {
  const h = bare(host);
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** TLS options: the certificate is verified except for a loopback host; SNI is sent for a NAME, never an IP (RFC 6066). */
export function tlsOptions(host: string, port: number): Record<string, unknown> {
  const h = bare(host);
  const opts: Record<string, unknown> = { host: h, port, rejectUnauthorized: !isLoopbackHost(h) };
  if (isIP(h) === 0) opts.servername = h;
  return opts;
}

export interface Line { text: string; literal: Buffer | null }

/** One logical response line. A trailing `{n}` marker is followed by n literal bytes, then the rest of the line. */
export class LineReader {
  private buf = Buffer.alloc(0);
  private ended = false;
  private wake: (() => void) | null = null;
  private readonly onData = (c: Buffer) => { this.buf = Buffer.concat([this.buf, c]); this.notify(); };
  private readonly onEnd = () => { this.ended = true; this.notify(); };

  constructor(private socket: Socket, private maxLiteral: number) {
    socket.on("data", this.onData);
    socket.on("close", this.onEnd);
    socket.on("error", this.onEnd);
  }

  detach(): void {
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("close", this.onEnd);
  }

  /** Bytes received and not yet consumed. */
  pending(): number { return this.buf.length; }

  private notify(): void { const w = this.wake; this.wake = null; w?.(); }

  private async until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.ended) throw new ImapError("unreachable");
      await new Promise<void>((r) => { this.wake = r; });
    }
  }

  private async takeLine(): Promise<string> {
    await this.until(() => this.buf.indexOf(10) >= 0);
    const nl = this.buf.indexOf(10);
    const line = this.buf.subarray(0, nl + 1).toString("latin1").replace(/\r?\n$/, "");
    this.buf = this.buf.subarray(nl + 1);
    return line;
  }

  private async takeBytes(n: number): Promise<Buffer> {
    await this.until(() => this.buf.length >= n);
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readLine(): Promise<Line> {
    const first = await this.takeLine();
    const marker = /\{(\d+)\+?\}$/.exec(first);
    if (!marker) return { text: first, literal: null };
    const size = Number(marker[1]);
    if (size > this.maxLiteral) {
      this.socket.destroy();
      throw new ImapError("protocol");
    }
    const literal = await this.takeBytes(size);
    const rest = await this.takeLine();
    if (/\{\d+\+?\}$/.test(rest)) throw new ImapError("protocol"); // a second literal on one line: not supported
    return { text: first.slice(0, first.length - marker[0].length) + rest, literal };
  }
}

export interface Conn {
  socket: Socket;
  reader: LineReader;
  host: string;
  port: number;
  secure: boolean;
  tag: number;
  commandTimeoutMs: number;
  maxLiteral: number;
}

export interface ConnectOptions {
  host: string;
  port: number;
  tls: TlsMode;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxLiteral: number;
  /** Name resolution override; a test seam, production leaves it unset. */
  lookup?: LookupFunction;
}

function classify(err: unknown): ImapError {
  const e = err as { code?: string; message?: string };
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  return new ImapError(/CERT|ERR_TLS|SSL|certificate|self[- ]signed|altname|handshake/i.test(text) ? "tls_error" : "unreachable");
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new ImapError("timeout")); }, ms);
  });
  p.catch(() => {}); // the loser of the race must not become an unhandled rejection
  return Promise.race([p, stalled]).finally(() => clearTimeout(timer));
}

function connectSocket(o: ConnectOptions, ms: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const implicit = o.tls === "implicit";
    const extra = o.lookup ? { lookup: o.lookup } : {};
    const socket = implicit ? tlsConnect({ ...tlsOptions(o.host, o.port), ...extra }) : netConnect({ host: bare(o.host), port: o.port, ...extra });
    const timer = setTimeout(() => { socket.destroy(); reject(new ImapError("timeout")); }, ms);
    socket.once("error", (e) => { clearTimeout(timer); reject(classify(e)); });
    socket.once(implicit ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

async function readGreeting(conn: Conn, ms: number): Promise<void> {
  try {
    const greeting = await withTimeout(conn.reader.readLine(), ms, () => conn.socket.destroy());
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text)) throw new ImapError("unreachable");
  } catch (err) {
    conn.socket.destroy();
    throw err;
  }
}

export async function openConnection(o: ConnectOptions): Promise<Conn> {
  if (o.tls === "plain" && !isLoopbackHost(o.host)) throw new ImapError("plain_remote");
  const ms = o.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const socket = await connectSocket(o, ms);
  const conn: Conn = {
    socket, reader: new LineReader(socket, o.maxLiteral), host: o.host, port: o.port, secure: o.tls === "implicit",
    tag: 0, commandTimeoutMs: o.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, maxLiteral: o.maxLiteral,
  };
  await readGreeting(conn, ms);
  return conn;
}

/** Upgrade a plain connection after `STARTTLS` was answered OK. */
export function upgradeToTls(conn: Conn, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
  conn.reader.detach();
  if (conn.reader.pending() > 0) { conn.socket.destroy(); return Promise.reject(new ImapError("tls_error")); }
  const secured = new Promise<void>((resolve, reject) => {
    const s = tlsConnect({ ...tlsOptions(conn.host, conn.port), socket: conn.socket });
    s.once("error", () => reject(new ImapError("tls_error")));
    s.once("secureConnect", () => {
      s.removeAllListeners("error");
      conn.socket = s;
      conn.reader = new LineReader(s, conn.maxLiteral);
      conn.secure = true;
      resolve();
    });
  });
  return withTimeout(secured, timeoutMs, () => conn.socket.destroy());
}

/** The only commands this module can send. Read-only by construction: nothing here can change a mailbox. */
const QUOTED = String.raw`"(?:[^"\\\r\n]|\\.)*"`;
const ALLOWED: RegExp[] = [
  /^(CAPABILITY|STARTTLS|LOGOUT)$/,
  new RegExp(`^LOGIN ${QUOTED} ${QUOTED}$`),
  /^LIST "" "\*"$/,
  new RegExp(`^EXAMINE ${QUOTED}$`),
  /^UID SEARCH (SINCE \d{1,2}-[A-Z][a-z]{2}-\d{4}|UID \d+:\*)$/,
  /^UID FETCH \d+ \((?:(?:INTERNALDATE|UID|FLAGS) )*BODY\.PEEK\[[A-Za-z0-9.() -]*\](?:<\d+\.\d+>)?\)$/,
];

export function isAllowedCommand(verb: string): boolean {
  return ALLOWED.some((re) => re.test(verb));
}

export interface Response { status: string; lines: Line[] }

async function collect(conn: Conn, tag: string): Promise<Response> {
  const lines: Line[] = [];
  for (;;) {
    const line = await conn.reader.readLine();
    if (!line.text.startsWith(`${tag} `)) { lines.push(line); continue; }
    const status = line.text.slice(tag.length + 1).split(" ")[0].toUpperCase();
    if (status === "OK") return { status, lines };
    throw Object.assign(new ImapError("protocol"), { refused: true });
  }
}

/** Send one tagged command and collect its untagged lines. Throws an ImapError (refused = true on NO or BAD). */
export async function command(conn: Conn, verb: string): Promise<Response> {
  if (!isAllowedCommand(verb)) throw new ImapError("protocol");
  const tag = `A${++conn.tag}`;
  conn.socket.write(`${tag} ${verb}\r\n`, "utf8");
  return withTimeout(collect(conn, tag), conn.commandTimeoutMs, () => closeConnection(conn));
}

export function closeConnection(conn: Conn): void {
  try { conn.socket.destroy(); } catch { /* best effort */ }
}

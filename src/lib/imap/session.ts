import {
  closeConnection, command, openConnection, upgradeToTls, ImapError, type Conn, type ConnectOptions, type TlsMode, type Response,
} from "./protocol";
import { utf7Decode, utf7Encode } from "./utf7";

/** A read-only IMAP session: connect, (STARTTLS,) LOGIN, then list, examine, search and peek-fetch. */

export interface SessionOptions {
  host: string;
  port: number;
  tls: TlsMode;
  user: string;
  password: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Bytes asked of each message; a literal may be this plus 64 KiB. */
  maxBodyBytes?: number;
  /** Name resolution override; a test seam. */
  lookup?: ConnectOptions["lookup"];
}

export interface FolderInfo { name: string; delimiter: string | null }
export interface Fetched { raw: Buffer; internalDate: string | null; truncated: boolean }

export interface Session {
  capabilities: string[];
  examine(folder: string): Promise<number | null>;
  list(): Promise<FolderInfo[]>;
  searchSince(date: Date): Promise<number[]>;
  searchAfter(uid: number): Promise<number[]>;
  /** null when the message is gone. */
  fetch(uid: number): Promise<Fetched | null>;
  close(): Promise<void>;
}

/** Opens a session; tests inject a fake one. */
export type SessionFactory = (o: SessionOptions) => Promise<Session>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function imapDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function uidsOf(res: Response): number[] {
  const out: number[] = [];
  for (const l of res.lines) {
    const m = /^\* SEARCH\b(.*)$/i.exec(l.text);
    if (m) out.push(...m[1].split(/\s+/).filter((t) => /^\d+$/.test(t)).map(Number));
  }
  return out;
}

/** `"03-Nov-2026 10:00:00 +0100"` to an ISO string, or null. */
export function parseInternalDate(text: string): string | null {
  const m = /INTERNALDATE "\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)"/.exec(text);
  if (!m || MONTHS.indexOf(m[2]) < 0) return null;
  const utc = Date.UTC(+m[3], MONTHS.indexOf(m[2]), +m[1], +m[4], +m[5], +m[6]);
  const offset = (m[7] === "-" ? -1 : 1) * (+m[8] * 60 + +m[9]) * 60_000;
  return new Date(utc - offset).toISOString();
}

function parseList(line: { text: string; literal: Buffer | null }): FolderInfo | null {
  const m = /^\* LIST \(([^)]*)\) (NIL|"(?:[^"\\]|\\.)*") ?(.*)$/i.exec(line.text);
  if (!m || /\\(Noselect|NonExistent)\b/i.test(m[1])) return null;
  const unq = (q: string) => q.slice(1, -1).replace(/\\(.)/g, "$1");
  const rest = m[3].trim();
  const name = line.literal ? line.literal.toString("latin1") : rest.startsWith('"') ? unq(rest) : rest;
  return name ? { name: utf7Decode(name), delimiter: m[2].toUpperCase() === "NIL" ? null : unq(m[2]) } : null;
}

class ImapSession implements Session {
  constructor(private conn: Conn, readonly capabilities: string[], private maxBody: number) {}

  examine = async (folder: string): Promise<number | null> => {
    try {
      const { lines } = await command(this.conn, `EXAMINE ${quote(utf7Encode(folder))}`);
      const m = lines.map((l) => /UIDVALIDITY\s+(\d+)/i.exec(l.text)).find(Boolean);
      return m ? Number(m[1]) : null;
    } catch (err) {
      throw err instanceof ImapError && !err.refused ? err : new ImapError("folder_failed");
    }
  };

  async list(): Promise<FolderInfo[]> {
    const { lines } = await command(this.conn, 'LIST "" "*"');
    return lines.map(parseList).filter((f): f is FolderInfo => f !== null);
  }

  async searchSince(date: Date): Promise<number[]> {
    return uidsOf(await command(this.conn, `UID SEARCH SINCE ${imapDate(date)}`));
  }

  async searchAfter(uid: number): Promise<number[]> {
    return uidsOf(await command(this.conn, `UID SEARCH UID ${uid + 1}:*`)).filter((u) => u > uid);
  }

  async fetch(uid: number): Promise<Fetched | null> {
    const { lines } = await command(this.conn, `UID FETCH ${uid} (INTERNALDATE BODY.PEEK[]<0.${this.maxBody}>)`);
    const line = lines.find((l) => /^\* \d+ FETCH\b/i.test(l.text));
    if (!line) return null;
    const raw = line.literal ?? Buffer.alloc(0);
    return { raw, internalDate: parseInternalDate(line.text), truncated: raw.length >= this.maxBody };
  }

  async close(): Promise<void> {
    try { await command(this.conn, "LOGOUT"); } catch { /* the socket is closed next */ }
    closeConnection(this.conn);
  }
}

async function capabilitiesOf(conn: Conn): Promise<string[]> {
  const { lines } = await command(conn, "CAPABILITY");
  const l = lines.find((x) => /^\* CAPABILITY\b/i.test(x.text));
  return l ? l.text.replace(/^\* CAPABILITY\s+/i, "").toUpperCase().split(/\s+/) : [];
}

/** CAPABILITY, then STARTTLS and a new CAPABILITY when asked; LOGIN is never sent before the upgrade. */
async function secure(conn: Conn, tls: TlsMode): Promise<string[]> {
  let caps = await capabilitiesOf(conn);
  if (tls === "starttls") {
    if (!caps.includes("STARTTLS")) throw new ImapError("tls_error");
    try { await command(conn, "STARTTLS"); } catch { throw new ImapError("tls_error"); }
    await upgradeToTls(conn);
    caps = await capabilitiesOf(conn);
  }
  if (caps.includes("LOGINDISABLED")) throw new ImapError("tls_error");
  return caps;
}

async function login(conn: Conn, user: string, password: string): Promise<void> {
  try {
    await command(conn, `LOGIN ${quote(user)} ${quote(password)}`);
  } catch (err) {
    throw err instanceof ImapError && !err.refused ? err : new ImapError("auth_failed");
  }
}

export const openSession: SessionFactory = async (o) => {
  const maxBody = o.maxBodyBytes ?? 262144;
  const conn = await openConnection({ ...o, maxLiteral: maxBody + 65536 });
  try {
    const caps = await secure(conn, o.tls);
    await login(conn, o.user, o.password);
    return new ImapSession(conn, caps, maxBody);
  } catch (err) {
    closeConnection(conn);
    throw err;
  }
};

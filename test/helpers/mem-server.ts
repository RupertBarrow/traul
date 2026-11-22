import { ImapError } from "../../src/lib/imap/protocol";
import type { Session, SessionFactory, Fetched } from "../../src/lib/imap/session";
import { loadConfig, defaultImapConfig, type ImapAccount, type ImapConfig, type TraulConfig } from "../../src/lib/config";

/** An in-memory IMAP server behind the Session interface: synthetic mail only. */

export interface MemMsg { uid: number; raw: string; internalDate?: string }
export interface MemFolder { uidValidity: number; messages: MemMsg[] }

export class MemServer {
  fetched: number[] = [];
  searches: string[] = [];
  failFetch = new Set<number>();
  closed = 0;
  constructor(public folders: Record<string, MemFolder>) {}

  session(): Session {
    let current = "";
    const folder = () => this.folders[current];
    return {
      capabilities: [],
      examine: async (name) => {
        if (!this.folders[name]) throw new ImapError("folder_failed");
        current = name;
        return this.folders[name].uidValidity;
      },
      list: async () => Object.keys(this.folders).map((name) => ({ name, delimiter: "/" })),
      searchSince: async (d) => {
        this.searches.push(`since ${d.toISOString().slice(0, 10)}`);
        return folder().messages.filter((m) => Date.parse(m.internalDate ?? "2026-10-01T00:00:00Z") >= d.getTime()).map((m) => m.uid);
      },
      searchAfter: async (uid) => {
        this.searches.push(`after ${uid}`);
        return folder().messages.filter((m) => m.uid > uid).map((m) => m.uid);
      },
      fetch: async (uid): Promise<Fetched | null> => {
        if (this.failFetch.has(uid)) throw new ImapError("timeout");
        this.fetched.push(uid);
        const m = folder().messages.find((x) => x.uid === uid);
        if (!m) return null;
        return { raw: Buffer.from(m.raw, "utf-8"), internalDate: m.internalDate ?? "2026-10-01T00:00:00.000Z", truncated: false };
      },
      close: async () => { this.closed++; },
    };
  }
}

/** One server per host name; an unknown host is unreachable. */
export function factoryFor(servers: Record<string, MemServer>): SessionFactory {
  return async (o) => {
    const s = servers[o.host];
    if (!s) throw new ImapError("unreachable");
    return s.session();
  };
}

export function mail(uid: number, o: { id?: string | null; subject?: string; body?: string; date?: string; internalDate?: string; extra?: string[] } = {}): MemMsg {
  const head = [`From: Alice Example <alice@example.org>`, `To: bob@example.org`, `Subject: ${o.subject ?? `Subject ${uid}`}`];
  if (o.id !== null) head.push(`Message-ID: <${o.id ?? `m${uid}@example.org`}>`);
  if (o.date !== undefined) head.push(`Date: ${o.date}`);
  head.push(...(o.extra ?? []), "Content-Type: text/plain; charset=utf-8");
  return { uid, raw: `${head.join("\r\n")}\r\n\r\n${o.body ?? `Body of ${uid}`}`, internalDate: o.internalDate };
}

export function account(name: string, over: Partial<ImapAccount> = {}): ImapAccount {
  return { name, host: `${name}.example.org`, port: 993, tls: "implicit", user: `${name}@example.org`,
    password_secret: `IMAP_PASSWORD_${name.toUpperCase()}`, folders: ["INBOX"], ...over };
}

export function configWith(accounts: ImapAccount[], over: Partial<ImapConfig> = {}): TraulConfig {
  const base = loadConfig();
  base.imap = { ...defaultImapConfig(), sync_start: "2026-09-01", accounts, ...over };
  return base;
}

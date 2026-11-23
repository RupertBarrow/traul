/** Parsing of `traul import --source imap --ndjson -` (docs/triage-fork/CONTRACT.md). Nothing is written here. */

export interface ImportMessage {
  source_id: string; subject: string; from: string; sent_at: number;
  account: string; folder: string; uidValidity: number; uid: number;
}
export interface ImportCursor { account: string; folder: string; uidValidity: number; lastUid: number }
export type ImportLine = ({ type: "message" } & ImportMessage) | ({ type: "cursor" } & ImportCursor);

export class ImportError extends Error {
  constructor(readonly line: number, readonly problem: string) {
    super(`line ${line}: ${problem}`);
    this.name = "ImportError";
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNat = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** `sent_at` is an ISO 8601 string or whole epoch seconds. */
export function toSeconds(v: unknown): number | null {
  if (isNat(v)) return v;
  if (!isStr(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function parseMessage(o: Record<string, unknown>, n: number): ImportLine {
  const sent = toSeconds(o.sent_at);
  const { source_id, subject, from, account, folder, uidValidity, uid } = o;
  if (!isStr(source_id) || !source_id) throw new ImportError(n, "source_id must be a non-empty string");
  if (!isStr(subject) || !isStr(from)) throw new ImportError(n, "subject and from must be strings");
  if (sent === null) throw new ImportError(n, "sent_at must be an ISO date or epoch seconds");
  if (!isStr(account) || !account || !isStr(folder) || !folder) throw new ImportError(n, "account and folder must be non-empty strings");
  if (!isNat(uidValidity) || !isNat(uid)) throw new ImportError(n, "uidValidity and uid must be whole numbers");
  return { type: "message", source_id, subject, from, sent_at: sent, account, folder, uidValidity, uid };
}

function parseCursor(o: Record<string, unknown>, n: number): ImportLine {
  const { account, folder, uidValidity, lastUid } = o;
  if (!isStr(account) || !account || !isStr(folder) || !folder) throw new ImportError(n, "account and folder must be non-empty strings");
  if (!isNat(uidValidity) || !isNat(lastUid)) throw new ImportError(n, "uidValidity and lastUid must be whole numbers");
  return { type: "cursor", account, folder, uidValidity, lastUid };
}

export function parseLine(text: string, n: number): ImportLine {
  let o: unknown;
  try { o = JSON.parse(text); } catch { throw new ImportError(n, "not JSON"); }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new ImportError(n, "not an object");
  const rec = o as Record<string, unknown>;
  if (rec.type === "message") return parseMessage(rec, n);
  if (rec.type === "cursor") return parseCursor(rec, n);
  throw new ImportError(n, "type must be message or cursor");
}

/** All lines or an ImportError: a bad line means nothing is written. Blank lines are ignored. */
export function parseNdjson(text: string): ImportLine[] {
  const out: ImportLine[] = [];
  text.split(/\r?\n/).forEach((l, i) => { if (l.trim()) out.push(parseLine(l, i + 1)); });
  return out;
}

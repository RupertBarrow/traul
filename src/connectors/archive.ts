import { readFileSync, statSync } from "node:fs";
import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import { loopbackHttpUrl, validateArchiveConfig, type ArchiveConfig } from "../lib/archive-config";
import { getJson, type HttpFailure } from "./archive-http";
import { parseItems, type ParsedItems } from "./archive-items";

/**
 * Archibald's intakes from the local archive reader (`archive` section). One GET per run; the token is read from its
 * file at each run (owner-only file) and sent as one header, never logged. Intakes that left the reader's window are
 * deleted, unless the answer says it is truncated.
 */
export type ArchiveStatus = "ok" | "not_configured" | "bad_config" | "no_token" | "token_mode" | "bad_answer" | HttpFailure;
export interface ArchiveReport { source: "archive"; status: ArchiveStatus; added: number; updated: number; removed: number; skipped: number }
export interface ArchiveDeps { timeoutMs?: number; now?: () => number }

const report = (status: ArchiveStatus, n: Partial<ArchiveReport> = {}): ArchiveReport =>
  ({ source: "archive", status, added: 0, updated: 0, removed: 0, skipped: 0, ...n });

function readToken(path: string): string | "no_token" | "token_mode" {
  let st;
  try { st = statSync(path); } catch { return "no_token"; }
  if (!st.isFile()) return "no_token";
  if ((st.mode & 0o077) !== 0) return "token_mode";
  const token = readFileSync(path, "utf-8").trim();
  return token && !/[\r\n]/.test(token) ? token : "no_token";
}

function store(db: TraulDB, parsed: ParsedItems): Partial<ArchiveReport> {
  const n = { added: 0, updated: 0, removed: 0, skipped: parsed.skipped };
  db.db.transaction(() => {
    for (const row of parsed.rows) {
      if (db.hasMessage("archive", row.source_id)) n.updated++;
      else n.added++;
      db.upsertMessage({ source: "archive", ...row });
    }
    if (!parsed.truncated) n.removed = removeOthers(db, new Set(parsed.ids));
  })();
  return n;
}

function removeOthers(db: TraulDB, keep: Set<string>): number {
  const stored = db.db.query("SELECT id, source_id FROM messages WHERE source = 'archive'").all() as { id: number; source_id: string }[];
  const gone = stored.filter((r) => !keep.has(r.source_id));
  for (const r of gone) db.deleteMessage(r.id);
  return gone.length;
}

export async function syncArchive(db: TraulDB, config: TraulConfig, deps: ArchiveDeps = {}): Promise<ArchiveReport> {
  const cfg: ArchiveConfig = config.archive;
  if (!cfg?.items_url) return report("not_configured");
  const url = loopbackHttpUrl(cfg.items_url);
  if (validateArchiveConfig(cfg).length || !url) return report("bad_config");
  const token = readToken(cfg.token_file);
  if (token === "no_token" || token === "token_mode") return report(token);
  const answer = await getJson(url, { [cfg.token_header]: token }, deps.timeoutMs);
  if (answer.kind === "failed") return report(answer.code);
  const parsed = parseItems(answer.body, Math.floor((deps.now?.() ?? Date.now()) / 1000));
  return parsed ? report("ok", store(db, parsed)) : report("bad_answer");
}

import type { TraulDB } from "../db/database";
import { getEmbedSettings } from "../lib/embed-config";
import { setInfoToStderr } from "../lib/logger";
import { runEmbed } from "./embed";

/** Messages and chunks still waiting for a vector. */
export function countPending(db: TraulDB): number {
  const one = (sql: string): number => (db.db.query<{ n: number }, []>(sql).get()?.n ?? 0);
  return one(`SELECT COUNT(*) AS n FROM messages m WHERE m.content != ''
              AND m.id NOT IN (SELECT message_id FROM vec_messages)
              AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)`)
    + one(`SELECT COUNT(*) AS n FROM chunks c WHERE c.content != '' AND c.id NOT IN (SELECT chunk_id FROM vec_chunks)`);
}

/** `traul embed --json`: one JSON value on stdout, nothing else; exit 0 when it ran. */
export async function runEmbedJson(db: TraulDB, options: { limit?: string; rechunk?: boolean }): Promise<void> {
  setInfoToStderr(true);
  const o = await runEmbed(db, { ...options, quiet: true });
  const s = getEmbedSettings();
  const out = { state: o.code ?? "ok", embedded: o.embedded, failed: o.failed, pending: countPending(db), model: s.model, dims: s.dims };
  process.stdout.write(JSON.stringify(out) + "\n");
}

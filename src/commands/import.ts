import type { Command } from "commander";
import type { TraulDB } from "../db/database";
import { ImportError, parseNdjson, type ImportLine } from "./import-parse";

/** `traul import`: Triage's own mail history as stubs, and the sync cursors it wants kept. */

export interface ImportResult { imported: number; existing: number; cursors: number }

const INSERT_STUB = `
  INSERT INTO messages (source, source_id, channel_id, channel_name, thread_id, author_name, content, sent_at, metadata)
  VALUES ('imap', ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, source_id) DO NOTHING`;
const INSERT_CURSOR = `INSERT INTO sync_cursors (source, key, cursor_value) VALUES ('imap', ?, ?) ON CONFLICT(source, key) DO NOTHING`;

function stubMetadata(m: Extract<ImportLine, { type: "message" }>): string {
  const { account, folder, uidValidity, uid, subject, from } = m;
  return JSON.stringify({ v: 1, account, folder, uidValidity, uid, subject, from, stub: true });
}

function insertMessage(db: TraulDB, m: Extract<ImportLine, { type: "message" }>): boolean {
  const mid = m.source_id.startsWith("mid:") ? m.source_id.slice(4) : m.source_id;
  const r = db.db.run(INSERT_STUB, [m.source_id, m.account, `${m.account}/${m.folder}`, mid, m.from || null, m.subject || m.source_id, m.sent_at, stubMetadata(m)]);
  return r.changes > 0;
}

function insertCursor(db: TraulDB, c: Extract<ImportLine, { type: "cursor" }>): boolean {
  const value = JSON.stringify({ uidValidity: c.uidValidity, lastUid: c.lastUid });
  return db.db.run(INSERT_CURSOR, [`${c.account}|${c.folder}`, value]).changes > 0;
}

/** One transaction. A stub never replaces a row; a cursor is set only where there is none. */
export function importLines(db: TraulDB, lines: ImportLine[]): ImportResult {
  const r: ImportResult = { imported: 0, existing: 0, cursors: 0 };
  db.inTransaction(() => {
    for (const l of lines) {
      if (l.type === "cursor") r.cursors += insertCursor(db, l) ? 1 : 0;
      else if (insertMessage(db, l)) r.imported++;
      else r.existing++;
    }
  });
  return r;
}

/** Returns the exit code: 0, or 2 for a bad option or line (nothing written). */
export async function runImport(db: TraulDB, options: { source?: string; ndjson?: string }): Promise<number> {
  if (options.source !== "imap" || options.ndjson !== "-") {
    console.error("import supports --source imap --ndjson - only");
    return 2;
  }
  try {
    const lines = parseNdjson(await Bun.stdin.text());
    process.stdout.write(JSON.stringify(importLines(db, lines)) + "\n");
    return 0;
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    console.error(err.message);
    return 2;
  }
}

export function registerImportCommand(program: Command, db: TraulDB): void {
  program
    .command("import")
    .description("Import message stubs and sync cursors from NDJSON on stdin")
    .option("--source <source>", "source (imap)")
    .option("--ndjson <file>", "NDJSON input; only - (stdin)")
    .action(async (options) => {
      process.exitCode = await runImport(db, options);
      db.close();
    });
}

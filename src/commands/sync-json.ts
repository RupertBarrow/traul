import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import { syncImap } from "../connectors/imap-sync";
import { ImapConfigError } from "../lib/imap-config";
import { setInfoToStderr } from "../lib/logger";
import { JSON_SOURCES, syncSourceReport } from "./sync-source";

/** `traul sync imap|slack|markdown|whatsapp|facebook --json`: one JSON value on stdout (the report), logs on stderr. Returns the exit code. */
export async function runSyncJson(db: TraulDB, config: TraulConfig, source?: string): Promise<number> {
  setInfoToStderr(true);
  if (source && JSON_SOURCES.includes(source)) {
    process.stdout.write(JSON.stringify(await syncSourceReport(db, config, source)) + "\n");
    return 0;
  }
  if (source !== "imap") {
    console.error("sync --json supports the sources imap, slack, markdown, whatsapp and facebook only");
    return 2;
  }
  try {
    const report = await syncImap(db, config);
    process.stdout.write(JSON.stringify(report) + "\n");
    return 0;
  } catch (err) {
    if (!(err instanceof ImapConfigError)) throw err;
    console.error(err.message);
    return 2;
  }
}

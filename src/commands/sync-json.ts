import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import { syncImap } from "../connectors/imap-sync";
import { ImapConfigError } from "../lib/imap-config";
import { setInfoToStderr } from "../lib/logger";

/** `traul sync imap --json`: one JSON value on stdout (the report), logs on stderr. Returns the exit code. */
export async function runSyncJson(db: TraulDB, config: TraulConfig, source?: string): Promise<number> {
  setInfoToStderr(true);
  if (source !== "imap") {
    console.error("sync --json supports the source imap only");
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

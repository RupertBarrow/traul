import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import { syncImap } from "../connectors/imap-sync";
import { syncArchive } from "../connectors/archive";
import { ImapConfigError } from "../lib/imap-config";
import { setInfoToStderr } from "../lib/logger";

/** `traul sync imap|archive --json`: one JSON value on stdout (the report), logs on stderr. Returns the exit code. */
export async function runSyncJson(db: TraulDB, config: TraulConfig, source?: string): Promise<number> {
  setInfoToStderr(true);
  if (source === "archive") return runArchive(db, config);
  if (source !== "imap") {
    console.error("sync --json supports the sources imap and archive only");
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

async function runArchive(db: TraulDB, config: TraulConfig): Promise<number> {
  const report = await syncArchive(db, config);
  process.stdout.write(JSON.stringify(report) + "\n");
  return report.status === "bad_config" ? 2 : 0;
}

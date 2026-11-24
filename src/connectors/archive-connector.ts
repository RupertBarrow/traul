import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import * as log from "../lib/logger";
import { syncArchive, type ArchiveDeps } from "./archive";

/** Archibald's intakes. Logs carry counts and the status, never a title or a link. */
export const archiveConnector: Connector & {
  sync: (db: TraulDB, config: TraulConfig, deps?: ArchiveDeps) => Promise<SyncResult>;
} = {
  name: "archive",
  defaultInterval: 300,
  hasCredentials: (config: TraulConfig) => !!config.archive?.items_url,
  async sync(db: TraulDB, config: TraulConfig, deps?: ArchiveDeps): Promise<SyncResult> {
    const r = await syncArchive(db, config, deps);
    const line = `archive: ${r.status}, ${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.skipped} skipped`;
    if (r.status === "ok") log.info(line);
    else log.warn(line);
    return { messagesAdded: r.added, messagesUpdated: r.updated, contactsAdded: 0 };
  },
};

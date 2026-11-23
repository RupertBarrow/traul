import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import * as log from "../lib/logger";
import { syncImap, type ImapReport, type SyncDeps } from "./imap-sync";

/** Read-only IMAP mail. Logs carry counts and codes, never a subject, an address or text. */

function logReport(report: ImapReport): void {
  report.accounts.forEach((a, i) => {
    const t = { added: 0, updated: 0, backfilled: 0, gone: 0, skipped: 0 };
    for (const f of a.folders) for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] += f[k];
    const line = `imap: account ${i + 1}: ${a.status}, ${t.added} added, ${t.updated} updated, ${t.backfilled} backfilled, ${t.gone} gone, ${t.skipped} skipped`;
    if (a.status === "ok") log.info(line);
    else log.warn(line);
  });
}

function totals(report: ImapReport): SyncResult {
  const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
  for (const a of report.accounts) {
    for (const f of a.folders) {
      result.messagesAdded += f.added + f.backfilled;
      result.messagesUpdated += f.updated;
    }
  }
  return result;
}

export const imapConnector: Connector & {
  sync: (db: TraulDB, config: TraulConfig, deps?: SyncDeps) => Promise<SyncResult>;
} = {
  name: "imap",
  defaultInterval: 300,
  hasCredentials: (config: TraulConfig) => config.imap.accounts.length > 0,
  async sync(db: TraulDB, config: TraulConfig, deps?: SyncDeps): Promise<SyncResult> {
    const report = await syncImap(db, config, deps);
    logReport(report);
    return totals(report);
  },
};

import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import type { Connector } from "../connectors/types";
import { getConnector } from "../connectors/registry";
import { resolveSlackCredentials } from "../lib/slack-secrets";

/** The `sync <slack|markdown> --json` report: counts and a status, never a channel, a path or text. */
export type SourceStatus = "ok" | "not_configured" | "no_credentials" | "failed";
export interface SourceReport { source: string; status: SourceStatus; added: number; updated: number }
export const JSON_SOURCES = ["slack", "markdown"];

async function precheck(config: TraulConfig, source: string): Promise<SourceStatus | null> {
  if (source === "markdown" && !(config.markdown?.dirs?.length)) return "not_configured";
  if (source === "slack" && (await resolveSlackCredentials(config)) === "none") return "no_credentials";
  return null;
}

export async function syncSourceReport(db: TraulDB, config: TraulConfig, source: string, connector?: Connector): Promise<SourceReport> {
  const empty = { source, added: 0, updated: 0 };
  const stop = await precheck(config, source);
  if (stop) return { ...empty, status: stop };
  const c = connector ?? getConnector(source);
  if (!c) return { ...empty, status: "failed" };
  try {
    const r = await c.sync(db, config);
    return { source, status: "ok", added: r.messagesAdded, updated: r.messagesUpdated };
  } catch {
    return { ...empty, status: "failed" };
  }
}

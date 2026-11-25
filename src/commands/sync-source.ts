import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import type { Connector } from "../connectors/types";
import { getConnector } from "../connectors/registry";
import { resolveSlackCredentials } from "../lib/slack-secrets";
import { resolveWhatsappKeys } from "../lib/whatsapp-secrets";
import { resolveFacebookTokens } from "../lib/facebook-secrets";

/** The `sync <slack|markdown|whatsapp|facebook> --json` report: counts and a status, never a channel, a path or text. */
export type SourceStatus = "ok" | "not_configured" | "no_credentials" | "failed";
export interface SourceReport { source: string; status: SourceStatus; added: number; updated: number }
export const JSON_SOURCES = ["slack", "markdown", "whatsapp", "facebook"];

async function whatsappPrecheck(config: TraulConfig): Promise<SourceStatus | null> {
  if (!(config.whatsapp?.instances?.length)) return "not_configured";
  return (await resolveWhatsappKeys(config)) ? null : "no_credentials";
}

async function facebookPrecheck(config: TraulConfig): Promise<SourceStatus | null> {
  const pages = config.facebook?.pages ?? [];
  if (!pages.length) return "not_configured";
  return (await resolveFacebookTokens(config)).size === pages.length ? null : "no_credentials";
}

async function precheck(config: TraulConfig, source: string): Promise<SourceStatus | null> {
  if (source === "markdown" && !(config.markdown?.dirs?.length)) return "not_configured";
  if (source === "slack" && (await resolveSlackCredentials(config)) === "none") return "no_credentials";
  if (source === "whatsapp") return whatsappPrecheck(config);
  if (source === "facebook") return facebookPrecheck(config);
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

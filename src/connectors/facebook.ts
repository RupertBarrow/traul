import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import type { FacebookPage, TraulConfig } from "../lib/config";
import * as log from "../lib/logger";
import { resolveFacebookTokens } from "../lib/facebook-secrets";
import {
  type GraphConversation, type GraphPage, contentOf, conversationsUrl, isGraphUrl, messageRow, pageUrl, seconds, stripToken,
} from "./facebook-graph";

/** Facebook Page inbox (Messenger conversations of the Pages you manage), read through the Graph API. */

const MAX_PAGES = 40;

async function getJson<T>(fetchFn: typeof fetch, url: string, token: string): Promise<T> {
  const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`graph ${r.status}`);
  return (await r.json()) as T;
}

function storeConversation(db: TraulDB, page: FacebookPage, pageName: string, conv: GraphConversation): number {
  let n = 0;
  for (const msg of conv.messages?.data ?? []) {
    if (!contentOf(msg)) continue;
    db.upsertMessage(messageRow(page, pageName, conv, msg));
    n++;
  }
  return n;
}

async function syncPage(db: TraulDB, config: TraulConfig, page: FacebookPage, token: string, fetchFn: typeof fetch): Promise<number> {
  const version = config.facebook.graph_version || "v26.0";
  const cursorKey = `${page.name}:updated`;
  const after = Number(db.getSyncCursor("facebook", cursorKey) ?? 0);
  const info = await getJson<{ name?: string }>(fetchFn, pageUrl(version, page.page_id), token);
  let url: string | undefined = conversationsUrl(version, page.page_id);
  let added = 0;
  let newest = after;
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const res: GraphPage<GraphConversation> = await getJson(fetchFn, url, token);
    let older = false;
    for (const conv of res.data) {
      const t = seconds(conv.updated_time);
      if (t <= after) { older = true; break; }
      newest = Math.max(newest, t);
      added += storeConversation(db, page, info.name ?? page.name, conv);
    }
    const next = res.paging?.next;
    url = !older && next && isGraphUrl(next) ? stripToken(next) : undefined;
  }
  if (newest > after) db.setSyncCursor("facebook", cursorKey, String(newest));
  return added;
}

export async function syncFacebook(db: TraulDB, config: TraulConfig, fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
  const pages = config.facebook?.pages ?? [];
  const tokens = await resolveFacebookTokens(config);
  let failed = 0;
  for (const page of pages) {
    const token = tokens.get(page.name);
    if (!token) { log.warn(`  [facebook:${page.name}] no Page access token`); failed++; continue; }
    try {
      result.messagesAdded += await syncPage(db, config, page, token, fetchFn);
    } catch (err) {
      log.warn(`  [facebook:${page.name}] ${(err as Error).message}`);
      failed++;
    }
  }
  if (pages.length > 0 && failed === pages.length) throw new Error("facebook: no Page could be read");
  return result;
}

export const facebookConnector: Connector = {
  name: "facebook",
  defaultInterval: 300,
  hasCredentials: (config) => (config.facebook?.pages?.length ?? 0) > 0,
  sync: (db, config) => syncFacebook(db, config),
};

import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, type WhatsappInstance, getEffectiveSyncStart } from "../lib/config";
import * as log from "../lib/logger";
import { resolveWhatsappKeys } from "../lib/whatsapp-secrets";

interface WahaChat {
  id: string;
  name: string;
  isGroup: boolean;
}

interface WahaMessage {
  id: string;
  body: string;
  timestamp: number;
  from: string;
  fromMe: boolean;
  hasMedia: boolean;
  mediaUrl?: string;
  ack: number;
  _data?: {
    notifyName?: string;
    type?: string;
  };
}

function getHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  return headers;
}

function mediaPlaceholder(msg: WahaMessage): string {
  const type = msg._data?.type ?? "file";
  const typeMap: Record<string, string> = {
    image: "image",
    video: "video",
    ptt: "audio",
    audio: "audio",
    document: "document",
    sticker: "sticker",
  };
  return `[media: ${typeMap[type] ?? type}]`;
}

/** A person's chat opens at wa.me/<number>; a group (or anything else) has no link. */
export function chatLink(chatId: string): string | null {
  const m = /^(\d{5,20})@(c\.us|s\.whatsapp\.net)$/.exec(chatId);
  return m ? `https://wa.me/${m[1]}` : null;
}

/** Syncs one WAHA instance; false when WAHA could not be reached or the session is not authenticated. */
async function syncInstance(
  db: TraulDB,
  config: TraulConfig,
  instance: WhatsappInstance,
  result: SyncResult,
  fetch: typeof globalThis.fetch,
): Promise<boolean> {
  const { name, url, api_key, session, chats: chatFilter } = instance;
  const headers = getHeaders(api_key);

  try {
    const statusResp = await fetch(`${url}/api/sessions/${session}`, { headers });
    if (!statusResp.ok) {
      log.warn(`  [${name}] WAHA session "${session}" not found. Run: traul whatsapp auth ${name}`);
      return false;
    }
    const status = await statusResp.json() as { status: string };
    if (status.status !== "WORKING") {
      log.warn(`  [${name}] WAHA session not authenticated (status: ${status.status}). Run: traul whatsapp auth ${name}`);
      return false;
    }
  } catch {
    log.warn(`  [${name}] Cannot reach WAHA. Is it running?`);
    return false;
  }

  const chatsResp = await fetch(`${url}/api/sessions/${session}/chats`, { headers });
  if (!chatsResp.ok) {
    log.warn(`  [${name}] Failed to list chats: ${chatsResp.status}`);
    return false;
  }
  let allChats = await chatsResp.json() as WahaChat[];

  if (chatFilter.length > 0) {
    allChats = allChats.filter(
      (c) => chatFilter.includes(c.id) || chatFilter.some((f) => c.name?.includes(f)),
    );
  }

  log.info(`  [${name}] Syncing ${allChats.length} chats...`);

  for (const chat of allChats) {
    const chatName = chat.name || chat.id;
    const link = chatLink(chat.id);
    const cursorKey = `${name}:chat:${chat.id}`;
    const effectiveStart = getEffectiveSyncStart(db, config, "whatsapp", cursorKey);
    const afterTs = effectiveStart ? parseInt(effectiveStart) : 0;

    log.info(`    ${chatName}`);

    let offset = 0;
    const PAGE_SIZE = 100;
    let latestTs = afterTs;
    let chatMsgCount = 0;

    while (true) {
      const msgsResp = await fetch(
        `${url}/api/sessions/${session}/chats/${encodeURIComponent(chat.id)}/messages?limit=${PAGE_SIZE}&offset=${offset}`,
        { headers },
      );

      if (!msgsResp.ok) {
        log.warn(`    Failed to fetch messages: ${msgsResp.status}`);
        break;
      }

      const messages = await msgsResp.json() as WahaMessage[];
      if (messages.length === 0) break;

      messages.sort((a, b) => a.timestamp - b.timestamp);

      for (const msg of messages) {
        if (msg.timestamp <= afterTs) continue;

        const content = msg.body
          ? msg.body
          : msg.hasMedia
            ? mediaPlaceholder(msg)
            : "";

        if (!content) continue;

        const authorName = msg._data?.notifyName ?? (msg.fromMe ? "Me" : msg.from);

        db.upsertMessage({
          source: "whatsapp",
          source_id: `${name}:${msg.id}`,
          channel_id: chat.id,
          channel_name: chatName,
          author_id: msg.from,
          author_name: authorName,
          content,
          sent_at: msg.timestamp,
          metadata: JSON.stringify({
            fromMe: msg.fromMe,
            hasMedia: msg.hasMedia,
            ack: msg.ack,
            instance: name,
            isGroup: !!chat.isGroup,
            ...(link ? { permalink: link } : {}),
          }),
        });
        chatMsgCount++;

        if (msg.timestamp > latestTs) {
          latestTs = msg.timestamp;
        }

        if (!msg.fromMe) {
          const existing = db.getContactBySourceId("whatsapp", msg.from);
          if (!existing) {
            const contactId = db.upsertContact(authorName);
            db.upsertContactIdentity({
              contactId,
              source: "whatsapp",
              sourceUserId: msg.from,
              username: msg.from,
              displayName: authorName,
            });
            result.contactsAdded++;
          }
        }
      }

      if (messages.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (latestTs > afterTs) {
      db.setSyncCursor("whatsapp", cursorKey, String(latestTs));
    }

    result.messagesAdded += chatMsgCount;
    if (chatMsgCount > 0) {
      log.info(`      ${chatMsgCount} messages`);
    }
  }
  return true;
}

/** Syncs every instance (API keys resolved by name first); throws when none could be read, so a report says failed. */
export async function syncWhatsapp(db: TraulDB, config: TraulConfig, fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
  const instances = config.whatsapp.instances;
  if (instances.length === 0) {
    log.warn("No WhatsApp instances configured.");
    log.warn("Add whatsapp.instances to ~/.config/traul/config.json");
    return result;
  }
  await resolveWhatsappKeys(config);
  log.info(`Syncing ${instances.length} WhatsApp instance(s)...`);
  let reached = 0;
  for (const instance of instances) {
    if (await syncInstance(db, config, instance, result, fetchFn)) reached++;
  }
  if (reached === 0) throw new Error("whatsapp: no WAHA instance could be read");
  return result;
}

export const whatsappConnector: Connector = {
  defaultInterval: 300,
  hasCredentials: (config) => config.whatsapp.instances.length > 0,
  name: "whatsapp",
  sync: (db, config) => syncWhatsapp(db, config),
};

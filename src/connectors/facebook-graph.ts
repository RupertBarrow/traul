import type { FacebookPage } from "../lib/config";

/** Shapes and pure helpers of the Graph API Page inbox (Messenger conversations of a Page). */

export interface GraphUser { id: string; name?: string }
export interface GraphMessage {
  id: string;
  created_time: string;
  from: GraphUser;
  message?: string;
  attachments?: { data: Array<{ mime_type?: string; name?: string }> };
}
export interface GraphConversation {
  id: string;
  updated_time: string;
  link?: string;
  participants?: { data: GraphUser[] };
  messages?: { data: GraphMessage[] };
}
export interface GraphPage<T> { data: T[]; paging?: { next?: string } }

const GRAPH = "https://graph.facebook.com";
/** The Graph API returns at most the 20 most recent messages of a conversation. */
const FIELDS = "id,updated_time,link,participants,messages.limit(20){id,created_time,from,message,attachments{mime_type,name}}";

/** The first page of a Page's Messenger conversations, newest first. The token goes in a header, never here. */
export function conversationsUrl(version: string, pageId: string): string {
  const q = new URLSearchParams({ platform: "messenger", fields: FIELDS, limit: "25" });
  return `${GRAPH}/${encodeURIComponent(version)}/${encodeURIComponent(pageId)}/conversations?${q}`;
}

/** The Page's own name, to tell its messages apart. */
export const pageUrl = (version: string, pageId: string) =>
  `${GRAPH}/${encodeURIComponent(version)}/${encodeURIComponent(pageId)}?fields=id,name`;

/** A `paging.next` URL without any `access_token` the Graph API may have put in it. */
export function stripToken(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("access_token");
  return u.toString();
}

/** Only a graph.facebook.com URL is followed. */
export const isGraphUrl = (url: string) => { try { return new URL(url).origin === GRAPH; } catch { return false; } };

export const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The conversation's name: the participants other than the Page. */
export function conversationTitle(conv: GraphConversation, pageId: string): string {
  const others = (conv.participants?.data ?? []).filter((p) => p.id !== pageId).map((p) => p.name || p.id);
  return others.join(", ") || conv.id;
}

function attachmentKind(mime?: string): string {
  const top = (mime ?? "").split("/")[0];
  return ["image", "video", "audio"].includes(top) ? top : "file";
}

/** The message text, then one `[attachment: kind]` line per attachment; "" when there is neither. */
export function contentOf(msg: GraphMessage): string {
  const parts = msg.message ? [msg.message] : [];
  for (const a of msg.attachments?.data ?? []) parts.push(`[attachment: ${attachmentKind(a.mime_type)}]`);
  return parts.join("\n");
}

/** One `messages` row (read schema 1). `permalink` opens the conversation in the Page inbox. */
export function messageRow(page: FacebookPage, pageName: string, conv: GraphConversation, msg: GraphMessage) {
  const fromPage = msg.from?.id === page.page_id;
  return {
    source: "facebook",
    source_id: `${page.name}:${msg.id}`,
    channel_id: conv.id,
    channel_name: conversationTitle(conv, page.page_id),
    author_id: msg.from?.id,
    author_name: msg.from?.name || msg.from?.id,
    content: contentOf(msg),
    sent_at: seconds(msg.created_time),
    metadata: JSON.stringify({
      page: page.name,
      page_id: page.page_id,
      page_name: pageName,
      fromPage,
      ...(conv.link ? { permalink: `https://www.facebook.com${conv.link.startsWith("/") ? "" : "/"}${conv.link}` } : {}),
    }),
  };
}

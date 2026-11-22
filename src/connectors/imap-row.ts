import { splitEntity } from "../lib/mail-headers";
import { parseMessage, type ParsedMessage } from "../lib/mime";
import type { Fetched } from "../lib/imap/session";
import { messageKey } from "./imap-key";

/** From a fetched message to the `messages` row of the read schema (docs/triage-fork/SPEC.md, 5.4). */

export interface Locator { account: string; folder: string; uidValidity: number; uid: number }
export interface ImapRow {
  source: "imap";
  source_id: string;
  channel_id: string;
  channel_name: string;
  thread_id: string;
  author_id?: string;
  author_name?: string;
  content: string;
  sent_at: number;
  metadata: string;
}

/** The key the message would be stored under, from its own headers. */
export function keyOf(raw: Buffer, at: Locator): string {
  const head = splitEntity(raw.toString("latin1")).head;
  return messageKey(head, at.account, at.folder, at.uidValidity, at.uid);
}

function seconds(...candidates: Array<string | null>): number {
  for (const c of candidates) {
    const ms = c ? Date.parse(c) : NaN;
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function metadataOf(p: ParsedMessage, f: Fetched, at: Locator, messageId: string | null): string {
  const meta: Record<string, unknown> = {
    v: 1, ...at, messageId, subject: p.subject, from: p.from?.address ?? null, to: p.to, date: p.date,
    listUnsubscribe: p.listUnsubscribe, listId: p.listId,
  };
  if (p.truncated || f.truncated) meta.truncated = true;
  return JSON.stringify(meta);
}

export function buildRow(f: Fetched, at: Locator, maxTextChars: number): ImapRow {
  const p = parseMessage(f.raw, { maxTextChars });
  const key = keyOf(f.raw, at);
  const messageId = key.startsWith("mid:") ? key.slice(4) : null;
  return {
    source: "imap",
    source_id: key,
    channel_id: at.account,
    channel_name: `${at.account}/${at.folder}`,
    thread_id: p.references[0] ?? p.inReplyTo ?? messageId ?? key,
    author_id: p.from?.address,
    author_name: p.from ? p.from.name || p.from.address : undefined,
    content: p.text ? `${p.subject}\n\n${p.text}` : p.subject,
    sent_at: seconds(p.date, f.internalDate),
    metadata: metadataOf(p, f, at, messageId),
  };
}

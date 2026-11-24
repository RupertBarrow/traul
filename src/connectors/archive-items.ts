/**
 * The reader's answer (`{schema: "archive-items", version: 1, data: {items, truncated}}`) turned into rows.
 * Only the title, the link and the date of an intake are kept (plus its id and source); an item that does not
 * have the expected shape is skipped, never stored in part.
 */
export const MAX_TITLE_CHARS = 1000;
const MAX_URL_CHARS = 2048;
const KEY_RE = /^[a-z0-9-]{1,64}$/;

export interface IntakeRow {
  source_id: string;
  channel_id: string;
  channel_name: string;
  content: string;
  sent_at: number;
  metadata: string;
}
export interface ParsedItems { rows: IntakeRow[]; ids: string[]; skipped: number; truncated: boolean }

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function link(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_URL_CHARS) return null;
  try { return ["http:", "https:"].includes(new URL(v).protocol) ? v : null; } catch { return null; }
}

function seconds(date: unknown, now: number): number {
  const ms = isObj(date) ? date.ms : null;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : now;
}

export function intakeRow(it: Record<string, any>, now: number): IntakeRow | null {
  const title = typeof it.title === "string" ? it.title.trim().slice(0, MAX_TITLE_CHARS) : "";
  const src = isObj(it.source) ? it.source : {};
  if (!title || !KEY_RE.test(String(src.key ?? "")) || typeof src.label !== "string") return null;
  const url = link(it.sourceUrl);
  const dayOnly = isObj(it.sourceDate) && it.sourceDate.dayOnly === true;
  return {
    source_id: String(it.id), channel_id: src.key, channel_name: src.label.slice(0, 100),
    content: url ? `${title}\n\n${url}` : title, sent_at: seconds(it.sourceDate, now),
    metadata: JSON.stringify({ v: 1, id: it.id, url, dayOnly }),
  };
}

/** null when the answer is not an archive-items envelope of version 1. */
export function parseItems(body: string, now: number): ParsedItems | null {
  let doc: any;
  try { doc = JSON.parse(body); } catch { return null; }
  if (!isObj(doc) || doc.schema !== "archive-items" || doc.version !== 1 || !isObj(doc.data) || !Array.isArray(doc.data.items)) return null;
  const out: ParsedItems = { rows: [], ids: [], skipped: 0, truncated: doc.data.truncated !== false };
  for (const it of doc.data.items) {
    const validId = isObj(it) && Number.isSafeInteger(it.id) && it.id > 0;
    if (validId) out.ids.push(String(it.id));
    const row = validId ? intakeRow(it, now) : null;
    if (row) out.rows.push(row);
    else out.skipped++;
  }
  return out;
}

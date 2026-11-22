import { decodeMimeWords } from "./mime-words";

/** RFC 5322 header helpers over a latin1 string (one char per byte). */

export interface Address { address: string; name: string }

export function splitEntity(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: "" };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** Header name (lowercase) to its first unfolded raw value. */
export function parseHeaders(head: string): Map<string, string> {
  const out = new Map<string, string>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
  }
  return out;
}

/** Raw header bytes as text: UTF-8 when valid (8-bit headers), else latin1; then RFC 2047 words. */
export function headerText(value: string | undefined): string {
  if (!value) return "";
  const bytes = Buffer.from(value, "latin1");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = value;
  }
  return decodeMimeWords(text).trim();
}

/** Split on commas outside quotes and angle brackets. */
function splitList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseOne(item: string): Address | null {
  const m = /^(.*?)<([^<>]*)>\s*$/.exec(item);
  const address = (m ? m[2] : item).trim().replace(/^mailto:/i, "");
  if (!address.includes("@")) return null;
  const name = m ? m[1].trim().replace(/^"(.*)"$/s, "$1").replace(/\\(.)/g, "$1") : "";
  return { address, name: headerText(name) };
}

export function parseAddresses(value: string | undefined): Address[] {
  if (!value) return [];
  return splitList(value).map(parseOne).filter((a): a is Address => a !== null);
}

/** Every `<id>` of a Message-ID, References or In-Reply-To value, brackets removed. */
export function parseIds(value: string | undefined): string[] {
  if (!value) return [];
  const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1].trim());
  return ids.length ? ids : [value.trim()].filter((v) => v && !/\s/.test(v));
}

export function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

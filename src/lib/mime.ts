import { htmlToText } from "html-to-text";
import { decodeCharset, qpToBytes } from "./mime-words";
import {
  headerText, parseAddresses, parseDate, parseHeaders, parseIds, splitEntity, type Address,
} from "./mail-headers";

export interface ParsedMessage {
  messageId: string | null;
  references: string[];
  inReplyTo: string | null;
  subject: string;
  from: Address | null;
  to: string[];
  date: string | null;
  listUnsubscribe: string | null;
  listId: string | null;
  text: string;
  truncated: boolean;
}

interface Found { kind: "plain" | "html" | ""; text: string }
interface Ctx { truncated: boolean }

const EMPTY: Found = { kind: "", text: "" };
const HTML_OPTIONS: Parameters<typeof htmlToText>[1] = {
  wordwrap: false,
  selectors: [{ selector: "img", format: "skip" }, { selector: "a", options: { ignoreHref: true } }],
};

function params(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of value.matchAll(/;\s*([\w*.-]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return out;
}

function decodeBody(headers: Map<string, string>, body: string, charset: string): string {
  const cte = (headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
  let bytes: Buffer;
  if (cte === "base64") bytes = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  else if (cte === "quoted-printable") bytes = qpToBytes(body);
  else bytes = Buffer.from(body, "latin1");
  return decodeCharset(charset, bytes);
}

function splitParts(body: string, boundary: string, ctx: Ctx): string[] {
  const parts: string[][] = [];
  let closed = false;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trimEnd();
    if (t === `--${boundary}`) parts.push([]);
    else if (t === `--${boundary}--`) { closed = true; break; }
    else if (parts.length) parts[parts.length - 1].push(line);
  }
  if (!closed) ctx.truncated = true;
  return parts.map((p) => p.join("\r\n"));
}

function pickAlternative(found: Found[]): Found {
  const plain = found.find((f) => f.kind === "plain" && f.text.trim());
  if (plain) return plain;
  return [...found].reverse().find((f) => f.text.trim()) ?? EMPTY;
}

function extractMultipart(subtype: string, body: string, boundary: string, ctx: Ctx): Found {
  const found = splitParts(body, boundary, ctx).map((p) => extract(p, ctx));
  if (subtype === "alternative") return pickAlternative(found);
  const used = found.filter((f) => f.text.trim());
  const kind = used.some((f) => f.kind === "plain") ? "plain" : used.length ? "html" : "";
  return { kind, text: used.map((f) => f.text).join("\n\n") };
}

function extract(raw: string, ctx: Ctx): Found {
  const { head, body } = splitEntity(raw);
  const headers = parseHeaders(head);
  if (/^\s*attachment\b/i.test(headers.get("content-disposition") ?? "")) return EMPTY;
  const ct = headers.get("content-type") ?? "text/plain";
  const [type, subtype = ""] = (ct.split(";")[0] ?? "").trim().toLowerCase().split("/");
  const p = params(ct);
  if (type === "multipart") return p.boundary ? extractMultipart(subtype, body, p.boundary, ctx) : EMPTY;
  if (type !== "text" || (subtype !== "plain" && subtype !== "html")) return EMPTY;
  const text = decodeBody(headers, body, p.charset ?? "utf-8");
  return subtype === "html" ? { kind: "html", text: htmlToText(text, HTML_OPTIONS) } : { kind: "plain", text };
}

function summarize(headers: Map<string, string>): Omit<ParsedMessage, "text" | "truncated"> {
  return {
    messageId: parseIds(headers.get("message-id"))[0] ?? null,
    references: parseIds(headers.get("references")),
    inReplyTo: parseIds(headers.get("in-reply-to"))[0] ?? null,
    subject: headerText(headers.get("subject")),
    from: parseAddresses(headers.get("from"))[0] ?? null,
    to: parseAddresses(headers.get("to")).map((a) => a.address),
    date: parseDate(headers.get("date")),
    listUnsubscribe: headerText(headers.get("list-unsubscribe")) || null,
    listId: headerText(headers.get("list-id")) || null,
  };
}

/** Parse one raw RFC 5322 message (possibly cut by a partial fetch). Never throws on odd input. */
export function parseMessage(raw: Buffer, opts: { maxTextChars: number }): ParsedMessage {
  const latin = raw.toString("latin1");
  const ctx: Ctx = { truncated: false };
  let text = extract(latin, ctx).text;
  if (text.length > opts.maxTextChars) { text = text.slice(0, opts.maxTextChars); ctx.truncated = true; }
  return { ...summarize(parseHeaders(splitEntity(latin).head)), text, truncated: ctx.truncated };
}

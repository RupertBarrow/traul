/** Charsets and RFC 2047 encoded words. Pure functions; nothing here throws. */

// The eight code points where ISO-8859-15 differs from ISO-8859-1.
const LATIN9: Record<string, string> = {
  "¤": "€", "¦": "Š", "¨": "š", "´": "Ž",
  "¸": "ž", "¼": "Œ", "½": "œ", "¾": "Ÿ",
};

function label(charset: string): string {
  const c = charset.trim().toLowerCase().replace(/^"|"$/g, "");
  if (/^(iso[-_]?8859[-_]?(1|15)|latin[-_]?(1|9)|l1|l9)$/.test(c)) return "windows-1252";
  return c || "utf-8";
}

/** Decode bytes in a named charset; an unknown name falls back to UTF-8. */
export function decodeCharset(charset: string, bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder(label(charset)).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  if (/^(iso[-_]?8859[-_]?15|latin[-_]?9|l9)$/i.test(charset.trim())) {
    text = text.replace(/[¤¦¨´¸¼½¾]/g, (c) => LATIN9[c]);
  }
  return text;
}

export function qpToBytes(input: string, underscoreIsSpace = false): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "=") {
      out.push(underscoreIsSpace && ch === "_" ? 32 : input.charCodeAt(i) & 0xff);
      i++;
      continue;
    }
    const next = input.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(next)) { out.push(parseInt(next, 16)); i += 3; }
    else if (/^\r?\n/.test(next)) i += next[0] === "\r" ? 3 : 2; // soft line break
    else if (i + 3 > input.length) break; // escape cut short by a partial fetch
    else { out.push(61); i++; }
  }
  return Buffer.from(out);
}

const WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

interface Piece { charset: string; bytes: Buffer }

function wordBytes(enc: string, data: string): Buffer | null {
  if (enc.toUpperCase() === "B") return /^[A-Za-z0-9+/]*={0,2}$/.test(data) ? Buffer.from(data, "base64") : null;
  return /^[\x21-\x7e]*$/.test(data) ? qpToBytes(data, true) : null;
}

/** Decode runs of adjacent words of one charset together, so a character split across words survives. */
function decodePieces(pieces: Piece[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < pieces.length) {
    const charset = pieces[i].charset;
    const parts: Buffer[] = [];
    while (i < pieces.length && pieces[i].charset === charset) parts.push(pieces[i++].bytes);
    out.push(decodeCharset(charset.replace(/\*.*$/, ""), Buffer.concat(parts)));
  }
  return out.join("");
}

/** Decode `=?charset?B|Q?text?=` words. Whitespace between adjacent words is dropped. */
export function decodeMimeWords(text: string): string {
  const out: string[] = [];
  let pending: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD)) {
    const bytes = wordBytes(m[2], m[3]);
    if (bytes === null) continue;
    const gap = text.slice(last, m.index);
    if (!pending.length || gap.trim() !== "") { out.push(decodePieces(pending), gap); pending = []; }
    pending.push({ charset: m[1], bytes });
    last = m.index! + m[0].length;
  }
  out.push(decodePieces(pending), text.slice(last));
  return out.join("");
}

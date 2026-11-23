import type { MessageRow } from "../db/database";

/** The `--envelope` output of `traul search` (docs/triage-fork/CONTRACT.md). */

export type VectorState = "ok" | "unavailable" | "model_missing";
export const SNIPPET_MAX = 240;

/** At most SNIPPET_MAX characters of the text, whitespace collapsed, cut on a code point. */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > SNIPPET_MAX ? chars.slice(0, SNIPPET_MAX - 1).join("") + "…" : flat;
}

export function envelopeOf(vector: VectorState, rows: MessageRow[], withContent: boolean): { vector: VectorState; results: object[] } {
  const results = rows.map((m) => ({
    id: m.id,
    source: m.source,
    source_id: m.source_id,
    sent_at: new Date(m.sent_at * 1000).toISOString(),
    author: m.author_name,
    channel: m.channel_name,
    snippet: snippetOf(m.content),
    rank: m.rank ?? null,
    ...(withContent ? { content: m.content } : {}),
  }));
  return { vector, results };
}

/** Read the query from stdin so that it never appears in a process list. */
export async function readQueryStdin(): Promise<string> {
  return (await Bun.stdin.text()).trim();
}

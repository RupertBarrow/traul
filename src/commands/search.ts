import type { TraulDB, MessageRow } from "../db/database";
import { OllamaError } from "../lib/ollama";
import { envelopeOf, readQueryStdin, type VectorState } from "./search-envelope";
import { formatMessage, writeJSON } from "../lib/formatter";
import { embedQuery, vecToBytes } from "../lib/embeddings";

export interface SearchOptions {
  source?: string;
  channel?: string;
  after?: string;
  before?: string;
  limit?: string;
  json?: boolean;
  fts?: boolean;
  or?: boolean;
  like?: boolean;
  envelope?: boolean;
  queryStdin?: boolean;
  content?: boolean;
}

/** Free text is not FTS syntax: with --envelope every word is quoted. */
function quoteWords(q: string, joiner: string): string {
  return q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(joiner);
}

type Found = { rows: MessageRow[]; vector: VectorState };

async function findRows(db: TraulDB, query: string, options: SearchOptions): Promise<Found> {
  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const after = options.after
    ? Math.floor(new Date(options.after).getTime() / 1000)
    : undefined;
  const before = options.before
    ? Math.floor(new Date(options.before).getTime() / 1000)
    : undefined;

  const searchOpts = {
    source: options.source,
    channel: options.channel,
    after,
    before,
    limit,
  };

  // Build FTS query: join terms with OR when --or flag is set
  const joiner = options.or ? " OR " : " ";
  const ftsQuery = options.envelope
    ? quoteWords(query, joiner)
    : options.or ? query.split(/\s+/).filter(Boolean).join(" OR ") : query;

  let results: MessageRow[];
  let vector: VectorState = "unavailable";
  if (options.like) {
    results = db.likeSearchAll(query, searchOpts);
  } else if (options.fts) {
    results = db.ftsSearchAll(ftsQuery, searchOpts);
  } else {
    try {
      const vec = await embedQuery(query);
      results = db.hybridSearchAll(vecToBytes(vec), ftsQuery, searchOpts);
      vector = "ok";
      const { total_messages, embedded_messages } = db.getEmbeddingStats();
      const pct = total_messages > 0 ? Math.round((embedded_messages / total_messages) * 100) : 0;
      if (pct < 100) {
        console.warn(`search: hybrid mode — ${pct}% vector, ${100 - pct}% FTS`);
      }
    } catch (err) {
      if (err instanceof OllamaError && err.code === "model_missing") vector = "model_missing";
      console.warn("search: embedding unavailable, falling back to FTS-only");
      results = db.ftsSearchAll(ftsQuery, searchOpts);
    }
  }

  return { rows: results, vector };
}

export async function runSearch(db: TraulDB, queryArg: string | undefined, options: SearchOptions): Promise<void> {
  const query = options.queryStdin ? await readQueryStdin() : (queryArg ?? "");
  if (options.envelope && !query) {
    process.stdout.write(JSON.stringify(envelopeOf("unavailable", [], false)) + "\n");
    return;
  }
  const { rows: results, vector } = await findRows(db, query, options);
  if (options.envelope) {
    process.stdout.write(JSON.stringify(envelopeOf(vector, results, !!options.content)) + "\n");
    return;
  }
  if (results.length === 0) {
    if (options.json) {
      console.log("[]");
    } else {
      console.log("No results found.");
    }
    return;
  }

  if (options.json) {
    const jsonData = results.map((msg) => ({
      sent_at: new Date(msg.sent_at * 1000).toISOString(),
      author: msg.author_name,
      content: msg.content,
      channel: msg.channel_name,
      source: msg.source,
      ...(msg.thread_id ? { thread_id: msg.thread_id } : {}),
      ...(msg.rank != null ? { rank: msg.rank } : {}),
    }));
    await writeJSON(jsonData);
  } else {
    for (const msg of results) {
      console.log(formatMessage(msg));
    }
  }
}

import type { Llama, LlamaModel, LlamaEmbeddingContext } from "node-llama-cpp";
import { homeDir } from "./paths";
import { getEmbedSettings } from "./embed-config";
import { formatQuery, formatDoc } from "./llama-format";
export { isQwenEmbeddingModel, formatQuery, formatDoc } from "./llama-format";

// --- Singleton model wrapper ---

// Duplicated from embeddings.ts to avoid circular import
const MAX_TEXT_LENGTH = 4000;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** The model URI, from the configuration (TRAUL_EMBED_MODEL, embeddings.model). */
const llamaModel = (): string => getEmbedSettings().model;

// --- Singleton state ---
let llama: Llama | null = null;
let model: LlamaModel | null = null;
let ctx: LlamaEmbeddingContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Reset singleton for testing. */
export function _resetForTesting(): void {
  llama = null;
  model = null;
  ctx = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (ctx) { ctx.dispose(); ctx = null; }
    if (model) { await model.dispose(); model = null; }
  }, IDLE_TIMEOUT_MS);
  if (idleTimer && typeof idleTimer === "object" && "unref" in idleTimer) {
    (idleTimer as NodeJS.Timeout).unref();
  }
}

async function getContext(): Promise<LlamaEmbeddingContext> {
  if (ctx) {
    resetIdleTimer();
    return ctx;
  }

  // Dynamic, so a compiled executable that never uses llama never resolves the package.
  const { getLlama, LlamaLogLevel, resolveModelFile } = await import("node-llama-cpp");
  if (!llama) {
    llama = await getLlama({ logLevel: LlamaLogLevel.error });
  }

  if (!model) {
    const modelPath = await resolveModelFile(llamaModel(), {
      directory: `${homeDir()}/.cache/traul/models`,
      onProgress: ({ totalSize, downloadedSize }) => {
        const pct = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
        process.stderr.write(`\rDownloading model: ${pct}%`);
      },
    });
    model = await llama.loadModel({ modelPath });
  }

  ctx = await model.createEmbeddingContext();
  resetIdleTimer();
  return ctx;
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

const TRUNCATE_LIMITS = [2000, 1000];

async function embedSingle(embCtx: LlamaEmbeddingContext, text: string): Promise<Float32Array> {
  try {
    const { vector } = await embCtx.getEmbeddingFor(truncate(text));
    return new Float32Array(vector);
  } catch (err) {
    // Only retry with progressive truncation if the text is long enough to benefit
    for (const limit of TRUNCATE_LIMITS) {
      if (text.length <= limit) {
        // Text is already short — retrying won't help, rethrow original error
        throw err;
      }
      try {
        const { vector } = await embCtx.getEmbeddingFor(text.slice(0, limit));
        return new Float32Array(vector);
      } catch {
        continue;
      }
    }
    throw new Error(`Text too long to embed even at ${TRUNCATE_LIMITS.at(-1)} chars`);
  }
}

export async function embedDoc(text: string): Promise<Float32Array> {
  const embCtx = await getContext();
  return embedSingle(embCtx, formatDoc(text));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const embCtx = await getContext();
  return embedSingle(embCtx, formatQuery(text, llamaModel()));
}

export async function embedDocBatch(
  texts: string[],
  onSkip?: (index: number, error: string) => void,
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  const embCtx = await getContext();
  const results: (Float32Array | null)[] = [];

  for (let i = 0; i < texts.length; i++) {
    try {
      results.push(await embedSingle(embCtx, formatDoc(texts[i])));
    } catch (err) {
      onSkip?.(i, err instanceof Error ? err.message : String(err));
      results.push(null);
    }
  }

  return results;
}

export async function dispose(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (ctx) { ctx.dispose(); ctx = null; }
  if (model) { await model.dispose(); model = null; }
}

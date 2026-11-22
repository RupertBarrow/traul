import { getEmbedSettings } from "./embed-config";
import { postEmbed } from "./ollama";
import { formatQuery, formatDoc } from "./llama-format";

export const BATCH_SIZE = 50;
export const MAX_TEXT_LENGTH = 4000;
const TRUNCATE_LIMITS = [2000, 1000];

/** node-llama-cpp is loaded only when the backend is `llama`. */
async function llama(): Promise<typeof import("./llama")> {
  return import("./llama");
}

const useLlama = (): boolean => getEmbedSettings().backend === "llama";

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

function isContextOverflow(error: string): boolean {
  return error.includes("input length exceeds") || error.includes("context length");
}

// --- Ollama HTTP backend ---

async function ollamaEmbed(text: string): Promise<Float32Array> {
  const input = truncate(text);
  let result = await postEmbed(getEmbedSettings(), [input]);
  for (const limit of TRUNCATE_LIMITS) {
    if (result.ok || !isContextOverflow(result.error)) break;
    result = await postEmbed(getEmbedSettings(), [input.slice(0, limit)]);
  }
  if (result.ok) return new Float32Array(result.embeddings[0]);
  if (isContextOverflow(result.error)) {
    throw new Error(`Message too long to embed even at ${TRUNCATE_LIMITS.at(-1)} chars`);
  }
  throw new Error(`Ollama embedding failed: ${result.error}`);
}

type OnSkip = (index: number, error: string) => void;

async function ollamaOneByOne(batch: string[], offset: number, onSkip?: OnSkip): Promise<(Float32Array | null)[]> {
  const out: (Float32Array | null)[] = [];
  for (let j = 0; j < batch.length; j++) {
    const single = await postEmbed(getEmbedSettings(), [batch[j].slice(0, TRUNCATE_LIMITS[0])]);
    if (single.ok) out.push(new Float32Array(single.embeddings[0]));
    else {
      onSkip?.(offset + j, single.error);
      out.push(null);
    }
  }
  return out;
}

async function ollamaEmbedBatch(texts: string[], onSkip?: OnSkip): Promise<(Float32Array | null)[]> {
  const results: (Float32Array | null)[] = [];
  const truncated = texts.map(truncate);
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const result = await postEmbed(getEmbedSettings(), batch);
    if (result.ok) results.push(...result.embeddings.map((e) => new Float32Array(e)));
    else if (isContextOverflow(result.error)) results.push(...(await ollamaOneByOne(batch, i, onSkip)));
    else {
      batch.forEach((_, j) => onSkip?.(i + j, result.error));
      results.push(...batch.map(() => null));
    }
  }
  return results;
}

// --- Public API ---

export async function embed(text: string): Promise<Float32Array> {
  if (useLlama()) return (await llama()).embedDoc(truncate(text));
  return ollamaEmbed(formatDoc(text));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  if (useLlama()) return (await llama()).embedQuery(truncate(text));
  return ollamaEmbed(formatQuery(truncate(text), getEmbedSettings().model));
}

export async function embedBatch(texts: string[], onSkip?: OnSkip): Promise<(Float32Array | null)[]> {
  if (useLlama()) return (await llama()).embedDocBatch(texts.map(truncate), onSkip);
  return ollamaEmbedBatch(texts.map(formatDoc), onSkip);
}

export function vecToBytes(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer);
}

import { loadConfig, type EmbeddingsConfig } from "./config";

export const DEFAULT_OLLAMA_MODEL = "qwen3-embedding:0.6b";
export const DEFAULT_LLAMA_MODEL = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

export interface EmbedSettings extends Omit<EmbeddingsConfig, "backend"> {
  backend: "ollama" | "llama";
}

type Env = Record<string, string | undefined>;

function positiveInt(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Settings from the config file section and the environment
 * (TRAUL_OLLAMA_URL, OLLAMA_URL, TRAUL_EMBED_MODEL, TRAUL_EMBED_DIMS).
 * allow_remote is read from the file only.
 */
export function resolveEmbedSettings(file: Partial<EmbeddingsConfig>, env: Env): EmbedSettings {
  const backend = file.backend === "llama" ? "llama" : "ollama";
  const fallbackModel = backend === "llama" ? DEFAULT_LLAMA_MODEL : DEFAULT_OLLAMA_MODEL;
  return {
    backend,
    url: env.TRAUL_OLLAMA_URL || env.OLLAMA_URL || file.url || "http://127.0.0.1:11434",
    model: env.TRAUL_EMBED_MODEL || file.model || fallbackModel,
    dims: positiveInt(env.TRAUL_EMBED_DIMS) ?? positiveInt(file.dims) ?? 1024,
    keep_alive: file.keep_alive || "60s",
    timeout_ms: positiveInt(file.timeout_ms) ?? 30000,
    allow_remote: file.allow_remote === true,
  };
}

let _settings: EmbedSettings | null = null;

/** Resolved once, on first use, from the config file and the environment. */
export function getEmbedSettings(): EmbedSettings {
  _settings ??= resolveEmbedSettings(loadConfig().embeddings, process.env);
  return _settings;
}

/** Replace (or, with null, forget) the resolved settings. For tests. */
export function _setEmbedSettings(s: EmbedSettings | null): void {
  _settings = s;
}

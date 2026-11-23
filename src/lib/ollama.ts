import type { EmbedSettings } from "./embed-config";

export type OllamaFailure = "ollama_down" | "model_missing" | "dims_mismatch" | "ollama_remote";

/** A named state of the Ollama backend; nothing is stored when one is thrown. */
export class OllamaError extends Error {
  constructor(public code: OllamaFailure, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OllamaError";
  }
}

export type EmbedResult = { ok: true; embeddings: number[][] } | { ok: false; error: string };

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** localhost, 127.0.0.0/8 or ::1 only. */
export function isLoopbackUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]") return true;
  const m = IPV4_LOOPBACK.exec(host);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

function isModelMissing(status: number, error: string): boolean {
  return status === 404 || /model\b.*not found|not found.*model/i.test(error);
}

async function send(s: EmbedSettings, texts: string[]): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), s.timeout_ms);
  try {
    return await fetch(`${s.url.replace(/\/+$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: s.model, input: texts, truncate: true, keep_alive: s.keep_alive }),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw new OllamaError("ollama_down");
  } finally {
    clearTimeout(timer);
  }
}

function checkVectors(s: EmbedSettings, vectors: number[][], expected: number): number[][] {
  if (vectors.length !== expected || vectors.some((v) => v.length !== s.dims)) {
    throw new OllamaError("dims_mismatch", `expected ${expected} vectors of ${s.dims}`);
  }
  return vectors;
}

/**
 * POST /api/embed. Named states throw an OllamaError; any other failure is
 * returned as a value so the caller can retry smaller or skip.
 */
export async function postEmbed(s: EmbedSettings, texts: string[]): Promise<EmbedResult> {
  if (!s.allow_remote && !isLoopbackUrl(s.url)) throw new OllamaError("ollama_remote");
  const res = await send(s, texts);
  const data = (await res.json().catch(() => ({}))) as { embeddings?: number[][]; error?: string };
  const error = data.error ?? `HTTP ${res.status}`;
  if (isModelMissing(res.status, data.error ?? "")) throw new OllamaError("model_missing");
  if (!data.embeddings) return { ok: false, error };
  return { ok: true, embeddings: checkVectors(s, data.embeddings, texts.length) };
}

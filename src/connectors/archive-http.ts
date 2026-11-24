import { Agent, request, type IncomingMessage } from "node:http";

/**
 * One GET to the archive reader: node:http with its own Agent (no proxy from the environment), no redirect followed,
 * a total timeout, a 1 MiB cap. It never throws and never logs; a result never carries the token.
 */
export const MAX_ANSWER_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;
const agent = new Agent({ keepAlive: false, maxSockets: 1 });

export type HttpFailure = "unreachable" | "timeout" | "too_large" | "redirect" | "http_error";
export type HttpResult = { kind: "ok"; body: string } | { kind: "failed"; code: HttpFailure };

function collect(res: IncomingMessage, done: (r: HttpResult) => void): void {
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) return done({ kind: "failed", code: "redirect" });
  if (status !== 200) return done({ kind: "failed", code: "http_error" });
  const chunks: Buffer[] = [];
  let size = 0;
  res.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_ANSWER_BYTES) done({ kind: "failed", code: "too_large" });
    else chunks.push(c);
  });
  res.on("end", () => done({ kind: "ok", body: Buffer.concat(chunks).toString("utf-8") }));
  res.on("error", () => done({ kind: "failed", code: "unreachable" }));
}

export function getJson(url: URL, headers: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HttpResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: HttpResult) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); resolve(r); };
    const req = request(url, { method: "GET", agent, headers: { accept: "application/json", ...headers } }, (res) => collect(res, done));
    const timer = setTimeout(() => done({ kind: "failed", code: "timeout" }), timeoutMs);
    req.on("error", () => done({ kind: "failed", code: "unreachable" }));
    req.end();
  });
}

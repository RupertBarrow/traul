import { isAbsolute } from "node:path";
import { isLoopbackHost } from "./imap/protocol";

/**
 * The `archive` section: Archibald's intakes, read from a local archive reader. Off while `items_url` is empty.
 * The reader's route and token header are the owner's settings, not constants of this public repository.
 * Messages name the setting, never a value.
 */
export interface ArchiveConfig {
  items_url: string;
  token_file: string;
  token_header: string;
}

export function defaultArchiveConfig(): ArchiveConfig {
  return { items_url: "", token_file: "", token_header: "" };
}

/** An http URL on a loopback host, with no credentials and no fragment. */
export function loopbackHttpUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" || url.username || url.password || url.hash || raw.includes("#")) return null;
  return isLoopbackHost(url.hostname.replace(/^\[|\]$/g, "")) ? url : null;
}

export function validateArchiveConfig(cfg: ArchiveConfig): string[] {
  if (!cfg.items_url) return [];
  const out: string[] = [];
  if (!loopbackHttpUrl(cfg.items_url)) out.push("items_url must be an http URL on a loopback host");
  if (!cfg.token_file || !isAbsolute(cfg.token_file)) out.push("token_file must be an absolute path");
  if (!/^[A-Za-z0-9-]+$/.test(cfg.token_header ?? "")) out.push("token_header must match [A-Za-z0-9-]+");
  return out;
}

import type { ImapAccount, ImapConfig } from "./config";
import { isLoopbackHost } from "./imap/protocol";

/** Validation of the `imap` section. Messages name the setting, never a value (a host or user stays out of logs). */

export class ImapConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid imap configuration: ${problems.join("; ")}`);
    this.name = "ImapConfigError";
  }
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const TLS_MODES = ["implicit", "starttls", "plain"];
const isCount = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;

function accountProblems(a: ImapAccount, i: number): string[] {
  const at = `accounts[${i}]`;
  const out: string[] = [];
  if (!NAME_RE.test(String(a.name ?? ""))) out.push(`${at}.name must match [A-Za-z0-9._-]+`);
  if (!NAME_RE.test(String(a.password_secret ?? ""))) out.push(`${at}.password_secret must match [A-Za-z0-9._-]+`);
  if (!a.host || typeof a.host !== "string") out.push(`${at}.host is required`);
  if (!a.user || typeof a.user !== "string") out.push(`${at}.user is required`);
  if (a.port !== undefined && !(Number.isInteger(a.port) && a.port > 0 && a.port < 65536)) out.push(`${at}.port is out of range`);
  if (a.tls !== undefined && !TLS_MODES.includes(a.tls)) out.push(`${at}.tls must be implicit, starttls or plain`);
  if (a.tls === "plain" && !isLoopbackHost(String(a.host ?? ""))) out.push(`${at}: plain_remote (plain is for a loopback host only)`);
  if (a.folders !== undefined && !(Array.isArray(a.folders) && a.folders.every((f) => typeof f === "string" && f))) {
    out.push(`${at}.folders must be a list of names or patterns`);
  }
  return out;
}

export function validateImapConfig(cfg: ImapConfig): string[] {
  const out: string[] = [];
  for (const k of ["max_body_bytes", "max_text_chars", "max_messages_per_run", "max_run_seconds", "backfill_per_run"] as const) {
    if (!isCount(cfg[k])) out.push(`${k} must be a positive integer`);
  }
  if (!Array.isArray(cfg.accounts)) return [...out, "accounts must be a list"];
  const seen = new Set<string>();
  cfg.accounts.forEach((a, i) => {
    out.push(...accountProblems(a, i));
    if (seen.has(a.name)) out.push(`accounts[${i}].name is a duplicate`);
    seen.add(a.name);
  });
  return out;
}

export function assertImapConfig(cfg: ImapConfig): void {
  const problems = validateImapConfig(cfg);
  if (problems.length) throw new ImapConfigError(problems);
}

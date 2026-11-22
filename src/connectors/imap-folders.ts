import type { FolderInfo, Session } from "../lib/imap/session";

/** Folder names and patterns (`*`, `?`, and `/` as the separator whatever the server uses). */

const hasWildcard = (p: string) => /[*?]/.test(p);

function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

const normalized = (f: FolderInfo) => (f.delimiter && f.delimiter !== "/" ? f.name.split(f.delimiter).join("/") : f.name);

/** The server's own names for what the patterns select, in pattern order, without duplicates. */
export function matchFolders(patterns: string[], listed: FolderInfo[]): string[] {
  const out: string[] = [];
  const add = (n: string) => { if (!out.includes(n)) out.push(n); };
  for (const p of patterns) {
    if (hasWildcard(p)) {
      const re = globToRegExp(p);
      listed.filter((f) => re.test(normalized(f))).forEach((f) => add(f.name));
    } else {
      add(listed.find((f) => normalized(f) === p)?.name ?? p);
    }
  }
  return out;
}

/** Ask the server only when a pattern or a separator needs it. */
export async function resolveFolders(session: Session, patterns: string[] | undefined): Promise<string[]> {
  const wanted = patterns?.length ? patterns : ["INBOX"];
  if (!wanted.some((p) => hasWildcard(p) || p.includes("/"))) return wanted;
  return matchFolders(wanted, await session.list());
}

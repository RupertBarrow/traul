import { chmodSync, existsSync, mkdirSync, closeSync, openSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** The only place that reads the user's home directory. */

const HOMEBREW_SQLITE = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
];

export function homeDir(): string {
  return homedir();
}

/** Folder holding the database, the pid file and the log. */
export function traulHome(): string {
  return process.env.TRAUL_HOME || join(homeDir(), ".local", "share", "traul");
}

export function configPath(): string {
  return process.env.TRAUL_CONFIG_PATH || join(homeDir(), ".config", "traul", "config.json");
}

export function dbPath(): string {
  return process.env.TRAUL_DB_PATH || join(traulHome(), "traul.db");
}

export function pidPath(): string {
  return join(traulHome(), "daemon.pid");
}

export function logPath(): string {
  return join(traulHome(), "daemon.log");
}

/** Create a folder (and parents) owner-only when it does not exist. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Make sure the database file exists and is readable by its owner only. */
export function secureDbFile(path: string): void {
  if (path === ":memory:" || path === "") return;
  try {
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  } catch {
    // Not fatal: SQLite reports the real error when it opens the file.
  }
}

type Env = Record<string, string | undefined>;

/** The SQLite library to load for extension support, or null for the system one. */
export function resolveSqliteLib(
  env: Env,
  platform: string,
  exists: (p: string) => boolean,
): string | null {
  if (env.TRAUL_SQLITE_LIB) return env.TRAUL_SQLITE_LIB;
  if (platform !== "darwin") return null;
  return HOMEBREW_SQLITE.find(exists) ?? null;
}

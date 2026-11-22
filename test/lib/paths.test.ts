import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, statSync, existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  traulHome, configPath, dbPath, pidPath, logPath, ensureDir, secureDbFile, resolveSqliteLib,
} from "../../src/lib/paths";

const KEYS = ["TRAUL_HOME", "TRAUL_CONFIG_PATH", "TRAUL_DB_PATH"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "traul-paths-"));
}

describe("paths from the environment", () => {
  it("TRAUL_HOME holds the database, pid file and log", () => {
    process.env.TRAUL_HOME = "/x/home";
    delete process.env.TRAUL_DB_PATH;
    expect(traulHome()).toBe("/x/home");
    expect(dbPath()).toBe("/x/home/traul.db");
    expect(pidPath()).toBe("/x/home/daemon.pid");
    expect(logPath()).toBe("/x/home/daemon.log");
  });

  it("TRAUL_DB_PATH and TRAUL_CONFIG_PATH override single files", () => {
    process.env.TRAUL_HOME = "/x/home";
    process.env.TRAUL_DB_PATH = "/y/other.db";
    process.env.TRAUL_CONFIG_PATH = "/y/conf.json";
    expect(dbPath()).toBe("/y/other.db");
    expect(configPath()).toBe("/y/conf.json");
    expect(pidPath()).toBe("/x/home/daemon.pid");
  });

  it("defaults sit under the user's home", () => {
    delete process.env.TRAUL_HOME;
    delete process.env.TRAUL_CONFIG_PATH;
    expect(traulHome().endsWith(join(".local", "share", "traul"))).toBe(true);
    expect(configPath().endsWith(join(".config", "traul", "config.json"))).toBe(true);
  });
});

describe("file modes", () => {
  it("creates the folder 0700 and the database file 0600", () => {
    const root = tmp();
    const dir = join(root, "a", "b");
    ensureDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, "t.db");
    secureDbFile(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(root, { recursive: true });
  });

  it("tightens an existing database file and leaves :memory: alone", () => {
    const root = tmp();
    const file = join(root, "t.db");
    secureDbFile(file);
    Bun.spawnSync(["chmod", "644", file]);
    secureDbFile(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    secureDbFile(":memory:");
    expect(existsSync(":memory:")).toBe(false);
    rmSync(root, { recursive: true });
  });
});

describe("SQLite library choice", () => {
  const none = () => false;
  it("TRAUL_SQLITE_LIB wins", () => {
    expect(resolveSqliteLib({ TRAUL_SQLITE_LIB: "/l/x.dylib" }, "darwin", none)).toBe("/l/x.dylib");
    expect(resolveSqliteLib({ TRAUL_SQLITE_LIB: "/l/x.so" }, "linux", none)).toBe("/l/x.so");
  });
  it("on darwin picks the first Homebrew path that exists", () => {
    const arm = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    const intel = "/usr/local/opt/sqlite/lib/libsqlite3.dylib";
    expect(resolveSqliteLib({}, "darwin", (p) => p === intel)).toBe(intel);
    expect(resolveSqliteLib({}, "darwin", () => true)).toBe(arm);
    expect(resolveSqliteLib({}, "darwin", none)).toBeNull();
  });
  it("is null elsewhere when unset", () => {
    expect(resolveSqliteLib({}, "linux", () => true)).toBeNull();
  });
});

describe("no homedir() outside paths.ts", () => {
  it("reads the home directory in paths.ts only", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
      );
    const root = join(import.meta.dir, "../../src");
    const offenders = walk(root).filter(
      (f) => !f.endsWith(join("lib", "paths.ts")) && /\bhomedir\b|process\.env\.HOME\b/.test(readFileSync(f, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });
});

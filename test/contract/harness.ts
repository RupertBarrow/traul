import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLoadablePath } from "sqlite-vec";

/** Builds the Triage executable once (scripts/build-triage.sh) and runs it as a child process, as the Triage app does. */

export const supported = process.platform === "linux" && process.arch === "x64";
const root = join(import.meta.dir, "../..");
let built: Promise<string> | null = null;

export function buildExe(): Promise<string> {
  built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "traul-contract-build-"));
    const p = Bun.spawn(["bash", join(root, "scripts/build-triage.sh"), dir], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, TRAUL_BUILD_TARGETS: "bun-linux-x64:traul-linux-x64", TRAUL_BUILD_COMMIT: "testcommit" },
    });
    if ((await p.exited) !== 0) throw new Error("build failed: " + (await new Response(p.stderr).text()));
    return join(dir, "traul-linux-x64");
  })();
  return built;
}

export interface Run { code: number; out: string; err: string; json: any }

export interface Sandbox {
  home: string;
  /** Write the config file (merged over nothing: the executable's defaults apply to the rest). */
  config(c: object): void;
  run(args: string[], opts?: { stdin?: string; env?: Record<string, string> }): Promise<Run>;
  hasDb(): boolean;
}

export function sandbox(exe: string): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "traul-contract-"));
  const cfg = join(home, "config.json");
  const base = { TRAUL_HOME: home, TRAUL_CONFIG_PATH: cfg, TRAUL_SQLITE_VEC: getLoadablePath(), PATH: "/usr/bin:/bin", IMAP_PASSWORD_A: "pass" };
  return {
    home,
    config: (c) => writeFileSync(cfg, JSON.stringify(c)),
    hasDb: () => existsSync(join(home, "traul.db")),
    async run(args, opts = {}) {
      const p = Bun.spawn([exe, ...args], {
        cwd: home, env: { ...base, ...opts.env }, stdout: "pipe", stderr: "pipe",
        stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
      });
      const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
      let json: unknown = null;
      try { json = JSON.parse(out); } catch { /* stays null: the test says so */ }
      return { code, out, err, json };
    },
  };
}

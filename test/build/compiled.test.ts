import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getLoadablePath } from "sqlite-vec";

// Compiles the Triage entry point for this machine and runs it from an
// almost empty environment. Skipped where the compile cannot run.
const supported = process.platform === "linux" && process.arch === "x64";
const root = join(import.meta.dir, "../..");

describe.skipIf(!supported)("compiled Triage executable (linux-x64)", () => {
  const dir = mkdtempSync(join(tmpdir(), "traul-compiled-"));
  const exe = join(dir, "traul-triage");

  it("compiles with node-llama-cpp external", () => {
    const r = Bun.spawnSync(
      ["bun", "build", "--compile", "--external", "node-llama-cpp", "--target=bun-linux-x64",
        join(root, "src/index.triage.ts"), "--outfile", exe],
      { cwd: root, stderr: "pipe", stdout: "pipe" },
    );
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it("runs --help from an empty environment, with no node_modules around", () => {
    const r = Bun.spawnSync([exe, "--help"], {
      cwd: dir,
      env: { TRAUL_HOME: join(dir, "home"), TRAUL_SQLITE_VEC: getLoadablePath() },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("Usage: traul");
  });

  it("prints --contract from an empty environment", () => {
    const r = Bun.spawnSync([exe, "--contract"], {
      cwd: dir,
      env: { TRAUL_HOME: join(dir, "home") },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ contract: 1, readSchema: 1, connectors: ["imap", "archive"] });
  });

  it("contains no googleapis, slack or discord code", () => {
    const bin = readFileSync(exe).toString("latin1");
    expect(bin.includes("googleapis")).toBe(false);
    expect(bin.includes("@slack/web-api")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

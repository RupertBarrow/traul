import { spawn } from "node:child_process";

/** Secrets are looked up by NAME: environment first, then the macOS Keychain. */

export const SECURITY_BIN = "/usr/bin/security";
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export type SecretSource = "env" | "keychain";
export type SecretResult =
  | { ok: true; source: SecretSource; value: string }
  | { ok: false; code: "no_secret" };

export interface SecretOptions {
  /** Keychain service; empty disables the Keychain. */
  keychainService?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Tests inject a fake `security`; production uses the system one. */
  securityBin?: string;
  timeoutMs?: number;
}

const NONE: SecretResult = { ok: false, code: "no_secret" };

/** The value is not enumerable: JSON.stringify and util.inspect never show it. */
function found(source: SecretSource, value: string): SecretResult {
  const r = { ok: true as const, source } as SecretResult;
  Object.defineProperty(r, "value", { value, enumerable: false });
  return r;
}

function readKeychain(bin: string, service: string, name: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(bin, ["find-generic-password", "-s", service, "-a", name, "-w"], {
        shell: false, stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf-8"); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.replace(/\r?\n$/, "") : null);
    });
  });
}

export async function resolveSecret(name: string, opts: SecretOptions = {}): Promise<SecretResult> {
  if (!NAME_RE.test(name)) return NONE;
  const fromEnv = (opts.env ?? process.env)[name];
  if (fromEnv) return found("env", fromEnv);
  const service = opts.keychainService ?? "";
  if (!service || (opts.platform ?? process.platform) !== "darwin") return NONE;
  const value = await readKeychain(opts.securityBin ?? SECURITY_BIN, service, name, opts.timeoutMs ?? 5000);
  return value ? found("keychain", value) : NONE;
}

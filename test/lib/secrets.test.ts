import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveSecret } from "../../src/lib/secrets";

const NAME = "IMAP_PASSWORD_TEST";
const VALUE = "s3cret-value-xyz";
let dir: string;

/** A fake `security` that records its arguments and behaves as told. */
function fakeSecurity(body: string): string {
  const path = join(dir, "security");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${dir}/args"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const base = (bin: string) => ({
  keychainService: "triage.test", platform: "darwin", securityBin: bin, env: {} as Record<string, string>,
});

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "traul-sec-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveSecret", () => {
  it("takes the environment variable of that name first", async () => {
    const bin = fakeSecurity(`echo from-keychain`);
    const r = await resolveSecret(NAME, { ...base(bin), env: { [NAME]: VALUE } });
    expect(r).toMatchObject({ ok: true, source: "env" });
    if (r.ok) expect(r.value).toBe(VALUE);
    expect(() => readFileSync(join(dir, "args"))).toThrow();
  });

  it("ignores an empty environment variable", async () => {
    const bin = fakeSecurity(`echo ${VALUE}`);
    const r = await resolveSecret(NAME, { ...base(bin), env: { [NAME]: "" } });
    expect(r.ok && r.source).toBe("keychain");
  });

  it("asks security for service and account, without a shell", async () => {
    const bin = fakeSecurity(`echo ${VALUE}`);
    const r = await resolveSecret(NAME, base(bin));
    expect(r.ok && r.value).toBe(VALUE);
    expect(readFileSync(join(dir, "args"), "utf-8").trim())
      .toBe(`find-generic-password -s triage.test -a ${NAME} -w`);
  });

  it("no_secret when the item is not found (exit 44)", async () => {
    const r = await resolveSecret(NAME, base(fakeSecurity(`exit 44`)));
    expect(r).toEqual({ ok: false, code: "no_secret" });
  });

  it("no_secret when the keychain is locked or the user denies", async () => {
    const r = await resolveSecret(NAME, base(fakeSecurity(`echo "denied" >&2; exit 51`)));
    expect(r).toEqual({ ok: false, code: "no_secret" });
  });

  it("no_secret on a timeout", async () => {
    const r = await resolveSecret(NAME, { ...base(fakeSecurity(`sleep 5`)), timeoutMs: 150 });
    expect(r).toEqual({ ok: false, code: "no_secret" });
  });

  it("no_secret without a keychain service, off macOS, or with a missing binary", async () => {
    const bin = fakeSecurity(`echo ${VALUE}`);
    expect(await resolveSecret(NAME, { ...base(bin), keychainService: "" })).toEqual({ ok: false, code: "no_secret" });
    expect(await resolveSecret(NAME, { ...base(bin), platform: "linux" })).toEqual({ ok: false, code: "no_secret" });
    expect(await resolveSecret(NAME, base(join(dir, "absent")))).toEqual({ ok: false, code: "no_secret" });
  });

  it("refuses a name outside [A-Za-z0-9._-]", async () => {
    const bin = fakeSecurity(`echo ${VALUE}`);
    for (const bad of ["", "a b", "a;b", "a/b"]) {
      expect(await resolveSecret(bad, base(bin))).toEqual({ ok: false, code: "no_secret" });
    }
  });

  it("never carries the value in its serialized form, and an empty output is no secret", async () => {
    const r = await resolveSecret(NAME, { ...base(fakeSecurity(`echo`)) });
    expect(r.ok).toBe(false);
    const ok = await resolveSecret(NAME, { ...base(fakeSecurity(`echo ${VALUE}`)) });
    expect(JSON.stringify(ok)).not.toContain(VALUE);
    expect(String(Object.values(ok))).not.toContain(VALUE);
  });

  it("logs nothing to stdout or stderr", async () => {
    const out: string[] = [];
    const o = console.log, e = console.error;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => out.push(a.join(" "));
    try {
      await resolveSecret(NAME, { ...base(fakeSecurity(`echo ${VALUE}`)) });
      await resolveSecret(NAME, { ...base(fakeSecurity(`exit 1`)) });
    } finally { console.log = o; console.error = e; }
    expect(out).toEqual([]);
  });
});

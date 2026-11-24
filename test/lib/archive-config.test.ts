import { describe, it, expect } from "bun:test";
import { defaultArchiveConfig, validateArchiveConfig } from "../../src/lib/archive-config";

const ok = { items_url: "http://127.0.0.1:4999/reader/home-1/items", token_file: "/tmp/token", token_header: "X-Reader-Token" };

describe("archive configuration", () => {
  it("is off by default and a default is valid", () => {
    expect(defaultArchiveConfig()).toEqual({ items_url: "", token_file: "", token_header: "" });
    expect(validateArchiveConfig(defaultArchiveConfig())).toEqual([]);
  });

  it("accepts a loopback http URL, an absolute token file and a header name", () => {
    expect(validateArchiveConfig(ok)).toEqual([]);
    expect(validateArchiveConfig({ ...ok, items_url: "http://[::1]:4999/x" })).toEqual([]);
    expect(validateArchiveConfig({ ...ok, items_url: "http://localhost:4999/x" })).toEqual([]);
  });

  it("refuses a remote host, https, credentials in the URL and a fragment", () => {
    for (const url of ["http://192.0.2.10/x", "http://archive.example.org/x", "https://127.0.0.1/x", "http://u:p@127.0.0.1/x", "http://127.0.0.1/x#f", "not a url"]) {
      expect(validateArchiveConfig({ ...ok, items_url: url })).toContain("items_url must be an http URL on a loopback host");
    }
  });

  it("needs an absolute token file and a header name when on, and never echoes a value", () => {
    const problems = validateArchiveConfig({ ...ok, token_file: "token", token_header: "bad header" });
    expect(problems).toEqual(["token_file must be an absolute path", "token_header must match [A-Za-z0-9-]+"]);
    expect(problems.join(" ")).not.toContain("bad header");
  });
});

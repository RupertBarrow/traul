import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  setConnectors, getConnectors, getConnector, getConnectorNames,
} from "../../src/connectors/registry";
import { allConnectors } from "../../src/connectors/all";
import { triageConnectors } from "../../src/connectors/triage";
import type { Connector } from "../../src/connectors/types";

const fake = (name: string): Connector => ({
  name,
  sync: async () => ({ messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 }),
});

const src = (rel: string) => readFileSync(join(import.meta.dir, "../../src", rel), "utf-8");

afterEach(() => setConnectors(allConnectors));

describe("registry", () => {
  it("holds exactly what setConnectors gave it", () => {
    setConnectors([fake("a"), fake("b")]);
    expect(getConnectorNames()).toEqual(["a", "b"]);
    expect(getConnector("b")?.name).toBe("b");
    expect(getConnector("slack")).toBeUndefined();
    setConnectors([]);
    expect(getConnectors()).toEqual([]);
  });

  it("does not list a directory or require a computed path", () => {
    const text = src("connectors/registry.ts");
    expect(text).not.toMatch(/readdirSync|require\(/);
  });
});

describe("entry points", () => {
  it("all.ts registers every built-in connector once", () => {
    const names = allConnectors.map((c) => c.name).sort();
    expect(names).toEqual(
      ["archive", "claudecode", "discord", "gmail", "imap", "linear", "markdown", "slack", "telegram", "whatsapp"],
    );
  });

  it("the Triage list holds imap and archive", () => {
    expect(triageConnectors.map((c) => c.name)).toEqual(["imap", "archive"]);
  });

  it("index.triage.ts registers the Triage list and pulls in no other connector, no whatsapp, no llama", () => {
    const text = src("index.triage.ts");
    expect(text).toContain("triageConnectors");
    expect(text).not.toMatch(/connectors\/all|whatsapp|slack|discord|gmail|linear|telegram|llama/i);
    const imports = src("cli.ts").split("\n").filter((l) => l.startsWith("import"));
    expect(imports.join("\n")).not.toMatch(/connectors\/(?!registry)|whatsapp|googleapis/i);
  });

  it("index.ts registers all connectors and the whatsapp command", () => {
    const text = src("index.ts");
    expect(text).toContain("allConnectors");
    expect(text).toMatch(/whatsapp/i);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraulDB } from "../../src/db/database";
import { syncSourceReport } from "../../src/commands/sync-source";
import { resolveSlackCredentials } from "../../src/lib/slack-secrets";
import { slackConnector } from "../../src/connectors/slack";

let dir: string;
let db: TraulDB;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "traul-sources-")); db = new TraulDB(":memory:"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.TEST_SLACK_TOKEN; delete process.env.TEST_SLACK_COOKIE; });

const slack = (over: Record<string, unknown> = {}) =>
  ({ token: "", cookie: "", my_user_id: "", channels: [], token_secret: "", cookie_secret: "", keychain_service: "", ...over });
const config = (over: Record<string, unknown> = {}) => ({ slack: slack(), markdown: { dirs: [] }, ...over }) as any;

describe("slack secrets by name", () => {
  it("fills the token and cookie from the named secrets, never logging them", async () => {
    process.env.TEST_SLACK_TOKEN = "xoxc-test"; process.env.TEST_SLACK_COOKIE = "cookie-test";
    const c = config({ slack: slack({ token_secret: "TEST_SLACK_TOKEN", cookie_secret: "TEST_SLACK_COOKIE" }) });
    expect(await resolveSlackCredentials(c)).toBe("env");
    expect(c.slack.token).toBe("xoxc-test");
    expect(c.slack.cookie).toBe("cookie-test");
  });

  it("keeps a token already given, and is none when nothing resolves", async () => {
    const given = config({ slack: slack({ token: "xoxb-given", token_secret: "TEST_SLACK_TOKEN" }) });
    expect(await resolveSlackCredentials(given)).toBe("config");
    expect(given.slack.token).toBe("xoxb-given");
    const none = config({ slack: slack({ token_secret: "TEST_SLACK_TOKEN" }) });
    expect(await resolveSlackCredentials(none)).toBe("none");
    expect(none.slack.token).toBe("");
  });

  it("has credentials when a token or a token secret name is set", () => {
    expect(slackConnector.hasCredentials!(config())).toBe(false);
    expect(slackConnector.hasCredentials!(config({ slack: slack({ token_secret: "X" }) }))).toBe(true);
  });
});

describe("sync <slack|markdown> --json report", () => {
  it("markdown: counts what it added, then what it updated", async () => {
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "a.md"), "# A\n\nhello");
    const c = config({ markdown: { dirs: [dir] } });
    expect(await syncSourceReport(db, c, "markdown")).toEqual({ source: "markdown", status: "ok", added: 1, updated: 0 });
    writeFileSync(join(dir, "notes", "a.md"), "# A\n\nhello again");
    expect(await syncSourceReport(db, c, "markdown")).toEqual({ source: "markdown", status: "ok", added: 0, updated: 1 });
  });

  it("markdown with no folder is not_configured", async () => {
    expect(await syncSourceReport(db, config(), "markdown")).toEqual({ source: "markdown", status: "not_configured", added: 0, updated: 0 });
  });

  it("slack without a token is no_credentials and calls nothing", async () => {
    expect(await syncSourceReport(db, config({ slack: slack({ token_secret: "TEST_SLACK_TOKEN" }) }), "slack"))
      .toEqual({ source: "slack", status: "no_credentials", added: 0, updated: 0 });
  });

  it("a connector that throws is failed, with no message text", async () => {
    const boom = { name: "slack", sync: async () => { throw new Error("secret detail"); } };
    const r = await syncSourceReport(db, config({ slack: slack({ token: "xoxb-x" }) }), "slack", boom as any);
    expect(r).toEqual({ source: "slack", status: "failed", added: 0, updated: 0 });
  });
});

describe("sync <whatsapp|facebook> --json report", () => {
  it("whatsapp with no instance and facebook with no page are not_configured", async () => {
    const c = config({ whatsapp: { keychain_service: "", instances: [] }, facebook: { graph_version: "v26.0", keychain_service: "", pages: [] } });
    expect(await syncSourceReport(db, c, "whatsapp")).toEqual({ source: "whatsapp", status: "not_configured", added: 0, updated: 0 });
    expect(await syncSourceReport(db, c, "facebook")).toEqual({ source: "facebook", status: "not_configured", added: 0, updated: 0 });
  });

  it("an unresolved WAHA key or Page token is no_credentials", async () => {
    const c = config({
      whatsapp: { keychain_service: "", instances: [{ name: "p", url: "http://127.0.0.1:3000", api_key: "", api_key_secret: "TEST_NO_KEY", session: "default", chats: [] }] },
      facebook: { graph_version: "v26.0", keychain_service: "", pages: [{ name: "shop", page_id: "1", token_secret: "TEST_NO_TOKEN" }] },
    });
    expect((await syncSourceReport(db, c, "whatsapp")).status).toBe("no_credentials");
    expect((await syncSourceReport(db, c, "facebook")).status).toBe("no_credentials");
  });
});

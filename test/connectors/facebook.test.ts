import { describe, it, expect, afterEach } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { facebookConnector, syncFacebook } from "../../src/connectors/facebook";
import { contentOf, conversationTitle, messageRow, conversationsUrl, stripToken } from "../../src/connectors/facebook-graph";
import { resolveFacebookTokens } from "../../src/lib/facebook-secrets";

afterEach(() => { delete process.env.TEST_FB_TOKEN; });

const PAGE = { name: "shop", page_id: "111", token_secret: "TEST_FB_TOKEN" };
const config = (pages: unknown[] = [PAGE], over: Record<string, unknown> = {}) =>
  ({ sync_start: "", facebook: { graph_version: "v26.0", keychain_service: "", pages, ...over } }) as any;

const conv = {
  id: "t_1",
  updated_time: "2026-11-20T10:00:00+0000",
  link: "/shop/inbox/123/?section=messages",
  participants: { data: [{ id: "999", name: "Alice Martin" }, { id: "111", name: "Shop" }] },
  messages: {
    data: [
      { id: "m_2", created_time: "2026-11-20T10:00:00+0000", from: { id: "111", name: "Shop" }, message: "Bonjour Alice" },
      { id: "m_1", created_time: "2026-11-20T09:59:00+0000", from: { id: "999", name: "Alice Martin" }, message: "Hello",
        attachments: { data: [{ mime_type: "image/jpeg", name: "a.jpg" }] } },
    ],
  },
};

describe("facebook graph helpers", () => {
  it("names a conversation after the other participants, not the page", () => {
    expect(conversationTitle(conv as any, "111")).toBe("Alice Martin");
  });

  it("keeps the text and marks attachments; an empty message is a placeholder", () => {
    expect(contentOf(conv.messages.data[1] as any)).toBe("Hello\n[attachment: image]");
    expect(contentOf({ id: "x", created_time: "", from: { id: "1" } } as any)).toBe("");
    expect(contentOf({ id: "x", created_time: "", from: { id: "1" }, attachments: { data: [{}] } } as any)).toBe("[attachment: file]");
  });

  it("builds one row per message with the page, the inbox link and seconds", () => {
    const r = messageRow(PAGE as any, "Shop", conv as any, conv.messages.data[1] as any);
    expect(r.source).toBe("facebook");
    expect(r.source_id).toBe("shop:m_1");
    expect(r.channel_id).toBe("t_1");
    expect(r.channel_name).toBe("Alice Martin");
    expect(r.author_name).toBe("Alice Martin");
    expect(r.sent_at).toBe(Date.parse("2026-11-20T09:59:00Z") / 1000);
    const meta = JSON.parse(r.metadata!);
    expect(meta).toEqual({ page: "shop", page_id: "111", page_name: "Shop", fromPage: false, permalink: "https://www.facebook.com/shop/inbox/123/?section=messages" });
  });

  it("asks for messenger conversations on graph.facebook.com and never puts a token in a URL", () => {
    const u = conversationsUrl("v26.0", "111");
    expect(u.startsWith("https://graph.facebook.com/v26.0/111/conversations?")).toBe(true);
    expect(u).toContain("platform=messenger");
    expect(u).not.toContain("access_token");
    expect(stripToken("https://graph.facebook.com/v26.0/111/conversations?after=abc&access_token=SECRET")).toBe(
      "https://graph.facebook.com/v26.0/111/conversations?after=abc");
  });
});

describe("facebook tokens by name", () => {
  it("resolves each page's token from its secret name", async () => {
    process.env.TEST_FB_TOKEN = "EAAB-test";
    const tokens = await resolveFacebookTokens(config());
    expect(tokens.get("shop")).toBe("EAAB-test");
  });

  it("a page whose secret does not resolve has no token", async () => {
    expect((await resolveFacebookTokens(config())).size).toBe(0);
  });
});

function fakeFetch(pages: Record<string, unknown>[], seen: { url: string; auth: string | null }[]) {
  let i = 0;
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(pages[i++] ?? { data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("facebook connector", () => {
  it("has its name and needs a configured page", () => {
    expect(facebookConnector.name).toBe("facebook");
    expect(facebookConnector.hasCredentials!(config([]))).toBe(false);
    expect(facebookConnector.hasCredentials!(config())).toBe(true);
  });

  it("stores every message of the conversations, sends the token as a header, and sets a cursor", async () => {
    process.env.TEST_FB_TOKEN = "EAAB-test";
    const db = new TraulDB(":memory:");
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = fakeFetch([{ id: "111", name: "Shop" }, { data: [conv], paging: {} }], seen);
    const r = await syncFacebook(db, config(), fetchFn);
    expect(r.messagesAdded).toBe(2);
    expect(seen.every((s) => s.auth === "Bearer EAAB-test" && !s.url.includes("EAAB"))).toBe(true);
    const rows = db.db.query("SELECT source_id, author_name FROM messages WHERE source = 'facebook' ORDER BY sent_at").all();
    expect(rows).toEqual([{ source_id: "shop:m_1", author_name: "Alice Martin" }, { source_id: "shop:m_2", author_name: "Shop" }]);
    expect(db.getSyncCursor("facebook", "shop:updated")).toBe(String(Date.parse("2026-11-20T10:00:00Z") / 1000));
    db.close();
  });

  it("stops at conversations not updated since the cursor", async () => {
    process.env.TEST_FB_TOKEN = "EAAB-test";
    const db = new TraulDB(":memory:");
    db.setSyncCursor("facebook", "shop:updated", String(Date.parse("2026-11-21T00:00:00Z") / 1000));
    const seen: { url: string; auth: string | null }[] = [];
    const r = await syncFacebook(db, config(), fakeFetch([{ id: "111", name: "Shop" }, { data: [conv], paging: { next: "https://graph.facebook.com/x?after=1" } }], seen));
    expect(r.messagesAdded).toBe(0);
    expect(seen.length).toBe(2);
    db.close();
  });

  it("throws when the Graph API refuses every page, so the report says failed", async () => {
    process.env.TEST_FB_TOKEN = "EAAB-test";
    const db = new TraulDB(":memory:");
    const refuse = (async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 })) as unknown as typeof fetch;
    await expect(syncFacebook(db, config(), refuse)).rejects.toThrow("facebook");
    db.close();
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { syncWhatsapp, whatsappConnector, chatLink } from "../../src/connectors/whatsapp";
import { resolveWhatsappKeys } from "../../src/lib/whatsapp-secrets";

afterEach(() => { delete process.env.TEST_WAHA_KEY; });

const INSTANCE = { name: "phone", url: "http://127.0.0.1:3000", api_key: "", api_key_secret: "TEST_WAHA_KEY", session: "default", chats: [] };
const config = (instances: unknown[] = [INSTANCE]) =>
  ({ sync_start: "", whatsapp: { keychain_service: "", instances: instances.map((i) => ({ ...(i as object) })) } }) as any;

describe("whatsapp chat links", () => {
  it("links a person's chat to wa.me and leaves a group without a link", () => {
    expect(chatLink("33612345678@c.us")).toBe("https://wa.me/33612345678");
    expect(chatLink("33612345678@s.whatsapp.net")).toBe("https://wa.me/33612345678");
    expect(chatLink("1203630@g.us")).toBeNull();
    expect(chatLink("weird")).toBeNull();
  });
});

describe("whatsapp api key by name", () => {
  it("fills api_key from the named secret and keeps a key given directly", async () => {
    process.env.TEST_WAHA_KEY = "waha-test";
    const c = config([INSTANCE, { ...INSTANCE, name: "given", api_key: "direct" }]);
    expect(await resolveWhatsappKeys(c)).toBe(true);
    expect(c.whatsapp.instances.map((i: any) => i.api_key)).toEqual(["waha-test", "direct"]);
  });

  it("is false when a named key does not resolve; an instance with no secret name needs none", async () => {
    expect(await resolveWhatsappKeys(config())).toBe(false);
    expect(await resolveWhatsappKeys(config([{ ...INSTANCE, api_key_secret: undefined }]))).toBe(true);
  });
});

function waha(routes: Record<string, unknown>, seen: { url: string; key: string | null }[]) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, key: new Headers(init?.headers).get("x-api-key") });
    const path = new URL(url).pathname;
    const body = routes[path];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("whatsapp connector", () => {
  it("stores messages with the chat link, the account and the key as a header", async () => {
    process.env.TEST_WAHA_KEY = "waha-test";
    const db = new TraulDB(":memory:");
    const seen: { url: string; key: string | null }[] = [];
    const fetchFn = waha({
      "/api/sessions/default": { status: "WORKING" },
      "/api/sessions/default/chats": [{ id: "33612345678@c.us", name: "Alice", isGroup: false }],
      "/api/sessions/default/chats/33612345678%40c.us/messages": [
        { id: "w1", body: "Salut", timestamp: Math.floor(Date.now() / 1000) - 60, from: "33612345678@c.us", fromMe: false, hasMedia: false, ack: 1, _data: { notifyName: "Alice" } },
      ],
    }, seen);
    const r = await syncWhatsapp(db, config(), fetchFn);
    expect(r.messagesAdded).toBe(1);
    expect(seen.every((s) => s.key === "waha-test")).toBe(true);
    const row = db.db.query("SELECT source_id, channel_name, metadata FROM messages WHERE source = 'whatsapp'").get() as any;
    expect(row.source_id).toBe("phone:w1");
    expect(row.channel_name).toBe("Alice");
    expect(JSON.parse(row.metadata)).toEqual({ fromMe: false, hasMedia: false, ack: 1, instance: "phone", isGroup: false, permalink: "https://wa.me/33612345678" });
    db.close();
  });

  it("throws when no instance is reachable, so the report says failed", async () => {
    process.env.TEST_WAHA_KEY = "waha-test";
    const db = new TraulDB(":memory:");
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(syncWhatsapp(db, config(), down)).rejects.toThrow("whatsapp");
    db.close();
  });

  it("needs at least one instance", () => {
    expect(whatsappConnector.hasCredentials!(config([]))).toBe(false);
    expect(whatsappConnector.hasCredentials!(config())).toBe(true);
  });
});

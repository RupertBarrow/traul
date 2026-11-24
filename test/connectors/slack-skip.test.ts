import { describe, it, expect, mock } from "bun:test";

/** A fake Slack: one channel that reads fine, one DM whose history Slack refuses. */
mock.module("@slack/web-api", () => ({
  LogLevel: { ERROR: "error" },
  WebClient: class {
    conversations = {
      async list(args: { types: string }) {
        if (args.types.includes("im")) return { channels: [{ id: "D1", is_im: true, user: "U1" }], response_metadata: {} };
        return { channels: [{ id: "C1", name: "general", is_member: true }], response_metadata: {} };
      },
      async history(args: { channel: string }) {
        if (args.channel === "D1") throw Object.assign(new Error("An API error occurred: channel_not_found"), { data: { error: "channel_not_found" } });
        return { messages: [{ ts: "1700000000.000100", user: "U1", text: "hello <@U1>" }], response_metadata: {} };
      },
      async replies() { return { messages: [], response_metadata: {} }; },
    };
    auth = { async test() { return { team: "Rapido", team_id: "T1", url: "https://rapido.slack.com/" }; } };
    users = { async info() { return { user: { name: "ana", profile: { display_name: "Ana" } } }; } };
  },
}));

describe("Slack sync with one unreadable conversation", () => {
  it("skips that conversation and still syncs the others (no throw)", async () => {
    const { slackConnector } = await import("../../src/connectors/slack");
    const { TraulDB } = await import("../../src/db/database");
    const db = new TraulDB(":memory:");
    const config = { database: { path: ":memory:" }, slack: { token: "xoxp-test", my_user_id: "", channels: [] } };
    const result = await slackConnector.sync(db, config as any);
    expect(result.messagesAdded).toBe(1);
    db.close();
  });

  it("stores the workspace, the permalink and readable text, and a first run under format 2 refetches from the start once", async () => {
    const { slackConnector } = await import("../../src/connectors/slack");
    const { TraulDB } = await import("../../src/db/database");
    const db = new TraulDB(":memory:");
    db.setSyncCursor("slack", "channel:C1", "1800000000.000000"); // a cursor past the message: format 1 would fetch nothing
    const config = { database: { path: ":memory:" }, slack: { token: "xoxp-test", my_user_id: "", channels: [] } };
    expect((await slackConnector.sync(db, config as any)).messagesAdded).toBe(1);
    const row = (db as any).db.query("SELECT content, metadata FROM messages WHERE source = 'slack'").get() as { content: string; metadata: string };
    expect(row.content).toBe("hello @Ana");
    expect(JSON.parse(row.metadata)).toMatchObject({ workspace: "Rapido", team_id: "T1", permalink: "https://rapido.slack.com/archives/C1/p1700000000000100" });
    expect(db.getSyncCursor("slack", "format")).toBe("2");
    db.close();
  });
});

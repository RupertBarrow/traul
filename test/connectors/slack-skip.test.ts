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
        return { messages: [{ ts: "1700000000.000100", user: "U1", text: "hello" }], response_metadata: {} };
      },
      async replies() { return { messages: [], response_metadata: {} }; },
    };
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
});

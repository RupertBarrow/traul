import { describe, it, expect } from "bun:test";
import { conversationName, listConversations, type ConversationsClient } from "../../src/connectors/slack-conversations";

type Ch = Record<string, unknown>;
/** A fake `conversations.list`: one page per `types` value; `refuse` makes a types value answer missing_scope like Slack does. */
function fakeClient(byTypes: Record<string, Ch[]>, refuse: string[] = []): ConversationsClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    conversations: {
      async list(args: { types: string; cursor?: string }) {
        calls.push(args.types);
        if (refuse.includes(args.types)) throw Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } });
        return { channels: byTypes[args.types] ?? [], response_metadata: {} };
      },
    },
  };
}
const names: Record<string, string> = { U1: "Alice", U2: "Bob" };
const nameOf = async (id: string) => names[id] ?? id;

describe("Slack conversation names", () => {
  it("a channel keeps its name, a DM is @<person>, a group DM lists its members", async () => {
    expect(await conversationName({ id: "C1", name: "general" }, nameOf)).toBe("general");
    expect(await conversationName({ id: "D1", is_im: true, user: "U1" }, nameOf)).toBe("@Alice");
    expect(await conversationName({ id: "G1", is_mpim: true, name: "mpdm-alice--bob--carol-1" }, nameOf)).toBe("@alice, @bob, @carol");
  });
});

describe("Slack conversations to sync", () => {
  const channels = { "public_channel,private_channel": [{ id: "C1", name: "general", is_member: true }, { id: "C2", name: "random", is_member: false }], "im,mpim": [{ id: "D1", is_im: true, user: "U2" }, { id: "G1", is_mpim: true, name: "mpdm-alice--bob-1" }] };

  it("with no channel list: the joined channels, then every DM and group DM", async () => {
    const got = await listConversations(fakeClient(channels), [], nameOf);
    expect(got).toEqual([{ id: "C1", name: "general" }, { id: "D1", name: "@Bob" }, { id: "G1", name: "@alice, @bob" }]);
  });

  it("with a channel list: those channels, and the DMs still", async () => {
    const got = await listConversations(fakeClient(channels), ["random"], nameOf);
    expect(got).toEqual([{ id: "C2", name: "random" }, { id: "D1", name: "@Bob" }, { id: "G1", name: "@alice, @bob" }]);
  });

  it("a token without the DM scopes still syncs its channels (DMs skipped with a warning)", async () => {
    const warnings: string[] = [];
    const got = await listConversations(fakeClient(channels, ["im,mpim"]), [], nameOf, (m) => warnings.push(m));
    expect(got).toEqual([{ id: "C1", name: "general" }]);
    expect(warnings.join(" ")).toContain("im:read");
  });
});

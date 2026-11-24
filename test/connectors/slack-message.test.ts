import { describe, it, expect } from "bun:test";
import { permalink, readableText, workspaceOf } from "../../src/connectors/slack-message";

const ws = { teamId: "T1", name: "Rapido", url: "https://rapido.slack.com/" };
const names: Record<string, string> = { U1: "Ana", U2: "Bob" };
const nameOf = async (id: string) => names[id] ?? id;

describe("permalink", () => {
  it("builds the archives link with the ts without its dot", () => {
    expect(permalink(ws, "C1", "1700000000.000100")).toBe("https://rapido.slack.com/archives/C1/p1700000000000100");
  });
  it("adds the thread for a reply, not for a thread's parent", () => {
    expect(permalink(ws, "C1", "1700000001.000200", "1700000000.000100")).toBe("https://rapido.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.000100&cid=C1");
    expect(permalink(ws, "C1", "1700000000.000100", "1700000000.000100")).toBe("https://rapido.slack.com/archives/C1/p1700000000000100");
  });
});

describe("readableText", () => {
  it("names users, channels, links and specials", async () => {
    expect(await readableText("hi <@U1> and <@U2|bobby>, see <#C9|general> and <https://x.io|the doc> or <https://y.io>; <!here> &amp; 1 &lt; 2", nameOf))
      .toBe("hi @Ana and @bobby, see #general and the doc or https://y.io; @here & 1 < 2");
  });
  it("leaves plain text alone", async () => {
    expect(await readableText("no markup", nameOf)).toBe("no markup");
  });
});

describe("workspaceOf", () => {
  it("reads auth.test, adding the trailing slash", async () => {
    expect(await workspaceOf({ auth: { test: async () => ({ team: "Rapido", team_id: "T1", url: "https://rapido.slack.com" }) } })).toEqual(ws);
  });
  it("is null when auth.test fails or says nothing", async () => {
    expect(await workspaceOf({ auth: { test: async () => { throw new Error("x"); } } })).toBeNull();
    expect(await workspaceOf({ auth: { test: async () => ({}) } })).toBeNull();
  });
});

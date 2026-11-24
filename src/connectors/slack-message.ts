/** What a Slack message carries beyond its text (2026-11-24): the workspace it is in, its permalink, and its text with Slack's
 *  markup made readable (`<@U123>` -> `@Ana`, `<#C1|general>` -> `#general`, `<https://x|label>` -> `label`). */

export interface SlackWorkspace { teamId: string; name: string; url: string }

/** The workspace of the token (auth.test), or null when Slack does not say: the messages are still stored, without a link. */
export async function workspaceOf(client: { auth: { test(): Promise<{ team?: string; team_id?: string; url?: string }> } }): Promise<SlackWorkspace | null> {
  try {
    const r = await client.auth.test();
    if (!r.url || !r.team_id) return null;
    return { teamId: r.team_id, name: r.team ?? r.team_id, url: r.url.endsWith("/") ? r.url : `${r.url}/` };
  } catch {
    return null;
  }
}

/** The message's permalink as Slack builds it: `<workspace>/archives/<channel>/p<ts without the dot>`, plus the thread for a reply.
 *  Opened in a browser it offers the Slack app when installed. */
export function permalink(ws: SlackWorkspace, channelId: string, ts: string, threadTs?: string): string {
  const base = `${ws.url}archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Slack's text markup made readable. `nameOf` gives a user's display name (it may look the user up). */
export async function readableText(text: string, nameOf: (userId: string) => Promise<string>): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(/<([^<>]+)>/g)) {
    parts.push(text.slice(last, m.index));
    parts.push(await renderToken(m[1]!, nameOf));
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return unescape(parts.join(""));
}

async function renderToken(token: string, nameOf: (userId: string) => Promise<string>): Promise<string> {
  const [target, label] = splitLabel(token);
  if (target.startsWith("@")) return `@${label ?? (await nameOf(target.slice(1)))}`;
  if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
  if (target.startsWith("!subteam^")) return label ?? "@group";
  if (target.startsWith("!")) return `@${label ?? target.slice(1).split("^")[0]}`;
  return label ?? target;
}

function splitLabel(token: string): [string, string | undefined] {
  const bar = token.indexOf("|");
  return bar < 0 ? [token, undefined] : [token.slice(0, bar), token.slice(bar + 1) || undefined];
}

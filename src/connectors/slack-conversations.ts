/**
 * Which Slack conversations a sync reads, and the name each is stored under (`channel_name`).
 * Channels (public and private): the configured list, else every channel the token's user has joined.
 * Direct messages and group DMs: always, named `@<person>` and `@a, @b, @c`. They need the `im:read`,
 * `im:history`, `mpim:read` and `mpim:history` scopes; a token without them still syncs its channels
 * (the DMs are skipped with a warning).
 */

export interface SlackConversation {
  id: string;
  name?: string;
  is_member?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  user?: string;
}

/** The part of `WebClient` this module calls (a fake in the tests). */
export interface ConversationsClient {
  conversations: {
    list(args: { types: string; limit?: number; cursor?: string; exclude_archived?: boolean }): Promise<{ channels?: unknown[]; response_metadata?: { next_cursor?: string } }>;
  };
}

const CHANNEL_TYPES = "public_channel,private_channel";
const DM_TYPES = "im,mpim";

async function* pages(client: ConversationsClient, types: string): AsyncGenerator<SlackConversation[]> {
  let cursor: string | undefined;
  do {
    const resp = await client.conversations.list({ types, limit: 200, cursor, exclude_archived: true });
    yield (resp.channels ?? []) as SlackConversation[];
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** A channel's own name; a DM `@<display name of the other person>`; a group DM its members from Slack's `mpdm-a--b--c-1` name. */
export async function conversationName(ch: SlackConversation, nameOf: (userId: string) => Promise<string>): Promise<string> {
  if (ch.is_im) return `@${ch.user ? await nameOf(ch.user) : ch.id}`;
  if (ch.is_mpim) {
    const m = /^mpdm-(.+)-\d+$/.exec(ch.name ?? "");
    return m ? m[1]!.split("--").map((n) => `@${n}`).join(", ") : (ch.name ?? ch.id);
  }
  return ch.name ?? ch.id;
}

export const isMissingScope = (err: unknown): boolean =>
  (err as { data?: { error?: string } })?.data?.error === "missing_scope" || /missing_scope/.test(String((err as Error)?.message ?? err));

/** The conversations to sync, channels first, then DMs and group DMs. `configured` holds channel names or ids (empty: every joined channel). */
export async function listConversations(
  client: ConversationsClient,
  configured: readonly string[],
  nameOf: (userId: string) => Promise<string>,
  warn: (message: string) => void = () => {},
): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const all: SlackConversation[] = [];
  for await (const page of pages(client, CHANNEL_TYPES)) all.push(...page);
  if (configured.length > 0) {
    for (const wanted of configured) {
      const ch = all.find((c) => c.name === wanted || c.id === wanted);
      if (ch) out.push({ id: ch.id, name: ch.name ?? ch.id });
      else warn(`Channel not found: ${wanted}`);
    }
  } else {
    for (const ch of all) if (ch.is_member) out.push({ id: ch.id, name: ch.name ?? ch.id });
  }
  try {
    for await (const page of pages(client, DM_TYPES)) {
      for (const ch of page) out.push({ id: ch.id, name: await conversationName(ch, nameOf) });
    }
  } catch (err) {
    if (!isMissingScope(err)) throw err;
    warn("Slack DMs skipped: the token lacks the im:read, im:history, mpim:read and mpim:history scopes");
  }
  return out;
}

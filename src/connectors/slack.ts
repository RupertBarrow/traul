import { listConversations, isMissingScope, slackErrorCode } from "./slack-conversations";
import { WebClient, LogLevel } from "@slack/web-api";
import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, getEffectiveSyncStart } from "../lib/config";
import * as log from "../lib/logger";
import { resolveSlackCredentials } from "../lib/slack-secrets";

export const slackConnector: Connector = {
  name: "slack",
  defaultInterval: 300,
  hasCredentials: (config) => !!(config.slack.token || config.slack.token_secret),

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    await resolveSlackCredentials(config);
    if (!config.slack.token) {
      log.warn("Slack token not configured.");
      log.warn("Set SLACK_BOT_TOKEN or SLACK_USER_TOKEN env var, or add slack.token to ~/.config/traul/config.json");
      log.warn("To extract tokens from Slack desktop app, run: /slack connect");
      return { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
    }

    const headers: Record<string, string> = {};
    if (config.slack.token.startsWith("xoxc-") && config.slack.cookie) {
      headers.cookie = `d=${config.slack.cookie}`;
    }
    const client = new WebClient(config.slack.token, {
      headers,
      retryConfig: { retries: 5, factor: 2 },
      logLevel: LogLevel.ERROR, // suppress built-in rate limit warnings
    });
    const result: SyncResult = {
      messagesAdded: 0,
      messagesUpdated: 0,
      contactsAdded: 0,
    };

    const userCache = new Map<
      string,
      { displayName: string; username: string }
    >();

    async function resolveUser(
      userId: string
    ): Promise<{ displayName: string; username: string }> {
      const cached = userCache.get(userId);
      if (cached) return cached;

      try {
        const resp = await client.users.info({ user: userId });
        const user = resp.user!;
        const displayName =
          user.profile?.display_name || user.real_name || user.name || userId;
        const username = user.name || userId;

        userCache.set(userId, { displayName, username });

        const existing = db.getContactBySourceId("slack", userId);
        if (!existing) {
          const contactId = db.upsertContact(displayName);
          db.upsertContactIdentity({
            contactId,
            source: "slack",
            sourceUserId: userId,
            username,
            displayName,
          });
          result.contactsAdded++;
        }

        return { displayName, username };
      } catch (err) {
        log.warn(`Failed to resolve user ${userId}:`, err);
        return { displayName: userId, username: userId };
      }
    }

    // Channels (the configured list, else every joined one), then DMs and group DMs
    const channelIds = await listConversations(
      client,
      config.slack.channels,
      async (userId) => (await resolveUser(userId)).displayName,
      (m) => log.warn(m),
    );

    log.info(`Syncing ${channelIds.length} channels...`);

    for (const channel of channelIds) {
      try {
        log.info(`  ${channel.name.startsWith("@") ? "" : "#"}${channel.name}`);
        const cursorKey = `channel:${channel.id}`;
        const oldest = getEffectiveSyncStart(db, config, "slack", cursorKey) ?? "0";
        let latestTs = oldest;
        let channelMsgCount = 0;
  
        let cursor: string | undefined;
        do {
          const resp = await client.conversations
            .history({ channel: channel.id, oldest, limit: 200, cursor })
            .catch((err) => {
              if (isMissingScope(err)) return null; // e.g. a DM without im:history: skip it, keep the channels
              throw err;
            });
          if (!resp) {
            log.warn(`    skipped: the token lacks the scope to read ${channel.name}`);
            break;
          }
  
          for (const msg of resp.messages ?? []) {
            if (msg.subtype && msg.subtype !== "thread_broadcast") continue;
            if (!msg.ts || !msg.text) continue;
  
            const user = msg.user ? await resolveUser(msg.user) : null;
  
            db.upsertMessage({
              source: "slack",
              source_id: `${channel.id}:${msg.ts}`,
              channel_id: channel.id,
              channel_name: channel.name,
              thread_id: msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
              author_id: msg.user,
              author_name: user?.displayName,
              content: msg.text,
              sent_at: Math.floor(parseFloat(msg.ts)),
              metadata: JSON.stringify({
                reactions: msg.reactions,
                reply_count: msg.reply_count,
              }),
            });
            channelMsgCount++;
  
            if (msg.ts > latestTs) latestTs = msg.ts;
  
            // Fetch thread replies
            if (msg.reply_count && msg.reply_count > 0 && msg.thread_ts === msg.ts) {
              let threadCursor: string | undefined;
              do {
                const threadResp = await client.conversations.replies({
                  channel: channel.id,
                  ts: msg.ts,
                  oldest,
                  limit: 200,
                  cursor: threadCursor,
                });
  
                for (const reply of threadResp.messages ?? []) {
                  if (reply.ts === msg.ts) continue; // skip parent
                  if (!reply.text) continue;
  
                  const replyUser = reply.user
                    ? await resolveUser(reply.user)
                    : null;
  
                  db.upsertMessage({
                    source: "slack",
                    source_id: `${channel.id}:${reply.ts}`,
                    channel_id: channel.id,
                    channel_name: channel.name,
                    thread_id: msg.ts,
                    author_id: reply.user,
                    author_name: replyUser?.displayName,
                    content: reply.text,
                    sent_at: Math.floor(parseFloat(reply.ts!)),
                  });
                  channelMsgCount++;
  
                  if (reply.ts! > latestTs) latestTs = reply.ts!;
                }
  
                threadCursor =
                  threadResp.response_metadata?.next_cursor || undefined;
              } while (threadCursor);
            }
          }
  
          cursor = resp.response_metadata?.next_cursor || undefined;
        } while (cursor);
  
        if (latestTs !== oldest) {
          db.setSyncCursor("slack", cursorKey, latestTs);
        }
        result.messagesAdded += channelMsgCount;
        log.info(`    ${channelMsgCount} messages`);
      } catch (err) {
        // One conversation that cannot be read (a deleted user's DM, a group DM Slack refuses, a missing scope...) is skipped;
        // the others still sync, and the next run tries it again from its cursor.
        log.warn(`    skipped ${channel.name}: ${slackErrorCode(err)}`);
      }
    }

    return result;
  },
};

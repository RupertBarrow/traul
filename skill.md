---
name: traul
description: Personal Intelligence Engine CLI for syncing, searching, and monitoring messages from Slack, Telegram, Discord, Linear, Gmail, IMAP mail, Claude Code sessions, Markdown files, and WhatsApp. Use when working with traul commands, message sync, search, signals, briefings, or browsing chat history.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
---

# Traul — Personal Intelligence Engine

CLI tool that watches communication streams (Slack, Telegram, Discord, Linear, Gmail, Claude Code sessions, Markdown files, WhatsApp), indexes messages, detects patterns via signals, and surfaces actionable insights.

**Runtime:** Bun + TypeScript | **DB:** SQLite (WAL mode, FTS5, sqlite-vec) | **Embeddings:** Ollama (qwen3-embedding:0.6b, the fork default) or node-llama-cpp, chosen by configuration | **Version:** 0.2.0

**Project:** `/Users/dandaka/projects/traul`

---

## CLI Commands

### `traul sync [source]`

Sync messages from communication sources incrementally.

| Argument | Description |
|----------|-------------|
| `source` | Optional. `slack`, `telegram`, `discord`, `linear`, `gmail`, `imap`, `claudecode`, `markdown`, `whatsapp` or `facebook`. Omit to sync all. |

- Uses cursor-based incremental sync (only fetches new messages)
- Slack: syncs channels (the `slack.channels` list, else every joined channel), then every direct message and group DM, + thread replies; caches user profiles, stores reactions/reply_count in metadata, plus `workspace` (the team name), `team_id` and `permalink` (`https://<team>.slack.com/archives/<channel>/p<ts>`, with `?thread_ts=…&cid=…` for a thread reply) when `auth.test` answers. The stored text is readable: `<@U…>` becomes `@Name`, `<#C…|x>` `#x`, `<url|label>` `label`, `<!here>` `@here`, and `&amp;`/`&lt;`/`&gt;` are unescaped. The first sync after an upgrade to this format refetches every conversation once (sync cursor `slack`/`format` = `2`) so older messages gain it. A DM is stored with `channel_name` `@<person>`, a group DM `@a, @b, @c`. DMs need the `im:read`, `im:history`, `mpim:read` and `mpim:history` scopes; without them the channels still sync and the DMs are skipped with a warning. A conversation Slack refuses to read (any error) is skipped with a warning naming its error code; the others still sync
- Telegram: syncs via `tg.py` (Telethon), 1-hour cooldown skip per chat, progress reporting every 10s
- Claude Code: reads all JSONL sessions from `~/.claude/projects/`, extracts user+assistant messages
- Markdown: walks configured dirs for `.md` files, tracks changes by content hash
- WhatsApp: reads each WAHA instance's chats and messages (see Connectors); a person's chat carries `permalink` `https://wa.me/<number>`
- Facebook: reads the Messenger inbox of each configured Facebook Page through the Graph API (see Connectors)
- IMAP: read-only mail (`EXAMINE`, `BODY.PEEK`), cursors per folder on `UIDVALIDITY` and UID, budgets per run, backfill of stubs (see Connectors)
- Reports messages added + contacts discovered per source
- `--json` (imap, slack, markdown, whatsapp and facebook only): `sync slack|markdown|whatsapp|facebook --json` print `{"source","status","added","updated"}`, `status` one of `ok`, `not_configured` (markdown with no `dirs`, whatsapp with no instance, facebook with no page), `no_credentials` (slack with no token, a WAHA `api_key_secret` or a Page `token_secret` that does not resolve), `failed` (the connector threw, also: no WAHA instance reachable and authenticated, or every Page refused by the Graph API; no detail on stdout); exit 0. `sync imap --json` prints the sync report as one JSON value on stdout (`{"source":"imap","accounts":[{"name","status","folders":[{"folder","uidValidity","lastUid","added","updated","backfilled","gone","skipped"}]}]}`); logs go to stderr; does not embed afterwards (run `traul embed --json`). Exit 0 when it ran (read the statuses), 2 for a bad configuration or another source, 3 for a database of a newer read schema. See `docs/triage-fork/CONTRACT.md`.

### `traul imap check --account <name> [--json]`

Connect, `LOGIN`, `EXAMINE` each configured folder (`LIST` for a pattern), `LOGOUT`. Fetches nothing and opens no database (no database file is created). Prints `{"account","status"}`; `status` is `ok` or one of `auth_failed`, `unreachable`, `tls_error`, `timeout`, `folder_failed`, `no_secret`, `protocol`. Without `--json` it prints `<account>: <status>`. Exit 0 when it ran (read the status); exit 2 for a bad configuration or an unknown account. Never prints a host, a user or a server line.

### `traul imap folders --account <name> [--json]`

Lists the folder names of an account: `{"account","folders":[...]}` (or `{"account","status"}` when it could not connect). Same exit codes and rules as `imap check`.

### `traul --contract`

Prints `{"contract":1,"readSchema":1,"version","commit","connectors":[...]}` and exits 0. Needs no database and no configuration. `commit` is stamped at build time (`dev` when run from source).

### `traul embed [--limit <n>] [--json]`

Embeds messages and chunks that have no vector yet (default limit 500, 0 = all). With `--json` it prints one value, `{"state","embedded","failed","pending","model","dims"}`, and nothing else on stdout. `state` is `ok`, `ollama_down`, `model_missing`, `dims_mismatch` or `ollama_remote`; a named state stops the run and nothing is stored for the failing batch. Exit 0 when it ran. traul never pulls a model.

### `traul import --source imap --ndjson -`

Reads NDJSON from stdin: `{"type":"message","source_id","subject","from","sent_at","account","folder","uidValidity","uid"}` is inserted as a stub (`metadata.stub` true; never over an existing row; `sent_at` is an ISO 8601 string or epoch seconds) and `{"type":"cursor","account","folder","uidValidity","lastUid"}` sets a folder cursor only where none exists. Prints `{"imported","existing","cursors"}`. One transaction: a bad line exits 2 with `line <n>: <problem>` on stderr and nothing is written. The next `sync imap` backfills the stubs.

### `traul search <query>`

Hybrid search combining vector similarity (semantic) and FTS5 keyword matching with Reciprocal Rank Fusion. Falls back to FTS-only if embedding is unavailable.

**Search modes:**
- **Hybrid (default)** — best for multi-word and exploratory queries. Finds semantically related messages even when exact keywords don't appear. Embeds the query through the configured backend (Ollama by default; see Embeddings configuration). There is no fall-through from one backend to the other; if embedding is unavailable it falls back to FTS-only. Prints coverage ratio to stderr (e.g. `88% vector, 12% FTS`).
- **FTS-only (`--fts`)** — keyword matching with BM25 ranking. Faster, but requires ALL terms to match (implicit AND). Brittle with multi-word queries, especially combined with source/channel filters.
- **Keywords in French and English** — every keyword search (`--fts`, and the FTS part of hybrid) ignores case and accents and uses two indexes merged by RRF: the English one (porter stemmer) and a French one (Snowball French stemmer), so `impayé` finds `impayées` and `réunions` finds `Réunion`. Elided articles are ignored (`l'équipe` = `équipe`) and `œ`/`æ` read as `oe`/`ae`. Typing the accents gives the best French matching: an unaccented word (`impaye`) matches only the same unaccented form.
- **OR mode (`--or`)** — joins search terms with OR instead of AND. Works with both `--fts` and hybrid. Use for broad exploratory queries where any term is relevant.
- **Substring (`--like`)** — bypasses FTS entirely, uses SQL LIKE. Useful for exact phrases that FTS tokenization breaks (e.g. "how do I").

**Tip:** Prefer hybrid (default) for broad queries like "metrics mixpanel registration". Use `--fts --or` for exploratory keyword searches matching ANY term. Use `--like` for exact phrase matching.

| Option | Description |
|--------|-------------|
| `-s, --source <source>` | Filter by source |
| `-c, --channel <channel>` | Filter by channel name |
| `-a, --after <date>` | Messages after ISO date (aliases: `--from`, `--start`) |
| `-b, --before <date>` | Messages before ISO date (aliases: `--to`, `--end`) |
| `-l, --limit <n>` | Max results (default: 20) |
| `--json` | Output as JSON |
| `--fts` | Keyword-only search (skip vector search) |
| `--or` | Join terms with OR instead of AND (works with `--fts` and hybrid) |
| `--like` | Substring match (LIKE) — bypasses FTS, useful for exact phrases |
| `--envelope` | Output `{"vector":"ok"\|"unavailable"\|"model_missing","results":[{"id","source","source_id","sent_at","author","channel","snippet","rank"}]}` as one JSON value; `snippet` is at most 240 characters; words of the query are quoted (free text is not FTS syntax); exit 0 |
| `--query-stdin` | Read the query from stdin (it never appears in a process list); the `<query>` argument is then omitted |
| `--content` | With `--envelope`: add `content` (the full text) to each result |

### `traul get [thread-id]`

Retrieve a full conversation thread by its thread ID, or list all threads from a given date. Search results display thread IDs in the output so you can copy them for use with `get`.

| Option | Description |
|--------|-------------|
| `thread-id` (positional) | Thread ID (e.g. Claude Code session UUID) |
| `-d, --date <date>` | Get all threads from a date (ISO 8601) |
| `--json` | Output as JSON |

```bash
# Search shows thread IDs in results
traul search "mixpanel metrics"
# → 2026-03-10 13:06  #base  claude  [thread:abc-123-uuid]: Let me try...

# Get full conversation by thread ID
traul get abc-123-session-uuid

# List all threads from a specific date
traul get --date 2026-03-10

# JSON output
traul get abc-123-session-uuid --json
```

### `traul messages [channel]`

Browse messages chronologically (no FTS required).

| Option | Description |
|--------|-------------|
| `channel` (positional) | Exact channel name match |
| `-c, --channel <name>` | Substring match on channel name |
| `-a, --author <name>` | Filter by author name (substring) |
| `-s, --source <source>` | Filter by source |
| `--after <date>` | Messages after ISO date (alias: `--from`) |
| `--before <date>` | Messages before ISO date (alias: `--to`) |
| `-l, --limit <n>` | Max results (default: 50) |
| `--json` | Output as JSON |
| `--asc` | Oldest first (default: newest first) |

### `traul channels`

List known channels with message counts and last activity.

| Option | Description |
|--------|-------------|
| `-s, --source <source>` | Filter by source |
| `--search <term>` | Substring search in channel name |
| `--json` | Output as JSON |

### `traul sql <query>`

Execute arbitrary read-only SQL against the database. Only SELECT, PRAGMA, WITH, and EXPLAIN queries are allowed by default.

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON (default) |
| `--write` | Allow write operations (INSERT, UPDATE, DELETE, etc.) |

```bash
# Ad-hoc analytics
traul sql "SELECT source, COUNT(*) as cnt FROM messages GROUP BY source"

# Check sync cursors
traul sql "SELECT * FROM sync_cursors WHERE source='gmail'"

# Modify data (requires --write flag)
traul sql "UPDATE messages SET channel_name='renamed' WHERE channel_name='old'" --write
```

### `traul schema`

Show database tables with column names, types, and constraints. Excludes FTS shadow tables.

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

### `traul signals`

View active signal results (not dismissed), ordered by severity then date.

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

#### `traul signals run`

Evaluate all enabled signal definitions against the database. Seeds built-in signals automatically. Replaces `:my_user_id` placeholder with configured Slack user ID.

#### `traul signals dismiss <id>`

Dismiss a signal result by its numeric ID.

### `traul briefing`

Structured overview with three sections:
1. **Signals** — up to 10 active signals with severity/detail
2. **Stats** — total messages, channels, contacts, active signals
3. **Volume** — last 7 days message bar chart

### `traul reset`

Reset a data layer to force regeneration. Useful when you need to re-sync, re-chunk, or re-embed data.

| Subcommand | Description |
|------------|-------------|
| `traul reset sync [--source <source>]` | Clear sync cursors; full refetch on next sync. Optional `--source` flag filters to a specific connector (e.g., `markdown`, `slack`). |
| `traul reset chunks` | Delete all chunks and embeddings; rechunk on next sync. |
| `traul reset embed` | Drop and recreate vector tables; re-embed with `traul embed`. |
| `traul reset all` | Reset everything: sync cursors + chunks + embeddings. |

**Auto-migration:** Traul automatically detects version changes on startup. If the chunking algorithm or embedding model/dimensions change between versions, affected data layers are reset automatically. No manual action needed after upgrading.

### Global Options

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Debug logging to stderr |

---

## JSON Output Fields

All `--json` outputs use clean, normalized field names (not raw SQL column names).

### `channels --json`

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | Source connector name |
| `name` | string | Channel name |
| `message_count` | number | Total messages in channel |
| `last_activity` | string | ISO 8601 timestamp of last message |

### `messages --json`

| Field | Type | Description |
|-------|------|-------------|
| `sent_at` | string | ISO 8601 timestamp |
| `author` | string | Author display name |
| `content` | string | Message content |
| `channel` | string | Channel name |
| `source` | string | Source connector name |

### `search --json`

| Field | Type | Description |
|-------|------|-------------|
| `sent_at` | string | ISO 8601 timestamp |
| `author` | string | Author display name |
| `content` | string | Message content |
| `channel` | string | Channel name |
| `source` | string | Source connector name |
| `thread_id` | string | Thread/session ID (optional, present when available) |
| `rank` | number | Search relevance score (optional) |

---

## Connectors

### Slack

- **Auth:** `SLACK_BOT_TOKEN` or `SLACK_USER_TOKEN` env var (+ optional `SLACK_COOKIE_*` for user tokens), or by NAME: `slack.token_secret` / `slack.cookie_secret` name an environment variable or, on macOS with `slack.keychain_service`, a Keychain item (as IMAP passwords; never logged). A `token` given directly wins.
- **Config:** `token`, `cookie`, `my_user_id`, `channels[]`, `token_secret`, `cookie_secret`, `keychain_service`
- **Features:** Pagination (200/page), direct messages and group DMs (scopes `im:read`, `im:history`, `mpim:read`, `mpim:history`), thread reply fetching, user profile caching, reaction/reply_count metadata
- **Cursors:** Stored per-channel as timestamps

### Telegram

- **Auth:** `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` env vars
- **Config:** `api_id`, `api_hash`, `session_path`, `chats[]`
- **External dep:** `~/.claude/skills/telegram-telethon/scripts/tg.py` (Telethon)
- **Features:** Auto-discover chats (limit 50), 1-hour cooldown skip, progress reporting, reaction metadata
- **Cursors:** Stored per-chat

### Linear

- **Auth:** `LINEAR_API_KEY` env var for single workspace, or `LINEAR_API_KEY_<NAME>` for multiple workspaces (e.g. `LINEAR_API_KEY_TRENDLE`, `LINEAR_API_KEY_AIFC`)
- **Config:** `linear.api_key`, `linear.teams[]`, `linear.workspaces[]` (each with `name`, `api_key`, `teams[]`)
- **Features:** GraphQL API, paginated issue fetch (50/page), comments as thread replies, priority/status/labels in metadata, contact caching
- **Cursors:** Stored per-workspace+team as `<workspace>:team:<id>` or `<workspace>:all`
- **Multi-workspace:** All `LINEAR_API_KEY_*` env vars are auto-discovered as separate workspaces

### IMAP

Read-only mail (docs/triage-fork/SPEC.md, section 5). Message text is stored in `messages`.

- **Auth:** by NAME. Each account has `password_secret`, matching `^[A-Za-z0-9._-]+$`: the environment variable of that name if set and non-empty; else, on macOS with a non-empty `imap.keychain_service`, `/usr/bin/security find-generic-password -s <service> -a <name> -w` (5 s, no shell); else the status `no_secret`. The config file never holds a password, and nothing writes the Keychain.
- **Config:** `imap.keychain_service`, `sync_start`, `max_body_bytes` (262144), `max_text_chars` (100000), `max_messages_per_run` (100), `max_run_seconds` (120), `backfill_per_run` (50), `accounts[]` each with `name`, `host`, `port` (993; 143 for `starttls` and `plain`), `tls` (`implicit` default, `starttls`, or `plain` for a loopback host only; `plain_remote` otherwise), `user`, `password_secret`, `folders[]` (names or patterns with `*` and `?`, `/` as the separator whatever the server uses; absent means `INBOX`).
- **Read-only by construction:** the only verbs sent are `CAPABILITY`, `STARTTLS`, `LOGIN`, `LIST`, `EXAMINE`, `UID SEARCH`, `UID FETCH` (with `BODY.PEEK` only) and `LOGOUT`.
- **TLS:** the certificate is verified for every host except a loopback one (a local bridge serves a self-signed certificate). The server name is sent for a host name only, never for an IP address. `LOGIN` is never sent before a `STARTTLS` upgrade, nor on a `plain` session that advertises `LOGINDISABLED`.
- **Stored:** `source` `imap`; `source_id` `mid:<Message-ID without angle brackets>`, or without one `imap:<account>:<folder>:<uidValidity>:<uid>` (the same key as Triage's, shared vectors in `test/fixtures/triage-keys.json`); `channel_id` the account; `channel_name` `<account>/<folder>`; `thread_id` first of `References`, else `In-Reply-To`, else the Message-ID; `author_id`/`author_name` from `From` (RFC 2047 decoded); `content` the subject, a blank line, the text (the subject alone when there is no text part); `sent_at` the `Date` header, else `INTERNALDATE`; `metadata` `{"v":1,"account","folder","uidValidity","uid","messageId","subject","from","to","date","listUnsubscribe","listId","truncated"?,"stub"?}`.
- **Text:** `text/plain`, else `text/html` through `html-to-text`; attachments and other types are skipped; base64 and quoted-printable; charsets through `TextDecoder` (ISO-8859-1 and -15 as windows-1252 with the eight differing code points mapped); cut at `max_text_chars`; a part cut by the partial fetch sets `truncated`. The upsert for this source updates every column on conflict, but a stub never replaces a full message.
- **Cursors:** `sync_cursors` source `imap`, key `<account>|<folder>`, value `{"uidValidity":N,"lastUid":M}`. A `UIDVALIDITY` other than the cursor's resets it. The row and the cursor move in one transaction. A UID whose fetch fails stops the folder; the same UID failing three runs in a row (counted in `traul_meta`, key `imap_fail:...`) is skipped.
- **Backfill:** with budget left, up to `backfill_per_run` rows of the account whose `metadata.stub` is `true` and whose locator matches the folder's current `UIDVALIDITY` are fetched by UID; the fetched message must yield the stub's `source_id`, then it replaces the stub. A UID that is gone, or another message, sets `stub` to `"gone"`.
- **Budget:** `max_messages_per_run` and `max_run_seconds` are shared by the accounts in turn; what is left waits for the next run.
- **Logs:** counts and codes only, never a subject, an address or text.

### Claude Code

- **Auth:** None required (reads local files)
- **Source dir:** `~/.claude/projects/` (all project subdirectories)
- **Features:** Parses JSONL session transcripts, extracts user + assistant text messages, skips tool results/commands
- **Channel:** Project name (derived from directory name, e.g. `-Users-dandaka-projects-traul` → `traul`)
- **Thread:** Session ID (UUID)
- **Cursors:** Per-session timestamp, incremental sync

### Markdown

- **Auth:** None required (reads local files)
- **Config:** `markdown.dirs[]` — list of directories to scan (supports `~` expansion)
- **Features:** Recursive `.md` file discovery, content-hash-based change detection, re-syncs on file modification (counted as updated, a new file as added)
- **Channel:** Parent directory path relative to configured base dir
- **Author:** Filename (without `.md` extension)
- **Cursors:** Per-file content hash (only re-indexes changed files)

### WhatsApp

- **Auth:** a WAHA instance (WhatsApp HTTP API, self-hosted; `docker-compose.waha.yml`), its session authenticated once by QR (`traul whatsapp auth <name>`, or WAHA's own dashboard). The API key is given directly (`api_key`) or by NAME (`api_key_secret`: an environment variable or, on macOS with `whatsapp.keychain_service`, a Keychain item; never logged). An instance with neither sends no key.
- **Config:** `whatsapp.instances[]` — `name`, `url`, `session`, `api_key` or `api_key_secret`, optional `chats` (ids or name parts); `whatsapp.keychain_service`
- **Rows:** `source` `whatsapp`, `source_id` `<instance>:<message id>`, `channel_id` the chat id, `channel_name` the chat name, `author_name` the sender's push name. `metadata`: `fromMe`, `hasMedia`, `ack`, `instance`, `isGroup` and, for a person's chat, `permalink` (`https://wa.me/<number>`). A media message without text is `[media: image|video|audio|document|sticker]`.
- **Cursors:** per instance and chat, last message timestamp

### Facebook

- **Auth:** one Page access token per Page (from a Meta app with `pages_messaging` / `pages_read_engagement`, asked by someone with the MESSAGING task on the Page), by NAME only: `pages[].token_secret` names an environment variable or, on macOS with `facebook.keychain_service`, a Keychain item. The token is sent as an `Authorization: Bearer` header, never in a URL, never logged.
- **Config:** `facebook.pages[]` — `name` (the account name), `page_id`, `token_secret`; `facebook.graph_version` (default `v26.0`); `facebook.keychain_service`
- **Features:** reads `GET /<page-id>/conversations?platform=messenger` newest first, with the 20 most recent messages of each conversation (the Graph API gives no more), and stops at the first conversation not updated since the last sync. Only `graph.facebook.com` URLs are followed.
- **Rows:** `source` `facebook`, `source_id` `<page name>:<message id>`, `channel_id` the conversation id, `channel_name` the other participants, `author_name` the sender. `metadata`: `page`, `page_id`, `page_name`, `fromPage`, `permalink` (the conversation in the Page inbox). An attachment adds a line `[attachment: image|video|audio|file]`.
- **Cursors:** per page (`<name>:updated`), the newest conversation `updated_time` seen

---

## Signals System

SQL-based pattern detection engine.

### Signal Definition Structure

| Field | Description |
|-------|-------------|
| `name` | Unique identifier |
| `query` | SQL returning: `message_id`, `severity`, `title`, `detail` |
| `severity_expression` | `"info"` (static) or `"dynamic"` (from query CASE) |
| `enabled` | Boolean toggle |

### Built-in Signals

**stale-threads** — Detects threads you participated in with no reply for 3+ days.

| Severity | Condition |
|----------|-----------|
| `urgent` | No reply 14+ days |
| `warning` | No reply 7+ days |
| `info` | No reply 3+ days |

---

## Database Schema

**Location:** `~/.local/share/traul/traul.db` (configurable)

| Table | Purpose |
|-------|---------|
| `messages` | Primary message store (source, channel, author, content, sent_at, metadata JSON) |
| `messages_fts` | FTS5 virtual table (content, author_name, channel_name) with porter tokenizer |
| `messages_fr` | Each message's French stems (message_id → stems), written by traul on every message write |
| `messages_fr_fts` | FTS5 virtual table over `messages_fr.stems` (unicode61, remove_diacritics 2) |
| `vec_messages` | sqlite-vec virtual table for vector embeddings (float[1024]) |
| `contacts` | Unified contact directory (display_name unique) |
| `contact_identities` | Multi-source user mapping (source + source_user_id unique) |
| `sync_cursors` | Incremental sync state per source+key |
| `signal_definitions` | Signal rules with SQL queries |
| `signal_results` | Signal matches with severity, dismissal tracking |

FTS5 is auto-synced via INSERT/UPDATE/DELETE triggers on messages. The French index is written by traul itself (the stemmer is TypeScript); at start-up traul indexes any message without French stems, and rebuilds the index when `traul_meta.french_index_version` changes.

---

## Configuration

**File:** `~/.config/traul/config.json`

**Paths and SQLite from the environment** (for running inside an app):

| Variable | Meaning |
|---|---|
| `TRAUL_HOME` | Folder for the database, pid file and log (default `~/.local/share/traul`). Created 0700; the database file is 0600. |
| `TRAUL_CONFIG_PATH` | Config file (default `~/.config/traul/config.json`) |
| `TRAUL_DB_PATH` | Database file (default `$TRAUL_HOME/traul.db`) |
| `TRAUL_SQLITE_LIB` | SQLite library to load (macOS: default is Homebrew's, Apple Silicon then Intel) |
| `TRAUL_SQLITE_VEC` | Path of the sqlite-vec extension, loaded instead of the bundled package |

**Embeddings configuration** (fork change: the default backend is now Ollama, not node-llama-cpp):

```json
"embeddings": { "backend": "ollama", "url": "http://127.0.0.1:11434", "model": "qwen3-embedding:0.6b",
                "dims": 1024, "keep_alive": "60s", "timeout_ms": 30000, "allow_remote": false }
```

- `backend`: `ollama` (default) or `llama`. `node-llama-cpp` is an optional dependency, loaded only for `llama`. A failing backend is an error; traul never switches to the other one.
- Environment overrides: `TRAUL_OLLAMA_URL` (then `OLLAMA_URL`), `TRAUL_EMBED_MODEL`, `TRAUL_EMBED_DIMS`.
- Loopback only: the URL host must be `localhost`, `127.0.0.0/8` or `::1`, else the error `ollama_remote` and no request. Only `allow_remote: true` in the config file lifts this (no environment variable can).
- The vector tables are created with `dims`. Changing `model` or `dims` resets the embeddings on the next start; re-embed with `traul embed`.
- traul never pulls or substitutes a model. Named states: `model_missing`, `ollama_down` (refused connection or timeout), `dims_mismatch` (a vector of another length; nothing is stored), `ollama_remote`.
- Queries get the instruction prefix for Qwen embedding models.

```json
{
  "sync_start": "2025-01-01",
  "database": { "path": "~/.local/share/traul/traul.db" },
  "slack": {
    "token": "",
    "cookie": "",
    "my_user_id": "",
    "channels": []
  },
  "telegram": {
    "api_id": "",
    "api_hash": "",
    "session_path": "",
    "chats": []
  },
  "linear": {
    "api_key": "",
    "teams": [],
    "workspaces": []
  },
  "markdown": {
    "dirs": ["~/projects/dn-kb"]
  }
}
```

```json
"imap": {
  "keychain_service": "", "sync_start": "2026-09-01", "max_body_bytes": 262144, "max_text_chars": 100000,
  "max_messages_per_run": 100, "max_run_seconds": 120, "backfill_per_run": 50,
  "accounts": [
    { "name": "personal", "host": "imap.example.org", "port": 993, "tls": "implicit",
      "user": "me@example.org", "password_secret": "IMAP_PASSWORD_PERSONAL", "folders": ["INBOX"] }
  ]
}
```

ENV vars override config values. Empty `channels`/`chats` arrays = sync all.

---

## Project Structure

```
src/
  index.ts                  # CLI entry (Commander.js)
  commands/                 # Command handlers
    sync.ts, search.ts, messages.ts, channels.ts, get.ts, signals.ts, briefing.ts, sql.ts
  connectors/               # Source adapters
    types.ts, slack.ts, telegram.ts, linear.ts, claude-code.ts, markdown.ts, imap.ts, imap-sync.ts
  db/                       # Data layer
    schema.ts, database.ts, queries.ts
  lib/                      # Utilities
    config.ts, logger.ts, formatter.ts, secrets.ts, mime.ts, imap/ (protocol.ts, session.ts)
  signals/                  # Signal engine
    types.ts, evaluator.ts, definitions/stale-threads.ts
```

---

## Important: Source Discovery

**Never assume a source doesn't exist just because a search returns no results.** The config and connectors evolve — always verify by listing actual data:

1. Run `traul channels -s <source>` to check if a source has synced data
2. Run `traul messages -s <source> -l 10` to browse recent messages from a source
3. If both return nothing, the source may need a sync — ask the user before running it

**Do NOT** use `traul channels --search "discord"` to check if Discord is a source — that searches *channel names* for the word "discord", not source types.

---

## Important: Sync Performance

**`traul sync` is very slow — can take up to 1 hour.** Do NOT run sync before operations like search, messages, signals, or briefing. Always work with the data already in the database. Only run sync when the user explicitly asks for it.

---

## Common Workflows

```bash
# Initial sync of all sources
traul sync

# Sync only Slack
traul sync slack

# Browse recent messages in a channel
traul messages "general" --limit 20

# Find channels matching a keyword
traul channels --search "dev"

# Search for a topic (results include thread IDs)
traul search "deployment issue" --after 2026-03-01

# Get a full thread/conversation
traul get <thread-id>
traul get --date 2026-03-10

# Exploratory search matching ANY term
traul search "deposit withdraw broken" --fts --or

# Exact phrase search (bypasses FTS tokenization)
traul search "how do I" --like -s discord -l 20

# Run signal evaluation and view results
traul signals run
traul signals

# Get a full briefing
traul briefing

# Dismiss a signal
traul signals dismiss 42

# Ad-hoc SQL queries (read-only by default)
traul sql "SELECT source, COUNT(*) as cnt FROM messages GROUP BY source"
traul sql "SELECT * FROM sync_cursors" --json

# Modify data with --write flag
traul sql "UPDATE messages SET channel_name='new' WHERE channel_name='old'" --write

# Explore database schema
traul schema
traul schema --json
```

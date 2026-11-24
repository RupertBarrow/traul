# The Triage contract (normative)

This file is the normative description of the command line that Triage runs. `SPEC.md` section 6 is the design;
this file is what the tests in `test/contract/` hold the executable to. `skill.md` documents the options for users.

## Numbers

- `contract` (now 1): the commands, options and JSON outputs below.
- `readSchema` (now 1): the columns of the `messages` table of SPEC 5.4 (`id`, `source`, `source_id`, `channel_id`,
  `channel_name`, `thread_id`, `author_id`, `author_name`, `content`, `sent_at`, `metadata`) and `traul_meta(key, value)`,
  which Triage reads with its own SQLite, read-only.

Within a number, things are only added: a field, an option, a column. Nothing is renamed, removed or retyped. A change
that would do so raises the number. `traul_meta.read_schema` records the number of the executable that last opened the
database; an executable that finds a larger number exits 3 and touches nothing else.

## General rules

- Every `--json` or `--envelope` command writes exactly one JSON value and a newline to stdout, and nothing else.
  Logs, warnings and errors go to stderr (never a password, host, user, subject or text).
- Exit codes: 0 the command ran (read the states in the JSON); 2 bad configuration, option or input; 3 the database has a
  newer read schema than this executable; 1 any other failure.
- No command in this file needs a network except `sync imap` (IMAP), `sync archive` (the archive reader, loopback only) and `embed`/`search` (Ollama, loopback only).

## Commands

### `traul --contract`

`{"contract":1,"readSchema":1,"version":"<package version>","commit":"<build commit or dev>","connectors":["imap","archive"]}`.
Needs no database and no configuration file; creates no file. `connectors` lists the sources compiled in.

### `traul sync imap --json`

```json
{"source":"imap","accounts":[{"name":"personal","status":"ok",
  "folders":[{"folder":"INBOX","uidValidity":7,"lastUid":2,"added":2,"updated":0,"backfilled":0,"gone":0,"skipped":0}]}]}
```

- `status` is `ok` or `auth_failed`, `unreachable`, `tls_error`, `timeout`, `folder_failed`, `no_secret`, `plain_remote`,
  `protocol`. A folder that stopped early may carry an additional `code`.
- A failing account is a status; the exit code stays 0. 2: bad imap configuration, or a source other than `imap`.
- Does not embed afterwards; run `embed --json`.

### `traul sync archive --json`

```json
{"source":"archive","status":"ok","added":1,"updated":0,"removed":0,"skipped":0}
```

- `status` is `ok` or `not_configured`, `bad_config`, `no_token`, `token_mode`, `unreachable`, `timeout`, `too_large`,
  `redirect`, `http_error`, `bad_answer`. Exit 2 for `bad_config`, else 0.
- Rows: `source` `archive`, `source_id` the item id, `content` the title and link, `metadata` `{"v":1,"id","url","dayOnly"}`
  (SPEC section 7). Added in contract 1; nothing of read schema 1 changes.

### `traul embed --json [--limit <n>]`

`{"state","embedded","failed","pending","model","dims"}`. `state`: `ok`, `ollama_down`, `model_missing`, `dims_mismatch`,
`ollama_remote`. A named state stops the run and nothing is stored for the failing batch. `embedded` and `failed` count this
run (a long message split into chunks counts as handled); `pending` is the messages and chunks still without a vector.
`--limit` defaults to 500, 0 means all. Exit 0 when it ran.

### `traul search --envelope --query-stdin [--source s] [--limit n] [--fts] [--content]`

```json
{"vector":"ok","results":[{"id":1,"source":"imap","source_id":"mid:x@y","sent_at":"2026-10-01T00:00:00.000Z",
  "author":"Alice","channel":"a/INBOX","snippet":"...","rank":0.03}]}
```

- The query is read from stdin. The words are quoted for FTS, so free text cannot be a syntax error. An empty query gives
  `{"vector":"unavailable","results":[]}`.
- `vector`: `ok` (hybrid search ran), `unavailable` (`--fts` was given, or Ollama could not be used: results are keyword
  results), `model_missing` (the configured model is not in Ollama: keyword results).
- `sent_at` is ISO 8601 UTC; `snippet` is at most 240 code points, whitespace collapsed; `rank` is a number or null;
  `author` and `channel` may be null. `--content` adds `content`.
- `search --json` without `--envelope` keeps its array.

### `traul import --source imap --ndjson -`

stdin, one JSON object per line (blank lines ignored):

- `{"type":"message","source_id","subject","from","sent_at","account","folder","uidValidity","uid"}`: inserted as a stub
  (`metadata.stub` is `true`) unless a row with that `source` and `source_id` exists. `sent_at`: ISO 8601 or epoch seconds.
- `{"type":"cursor","account","folder","uidValidity","lastUid"}`: set only where the folder has no cursor.

Prints `{"imported":n,"existing":n,"cursors":n}`. Everything is one transaction; a bad line exits 2 with
`line <n>: <problem>` on stderr and writes nothing. The next `sync imap` fills the stubs (SPEC 5.5, step 4).

### `traul imap check`, `traul imap folders`

SPEC 5.5. Open no database. Exit 0 when they ran, 2 for a bad configuration or an unknown account.

# SPEC: what the Triage app needs from this fork

> **Governing path:** `docs/triage-fork/SPEC.md` in RupertBarrow/traul. **Revision 1**, 2026-11-22. Base `4de8dc8`.
> **Consumer:** Rapido-FAB/inbox-triage, `docs/2026-11-22-triage-v1/SPEC.md` (the app design; it governs the app, this file
> governs the fork). **Status:** design only, nothing implemented.
> **House rules** (`CLAUDE.md`): type-check with Bun, tests first, every CLI change in `skill.md`, every change through a PR.
> New source files stay under 300 lines and new functions under 20 (the consumer's rule; existing files are not reflowed).
> **Licence:** AGPL-3.0-only, unchanged. This repository is public: no private host, account, token or path goes into it,
> in code, tests, fixtures or commit messages. Tests use synthetic mail and `example.org` names.

## 1. Why

Triage is a macOS mail companion. From its 1.0.0 it uses traul as its ingestion, message store and search: it runs a
compiled traul executable from inside a signed app, with an environment built from scratch, and reads `messages` read-only.
traul today cannot do that: it has no IMAP, it reads its connectors from the source folder at run time, it loads Homebrew's
SQLite by a fixed path, its paths are under `~/.config` and `~/.local`, and its default embedding backend is node-llama-cpp.

Triage keeps classification, labels, its console and its mail actions. Nothing of those comes here.

## 2. The changes, one PR each

| PR | Change | New or changed files | Depends on |
|---|---|---|---|
| F1 | Paths and SQLite from the environment; file modes | `src/lib/paths.ts` (new), `src/lib/config.ts`, `src/db/schema.ts`, `src/commands/daemon.ts` | - |
| F2 | Static connector registry, two entry points, the compile script | `src/connectors/registry.ts`, `src/connectors/all.ts` (new), `src/index.triage.ts` (new), `scripts/build-triage.sh` (new), `.github/workflows/ci.yml` | F1 |
| F3 | Ollama as the embedding backend, by configuration | `src/lib/embeddings.ts`, `src/lib/ollama.ts` (new), `src/lib/llama.ts`, `src/db/schema.ts`, `src/db/migrations.ts`, `package.json` | F1 |
| F4 | Secrets by name | `src/lib/secrets.ts` (new) | - |
| F5 | IMAP protocol and MIME | `src/lib/imap/protocol.ts`, `src/lib/imap/session.ts`, `src/lib/mime.ts`, `src/lib/mime-words.ts` (new) | - |
| F6 | The `imap` connector and `traul imap check` | `src/connectors/imap.ts`, `src/connectors/imap-sync.ts`, `src/commands/imap.ts` (new), `src/lib/config.ts`, `src/db/queries.ts`, `src/db/database.ts` | F4, F5 |
| F7 | The Triage contract: `--contract`, `sync --json`, `search --envelope`, `embed --json`, `import` | `src/commands/{sync,search,embed,import}.ts`, `src/index.ts`, `skill.md`, `docs/triage-fork/CONTRACT.md` (new) | F3, F6 |
| F8 | The `archive` connector (Archibald's intakes) | section 7 | F1, F7 |

## 3. Running inside an app (F1, F2)

- **Paths.** `TRAUL_HOME` (default `~/.local/share/traul`) holds the database, the pid file and the log;
  `TRAUL_CONFIG_PATH` (default `~/.config/traul/config.json`) and `TRAUL_DB_PATH` (exists) override single files. No code
  reads `homedir()` outside `paths.ts`. The database folder is created 0700 and the database file 0600.
- **SQLite on macOS.** `TRAUL_SQLITE_LIB` set: `Database.setCustomSQLite(<it>)`. Unset on darwin: the first that exists of
  `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`, `/usr/local/opt/sqlite/lib/libsqlite3.dylib` (today's behaviour, plus Intel).
  `TRAUL_SQLITE_VEC` set: `db.loadExtension(<it>)` instead of `sqliteVec.load(db)` (a compiled executable has no
  `node_modules` to find it in; measured: this works from an empty environment).
- **Registry.** `registry.ts` no longer lists a directory or calls `require` with a computed path; it holds what
  `setConnectors([...])` gave it. `src/index.ts` registers all connectors (`connectors/all.ts`); `src/index.triage.ts`
  registers `imap` only and leaves out the `whatsapp` command, so the compiled Triage executable contains no Slack, Discord,
  Google, Linear or llama code.
- **Build.** `scripts/build-triage.sh <outdir>`: `bun install --frozen-lockfile`, then
  `bun build --compile --external node-llama-cpp --target=bun-darwin-arm64 src/index.triage.ts --outfile <outdir>/traul-arm64`
  and the same for `bun-darwin-x64` → `traul-x86_64`; it prints the sha256 of both. Output is byte-identical for one commit,
  one Bun version and one output file name (measured on Bun 1.4.4); `--check` builds twice and compares. CI adds a
  `bun-linux-x64` build of the same entry and runs the contract tests against that executable.
- **Daemon.** Unchanged and not used by Triage (its scan tick is the only clock). `--detach` keeps needing `bun` on the PATH.

## 4. Embeddings through Ollama (F3)

```json
"embeddings": { "backend": "ollama", "url": "http://127.0.0.1:11434", "model": "qwen3-embedding:0.6b",
                "dims": 1024, "keep_alive": "60s", "timeout_ms": 30000, "allow_remote": false }
```

- `backend` is `ollama` (the fork's default, a change from upstream, stated in `README.md` and `skill.md`) or `llama`.
  `node-llama-cpp` moves to `optionalDependencies` and is loaded by a dynamic `import()` only when the backend is `llama`.
  There is no automatic fall-through from one backend to the other.
- Environment overrides: `TRAUL_OLLAMA_URL` (then `OLLAMA_URL`, kept), `TRAUL_EMBED_MODEL`, `TRAUL_EMBED_DIMS`.
- **Loopback only.** The URL's host must be `localhost`, `127.0.0.0/8` or `::1`, else the named error `ollama_remote` and
  no request, unless the CONFIG FILE says `allow_remote: true` (no environment variable can lift it).
- The model and the dimensions come from the configuration, not from constants: `EMBED_DIMS` becomes a value resolved at
  start; the vector tables are created with it; the existing migration (reset the embeddings when `embed_model` or
  `embed_dims` in `traul_meta` differ) does the rest. A response vector of another length is `dims_mismatch`: nothing is stored.
- Queries keep the instruction prefix for Qwen embedding models (`llama-format.ts`, already matching `qwen3-embedding`).
- traul never pulls a model and never substitutes one. `POST /api/embed` answering "model not found" is the state
  `model_missing`; a refused connection or a timeout is `ollama_down`. Search then runs on FTS and says so (section 6).
- Where Ollama keeps its models is Ollama's business (`OLLAMA_MODELS` of the server Triage starts); traul has no setting for it.

## 5. Mail over IMAP (F4, F5, F6)

### 5.1 Configuration

```json
"imap": {
  "keychain_service": "",            "sync_start": "2026-09-01",
  "max_body_bytes": 262144,          "max_text_chars": 100000,
  "max_messages_per_run": 100,       "max_run_seconds": 120,       "backfill_per_run": 50,
  "accounts": [
    { "name": "personal", "host": "imap.example.org", "port": 993, "tls": "implicit",
      "user": "me@example.org", "password_secret": "IMAP_PASSWORD_PERSONAL", "folders": ["INBOX"] }
  ]
}
```

- `name` and `password_secret` match `^[A-Za-z0-9._-]+$`; `tls` is `implicit` (default), `starttls` or `plain`;
  `plain` is accepted for a loopback host only (`plain_remote` otherwise); `folders` are names or patterns (`*`, `?`, `/` as
  the separator whatever the server uses; absent = `INBOX`).
- The file never holds a password.

### 5.2 Secrets (`src/lib/secrets.ts`)

`resolveSecret(name)`: the environment variable of that NAME if set and non-empty; else, on macOS with a non-empty
`keychain_service`, `/usr/bin/security find-generic-password -s <service> -a <name> -w` (5 s, no shell, the value read from
stdout and never logged); else `no_secret`. Results carry the SOURCE (`env` or `keychain`), never the value. Nothing writes
the Keychain. Tests inject a fake `security`; no real Keychain is touched.

### 5.3 The protocol (`src/lib/imap/`)

A port of Triage's own client (its authors license it here under AGPL): a line and literal reader over `node:tls` and
`node:net`, one command in flight, a connect timeout (10 s) and a per-command timeout (60 s), a cap on a literal
(`max_body_bytes` + 64 KiB).

- **Read-only by construction.** The only verbs the module can send are `CAPABILITY`, `STARTTLS`, `LOGIN`, `LIST`,
  `EXAMINE`, `UID SEARCH`, `UID FETCH` (with `BODY.PEEK` only) and `LOGOUT`: `command()` refuses anything else, and a test
  reads the source for `SELECT`, `STORE`, `APPEND`, `EXPUNGE`, `COPY`, `MOVE`, `DELETE`, `CREATE`, `RENAME`.
- **TLS.** The certificate is verified for every host except a loopback one (a local bridge serves a self-signed
  certificate). `servername` is sent for a host NAME only, never for an IP address (RFC 6066; no `DEP0123` warning).
  `starttls`: plain connect, greeting, `STARTTLS`, upgrade, a new `CAPABILITY`; `LOGIN` is never sent before the upgrade,
  nor on a `plain` session that advertises `LOGINDISABLED`.
- Errors are codes (`auth_failed`, `unreachable`, `tls_error`, `timeout`, `folder_failed`, `no_secret`), never a host, a
  user or a server line in JSON output.

### 5.4 What is stored

One `UID FETCH <uid> (INTERNALDATE BODY.PEEK[]<0.max_body_bytes>)` per message; headers and text are parsed locally.

| Column | Value |
|---|---|
| `source` | `imap` |
| `source_id` | `mid:<Message-ID without angle brackets, trimmed>`; without a Message-ID `imap:<account>:<folder>:<uidValidity>:<uid>` (Triage's key, byte for byte; shared test vectors) |
| `channel_id`, `channel_name` | the account; `<account>/<folder>` |
| `thread_id` | first id of `References`, else `In-Reply-To`, else the Message-ID |
| `author_id`, `author_name` | address and display name of `From` (RFC 2047 decoded) |
| `content` | the subject, a blank line, the text; the subject alone when there is no text part (a message is never skipped) |
| `sent_at` | the `Date` header, else `INTERNALDATE` |
| `metadata` | `{"v":1,"account","folder","uidValidity","uid","messageId","subject","from","to","date","listUnsubscribe","listId","truncated"?,"stub"?}` |

Text (`src/lib/mime.ts`): unfold headers; walk multipart (alternative, mixed, related, nested); take `text/plain`, else
`text/html` through `html-to-text` (the existing dependency and options); skip attachments and every other type; decode
base64 and quoted-printable; decode the charset with `TextDecoder` (ISO-8859-1 and -15 through windows-1252, with the eight
differing code points of -15 mapped); cut at `max_text_chars`; a part cut by the partial fetch is decoded as far as it goes
and sets `truncated`. Attachments are never fetched beyond what the partial fetch happens to include, and never stored.

The upsert for this source updates every column on conflict (today's updates `content` and `metadata` only), except that a
stub never replaces a full message.

### 5.5 Sync

Cursor per folder in `sync_cursors`: source `imap`, key `<account>|<folder>`, value `{"uidValidity":N,"lastUid":M}`.

1. Per account: resolve the secret, connect, `LOGIN`, resolve the folder patterns with `LIST`. A failing account is
   reported and the next one runs.
2. Per folder: `EXAMINE`. A `UIDVALIDITY` other than the cursor's resets that cursor (messages keyed by Message-ID are
   simply upserted again).
3. **New mail:** no cursor: `UID SEARCH SINCE <sync_start>`; else `UID SEARCH UID <lastUid+1>:*`, keeping UIDs above
   `lastUid`. Ascending, each UID is fetched, upserted and the cursor moved IN ONE TRANSACTION, so the cursor never passes a
   message that is not stored. A UID that is gone moves the cursor. A UID whose fetch fails stops the folder; the same UID
   failing three runs in a row (counted in `traul_meta`) is recorded in `skipped` and passed.
4. **Backfill:** with budget left, up to `backfill_per_run` rows of this account whose `metadata.stub` is `true` and whose
   locator matches the folder's current `UIDVALIDITY` are fetched by UID. The fetched message must yield the stub's
   `source_id`; then it replaces the stub. A UID that is gone, or another message, sets `stub` to `"gone"` (the facts stay,
   it is not tried again).
5. The budget (`max_messages_per_run`, `max_run_seconds`) is shared by the accounts in turn; what is left waits for the next run.
6. Logs carry counts and codes, never a subject, an address or text.

`traul imap check --account <name> --json`: connect, `LOGIN`, `EXAMINE` each folder (`LIST` for a pattern), `LOGOUT`;
prints `{"account","status"}` with the codes of 5.3 or `ok`; fetches nothing, opens no database. `traul imap folders
--account <name> --json` lists folder names.

## 6. The Triage contract (F7; `docs/triage-fork/CONTRACT.md` is the normative copy, `skill.md` documents the options)

Numbers: `contract` (the CLI below) and `readSchema` (the columns of 5.4 plus `traul_meta(key, value)`, which Triage reads
with its own SQLite, read-only). Within a number, things are only added. A test in this repository fails when a column of
read schema 1 changes or an output field below disappears.

| Command | Output (stdout, one JSON value) | Exit |
|---|---|---|
| `traul --contract` | `{"contract":1,"readSchema":1,"version","commit","connectors":["imap"]}` | 0 |
| `traul sync imap --json` | `{"source":"imap","accounts":[{"name","status","folders":[{"folder","uidValidity","lastUid","added","updated","backfilled","gone","skipped"}]}]}` | 0 when it ran (read the statuses), 2 bad configuration, 3 a database newer than this executable |
| `traul embed --json --limit <n>` | `{"state":"ok"\|"ollama_down"\|"model_missing"\|"dims_mismatch"\|"ollama_remote","embedded","failed","pending","model","dims"}` | 0 when it ran |
| `traul search --envelope --query-stdin [--source s] [--limit n] [--fts]` | `{"vector":"ok"\|"unavailable"\|"model_missing","results":[{"id","source","source_id","sent_at","author","channel","snippet","rank"}]}`; `snippet` is at most 240 characters; `--content` adds the text | 0 |
| `traul import --source imap --ndjson -` | stdin lines `{"type":"message","source_id","subject","from","sent_at","account","folder","uidValidity","uid"}` (inserted as stubs, never over an existing row) and `{"type":"cursor","account","folder","uidValidity","lastUid"}` (set only where no cursor exists); prints `{"imported","existing","cursors"}` | 0, 2 on a bad line (nothing written) |
| `traul imap check`, `traul imap folders` | 5.5 | 0 when it ran |

`search --json` without `--envelope` keeps today's array. `--query-stdin` reads the query from stdin so that it never
appears in a process list. Warnings go to stderr, never to stdout, in every `--json` mode.

## 7. The `archive` connector (F8, built 2026-11-24)

Archibald's intakes, from the local archive reader. Built on the owner's request to index them; the consumer's rule 32 is
lifted for traul's database to this extent: the title, the link and the date of an intake (plus its id and source).

- **Config:** `"archive": {"items_url": "http://127.0.0.1:<port>/<route>", "token_file": "/absolute/path", "token_header": "<name>"}`.
  The route and the header name are the owner's settings: this public repository holds neither. Loopback `http` only.
- **Token:** read from the file at each sync (a regular file with no group or other bits; never the environment, an
  argument or a log), sent as that one header.
- **Request:** one GET, its own agent, no redirect, 5 s, 1 MiB. The answer must be `schema` `archive-items`, `version` 1.
- **Rows:** `source` `archive`, `source_id` the item id, `channel_id`/`channel_name` the item's source, `content` the title
  (≤ 1000 characters) and the `http(s)` link, `sent_at` the source date, `metadata` `{"v":1,"id","url","dayOnly"}`. A
  malformed item is skipped. Rows that left the review window are deleted, unless the answer is `truncated`.
- **Files:** `src/lib/archive-config.ts`, `src/connectors/archive{,-http,-items,-connector}.ts`; tests
  `test/lib/archive-config.test.ts`, `test/connectors/archive.test.ts`, the contract test for `sync archive --json`.

## 8. Tests (Bun, all run on Linux CI unless marked)

| Id | What | File |
|---|---|---|
| FT-1 | paths from `TRAUL_HOME` / `TRAUL_CONFIG_PATH`; modes 0700 / 0600; no `homedir()` outside `paths.ts` (source test) | `test/lib/paths.test.ts` |
| FT-2 | registry holds what it is given; `index.triage.ts` registers `imap` only; the compiled Linux executable prints `--contract` from an empty environment and has no `googleapis` string | `test/connectors/registry.test.ts`, `test/build/compiled.test.ts` |
| FT-3 | `build-triage.sh --check`: two builds, same sha256 | CI step |
| FT-4 | Ollama client against a fake server: batch, timeout, `model_missing`, `ollama_down`, `dims_mismatch`, the loopback rule (11 URLs), `allow_remote` only from the file, the Qwen query prefix, no llama import when the backend is `ollama` | `test/lib/ollama.test.ts`, `test/lib/embeddings.test.ts` |
| FT-5 | model or dimension change resets the embeddings | `test/db/migrations.test.ts` |
| FT-6 | secrets: environment first, fake `security` (found, not found, locked, timeout), nothing logged, the value never in an error | `test/lib/secrets.test.ts` |
| FT-7 | protocol against an in-process fake server: greeting, literals, timeouts, the verb allow-list, STARTTLS order, `LOGINDISABLED`, no SNI for `127.0.0.1`, `::1`, `192.0.2.10`, verification kept for a name | `test/lib/imap-protocol.test.ts`, `test/lib/imap-tls.test.ts` |
| FT-8 | MIME: plain, HTML only, alternative, nested mixed, base64, quoted-printable, RFC 2047 subjects, ISO-8859-1/-15 and windows-1252 French samples, a truncated part, an attachment skipped, an empty body | `test/lib/mime.test.ts` |
| FT-9 | key derivation equals Triage's on shared vectors (`test/fixtures/triage-keys.json`) | `test/connectors/imap-key.test.ts` |
| FT-10 | sync: first run with `sync_start`, incremental by UID, `UIDVALIDITY` change, a gone UID, the three-failures rule, cursor and row in one transaction (a crash injected between them leaves neither), budgets, two accounts with one failing, a moved message keeps its row | `test/connectors/imap.test.ts` |
| FT-11 | backfill: a stub becomes a full message; another message at that UID or a gone UID gives `stub: "gone"`; a stub never replaces a full message | `test/connectors/imap-backfill.test.ts` |
| FT-12 | contract: every command of section 6 on the compiled executable, field by field; stdout is one JSON value; read schema 1 columns present | `test/contract/*.test.ts` |
| FT-13 | `imap check` statuses; no database file created | `test/commands/imap.test.ts` |
| FT-14 (macOS, manual until a mac job exists) | the darwin executables start signed with the hardened runtime and load the two libraries given by `TRAUL_SQLITE_LIB` / `TRAUL_SQLITE_VEC` | the consumer's spike S-1, S-2 |

## 9. Upstream

`main` of the fork is upstream plus these PRs, merged from `dandaka/traul` when it moves; Triage pins a commit, so a merge
changes nothing for it until its lock moves. F1 to F6 are of general use and can be offered upstream PR by PR (the owner's
call); the default-backend change of F3 and `index.triage.ts` are the fork's own.

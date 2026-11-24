import { Command } from "commander";
import { TraulDB } from "./db/database";
import { loadConfig, ensureDbDir, type TraulConfig } from "./lib/config";
import { setVerbose } from "./lib/logger";
import { runSync } from "./commands/sync";
import { runSearch } from "./commands/search";
import { runMessages } from "./commands/messages";
import { runChannels } from "./commands/channels";
import { runEmbed } from "./commands/embed";
import { runStats } from "./commands/stats";
import { runDaemonStart, runDaemonStop, runDaemonStatus } from "./commands/daemon";
import { runSql, runSchema } from "./commands/sql";
import { runGet } from "./commands/get";
import { runReset } from "./commands/reset";
import { runMigrations } from "./db/migrations";
import { registerImapCommands } from "./commands/imap";
import { registerImportCommand } from "./commands/import";
import { runSyncJson } from "./commands/sync-json";
import { runEmbedJson } from "./commands/embed-json";
import { VERSION } from "./lib/version";
import { checkReadSchema, contractInfo, DbNewerError } from "./lib/contract";

/** Shared by both entry points (src/index.ts and src/index.triage.ts). */
export function bootstrap(): { config: TraulConfig; db: TraulDB } {
  const config = loadConfig();
  ensureDbDir(config.database.path);
  const db = new TraulDB(config.database.path);
  try {
    checkReadSchema(db);
  } catch (err) {
    if (!(err instanceof DbNewerError)) throw err;
    console.error(err.message);
    process.exit(3);
  }
  runMigrations(db);
  return { config, db };
}

/**
 * `traul --contract` and `traul imap ...` need no database: run it before bootstrap() so that no database file is created.
 * Returns true when it handled the command line.
 */
export async function runDatabaseFree(argv: string[]): Promise<boolean> {
  if (argv[2] === "--contract") {
    process.stdout.write(JSON.stringify(contractInfo()) + "\n");
    return true;
  }
  if (argv[2] !== "imap") return false;
  const program = newProgram();
  registerImapCommands(program, loadConfig());
  await program.parseAsync(argv);
  return true;
}

export function newProgram(): Command {
  const program = new Command();

  program
    .name("traul")
    .description("Traul — Personal Intelligence Engine")
    .version(VERSION)
    .option("-v, --verbose", "enable verbose output")
    .hook("preAction", () => {
      if (program.opts().verbose) {
        setVerbose(true);
      }
    });

  return program;
}

export function registerReadCommands(program: Command, db: TraulDB, config: TraulConfig): void {
  program
    .command("sync")
    .description("Sync messages from communication sources")
    .argument("[source]", "source to sync (e.g. slack)")
    .option("--json", "print one JSON report on stdout (imap and archive only; logs go to stderr)")
    .action(async (source: string | undefined, options) => {
      if (options.json) process.exitCode = await runSyncJson(db, config, source);
      else await runSync(db, config, source);
      db.close();
    });

  program
    .command("search")
    .description(
      "Search messages (hybrid vector+keyword by default, requires Ollama)"
    )
    .argument("[query]", "search query (natural language or keywords)")
    .option("-s, --source <source>", "filter by source")
    .option("-c, --channel <channel>", "filter by channel name")
    .option("-a, --after <date>", "messages after date (ISO 8601)")
    .option("-b, --before <date>", "messages before date (ISO 8601)")
    .option("--from <date>", "alias for --after")
    .option("--to <date>", "alias for --before")
    .option("--start <date>", "alias for --after")
    .option("--end <date>", "alias for --before")
    .option("-l, --limit <n>", "max results", "20")
    .option("--json", "output as JSON")
    .option(
      "--fts",
      "keyword-only search (FTS5/BM25, no vector search). Faster but requires all terms to match — use hybrid for multi-word or exploratory queries"
    )
    .option("--envelope", "output {vector, results} as one JSON value (Triage contract)")
    .option("--query-stdin", "read the query from stdin, not from the command line")
    .option("--content", "with --envelope: add the full text of each result")
    .option("--or", "join search terms with OR instead of AND (use with --fts)")
    .option(
      "--like",
      "substring match (LIKE) — bypasses FTS, useful for exact phrases"
    )
    .action(async (query: string | undefined, options) => {
      options.after = options.after || options.from || options.start;
      options.before = options.before || options.to || options.end;
      await runSearch(db, query, options);
      db.close();
    });

  program
    .command("messages")
    .description("Browse messages chronologically")
    .argument("[channel]", "channel name (exact match)")
    .option("-c, --channel <name>", "channel name (substring match)")
    .option("-a, --author <name>", "filter by author name")
    .option("-s, --source <source>", "filter by source (telegram, slack)")
    .option("--after <date>", "messages after ISO date")
    .option("--before <date>", "messages before ISO date")
    .option("--from <date>", "alias for --after")
    .option("--to <date>", "alias for --before")
    .option("--start <date>", "alias for --after")
    .option("--end <date>", "alias for --before")
    .option("-l, --limit <n>", "max results (default: 50)")
    .option("--json", "output as JSON")
    .option("--asc", "oldest first")
    .action(async (channel: string | undefined, options) => {
      options.after = options.after || options.from || options.start;
      options.before = options.before || options.to || options.end;
      await runMessages(db, channel, options);
      db.close();
    });

  program
    .command("get")
    .description("Get full thread/conversation by thread ID")
    .argument("[thread-id]", "thread ID (e.g. Claude Code session UUID)")
    .option("-d, --date <date>", "get all threads from a date (ISO 8601)")
    .option("--json", "output as JSON")
    .action(async (threadId: string | undefined, options) => {
      await runGet(db, threadId, options);
      db.close();
    });

  program
    .command("channels")
    .description("List known channels with message counts")
    .option("-s, --source <source>", "filter by source")
    .option("--search <term>", "substring search in channel name")
    .option("--json", "output as JSON")
    .action(async (options) => {
      await runChannels(db, options);
      db.close();
    });

  program
    .command("stats")
    .description("Show database statistics")
    .option("--json", "output as JSON")
    .action(async (options) => {
      await runStats(db, config, options);
      db.close();
    });
}

export function registerMaintenanceCommands(program: Command, db: TraulDB): void {
  program
    .command("embed")
    .description("Generate vector embeddings for messages (requires Ollama)")
    .option("-l, --limit <n>", "max messages to embed per run (0 = all)", "500")
    .option("-q, --quiet", "minimal output")
    .option("--json", "print one JSON value {state, embedded, failed, pending, model, dims}")
    .option("--rechunk", "re-chunk long messages that were embedded whole (pre-chunking)")
    .action(async (options) => {
      if (options.json) await runEmbedJson(db, options);
      else await runEmbed(db, options);
      db.close();
    });

  program
    .command("reset")
    .description("Reset a data layer (sync, chunks, embed, all)")
    .argument("<layer>", "layer to reset: sync, chunks, embed, all")
    .option("-s, --source <source>", "filter by source (for sync layer)")
    .action(async (layer: string, options) => {
      runReset(db, layer, options);
      db.close();
    });

  program
    .command("reset-embed")
    .description("(deprecated: use 'traul reset embed') Drop all embeddings")
    .action(async () => {
      console.log("Note: 'reset-embed' is deprecated, use 'traul reset embed' instead.");
      runReset(db, "embed", {});
      db.close();
    });

  program
    .command("sql")
    .description("Execute a read-only SQL query against the database")
    .argument("<query>", "SQL query (SELECT, PRAGMA, WITH, EXPLAIN only)")
    .option("--json", "output as JSON (default)")
    .option("--write", "allow write operations (INSERT, UPDATE, DELETE, etc.)")
    .action(async (query: string, options) => {
      const result = runSql(db, query, { write: options.write });
      if (options.json !== false) {
        const output = JSON.stringify(result, null, 2);
        process.stdout.write(output + "\n");
      } else {
        if (Array.isArray(result)) {
          console.table(result);
        } else {
          console.log(`${result.changes} row(s) affected`);
        }
      }
      db.close();
    });

  program
    .command("schema")
    .description("Show database schema (tables and columns)")
    .option("--json", "output as JSON")
    .action(async (options) => {
      const tables = runSchema(db);
      if (options.json) {
        const output = JSON.stringify(tables, null, 2);
        process.stdout.write(output + "\n");
      } else {
        for (const t of tables) {
          console.log(`\n${t.name} (${t.type})`);
          if (t.columns.length > 0) {
            for (const c of t.columns) {
              const pk = c.pk ? " PK" : "";
              const nn = c.notnull ? " NOT NULL" : "";
              console.log(`  ${c.name} ${c.type}${pk}${nn}`);
            }
          }
        }
      }
      db.close();
    });
}

export function registerDaemonCommands(program: Command, db: TraulDB, config: TraulConfig): void {
  const daemon = program
    .command("daemon")
    .description("Background sync daemon");

  daemon
    .command("start", { isDefault: true })
    .description("Start the daemon (foreground by default)")
    .option("--detach", "run in background")
    .action(async (options) => {
      await runDaemonStart(db, config, options);
    });

  daemon
    .command("stop")
    .description("Stop the running daemon")
    .action(() => {
      runDaemonStop();
    });

  daemon
    .command("status")
    .description("Check daemon status")
    .action(async () => {
      await runDaemonStatus(config);
      process.exit(0);
    });
}

import type { Command } from "commander";
import type { ImapAccount, TraulConfig } from "../lib/config";
import { assertImapConfig, ImapConfigError } from "../lib/imap-config";
import { ImapError, type ImapErrorCode } from "../lib/imap/protocol";
import { openSession, type Session, type SessionFactory } from "../lib/imap/session";
import { resolveSecret } from "../lib/secrets";
import { resolveFolders } from "../connectors/imap-folders";
import { sessionOptions } from "../connectors/imap-sync";

/** `traul imap check` and `traul imap folders`: connect and look, fetch nothing, open no database. */

export interface ImapCommandDeps {
  openSession?: SessionFactory;
  commandTimeoutMs?: number;
}
export interface CheckResult { account: string; status: "ok" | ImapErrorCode }
export interface FoldersResult { account: string; folders: string[] }

function pickAccount(config: TraulConfig, name: string): ImapAccount {
  assertImapConfig(config.imap);
  const found = config.imap.accounts.find((a) => a.name === name);
  if (!found) throw new ImapConfigError([`no account named in --account`]);
  return found;
}

/** Open the account's session, or the code that says why not. */
async function connect(config: TraulConfig, a: ImapAccount, deps: ImapCommandDeps): Promise<Session | ImapErrorCode> {
  const secret = await resolveSecret(a.password_secret, { keychainService: config.imap.keychain_service });
  if (!secret.ok) return secret.code;
  try {
    const o = { ...sessionOptions(a, secret.value, config.imap), commandTimeoutMs: deps.commandTimeoutMs };
    return await (deps.openSession ?? openSession)(o);
  } catch (err) {
    if (err instanceof ImapError) return err.code;
    throw err;
  }
}

async function examineAll(session: Session, a: ImapAccount): Promise<CheckResult["status"]> {
  for (const f of await resolveFolders(session, a.folders)) await session.examine(f);
  return "ok";
}

export async function runImapCheck(config: TraulConfig, name: string, deps: ImapCommandDeps = {}): Promise<CheckResult> {
  const a = pickAccount(config, name);
  const session = await connect(config, a, deps);
  if (typeof session === "string") return { account: a.name, status: session };
  try {
    return { account: a.name, status: await examineAll(session, a) };
  } catch (err) {
    if (!(err instanceof ImapError)) throw err;
    return { account: a.name, status: err.code };
  } finally {
    await session.close();
  }
}

export async function runImapFolders(config: TraulConfig, name: string, deps: ImapCommandDeps = {}): Promise<FoldersResult | CheckResult> {
  const a = pickAccount(config, name);
  const session = await connect(config, a, deps);
  if (typeof session === "string") return { account: a.name, status: session };
  try {
    return { account: a.name, folders: (await session.list()).map((f) => f.name) };
  } catch (err) {
    if (!(err instanceof ImapError)) throw err;
    return { account: a.name, status: err.code };
  } finally {
    await session.close();
  }
}

function print(result: object, json: boolean): void {
  if (json) { console.log(JSON.stringify(result)); return; }
  const r = result as Partial<CheckResult & FoldersResult>;
  console.log(r.folders ? r.folders.join("\n") : `${r.account}: ${r.status}`);
}

/** Exit 0 when the command ran (read the status), 2 for a bad configuration. */
async function guarded(fn: () => Promise<object>, json: boolean): Promise<void> {
  try {
    print(await fn(), json);
  } catch (err) {
    if (!(err instanceof ImapConfigError)) throw err;
    console.error(err.message);
    process.exitCode = 2;
  }
}

export function registerImapCommands(program: Command, config: TraulConfig, deps: ImapCommandDeps = {}): void {
  const imap = program.command("imap").description("Read-only IMAP checks (no database is opened)");
  imap.command("check")
    .description("Connect, log in and examine each configured folder; prints a status code")
    .requiredOption("--account <name>", "account name from the imap section")
    .option("--json", "output JSON")
    .action((o) => guarded(() => runImapCheck(config, o.account, deps), !!o.json));
  imap.command("folders")
    .description("List the folder names of an account")
    .requiredOption("--account <name>", "account name from the imap section")
    .option("--json", "output JSON")
    .action((o) => guarded(() => runImapFolders(config, o.account, deps), !!o.json));
}

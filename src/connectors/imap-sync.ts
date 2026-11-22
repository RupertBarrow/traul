import type { TraulDB } from "../db/database";
import type { ImapAccount, ImapConfig, TraulConfig } from "../lib/config";
import { assertImapConfig } from "../lib/imap-config";
import { ImapError, type ImapErrorCode } from "../lib/imap/protocol";
import { openSession, type Session, type SessionFactory, type SessionOptions } from "../lib/imap/session";
import { resolveSecret as defaultResolveSecret } from "../lib/secrets";
import { resolveFolders } from "./imap-folders";
import { buildRow, keyOf, type ImapRow, type Locator } from "./imap-row";

/** The imap sync (docs/triage-fork/SPEC.md, 5.5): per-folder UIDVALIDITY/UID cursors, budgets, backfill of stubs. */

export interface FolderReport {
  folder: string;
  uidValidity: number | null;
  lastUid: number;
  added: number;
  updated: number;
  backfilled: number;
  gone: number;
  skipped: number;
  /** Set when the folder stopped early. */
  code?: ImapErrorCode;
}
export interface AccountReport { name: string; status: "ok" | ImapErrorCode; folders: FolderReport[] }
export interface ImapReport { source: "imap"; accounts: AccountReport[] }

export interface SyncDeps {
  openSession?: SessionFactory;
  resolveSecret?: typeof defaultResolveSecret;
  now?: () => number;
  /** Test seam: runs inside the transaction, after the row and before the cursor. */
  beforeCursor?: () => void;
}

interface Ctx {
  db: TraulDB;
  cfg: ImapConfig;
  syncStart: Date;
  deps: Required<Pick<SyncDeps, "openSession" | "resolveSecret" | "now">> & Pick<SyncDeps, "beforeCursor">;
  budget: { left: number; deadline: number };
  account: ImapAccount;
  session: Session;
  backfillLeft: number;
}

const MAX_FAILURES = 3;
const cursorKey = (account: string, folder: string) => `${account}|${folder}`;
const failKey = (at: Locator) => `imap_fail:${at.account}|${at.folder}|${at.uidValidity}|${at.uid}`;
const exhausted = (c: Ctx) => c.budget.left <= 0 || c.deps.now() >= c.budget.deadline;

function readCursor(db: TraulDB, account: string, folder: string): { uidValidity: number; lastUid: number } | null {
  try {
    const v = JSON.parse(db.getSyncCursor("imap", cursorKey(account, folder)) ?? "null");
    return v && Number.isInteger(v.uidValidity) && Number.isInteger(v.lastUid) ? v : null;
  } catch {
    return null;
  }
}

/** The row (if any) and the cursor move in one transaction, so the cursor never passes an unstored message. */
function commit(c: Ctx, at: Locator, row: ImapRow | null): boolean {
  return c.db.inTransaction(() => {
    const existed = row ? c.db.hasMessage("imap", row.source_id) : false;
    if (row) c.db.upsertMessage(row);
    c.deps.beforeCursor?.();
    c.db.setSyncCursor("imap", cursorKey(at.account, at.folder), JSON.stringify({ uidValidity: at.uidValidity, lastUid: at.uid }));
    return existed;
  });
}

type Fetch = { ok: true; row: ImapRow | null } | { ok: false; code: ImapErrorCode };

async function tryFetch(c: Ctx, at: Locator): Promise<Fetch> {
  try {
    const f = await c.session.fetch(at.uid);
    return { ok: true, row: f ? buildRow(f, at, c.cfg.max_text_chars) : null };
  } catch (err) {
    return { ok: false, code: err instanceof ImapError ? err.code : "protocol" };
  }
}

/** A failed UID stops the folder; the third failure in a row is skipped and passed. */
function failed(c: Ctx, at: Locator, rep: FolderReport, code: ImapErrorCode): boolean {
  const n = Number(c.db.getMeta(failKey(at)) ?? 0) + 1;
  if (n < MAX_FAILURES) {
    c.db.setMeta(failKey(at), String(n));
    rep.code = code;
    return false;
  }
  c.db.deleteMeta(failKey(at));
  commit(c, at, null);
  rep.skipped++;
  rep.lastUid = at.uid;
  return true;
}

/** Returns false when the folder must stop. */
async function processUid(c: Ctx, at: Locator, rep: FolderReport): Promise<boolean> {
  const got = await tryFetch(c, at);
  if (!got.ok) return failed(c, at, rep, got.code);
  c.budget.left--;
  const existed = commit(c, at, got.row);
  c.db.deleteMeta(failKey(at));
  if (!got.row) rep.gone++;
  else if (existed) rep.updated++;
  else rep.added++;
  rep.lastUid = at.uid;
  return true;
}

async function newMail(c: Ctx, folder: string, validity: number, rep: FolderReport): Promise<void> {
  const cur = readCursor(c.db, c.account.name, folder);
  const live = cur && cur.uidValidity === validity ? cur : null;
  rep.lastUid = live?.lastUid ?? 0;
  const found = live ? await c.session.searchAfter(live.lastUid) : await c.session.searchSince(c.syncStart);
  for (const uid of [...new Set(found)].sort((a, b) => a - b)) {
    if (exhausted(c)) return;
    if (!(await processUid(c, { account: c.account.name, folder, uidValidity: validity, uid }, rep))) return;
  }
}

/** Fetch the stub's message; it replaces the stub only when it yields the stub's own key. */
async function fillStub(c: Ctx, stub: { source_id: string; metadata: string }, at: Locator, rep: FolderReport): Promise<boolean> {
  let fetched;
  try {
    fetched = Number.isInteger(at.uid) ? await c.session.fetch(at.uid) : null;
  } catch {
    return false; // the connection is not usable; the stub waits for the next run
  }
  c.budget.left--;
  if (!fetched || keyOf(fetched.raw, at) !== stub.source_id) {
    c.db.markImapStubGone(stub.source_id);
    rep.gone++;
  } else {
    c.db.upsertMessage(buildRow(fetched, at, c.cfg.max_text_chars));
    rep.backfilled++;
  }
  return true;
}

async function backfill(c: Ctx, folder: string, validity: number, rep: FolderReport): Promise<void> {
  const room = Math.min(c.backfillLeft, c.budget.left);
  if (room <= 0) return;
  for (const stub of c.db.getImapStubs(c.account.name, folder, validity, room)) {
    if (exhausted(c)) return;
    c.backfillLeft--;
    const uid = JSON.parse(stub.metadata).uid;
    if (!(await fillStub(c, stub, { account: c.account.name, folder, uidValidity: validity, uid }, rep))) return;
  }
}

async function syncFolder(c: Ctx, folder: string): Promise<FolderReport> {
  const rep: FolderReport = { folder, uidValidity: null, lastUid: 0, added: 0, updated: 0, backfilled: 0, gone: 0, skipped: 0 };
  try {
    const validity = (await c.session.examine(folder)) ?? 0;
    rep.uidValidity = validity;
    await newMail(c, folder, validity, rep);
    if (!rep.code) await backfill(c, folder, validity, rep);
  } catch (err) {
    if (!(err instanceof ImapError)) throw err;
    rep.code = err.code;
  }
  return rep;
}

async function syncFolders(c: Ctx): Promise<AccountReport> {
  const name = c.account.name;
  try {
    const folders: FolderReport[] = [];
    for (const f of await resolveFolders(c.session, c.account.folders)) folders.push(await syncFolder(c, f));
    return { name, status: folders.find((f) => f.code)?.code ?? "ok", folders };
  } catch (err) {
    if (!(err instanceof ImapError)) throw err;
    return { name, status: err.code, folders: [] };
  }
}

export function sessionOptions(a: ImapAccount, password: string, cfg: ImapConfig): SessionOptions {
  const tls = a.tls ?? "implicit";
  return { host: a.host, port: a.port ?? (tls === "implicit" ? 993 : 143), tls, user: a.user, password, maxBodyBytes: cfg.max_body_bytes };
}

async function syncAccount(shared: Omit<Ctx, "account" | "session" | "backfillLeft">, account: ImapAccount): Promise<AccountReport> {
  const secret = await shared.deps.resolveSecret(account.password_secret, { keychainService: shared.cfg.keychain_service });
  if (!secret.ok) return { name: account.name, status: secret.code, folders: [] };
  let session: Session;
  try {
    session = await shared.deps.openSession(sessionOptions(account, secret.value, shared.cfg));
  } catch (err) {
    if (!(err instanceof ImapError)) throw err;
    return { name: account.name, status: err.code, folders: [] };
  }
  try {
    return await syncFolders({ ...shared, account, session, backfillLeft: shared.cfg.backfill_per_run });
  } finally {
    await session.close();
  }
}

/** `sync_start` of the imap section, else the global one, else 30 days ago. */
export function syncStartDate(cfg: ImapConfig, config: TraulConfig, now: number): Date {
  for (const raw of [cfg.sync_start, config.sync_start]) {
    const ms = raw ? Date.parse(raw) : NaN;
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return new Date(now - 30 * 86_400_000);
}

export async function syncImap(db: TraulDB, config: TraulConfig, deps: SyncDeps = {}): Promise<ImapReport> {
  const cfg = config.imap;
  assertImapConfig(cfg);
  const now = deps.now ?? Date.now;
  const shared = {
    db, cfg, syncStart: syncStartDate(cfg, config, now()),
    deps: { openSession: deps.openSession ?? openSession, resolveSecret: deps.resolveSecret ?? defaultResolveSecret, now, beforeCursor: deps.beforeCursor },
    budget: { left: cfg.max_messages_per_run, deadline: now() + cfg.max_run_seconds * 1000 },
  };
  const accounts: AccountReport[] = [];
  for (const account of cfg.accounts) accounts.push(await syncAccount(shared, account));
  return { source: "imap", accounts };
}

import type { TraulDB } from "../db/database";
import { getConnectorNames } from "../connectors/registry";
import { VERSION } from "./version";

/** The Triage contract numbers (docs/triage-fork/CONTRACT.md). Within a number things are only added. */
export const CONTRACT = 1;
export const READ_SCHEMA = 1;

/** Replaced at build time by scripts/build-triage.sh (`--define`); "dev" when run from source. */
declare const TRAUL_BUILD_COMMIT: string | undefined;
const commit = (): string => (typeof TRAUL_BUILD_COMMIT === "string" ? TRAUL_BUILD_COMMIT : "dev");

export function contractInfo(): { contract: number; readSchema: number; version: string; commit: string; connectors: string[] } {
  return { contract: CONTRACT, readSchema: READ_SCHEMA, version: VERSION, commit: commit(), connectors: getConnectorNames() };
}

/** Thrown when the database was written by an executable with a newer read schema. */
export class DbNewerError extends Error {
  constructor(readonly found: number) {
    super(`database read schema ${found} is newer than this executable (${READ_SCHEMA})`);
    this.name = "DbNewerError";
  }
}

/** Refuse a database of a newer read schema; otherwise record ours. Call right after opening. */
export function checkReadSchema(db: TraulDB): void {
  const stored = db.getMeta("read_schema");
  const found = stored === null ? 0 : Number(stored);
  if (found > READ_SCHEMA) throw new DbNewerError(found);
  if (found !== READ_SCHEMA) db.setMeta("read_schema", String(READ_SCHEMA));
}

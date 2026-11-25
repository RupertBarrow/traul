import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { configPath, dbPath, ensureDir } from "./paths";
import { DEFAULT_PORT, DEFAULT_EMBED_INTERVAL, type DaemonConfig, type DaemonIntervals } from "../daemon/types";

export interface EmbeddingsConfig {
  backend: "ollama" | "llama";
  url: string;
  /** Empty means the backend's default model. */
  model: string;
  dims: number;
  keep_alive: string;
  timeout_ms: number;
  /** Honoured from the config file only, never from the environment. */
  allow_remote: boolean;
}

export interface ImapAccount {
  name: string;
  host: string;
  port?: number;
  /** implicit (default), starttls, or plain (loopback hosts only). */
  tls?: "implicit" | "starttls" | "plain";
  user: string;
  /** NAME of the secret (environment variable or Keychain account); the file never holds a password. */
  password_secret: string;
  /** Names or patterns (`*`, `?`, `/` as the separator); absent means INBOX. */
  folders?: string[];
}

export interface ImapConfig {
  keychain_service: string;
  sync_start: string;
  max_body_bytes: number;
  max_text_chars: number;
  max_messages_per_run: number;
  max_run_seconds: number;
  backfill_per_run: number;
  accounts: ImapAccount[];
}

export interface WhatsappInstance {
  name: string;
  url: string;
  api_key: string;
  /** NAME of the WAHA API key (environment, then the Keychain); `api_key` given directly wins. */
  api_key_secret?: string;
  session: string;
  chats: string[];
}

export interface FacebookPage {
  /** Account name: the prefix of every `source_id` and cursor key. */
  name: string;
  page_id: string;
  /** NAME of the Page access token (environment, then the Keychain of `facebook.keychain_service`). */
  token_secret: string;
}

export interface FacebookConfig {
  graph_version: string;
  keychain_service: string;
  pages: FacebookPage[];
}

export interface TraulConfig {
  sync_start: string;
  database: {
    path: string;
  };
  slack: {
    token: string;
    cookie: string;
    my_user_id: string;
    channels: string[];
    /** Secret NAMES (environment, then the Keychain of `keychain_service` on macOS); a `token` given directly wins. */
    token_secret?: string;
    cookie_secret?: string;
    keychain_service?: string;
  };
  telegram: {
    api_id: string;
    api_hash: string;
    session_path: string;
    chats: string[];
  };
  linear: {
    api_key: string;
    teams: string[];
    workspaces: Array<{ name: string; api_key: string; teams: string[] }>;
  };
  markdown: {
    dirs: string[];
  };
  gmail: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    accounts: Array<{ name: string; labels: string[] }>;
  };
  whatsapp: {
    /** Keychain service for `api_key_secret` (macOS); empty: environment only. */
    keychain_service?: string;
    instances: WhatsappInstance[];
  };
  facebook: FacebookConfig;
  discord: {
    token: string;
    servers: {
      allowlist: string[];
      stoplist: string[];
    };
    channels: {
      allowlist: string[];
      stoplist: string[];
    };
  };
  imap: ImapConfig;
  embeddings: EmbeddingsConfig;
  daemon: DaemonConfig;
}

export function defaultImapConfig(): ImapConfig {
  return {
    keychain_service: "", sync_start: "", max_body_bytes: 262144, max_text_chars: 100000,
    max_messages_per_run: 100, max_run_seconds: 120, backfill_per_run: 50, accounts: [],
  };
}

function getDefaultConfig(): TraulConfig {
  return {
    sync_start: "",
    database: { path: dbPath() },
    slack: { token: "", cookie: "", my_user_id: "", channels: [] },
    telegram: { api_id: "", api_hash: "", session_path: "", chats: [] },
    linear: { api_key: "", teams: [], workspaces: [] },
    markdown: { dirs: [] },
    gmail: { client_id: "", client_secret: "", refresh_token: "", accounts: [] },
    whatsapp: { instances: [] },
    facebook: { graph_version: "v26.0", keychain_service: "", pages: [] },
    discord: {
      token: "",
      servers: { allowlist: [], stoplist: [] },
      channels: { allowlist: [], stoplist: [] },
    },
    imap: defaultImapConfig(),
    embeddings: {
      backend: "ollama", url: "http://127.0.0.1:11434", model: "", dims: 1024,
      keep_alive: "60s", timeout_ms: 30000, allow_remote: false,
    },
    daemon: { port: DEFAULT_PORT, intervals: { embed: DEFAULT_EMBED_INTERVAL } },
  };
}

export function deepMerge(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === null || srcVal === undefined) continue;
    if (
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key]) &&
      target[key] !== null
    ) {
      deepMerge(target[key], srcVal);
    } else {
      target[key] = srcVal;
    }
  }
}

export function loadConfig(): TraulConfig {
  const defaults = getDefaultConfig();

  let parsed: any = {};
  const cfgPath = configPath();
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, "utf-8");
      parsed = JSON.parse(raw);
      _rawParsed = parsed;
      deepMerge(defaults, parsed);
    } catch {
      // ignore malformed config, use defaults
    }
  }
  defaults.daemon = loadDaemonConfig(parsed);

  // Env var overrides
  if (process.env.TRAUL_DB_PATH) {
    defaults.database.path = process.env.TRAUL_DB_PATH;
  }
  // Slack token: SLACK_TOKEN > SLACK_BOT_TOKEN > SLACK_USER_TOKEN > SLACK_TOKEN_*
  defaults.slack.token =
    process.env.SLACK_TOKEN ??
    process.env.SLACK_BOT_TOKEN ??
    process.env.SLACK_USER_TOKEN ??
    defaults.slack.token;
  defaults.slack.cookie = process.env.SLACK_COOKIE ?? defaults.slack.cookie;

  // Fallback: pick up SLACK_TOKEN_<WORKSPACE> / SLACK_COOKIE_<WORKSPACE> from /slack skill
  if (!defaults.slack.token) {
    for (const [key, val] of Object.entries(process.env)) {
      if (key.startsWith("SLACK_TOKEN_") && val) {
        defaults.slack.token = val;
        const suffix = key.replace("SLACK_TOKEN_", "");
        defaults.slack.cookie = process.env[`SLACK_COOKIE_${suffix}`] ?? "";
        break;
      }
    }
  }
  if (process.env.TELEGRAM_API_ID) {
    defaults.telegram.api_id = process.env.TELEGRAM_API_ID;
  }
  if (process.env.TELEGRAM_API_HASH) {
    defaults.telegram.api_hash = process.env.TELEGRAM_API_HASH;
  }
  defaults.linear.api_key = process.env.LINEAR_API_KEY ?? defaults.linear.api_key;
  // Gmail: GMAIL_CREDS_JSON (combined) or individual env vars
  if (process.env.GMAIL_CREDS_JSON) {
    try {
      const creds = JSON.parse(process.env.GMAIL_CREDS_JSON);
      defaults.gmail.client_id = creds.client_id ?? defaults.gmail.client_id;
      defaults.gmail.client_secret = creds.client_secret ?? defaults.gmail.client_secret;
      defaults.gmail.refresh_token = creds.refresh_token ?? defaults.gmail.refresh_token;
    } catch {}
  }
  defaults.gmail.client_id = process.env.GMAIL_CLIENT_ID ?? defaults.gmail.client_id;
  defaults.gmail.client_secret = process.env.GMAIL_CLIENT_SECRET ?? defaults.gmail.client_secret;
  defaults.gmail.refresh_token = process.env.GMAIL_REFRESH_TOKEN ?? defaults.gmail.refresh_token;
  defaults.discord.token = process.env.DISCORD_TOKEN ?? defaults.discord.token;
  // Collect all LINEAR_API_KEY_<WORKSPACE> env vars into workspaces
  const envWorkspaceNames = new Set(defaults.linear.workspaces.map((w) => w.name));
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith("LINEAR_API_KEY_") && val) {
      const name = key.replace("LINEAR_API_KEY_", "").toLowerCase();
      if (!defaults.linear.api_key) {
        defaults.linear.api_key = val;
      }
      if (!envWorkspaceNames.has(name)) {
        defaults.linear.workspaces.push({ name, api_key: val, teams: [] });
        envWorkspaceNames.add(name);
      }
    }
  }

  return defaults;
}

export function getSyncStartTimestamp(config: TraulConfig, connector?: string): string {
  // Check per-connector sync_start first
  let raw = "";
  if (connector) {
    const section = _rawParsed[connector];
    if (section?.sync_start) raw = section.sync_start;
  }
  if (!raw) raw = config.sync_start;
  if (!raw) {
    // Default: 30 days ago
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return String(Math.floor(thirtyDaysAgo / 1000));
  }
  const ts = Math.floor(new Date(raw).getTime() / 1000);
  if (isNaN(ts)) return "0";
  return String(ts);
}

/**
 * Returns the effective sync start timestamp, respecting config changes.
 * If sync_start from config is earlier than the existing cursor, uses sync_start (backfill).
 * This ensures that moving sync_start to an earlier date in config takes effect.
 */
export function getEffectiveSyncStart(
  db: { getSyncCursor(source: string, key: string): string | null },
  config: TraulConfig,
  source: string,
  cursorKey: string,
  connector?: string,
): string | undefined {
  const cursor = db.getSyncCursor(source, cursorKey);
  const syncStart = getSyncStartTimestamp(config, connector);

  if (!cursor) {
    return syncStart !== "0" ? syncStart : undefined;
  }

  // If sync_start is earlier than cursor, backfill from sync_start
  if (syncStart !== "0" && parseInt(syncStart) < parseInt(cursor)) {
    return syncStart;
  }

  return cursor;
}

/** Raw parsed config for per-connector overrides */
let _rawParsed: Record<string, any> = {};
export function getRawParsedConfig(): Record<string, any> {
  return _rawParsed;
}
export function setRawParsedConfig(val: Record<string, any>): void {
  _rawParsed = val;
}

export function ensureDbDir(dbPath: string): void {
  ensureDir(dirname(dbPath));
}

export function saveDefaultConfig(): void {
  const cfgPath = configPath();
  if (!existsSync(cfgPath)) {
    ensureDir(dirname(cfgPath));
    writeFileSync(cfgPath, JSON.stringify(getDefaultConfig(), null, 2));
  }
}

export function loadDaemonConfig(parsed: Record<string, any>): DaemonConfig {
  const daemon = parsed?.daemon ?? {};
  const intervals: DaemonIntervals = { embed: DEFAULT_EMBED_INTERVAL };

  // Merge user-configured intervals (any connector name is valid)
  if (daemon.intervals && typeof daemon.intervals === "object") {
    for (const [key, val] of Object.entries(daemon.intervals)) {
      if (typeof val === "number") {
        intervals[key] = val;
      }
    }
  }

  return {
    port: typeof daemon.port === "number" ? daemon.port : DEFAULT_PORT,
    intervals,
  };
}

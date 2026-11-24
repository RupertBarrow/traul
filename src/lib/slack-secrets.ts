import type { TraulConfig } from "./config";
import { resolveSecret, type SecretOptions } from "./secrets";

/**
 * Slack credentials by NAME (as for IMAP): `slack.token_secret` / `slack.cookie_secret` name an environment variable or,
 * on macOS with `slack.keychain_service`, a Keychain item. A token already in the config or the environment wins.
 * Returns where the token came from, never the value.
 */
export async function resolveSlackCredentials(config: TraulConfig, opts: SecretOptions = {}): Promise<"config" | "env" | "keychain" | "none"> {
  const s = config.slack;
  if (s.token) return "config";
  if (!s.token_secret) return "none";
  const o = { keychainService: s.keychain_service ?? "", ...opts };
  const token = await resolveSecret(s.token_secret, o);
  if (!token.ok) return "none";
  s.token = token.value;
  if (!s.cookie && s.cookie_secret) {
    const cookie = await resolveSecret(s.cookie_secret, o);
    if (cookie.ok) s.cookie = cookie.value;
  }
  return token.source;
}

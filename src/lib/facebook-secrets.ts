import type { TraulConfig } from "./config";
import { resolveSecret, type SecretOptions } from "./secrets";

/**
 * Page access tokens by NAME (`pages[].token_secret`: environment, then the Keychain of `facebook.keychain_service`).
 * Returns page name -> token for the pages that resolved; the config never holds a token.
 */
export async function resolveFacebookTokens(config: TraulConfig, opts: SecretOptions = {}): Promise<Map<string, string>> {
  const fb = config.facebook;
  const o = { keychainService: fb?.keychain_service ?? "", ...opts };
  const out = new Map<string, string>();
  for (const p of fb?.pages ?? []) {
    const t = await resolveSecret(p.token_secret, o);
    if (t.ok) out.set(p.name, t.value);
  }
  return out;
}

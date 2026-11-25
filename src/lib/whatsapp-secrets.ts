import type { TraulConfig } from "./config";
import { resolveSecret, type SecretOptions } from "./secrets";

/**
 * WAHA API keys by NAME: an instance's `api_key_secret` names an environment variable or, on macOS with
 * `whatsapp.keychain_service`, a Keychain item. A key given directly wins; an instance with no name needs no key.
 * Returns false when a named key does not resolve. Never returns or logs a value.
 */
export async function resolveWhatsappKeys(config: TraulConfig, opts: SecretOptions = {}): Promise<boolean> {
  const o = { keychainService: config.whatsapp.keychain_service ?? "", ...opts };
  let ok = true;
  for (const inst of config.whatsapp.instances) {
    if (inst.api_key || !inst.api_key_secret) continue;
    const key = await resolveSecret(inst.api_key_secret, o);
    if (key.ok) inst.api_key = key.value;
    else ok = false;
  }
  return ok;
}

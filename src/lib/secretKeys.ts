/**
 * Config-bound keyrings for secrets encrypted at rest.
 *
 * Each secret family has one active write key plus optional legacy
 * decrypt-only keys so a key rotation never requires every row to change
 * atomically with a single environment update. See docs/secret-key-rotation.md.
 */
import { config } from "../config.js";
import { buildKeyring, parseKeyList, type SecretKeyring } from "../utils/crypto.js";

type KeyConfig = {
  SIGNING_SECRET_KEY?: string;
  SIGNING_SECRET_LEGACY_KEYS?: string;
  WEBHOOK_ENCRYPTION_KEY?: string;
  WEBHOOK_ENCRYPTION_LEGACY_KEYS?: string;
};

/** Keyring for per-publisher signing secrets; null when SIGNING_SECRET_KEY is unset. */
export function signingKeyring(cfg: KeyConfig = config): SecretKeyring | null {
  if (!cfg.SIGNING_SECRET_KEY) return null;
  return buildKeyring(cfg.SIGNING_SECRET_KEY, parseKeyList(cfg.SIGNING_SECRET_LEGACY_KEYS));
}

/** Keyring for webhook secrets; null when WEBHOOK_ENCRYPTION_KEY is unset. */
export function webhookKeyring(cfg: KeyConfig = config): SecretKeyring | null {
  if (!cfg.WEBHOOK_ENCRYPTION_KEY) return null;
  return buildKeyring(cfg.WEBHOOK_ENCRYPTION_KEY, parseKeyList(cfg.WEBHOOK_ENCRYPTION_LEGACY_KEYS));
}

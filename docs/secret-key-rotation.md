# Secret encryption key rotation

Per-publisher **signing secrets** (`SIGNING_SECRET_KEY`) and **webhook secrets**
(`WEBHOOK_ENCRYPTION_KEY`) are encrypted at rest with AES-256-GCM.

## Ciphertext format

New values are stored as a versioned envelope:

```
v1:<keyId>:<base64(iv | authTag | ciphertext)>
```

`keyId` is a 16-hex-char identifier *derived* from the key (a domain-separated
SHA-256, not the AES key itself), so it never has to be configured by hand and
reveals nothing usable about the key. Values written before this format existed
(un-prefixed base64) are still readable: they are tried against every
configured key.

## Keyring

| Variable | Role |
| --- | --- |
| `SIGNING_SECRET_KEY` / `WEBHOOK_ENCRYPTION_KEY` | **Active** key — every new write uses it. |
| `SIGNING_SECRET_LEGACY_KEYS` / `WEBHOOK_ENCRYPTION_LEGACY_KEYS` | Comma-separated retired keys, **decrypt-only**. |

An envelope is only ever tried against the key its id names; an envelope whose
key is not configured fails closed (it is never treated as plaintext).

## Rotation procedure

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Move the current key into the legacy list and set the new key as active, e.g.
   `SIGNING_SECRET_LEGACY_KEYS=<old>` and `SIGNING_SECRET_KEY=<new>`. Deploy.
   Reads keep working for every row; new writes use the new key.
3. Preview the migration (no writes):
   `npm run secrets:reencrypt -- --dry-run`
4. Re-encrypt: `npm run secrets:reencrypt` (optionally `--field signing|webhook`,
   `--batch-size N`, `--max-batches N`).
   - Each batch prints a JSON progress line with a `cursor`. If the run is
     interrupted, resume with `--after <cursor>`. Re-running from the start is
     also safe: rows already on the active key are skipped.
   - Writes are compare-and-swap on the old value, so a publisher rotating
     their secret mid-run is never overwritten (counted as `conflict`; re-run
     to pick it up).
   - Exit code `2` means some values could not be decrypted with any configured
     key; their publisher ids (never values) are listed under `undecryptable`.
5. When a run reports only `current` (and no `undecryptable`), remove the old key
   from the legacy list and deploy.

The command never prints plaintext secrets — only ids, field names, counts and
the resume cursor.

## Plaintext rows

Deployments that ran without an encryption key have plaintext rows. By default
the command reports them as `plaintext_skipped`. Once a key is configured, pass
`--encrypt-plaintext` to encrypt them in place. Read paths keep accepting the
legacy plaintext value until it has been migrated.

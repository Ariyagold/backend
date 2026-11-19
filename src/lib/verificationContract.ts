/**
 * Review-input contract and provider-failure type for content verification.
 *
 * Kept dependency-free so routes can use them without importing the model client.
 */

import { z } from "zod";

/**
 * Version of what the paid verdict covers, persisted on every verification row
 * (#189). `content-v1`: the verdict reviews ONLY the submitted `content` string:
 *   - file resources: the exact UTF-8 text of the uploaded file (first 10,000 chars)
 *   - link resources: the external URL string itself (the target is never fetched)
 *   - no resourceId:  the raw text, reviewed as "text"
 * Listing metadata (title, description, price) is NOT part of the review input.
 */
export const INPUT_CONTRACT_VERSION = "content-v1";

/**
 * Immutable version of the verification prompt/policy that produced a verdict
 * (#185). Persisted on every verification row so historical results can be
 * grouped by the prompt that generated them. Bump whenever the prompt or the
 * verdict policy changes.
 */
export const PROMPT_VERSION = "verify-prompt-v1";

/**
 * Strict runtime schema for the verification model response (#180).
 *
 * `is_original` MUST be a literal boolean — strings like "false", numbers,
 * null or missing values are rejected so they can never approve a resource.
 * `confidence` must be a finite number in [0, 1]; `flags` must be strings.
 */
export const verificationVerdictSchema = z.object({
  is_original: z.boolean(),
  confidence: z.number().finite().min(0).max(1),
  flags: z.array(z.string()),
});

export type VerificationVerdict = z.infer<typeof verificationVerdictSchema>;

export type ReviewResourceType = "file" | "link" | "text";

/** Retryable infrastructure/protocol failure — NOT a verdict on the content (#187). */
export class VerificationProviderError extends Error {
  readonly retryable = true as const;
  readonly reason: "empty_response" | "unparsable_response" | "provider_error" | "timeout";
  constructor(reason: VerificationProviderError["reason"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VerificationProviderError";
    this.reason = reason;
  }
}

/** Raised when the caller canceled (disconnect/abort) before a verdict was produced (#184). */
export class VerificationCanceledError extends Error {
  constructor() {
    super("Verification canceled");
    this.name = "VerificationCanceledError";
  }
}

/**
 * Review-input contract and provider-failure type for content verification.
 *
 * Kept dependency-free so routes can use them without importing the model client.
 */

/**
 * Version of what the paid verdict covers, persisted on every verification row
 * (#189). `content-v1`: the verdict reviews ONLY the submitted `content` string:
 *   - file resources: the exact UTF-8 text of the uploaded file (first 10,000 chars)
 *   - link resources: the external URL string itself (the target is never fetched)
 *   - no resourceId:  the raw text, reviewed as "text"
 * Listing metadata (title, description, price) is NOT part of the review input.
 */
export const INPUT_CONTRACT_VERSION = "content-v1";

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

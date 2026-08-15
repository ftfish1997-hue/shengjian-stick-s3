export const MAX_PROCESSING_ATTEMPTS = 4;
export const DEFAULT_RETRY_BATCH_SIZE = 5;
export const MAX_RETRY_BATCH_SIZE = 20;
export const RETRY_SCAN_LIMIT = 100;
export const STALE_PROCESSING_MS = 3 * 60 * 1_000;

const UPLOADED_GRACE_MS = 60 * 1_000;
const FAILED_RETRY_DELAYS_MS = [
  60 * 1_000,
  60 * 1_000,
  5 * 60 * 1_000,
  30 * 60 * 1_000,
] as const;

const CANDIDATE_STATES = new Set([
  "uploaded",
  "transcribing",
  "classifying",
  "transcription_failed",
  "classification_failed",
]);

const NON_RETRYABLE_ERROR_CODES = new Set([
  "ASR_NO_TEXT",
  "RAW_TEXT_MISSING",
]);

const NON_RETRYABLE_HTTP_SUFFIXES = [
  "_HTTP_400",
  "_HTTP_401",
  "_HTTP_403",
  "_HTTP_404",
  "_HTTP_413",
] as const;

export interface RetryCandidate {
  id: string;
  status: string;
  processing_attempts: number;
  error_code: string | null;
  updated_at: string;
}

export function isRetryableErrorCode(errorCode: string | null): boolean {
  if (!errorCode) return true;
  if (NON_RETRYABLE_ERROR_CODES.has(errorCode)) return false;
  return !NON_RETRYABLE_HTTP_SUFFIXES.some((suffix) => errorCode.endsWith(suffix));
}

export function retryDueAt(candidate: RetryCandidate): number | null {
  if (!CANDIDATE_STATES.has(candidate.status) ||
    !Number.isInteger(candidate.processing_attempts) ||
    candidate.processing_attempts < 0 ||
    candidate.processing_attempts >= MAX_PROCESSING_ATTEMPTS) {
    return null;
  }

  const updatedAt = Date.parse(candidate.updated_at);
  if (!Number.isFinite(updatedAt)) return null;

  if (candidate.status === "transcribing" || candidate.status === "classifying") {
    return updatedAt + STALE_PROCESSING_MS;
  }
  if (candidate.status === "uploaded") {
    return updatedAt + UPLOADED_GRACE_MS;
  }
  if (!isRetryableErrorCode(candidate.error_code)) return null;

  const delayIndex = Math.min(
    candidate.processing_attempts,
    FAILED_RETRY_DELAYS_MS.length - 1,
  );
  return updatedAt + FAILED_RETRY_DELAYS_MS[delayIndex];
}

export function isRetryDue(candidate: RetryCandidate, nowMs: number): boolean {
  const dueAt = retryDueAt(candidate);
  return dueAt !== null && dueAt <= nowMs;
}

export function selectRetryCandidates(
  candidates: RetryCandidate[],
  nowMs: number,
  batchSize = DEFAULT_RETRY_BATCH_SIZE,
): RetryCandidate[] {
  const safeBatchSize = Number.isInteger(batchSize)
    ? Math.min(Math.max(batchSize, 1), MAX_RETRY_BATCH_SIZE)
    : DEFAULT_RETRY_BATCH_SIZE;
  return candidates.filter((candidate) => isRetryDue(candidate, nowMs)).slice(0, safeBatchSize);
}

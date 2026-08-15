export const DEFAULT_RECORD_LIMIT = 20;
export const MAX_RECORD_LIMIT = 50;

export type DashboardQuery = {
  recordLimit: number;
};

export class DashboardQueryError extends Error {}

export function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function parseDashboardQuery(url: URL): DashboardQuery {
  const allowed = new Set(["record_limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new DashboardQueryError(`Unknown query parameter: ${key}`);
    }
  }

  const values = url.searchParams.getAll("record_limit");
  if (values.length > 1) {
    throw new DashboardQueryError("record_limit must appear at most once");
  }
  if (values.length === 0) {
    return { recordLimit: DEFAULT_RECORD_LIMIT };
  }

  if (!/^[1-9][0-9]*$/.test(values[0])) {
    throw new DashboardQueryError("record_limit must be a positive integer");
  }
  const recordLimit = Number(values[0]);
  if (!Number.isSafeInteger(recordLimit) || recordLimit > MAX_RECORD_LIMIT) {
    throw new DashboardQueryError(
      `record_limit must be between 1 and ${MAX_RECORD_LIMIT}`,
    );
  }
  return { recordLimit };
}

export function audioDurationSeconds(audioSizeBytes: unknown): number | null {
  if (
    typeof audioSizeBytes !== "number" ||
    !Number.isSafeInteger(audioSizeBytes) ||
    audioSizeBytes < 44
  ) {
    return null;
  }
  return Math.round(((audioSizeBytes - 44) / 32_000) * 10) / 10;
}

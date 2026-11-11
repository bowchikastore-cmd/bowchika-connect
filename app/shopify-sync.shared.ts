export const SHOPIFY_SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;

export const getIncrementalSyncSince = (
  lastCompletedAt: Date,
  overlapMs = SHOPIFY_SYNC_OVERLAP_MS,
) => {
  if (!Number.isFinite(lastCompletedAt.getTime())) {
    throw new Error("A valid completed full-sync timestamp is required.");
  }
  if (!Number.isFinite(overlapMs) || overlapMs < 0) {
    throw new Error("The sync overlap must be a non-negative duration.");
  }
  return new Date(lastCompletedAt.getTime() - overlapMs);
};

export const buildUpdatedAtSearchQuery = (since: Date) => {
  if (!Number.isFinite(since.getTime())) {
    throw new Error("A valid updated-at checkpoint is required.");
  }
  return `updated_at:>='${since.toISOString()}'`;
};

import assert from "node:assert/strict";
import {
  SHOPIFY_SYNC_OVERLAP_MS,
  buildUpdatedAtSearchQuery,
  getIncrementalSyncSince,
} from "./shopify-sync.shared.ts";

const completedAt = new Date("2026-11-11T06:00:00.000Z");
const since = getIncrementalSyncSince(completedAt);

assert.equal(SHOPIFY_SYNC_OVERLAP_MS, 24 * 60 * 60 * 1000);
assert.equal(since.toISOString(), "2026-11-10T06:00:00.000Z");
assert.equal(
  buildUpdatedAtSearchQuery(since),
  "updated_at:>= '2026-11-10T06:00:00.000Z'",
);
assert.equal(
  getIncrementalSyncSince(completedAt, 0).toISOString(),
  completedAt.toISOString(),
);
assert.throws(() => getIncrementalSyncSince(new Date("invalid")), /valid completed full-sync timestamp/);
assert.throws(() => getIncrementalSyncSince(completedAt, -1), /non-negative duration/);
assert.throws(() => buildUpdatedAtSearchQuery(new Date("invalid")), /valid updated-at checkpoint/);

console.log("Passed incremental Shopify sync checkpoint helper tests.");

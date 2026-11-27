import assert from "node:assert/strict";
import { getCampaignStatus } from "./campaign-draft-policy.ts";

assert.equal(getCampaignStatus(0, null), "DRAFT");
assert.equal(getCampaignStatus(0, new Date("2026-12-01T12:00:00.000Z")), "DRAFT");
assert.equal(getCampaignStatus(1, null), "QUEUED");
assert.equal(getCampaignStatus(12, new Date("2026-12-01T12:00:00.000Z")), "SCHEDULED");
assert.throws(() => getCampaignStatus(-1, null), /non-negative safe integer/);
assert.throws(() => getCampaignStatus(1.5, null), /non-negative safe integer/);
assert.throws(() => getCampaignStatus(Number.NaN, null), /non-negative safe integer/);

console.log("Passed campaign draft and queue policy tests.");

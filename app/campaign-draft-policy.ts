export type CampaignStatus = "DRAFT" | "QUEUED" | "SCHEDULED";

/**
 * A campaign with no eligible recipients is a saved draft, never a sendable queue.
 * Recipients are prepared separately and only eligible contacts enter that queue.
 */
export const getCampaignStatus = (recipientCount: number, scheduledAt: Date | null): CampaignStatus => {
  if (!Number.isSafeInteger(recipientCount) || recipientCount < 0) {
    throw new RangeError("Recipient count must be a non-negative safe integer.");
  }
  if (recipientCount === 0) return "DRAFT";
  return scheduledAt ? "SCHEDULED" : "QUEUED";
};

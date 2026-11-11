ALTER TABLE "ShopifyCustomerMirror" ADD COLUMN "whatsappConsentState" TEXT NOT NULL DEFAULT 'NEVER_SUBSCRIBED';
ALTER TABLE "ShopifyCustomerMirror" ADD COLUMN "whatsappConsentUpdatedAt" DATETIME;
ALTER TABLE "ShopifyCustomerMirror" ADD COLUMN "whatsappConsentCollectedFrom" TEXT;
ALTER TABLE "ShopifyCustomerMirror" ADD COLUMN "whatsappConsentOptInLevel" TEXT;
ALTER TABLE "ShopifyCustomerMirror" ADD COLUMN "whatsappOptOutAt" DATETIME;

CREATE TABLE "WhatsAppContactSuppression" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT 'OPT_OUT_KEYWORD',
  "lastOptOutAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "WhatsAppContactSuppression_shop_phoneNumber_key"
  ON "WhatsAppContactSuppression"("shop", "phoneNumber");
CREATE INDEX "WhatsAppContactSuppression_shop_lastOptOutAt_idx"
  ON "WhatsAppContactSuppression"("shop", "lastOptOutAt");

ALTER TABLE "WhatsAppCampaign" ADD COLUMN "audienceCriteriaJson" TEXT NOT NULL DEFAULT '{}';

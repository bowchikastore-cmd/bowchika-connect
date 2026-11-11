ALTER TABLE "ShopifyCustomerMirror"
  ADD COLUMN "whatsappConsentState" TEXT NOT NULL DEFAULT 'NEVER_SUBSCRIBED',
  ADD COLUMN "whatsappConsentUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "whatsappConsentCollectedFrom" TEXT,
  ADD COLUMN "whatsappConsentOptInLevel" TEXT,
  ADD COLUMN "whatsappOptOutAt" TIMESTAMP(3);

CREATE TABLE "WhatsAppContactSuppression" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT 'OPT_OUT_KEYWORD',
  "lastOptOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppContactSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppContactSuppression_shop_phoneNumber_key"
  ON "WhatsAppContactSuppression"("shop", "phoneNumber");
CREATE INDEX "WhatsAppContactSuppression_shop_lastOptOutAt_idx"
  ON "WhatsAppContactSuppression"("shop", "lastOptOutAt");

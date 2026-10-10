-- Add idempotency keys and durable status-event receipts for test sends/webhook races.
ALTER TABLE "WhatsAppMessage" ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "WhatsAppMessage_shop_clientRequestId_key"
ON "WhatsAppMessage"("shop", "clientRequestId");

CREATE TABLE "WhatsAppMessageStatusEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "whatsappMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "eventAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "WhatsAppMessageStatusEvent_shop_whatsappMessageId_status_key"
ON "WhatsAppMessageStatusEvent"("shop", "whatsappMessageId", "status");

CREATE INDEX "WhatsAppMessageStatusEvent_shop_whatsappMessageId_idx"
ON "WhatsAppMessageStatusEvent"("shop", "whatsappMessageId");

CREATE TABLE "WhatsAppWebhookVerification" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "phoneNumberId" TEXT NOT NULL,
    "verifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

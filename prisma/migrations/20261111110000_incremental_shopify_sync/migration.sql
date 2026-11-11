ALTER TABLE "ShopifyOrderMirror" ADD COLUMN "updatedAtShopify" DATETIME;

ALTER TABLE "ShopifySyncJob" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'FULL';
ALTER TABLE "ShopifySyncJob" ADD COLUMN "incrementalSince" DATETIME;
ALTER TABLE "ShopifySyncJob" ADD COLUMN "ordersUnlinked" INTEGER NOT NULL DEFAULT 0;

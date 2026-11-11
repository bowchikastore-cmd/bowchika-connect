ALTER TABLE "ShopifyOrderMirror"
  ADD COLUMN "updatedAtShopify" TIMESTAMP(3);

ALTER TABLE "ShopifySyncJob"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'FULL',
  ADD COLUMN "incrementalSince" TIMESTAMP(3),
  ADD COLUMN "ordersUnlinked" INTEGER NOT NULL DEFAULT 0;

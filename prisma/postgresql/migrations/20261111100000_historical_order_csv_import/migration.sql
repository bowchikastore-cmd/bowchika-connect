ALTER TABLE "ShopifyOrderMirror"
  ALTER COLUMN "customerId" DROP NOT NULL;

ALTER TABLE "ShopifyOrderMirror"
  ADD COLUMN "customerEmail" TEXT,
  ADD COLUMN "customerPhone" TEXT,
  ADD COLUMN "customerName" TEXT,
  ADD COLUMN "csvImportedAt" TIMESTAMP(3);

CREATE INDEX "ShopifyOrderMirror_shop_customerEmail_idx"
  ON "ShopifyOrderMirror"("shop", "customerEmail");
CREATE INDEX "ShopifyOrderMirror_shop_customerPhone_idx"
  ON "ShopifyOrderMirror"("shop", "customerPhone");

ALTER TABLE "ShopifyOrderMirror"
ADD COLUMN "lineItemsSearch" TEXT NOT NULL DEFAULT '';

UPDATE "ShopifyOrderMirror"
SET "lineItemsSearch" = LOWER("lineItemsJson");

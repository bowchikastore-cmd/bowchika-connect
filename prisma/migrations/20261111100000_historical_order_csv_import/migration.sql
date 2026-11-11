PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ShopifyOrderMirror" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "customerId" TEXT,
  "customerEmail" TEXT,
  "customerPhone" TEXT,
  "customerName" TEXT,
  "csvImportedAt" DATETIME,
  "orderName" TEXT NOT NULL,
  "orderNumber" INTEGER,
  "processedAt" DATETIME,
  "createdAtShopify" DATETIME,
  "totalPrice" REAL NOT NULL DEFAULT 0,
  "currencyCode" TEXT NOT NULL DEFAULT 'INR',
  "financialStatus" TEXT,
  "fulfillmentStatus" TEXT,
  "lineItemsJson" TEXT NOT NULL DEFAULT '[]',
  "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopifyOrderMirror_shop_customerId_fkey"
    FOREIGN KEY ("shop", "customerId")
    REFERENCES "ShopifyCustomerMirror"("shop", "id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ShopifyOrderMirror" (
  "id", "shop", "customerId", "orderName", "orderNumber", "processedAt",
  "createdAtShopify", "totalPrice", "currencyCode", "financialStatus",
  "fulfillmentStatus", "lineItemsJson", "syncedAt"
)
SELECT
  "id", "shop", "customerId", "orderName", "orderNumber", "processedAt",
  "createdAtShopify", "totalPrice", "currencyCode", "financialStatus",
  "fulfillmentStatus", "lineItemsJson", "syncedAt"
FROM "ShopifyOrderMirror";

DROP TABLE "ShopifyOrderMirror";
ALTER TABLE "new_ShopifyOrderMirror" RENAME TO "ShopifyOrderMirror";

CREATE UNIQUE INDEX "ShopifyOrderMirror_shop_id_key" ON "ShopifyOrderMirror"("shop", "id");
CREATE INDEX "ShopifyOrderMirror_shop_customerId_processedAt_idx" ON "ShopifyOrderMirror"("shop", "customerId", "processedAt");
CREATE INDEX "ShopifyOrderMirror_shop_orderName_idx" ON "ShopifyOrderMirror"("shop", "orderName");
CREATE INDEX "ShopifyOrderMirror_shop_customerEmail_idx" ON "ShopifyOrderMirror"("shop", "customerEmail");
CREATE INDEX "ShopifyOrderMirror_shop_customerPhone_idx" ON "ShopifyOrderMirror"("shop", "customerPhone");

PRAGMA foreign_keys=ON;

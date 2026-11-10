CREATE TABLE "ShopifySyncJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "phase" TEXT NOT NULL DEFAULT 'CUSTOMERS',
  "customerCursor" TEXT,
  "orderCursor" TEXT,
  "customersProcessed" INTEGER NOT NULL DEFAULT 0,
  "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
  "customerPages" INTEGER NOT NULL DEFAULT 0,
  "orderPages" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" DATETIME,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ShopifySyncJob_shop_status_updatedAt_idx"
ON "ShopifySyncJob"("shop", "status", "updatedAt");

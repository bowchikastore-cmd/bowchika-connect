CREATE TABLE "ShopifySyncJob" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "phase" TEXT NOT NULL DEFAULT 'CUSTOMERS',
  "customerCursor" TEXT,
  "orderCursor" TEXT,
  "customersProcessed" INTEGER NOT NULL DEFAULT 0,
  "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
  "ordersSkipped" INTEGER NOT NULL DEFAULT 0,
  "customerPages" INTEGER NOT NULL DEFAULT 0,
  "orderPages" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopifySyncJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShopifySyncJob_shop_status_updatedAt_idx"
ON "ShopifySyncJob"("shop", "status", "updatedAt");

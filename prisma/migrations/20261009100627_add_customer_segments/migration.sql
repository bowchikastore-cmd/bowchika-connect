-- CreateTable
CREATE TABLE "CustomerSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orderRule" TEXT NOT NULL DEFAULT 'any',
    "tag" TEXT NOT NULL DEFAULT '',
    "spendRule" TEXT NOT NULL DEFAULT 'any',
    "spendAmount" REAL,
    "lastOrderDays" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CustomerSegment_shop_idx" ON "CustomerSegment"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSegment_shop_name_key" ON "CustomerSegment"("shop", "name");

-- CreateTable
CREATE TABLE "ApprovedWhatsAppTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "metaTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "components" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovedWhatsAppTemplate_shop_metaTemplateId_key" ON "ApprovedWhatsAppTemplate"("shop", "metaTemplateId");

-- CreateIndex
CREATE INDEX "ApprovedWhatsAppTemplate_shop_name_idx" ON "ApprovedWhatsAppTemplate"("shop", "name");
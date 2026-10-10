-- CreateTable
CREATE TABLE "WhatsAppConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "customerName" TEXT,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" DATETIME,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "whatsappMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WhatsAppMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_shop_phoneNumber_key" ON "WhatsAppConversation"("shop", "phoneNumber");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_shop_lastMessageAt_idx" ON "WhatsAppConversation"("shop", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_shop_whatsappMessageId_key" ON "WhatsAppMessage"("shop", "whatsappMessageId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_conversationId_createdAt_idx" ON "WhatsAppMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_shop_createdAt_idx" ON "WhatsAppMessage"("shop", "createdAt");

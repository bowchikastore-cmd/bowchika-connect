-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSegment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orderRule" TEXT NOT NULL DEFAULT 'any',
    "tag" TEXT NOT NULL DEFAULT '',
    "spendRule" TEXT NOT NULL DEFAULT 'any',
    "spendAmount" DOUBLE PRECISION,
    "lastOrderDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovedWhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "metaTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "components" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovedWhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDraft" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppConversation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "customerName" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "whatsappMessageId" TEXT,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessageStatusEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "whatsappMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessageStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppWebhookVerification" (
    "shop" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppWebhookVerification_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE INDEX "CustomerSegment_shop_idx" ON "CustomerSegment"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSegment_shop_name_key" ON "CustomerSegment"("shop", "name");

-- CreateIndex
CREATE INDEX "ApprovedWhatsAppTemplate_shop_name_idx" ON "ApprovedWhatsAppTemplate"("shop", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovedWhatsAppTemplate_shop_metaTemplateId_key" ON "ApprovedWhatsAppTemplate"("shop", "metaTemplateId");

-- CreateIndex
CREATE INDEX "CampaignDraft_shop_updatedAt_idx" ON "CampaignDraft"("shop", "updatedAt");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_shop_lastMessageAt_idx" ON "WhatsAppConversation"("shop", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_shop_phoneNumber_key" ON "WhatsAppConversation"("shop", "phoneNumber");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_conversationId_createdAt_idx" ON "WhatsAppMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_shop_createdAt_idx" ON "WhatsAppMessage"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_shop_whatsappMessageId_key" ON "WhatsAppMessage"("shop", "whatsappMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_shop_clientRequestId_key" ON "WhatsAppMessage"("shop", "clientRequestId");

-- CreateIndex
CREATE INDEX "WhatsAppMessageStatusEvent_shop_whatsappMessageId_idx" ON "WhatsAppMessageStatusEvent"("shop", "whatsappMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessageStatusEvent_shop_whatsappMessageId_status_key" ON "WhatsAppMessageStatusEvent"("shop", "whatsappMessageId", "status");

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

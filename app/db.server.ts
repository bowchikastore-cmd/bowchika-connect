import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

if (process.env.NODE_ENV !== "production") {
  const cachedClient = global.prismaGlobal;
  const hasInboxDelegates =
    typeof cachedClient?.whatsAppConversation !== "undefined" &&
    typeof cachedClient.whatsAppMessage !== "undefined" &&
    typeof cachedClient.whatsAppMessageStatusEvent !== "undefined" &&
    typeof cachedClient.whatsAppWebhookVerification !== "undefined";

  if (!hasInboxDelegates) {
    if (cachedClient) {
      void cachedClient
        .$disconnect()
        .catch(() =>
          console.error("Failed to disconnect a stale Prisma client during refresh."),
        );
    }
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;

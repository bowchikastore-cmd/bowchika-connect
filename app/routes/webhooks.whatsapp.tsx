import { Prisma } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import {
  getConfiguredWhatsAppShop,
  getWhatsAppBusinessAccountId,
  getWhatsAppPhoneNumberId,
  getWhatsAppWebhookVerifyToken,
  isWhatsAppWebhookConfigurationComplete,
  isValidWhatsAppWebhookSignature,
  safeStringEqual,
} from "../whatsapp.server";
import {
  getWhatsAppStatusTransition,
  normalizeE164Phone,
} from "../whatsapp-shared";

const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecords = (value: unknown) =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const configuredShop = () => {
  const shop = getConfiguredWhatsAppShop();
  return shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)
    ? shop
    : null;
};

const parseEventDate = (timestamp: unknown) => {
  const seconds = typeof timestamp === "string" ? Number(timestamp) : NaN;
  const milliseconds = seconds * 1000;
  return Number.isFinite(milliseconds) &&
    milliseconds > 0 &&
    milliseconds <= 8.64e15
    ? new Date(milliseconds)
    : new Date();
};

const getCustomerPhone = (value: unknown) => {
  if (typeof value !== "string") return null;
  return normalizeE164Phone(value);
};

const getMessageText = (message: Record<string, unknown>, type: string) => {
  const content = isRecord(message[type]) ? message[type] : null;
  if (!content) return `${type} message received`;
  if (type === "text" && typeof content.body === "string") return content.body;
  if (
    (type === "image" || type === "video" || type === "document") &&
    typeof content.caption === "string"
  ) {
    return content.caption;
  }
  if (type === "button" && typeof content.text === "string") return content.text;
  if (type === "interactive") {
    const buttonReply = isRecord(content.button_reply)
      ? content.button_reply
      : null;
    const listReply = isRecord(content.list_reply) ? content.list_reply : null;
    if (typeof buttonReply?.title === "string") return buttonReply.title;
    if (typeof listReply?.title === "string") return listReply.title;
  }
  return `${type} message received`;
};

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const processIncomingMessage = async (
  shop: string,
  message: Record<string, unknown>,
  contacts: Record<string, unknown>[],
) => {
  if (
    typeof message.id !== "string" ||
    !message.id ||
    typeof message.from !== "string"
  ) {
    return;
  }
  const whatsappMessageId = message.id;
  const phoneNumber = getCustomerPhone(message.from);
  if (!phoneNumber) return;
  const rawType = typeof message.type === "string" ? message.type : "unknown";
  const type = /^[a-z_]{1,32}$/i.test(rawType)
    ? rawType.toUpperCase()
    : "UNKNOWN";
  const contact = contacts.find((item) => item.wa_id === message.from);
  const profile = contact && isRecord(contact.profile) ? contact.profile : null;
  let customerName: string | undefined;
  if (
    profile &&
    typeof profile.name === "string" &&
    profile.name.length <= 200
  ) {
    customerName = profile.name;
  }
  const receivedAt = parseEventDate(message.timestamp);

  try {
    await prisma.$transaction(async (transaction) => {
      const current = await transaction.whatsAppConversation.findUnique({
        where: { shop_phoneNumber: { shop, phoneNumber } },
      });
      const lastMessageAt =
        current && current.lastMessageAt > receivedAt
          ? current.lastMessageAt
          : receivedAt;
      const lastInboundAt =
        current?.lastInboundAt && current.lastInboundAt > receivedAt
          ? current.lastInboundAt
          : receivedAt;
      const conversation = current
        ? await transaction.whatsAppConversation.update({
            where: { id: current.id },
            data: {
              lastMessageAt,
              lastInboundAt,
              ...(customerName ? { customerName } : {}),
              unreadCount: { increment: 1 },
            },
          })
        : await transaction.whatsAppConversation.create({
            data: {
              shop,
              phoneNumber,
              customerName,
              lastMessageAt,
              lastInboundAt,
              unreadCount: 1,
            },
          });

      await transaction.whatsAppMessage.create({
        data: {
          conversationId: conversation.id,
          shop,
          direction: "INBOUND",
          type,
          text: getMessageText(message, rawType),
          status: "RECEIVED",
          whatsappMessageId,
          createdAt: receivedAt,
        },
      });

      // A clear inbound opt-out immediately revokes local campaign eligibility.
      // Never infer opt-in from inbound keywords; explicit consent must be recorded separately.
      const inboundText = getMessageText(message, rawType).trim();
      if (/^(stop|unsubscribe|opt\\s*out|cancel|quit)$/i.test(inboundText)) {
        const mirroredCustomers = await transaction.shopifyCustomerMirror.findMany({
          where: { shop },
          select: { id: true, phone: true },
        });
        const matchingCustomerIds = mirroredCustomers
          .filter((customer) => normalizeE164Phone(customer.phone ?? "") === phoneNumber)
          .map((customer) => customer.id);
        if (matchingCustomerIds.length) {
          await transaction.shopifyCustomerMirror.updateMany({
            where: { shop, id: { in: matchingCustomerIds } },
            data: { whatsappOptIn: false },
          });
          await transaction.whatsAppCampaignRecipient.updateMany({
            where: {
              shop,
              customerId: { in: matchingCustomerIds },
              status: "QUEUED",
            },
            data: {
              status: "SKIPPED",
              error: "Customer opted out via WhatsApp.",
            },
          });
        }
      }
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const duplicate = await prisma.whatsAppMessage.findUnique({
      where: { shop_whatsappMessageId: { shop, whatsappMessageId } },
      select: { id: true },
    });
    if (!duplicate) throw error;
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode") ?? "";
  const suppliedToken = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = getWhatsAppWebhookVerifyToken();
  const shop = configuredShop();
  const phoneNumberId = getWhatsAppPhoneNumberId();

  if (
    mode !== "subscribe" ||
    !verifyToken ||
    !shop ||
    !phoneNumberId ||
    !isWhatsAppWebhookConfigurationComplete() ||
    !challenge ||
    challenge.length > 256 ||
    !safeStringEqual(verifyToken, suppliedToken)
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  await prisma.whatsAppWebhookVerification.upsert({
    where: { shop },
    create: { shop, phoneNumberId },
    update: { phoneNumberId, verifiedAt: new Date() },
  });
  return new Response(challenge, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = configuredShop();
  const phoneNumberId = getWhatsAppPhoneNumberId();
  const businessAccountId = getWhatsAppBusinessAccountId();
  if (!shop || !phoneNumberId || !businessAccountId || !isWhatsAppWebhookConfigurationComplete()) {
    return Response.json(
      { error: "WhatsApp webhook tenant configuration is incomplete." },
      { status: 503 },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return new Response("Invalid request body", { status: 400 });
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  if (!isValidWhatsAppWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid webhook signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account") {
    return Response.json({ received: true });
  }

  for (const entry of asRecords(payload.entry)) {
    if (entry.id !== businessAccountId) continue;
    for (const change of asRecords(entry.changes)) {
      if (change.field !== "messages") continue;
      const value = isRecord(change.value) ? change.value : null;
      const metadata = value && isRecord(value.metadata) ? value.metadata : null;
      if (metadata?.phone_number_id !== phoneNumberId) continue;

      const contacts = asRecords(value?.contacts);
      for (const message of asRecords(value?.messages)) {
        await processIncomingMessage(shop, message, contacts);
      }

      for (const statusEvent of asRecords(value?.statuses)) {
        if (
          typeof statusEvent.id !== "string" ||
          typeof statusEvent.status !== "string"
        ) {
          continue;
        }
        const whatsappMessageId = statusEvent.id;
        const transition = getWhatsAppStatusTransition(statusEvent.status);
        if (!transition) continue;
        const eventAt = parseEventDate(statusEvent.timestamp);
        await prisma.$transaction(async (transaction) => {
          await transaction.whatsAppMessageStatusEvent.upsert({
            where: {
              shop_whatsappMessageId_status: {
                shop,
                whatsappMessageId,
                status: transition.status,
              },
            },
            create: {
              shop,
              whatsappMessageId,
              status: transition.status,
              eventAt,
            },
            update: {},
          });
          await transaction.whatsAppMessage.updateMany({
            where: {
              shop,
              whatsappMessageId,
              status: { in: [...transition.allowed] },
            },
            data: { status: transition.status },
          });
          const campaignStatusData: { status: string; deliveredAt?: Date; readAt?: Date; failedAt?: Date } = {
            status: transition.status,
            ...(transition.status === "DELIVERED" ? { deliveredAt: eventAt } : {}),
            ...(transition.status === "READ" ? { readAt: eventAt } : {}),
            ...(transition.status === "FAILED" ? { failedAt: eventAt } : {}),
          };
          await transaction.whatsAppCampaignRecipient.updateMany({
            where: { shop, whatsappMessageId, status: { in: [...transition.allowed] } },
            data: campaignStatusData,
          });
        });
      }
    }
  }
  return Response.json({ received: true });
};

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  getWhatsAppStatusTransition,
  normalizeE164Phone,
} from "./whatsapp-shared";

export type WhatsAppConfig = {
  phoneNumberId: string;
  accessToken: string;
  apiVersion: string;
};

export class WhatsAppConfigurationError extends Error {}

export class WhatsAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
  ) {
    super("WhatsApp API request failed");
  }
}

const requiredEnvironment = (key: string) => process.env[key]?.trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getWhatsAppPhoneNumberId = () =>
  requiredEnvironment("WHATSAPP_PHONE_NUMBER_ID");

export const getWhatsAppConfig = (): WhatsAppConfig => {
  const phoneNumberId = getWhatsAppPhoneNumberId();
  const accessToken = requiredEnvironment("WHATSAPP_ACCESS_TOKEN");
  const apiVersion = requiredEnvironment("META_GRAPH_API_VERSION") || "v23.0";

  if (!phoneNumberId || !accessToken) {
    throw new WhatsAppConfigurationError(
      "WhatsApp phone number credentials are not configured on the server.",
    );
  }
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new WhatsAppConfigurationError(
      "The Meta Graph API version is invalid.",
    );
  }

  return { phoneNumberId, accessToken, apiVersion };
};

export const getConfiguredWhatsAppShop = () =>
  requiredEnvironment("WHATSAPP_SHOP_DOMAIN")?.toLowerCase();

export const getWhatsAppBusinessAccountId = () =>
  requiredEnvironment("WHATSAPP_BUSINESS_ACCOUNT_ID");

export const getWhatsAppWebhookVerifyToken = () =>
  requiredEnvironment("WHATSAPP_WEBHOOK_VERIFY_TOKEN");

export const getMetaAppSecret = () => requiredEnvironment("META_APP_SECRET");

export const getWhatsAppTestRecipient = () => {
  const raw = requiredEnvironment("WHATSAPP_TEST_RECIPIENT_PHONE");
  return raw ? normalizeE164Phone(raw) : null;
};

export const isWhatsAppTestSendingEnabled = () =>
  requiredEnvironment("WHATSAPP_TEST_SENDING_ENABLED") === "true";

export const isWhatsAppWebhookConfigurationComplete = () =>
  Boolean(
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
      getConfiguredWhatsAppShop() ?? "",
    ) &&
      /^\d{5,30}$/.test(getWhatsAppPhoneNumberId() ?? "") &&
      /^\d{5,30}$/.test(getWhatsAppBusinessAccountId() ?? "") &&
      requiredEnvironment("WHATSAPP_ACCESS_TOKEN") &&
      getMetaAppSecret() &&
      getWhatsAppWebhookVerifyToken(),
  );

export const sendWhatsAppApiRequest = async (
  config: WhatsAppConfig,
  payload: Record<string, unknown>,
) => {
  let response: Response;
  try {
    response = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw new WhatsAppApiError(0);
  }

  const body: unknown = await response.json().catch(() => null);
  const providerError =
    isRecord(body) && isRecord(body.error) ? body.error : null;
  const providerCode =
    typeof providerError?.code === "number" ? providerError.code : undefined;
  if (!response.ok || providerError) {
    throw new WhatsAppApiError(response.status, providerCode);
  }
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const firstMessage = messages[0];
  const messageId =
    isRecord(firstMessage) && typeof firstMessage.id === "string"
      ? firstMessage.id
      : null;
  if (!messageId) throw new WhatsAppApiError(response.status);
  return messageId;
};

export const recordWhatsAppMessageAccepted = async (
  transaction: Prisma.TransactionClient,
  message: {
    id: string;
    conversationId: string;
    shop: string;
    whatsappMessageId: string;
  },
) => {
  const updated = await transaction.whatsAppMessage.updateMany({
    where: { id: message.id, shop: message.shop },
    data: { status: "SENT", whatsappMessageId: message.whatsappMessageId },
  });
  if (updated.count !== 1) {
    throw new Error("The pending WhatsApp message could not be updated.");
  }
  const conversationUpdated = await transaction.whatsAppConversation.updateMany({
    where: { id: message.conversationId, shop: message.shop },
    data: { lastMessageAt: new Date() },
  });
  if (conversationUpdated.count !== 1) {
    throw new Error("The WhatsApp conversation could not be updated.");
  }

  const recordedStatuses = await transaction.whatsAppMessageStatusEvent.findMany({
    where: { shop: message.shop, whatsappMessageId: message.whatsappMessageId },
    orderBy: { eventAt: "asc" },
  });
  for (const recordedStatus of recordedStatuses) {
    const transition = getWhatsAppStatusTransition(
      recordedStatus.status.toLowerCase(),
    );
    if (!transition) continue;
    await transaction.whatsAppMessage.updateMany({
      where: {
        id: message.id,
        shop: message.shop,
        status: { in: [...transition.allowed] },
      },
      data: { status: transition.status },
    });
  }
};

export const whatsAppApiErrorMessage = (error: unknown) => {
  if (error instanceof WhatsAppConfigurationError) return error.message;
  if (error instanceof WhatsAppApiError) {
    if (error.code === 190) {
      return "Meta rejected the access token. Check that it is active.";
    }
    if (error.code === 10 || error.code === 200) {
      return "Meta denied access. Check the token's WhatsApp permissions.";
    }
    if (error.code === 131047) {
      return "Meta requires an approved template because the 24-hour customer-service window has closed.";
    }
    if (error.code === 131026) {
      return "Meta could not deliver to this test recipient. Verify the number and its WhatsApp eligibility.";
    }
    if (error.code === 132000 || error.code === 132001) {
      return "Meta rejected this template or its parameters. Confirm the template is approved and its body parameters match.";
    }
    if (error.code === 131049) {
      return "Meta did not deliver this marketing message under its current messaging limits.";
    }
    if (error.status === 0) {
      return "Could not reach Meta. Check the server connection and try again.";
    }
    return `Meta returned an error (HTTP ${error.status}${error.code ? `, code ${error.code}` : ""}).`;
  }
  return "The WhatsApp operation could not be completed. Please try again.";
};

export const safeStringEqual = (expected: string, actual: string) => {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length > 0 &&
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
};

export const isValidWhatsAppWebhookSignature = (
  rawBody: string,
  signature: string | null,
) => {
  const appSecret = getMetaAppSecret();
  if (!appSecret || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;
  return safeStringEqual(expected.toLowerCase(), signature.toLowerCase());
};

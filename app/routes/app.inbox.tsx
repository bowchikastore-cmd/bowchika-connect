import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Link,
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "react-router";
import { Prisma } from "@prisma/client";
import type { WhatsAppConversation } from "@prisma/client";
import { createPortal } from "react-dom";
import type {
  WhatsAppTemplateInput,
  WhatsAppTemplateRequirements,
} from "../whatsapp-shared";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  isInsideCustomerServiceWindow,
  buildWhatsAppTemplatePayload,
  buildWhatsAppTextPayload,
  getTemplateBodyParameterCount,
  getWhatsAppTemplateRequirements,
  normalizeE164Phone,
  parseWhatsAppTemplateInput,
} from "../whatsapp-shared";
import {
  getConfiguredWhatsAppShop,
  getWhatsAppConfig,
  sendAndPersistWhatsAppMessage,
  WhatsAppDemoConversationError,
  getWhatsAppTestRecipient,
  isWhatsAppInboxSendingEnabled,
  isWhatsAppTestSendingEnabled,
  isWhatsAppWebhookConfigurationComplete,
  whatsAppApiErrorMessage,
  WhatsAppConfigurationError,
} from "../whatsapp.server";

const json = (body: object, status = 200) =>
  Response.json(body, { status });

type InboxActionData = {
  error?: string;
  success?: string;
  messageId?: string;
  conversationId?: string;
};

const formText = (formData: FormData, key: string) =>
  String(formData.get(key) ?? "").trim();

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const selectedId = new URL(request.url).searchParams.get("conversation");
  const [conversations, approvedTemplates] = await Promise.all([
    prisma.whatsAppConversation.findMany({
      where: { shop: session.shop },
      orderBy: { lastMessageAt: "desc" },
      take: 100,
      select: {
        id: true,
        phoneNumber: true,
        customerName: true,
        lastMessageAt: true,
        lastInboundAt: true,
        unreadCount: true,
        isDemo: true,
      },
    }),
    prisma.approvedWhatsAppTemplate.findMany({
      where: { shop: session.shop },
      orderBy: [{ name: "asc" }, { language: "asc" }],
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        components: true,
      },
    }),
  ]);
  const selectedConversation =
    conversations.find((conversation) => conversation.id === selectedId) ??
    conversations[0] ??
    null;
  const messages = selectedConversation
    ? await prisma.whatsAppMessage.findMany({
        where: {
          shop: session.shop,
          conversationId: selectedConversation.id,
        },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: {
          id: true,
          direction: true,
          type: true,
          text: true,
          status: true,
          createdAt: true,
        },
      })
    : [];
  messages.reverse();

  let metaConfigured = true;
  try {
    getWhatsAppConfig();
  } catch (error) {
    if (!(error instanceof WhatsAppConfigurationError)) throw error;
    metaConfigured = false;
  }
  const testRecipientPhone = getWhatsAppTestRecipient();
  const configuredShopDomain = getConfiguredWhatsAppShop();
  const activeShopDomain = session.shop.toLowerCase();
  const tenantBound = configuredShopDomain === activeShopDomain;
  const configuredPhoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const webhookVerified = Boolean(
    configuredPhoneNumberId &&
      (await prisma.whatsAppWebhookVerification.findFirst({
        where: {
          shop: session.shop,
          phoneNumberId: configuredPhoneNumberId,
        },
        select: { shop: true },
      })),
  );
  const testRecipientConversation = testRecipientPhone
    ? await prisma.whatsAppConversation.findUnique({
        where: {
          shop_phoneNumber: {
            shop: session.shop,
            phoneNumber: testRecipientPhone,
          },
        },
        select: { id: true, lastInboundAt: true, isDemo: true },
      })
    : null;
  const testSendingReady =
    isWhatsAppTestSendingEnabled() &&
    isWhatsAppWebhookConfigurationComplete() &&
    metaConfigured &&
    tenantBound &&
    webhookVerified &&
    approvedTemplates.length > 0 &&
    Boolean(testRecipientConversation?.lastInboundAt) &&
    testRecipientConversation?.isDemo === false;

  return {
    conversations,
    selectedConversation,
    messages,
    approvedTemplates: approvedTemplates.map((template) => {
      try {
        return {
          ...template,
          requirements: getWhatsAppTemplateRequirements(template.components),
          bodyParameterCount: getTemplateBodyParameterCount(template.components),
          componentError: null,
        };
      } catch {
        return {
          ...template,
          requirements: null,
          bodyParameterCount: null,
          componentError: "Template definition is invalid; sync templates again.",
        };
      }
    }),
    testRecipientPhone,
    testRecipientConfigured: Boolean(testRecipientPhone),
    testRecipientHasInbound:
      Boolean(testRecipientConversation?.lastInboundAt) &&
      testRecipientConversation?.isDemo === false,
    webhookVerified,
    testSendingOptIn: isWhatsAppTestSendingEnabled(),
    testSendingReady,
    inboxSendingOptIn: isWhatsAppInboxSendingEnabled(),
    // Outbound Cloud API sends only need valid credentials and the correct shop.
    // Webhook verification is required for inbound messages and delivery-status updates,
    // but must not block a customer-initiated template send.
    inboxSendingReady:
      isWhatsAppInboxSendingEnabled() &&
      metaConfigured &&
      tenantBound,
    activeShopDomain,
    configuredShopDomain,
    tenantBound,
    webhookConfigurationComplete:
      isWhatsAppWebhookConfigurationComplete() && metaConfigured,
    now: new Date().toISOString(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formText(formData, "intent");

  if (intent === "mark-read") {
    const conversationId = formText(formData, "conversationId");
    if (!conversationId) return json({ error: "Choose a conversation first." }, 400);
    const updated = await prisma.whatsAppConversation.updateMany({
      where: { id: conversationId, shop: session.shop },
      data: { unreadCount: 0 },
    });
    if (updated.count === 0) {
      return json({ error: "That conversation was not found for this shop." }, 404);
    }
    return json({ success: "Conversation marked as read." });
  }

  if (intent === "seed-demo") {
    const phoneNumber = "+15555550100";
    const now = new Date();
    const firstAt = new Date(now.getTime() - 3 * 60_000);
    const replyAt = new Date(now.getTime() - 2 * 60_000);
    const latestAt = new Date(now.getTime() - 60_000);

    const demoConflict = await prisma.$transaction(async (transaction) => {
      let conversation = await transaction.whatsAppConversation.findUnique({
        where: {
          shop_phoneNumber: { shop: session.shop, phoneNumber },
        },
      });
      if (conversation && !conversation.isDemo) return true;
      if (!conversation) {
        conversation = await transaction.whatsAppConversation.create({
          data: {
            shop: session.shop,
            phoneNumber,
            customerName: "Sample customer",
            isDemo: true,
          },
        });
      }
      const existingMessages = await transaction.whatsAppMessage.count({
        where: { shop: session.shop, conversationId: conversation.id },
      });
      if (existingMessages === 0) {
        await transaction.whatsAppMessage.createMany({
          data: [
            {
              conversationId: conversation.id,
              shop: session.shop,
              direction: "INBOUND",
              type: "TEXT",
              text: "Hi! I have a question about my recent order.",
              status: "RECEIVED",
              createdAt: firstAt,
              updatedAt: firstAt,
            },
            {
              conversationId: conversation.id,
              shop: session.shop,
              direction: "OUTBOUND",
              type: "TEXT",
              text: "Of course — how can I help?",
              status: "DEMO",
              createdAt: replyAt,
              updatedAt: replyAt,
            },
            {
              conversationId: conversation.id,
              shop: session.shop,
              direction: "INBOUND",
              type: "TEXT",
              text: "Could you share the latest delivery update?",
              status: "RECEIVED",
              createdAt: latestAt,
              updatedAt: latestAt,
            },
          ],
        });
        await transaction.whatsAppConversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: latestAt,
            lastInboundAt: latestAt,
            unreadCount: 1,
          },
        });
      }
      return false;
    });
    if (demoConflict) {
      return json(
        { error: "The reserved sample number is already used by a real conversation." },
        409,
      );
    }
    return json({ success: "Sample conversation is ready. No WhatsApp messages were sent." });
  }

  if (
    intent !== "send-reply" &&
    intent !== "send-template" &&
    intent !== "start-new-chat"
  ) {
    return json({ error: "Unsupported inbox action." }, 400);
  }

  const isStartNewChat = intent === "start-new-chat";
  const isTemplate = intent !== "send-reply";
  let recipientPhone: string;
  let conversation: WhatsAppConversation | null = null;
  let template: {
    name: string;
    language: string;
    category: string;
    components: string;
  } | null =
    null;
  let templateInput: ReturnType<typeof parseWhatsAppTemplateInput> | null = null;
  let text = "";
  if (isStartNewChat) {
    const rawRecipient = formText(formData, "recipientPhone");
    const normalizedRecipient = normalizeE164Phone(rawRecipient);
    if (!rawRecipient.startsWith("+") || !normalizedRecipient) {
      return json(
        { error: "Enter a valid international phone number beginning with +." },
        400,
      );
    }
    recipientPhone = normalizedRecipient;
  } else {
    const conversationId = formText(formData, "conversationId");
    if (!conversationId) {
      return json({ error: "Choose a conversation first." }, 400);
    }
    const foundConversation = await prisma.whatsAppConversation.findFirst({
      where: { id: conversationId, shop: session.shop },
    });
    if (!foundConversation) {
      return json({ error: "That conversation was not found for this shop." }, 404);
    }
    conversation = foundConversation;
    recipientPhone = foundConversation.phoneNumber;
  }

  if (isTemplate) {
    const templateId = formText(formData, "templateId");
    if (!templateId) return json({ error: "Choose an approved template." }, 400);
    template = await prisma.approvedWhatsAppTemplate.findFirst({
      where: { id: templateId, shop: session.shop },
      select: {
        name: true,
        language: true,
        category: true,
        components: true,
      },
    });
    if (!template) {
      return json({ error: "Choose an approved template synced for this shop." }, 400);
    }
    try {
      templateInput = parseWhatsAppTemplateInput(
        formText(formData, "templateInput"),
        template.components,
      );
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid template inputs." },
        400,
      );
    }
    text = `Template: ${template.name} · ${template.language}${
      templateInput.preview ? `\n${templateInput.preview}` : ""
    }`;
    if (
      !isStartNewChat &&
      conversation?.isDemo
    ) {
      // Keep template preview available in the local sample conversation.
    } else if (formText(formData, "confirmRecipientOptIn") !== "yes") {
      return json(
        {
          error:
            "Confirm that this recipient explicitly opted in to receive WhatsApp messages from this business.",
        },
        400,
      );
    }
  } else {
    text = formText(formData, "text");
    if (!text || text.length > 4096) {
      return json({ error: "Enter a reply between 1 and 4,096 characters." }, 400);
    }
    if (
      conversation &&
      !conversation.isDemo &&
      !isInsideCustomerServiceWindow(conversation.lastInboundAt)
    ) {
      return json(
        { error: "The 24-hour customer-service window has closed. Send an approved template instead." },
        400,
      );
    }
  }

  const clientRequestId = formText(formData, "clientRequestId");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      clientRequestId,
    )
  ) {
    return json(
      { error: "Refresh the Inbox and retry; the send request identifier is invalid." },
      400,
    );
  }

  if (conversation?.isDemo && !isStartNewChat) {
    try {
      const message = await prisma.$transaction(async (transaction) => {
        const created = await transaction.whatsAppMessage.create({
          data: {
            conversationId: conversation!.id,
            shop: session.shop,
            direction: "OUTBOUND",
            type: isTemplate ? "TEMPLATE" : "TEXT",
            text,
            status: "DEMO",
            clientRequestId,
          },
          select: { id: true },
        });
        await transaction.whatsAppConversation.update({
          where: { id: conversation!.id },
          data: { lastMessageAt: new Date() },
        });
        return created;
      });
      return json({
        success: "Demo message saved locally. No WhatsApp messages were sent.",
        messageId: message.id,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return json({ error: "This send request was already recorded." }, 409);
      }
      throw error;
    }
  }

  const inboxSending = isWhatsAppInboxSendingEnabled();
  if (isStartNewChat && !inboxSending) {
    return json({ error: "Starting new chats is disabled for live sending." }, 403);
  }

  let config;
  try {
    config = getWhatsAppConfig();
  } catch (error) {
    return json({ error: whatsAppApiErrorMessage(error) }, 503);
  }

  // Sending outbound messages does not depend on webhook verification.
  // The webhook is still required to receive customer messages and delivery statuses.
  if (getConfiguredWhatsAppShop() !== session.shop) {
    return json(
      { error: "The configured WhatsApp shop does not match this Shopify store." },
      403,
    );
  }

  if (!inboxSending) {
    const configuredRecipient = getWhatsAppTestRecipient();
    const normalizedRecipient = normalizeE164Phone(
      formText(formData, "testRecipientPhone"),
    );
    const testConversation = configuredRecipient
      ? await prisma.whatsAppConversation.findUnique({
          where: {
            shop_phoneNumber: {
              shop: session.shop,
              phoneNumber: configuredRecipient,
            },
          },
        })
      : null;
    if (
      !isWhatsAppTestSendingEnabled() ||
      normalizedRecipient !== configuredRecipient ||
      !testConversation ||
      !conversation ||
      testConversation.id !== conversation.id ||
      testConversation.isDemo ||
      !testConversation.lastInboundAt
    ) {
      return json(
        {
          error:
            "Test sending is locked. Configure the allow-listed phone, verify Meta's webhook, and receive a real inbound message from that phone.",
        },
        403,
      );
    }
    if (
      !isTemplate &&
      !isInsideCustomerServiceWindow(testConversation.lastInboundAt)
    ) {
      return json(
        { error: "The 24-hour customer-service window has closed. Send an approved template instead." },
        400,
      );
    }
  }

  const messageType = isTemplate ? "TEMPLATE" : "TEXT";
  let payload: Record<string, unknown>;
  if (!isTemplate) {
    payload = buildWhatsAppTextPayload(recipientPhone, text);
  } else {
    if (!template || !templateInput) {
      return json({ error: "Choose an approved template for this shop." }, 400);
    }
    payload = buildWhatsAppTemplatePayload(
      recipientPhone,
      template.name,
      template.language,
      templateInput.components,
    );
  }

  let sendResult;
  try {
    sendResult = await sendAndPersistWhatsAppMessage(
      prisma,
      config,
      payload,
      {
        shop: session.shop,
        phoneNumber: recipientPhone,
        ...(conversation ? { conversationId: conversation.id } : {}),
        clientRequestId,
        type: messageType,
        text,
      },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return json(
        { error: "This send request was already recorded; use a new request to send another message." },
        409,
      );
    }
    if (error instanceof WhatsAppDemoConversationError) {
      return json({ error: error.message }, 409);
    }
    throw error;
  }
  if (sendResult.error) {
    return json(
      {
        error: `${whatsAppApiErrorMessage(sendResult.error)} Check the Inbox before retrying if Meta's response timed out.`,
        messageId: sendResult.pendingMessage.messageId,
        conversationId: sendResult.pendingMessage.conversationId,
      },
      502,
    );
  }
  return json({
    success: "Message accepted by Meta.",
    messageId: sendResult.pendingMessage.messageId,
    conversationId: sendResult.pendingMessage.conversationId,
  });
};

type TemplateOption = Awaited<ReturnType<typeof loader>>["approvedTemplates"][number];

function TemplateInputFields({
  template,
  input,
  onChange,
  disabled,
  idPrefix,
}: {
  template: TemplateOption | undefined;
  input: WhatsAppTemplateInput;
  onChange: (next: WhatsAppTemplateInput) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const requirements: WhatsAppTemplateRequirements | null =
    template?.requirements ?? null;
  let preview = "";
  let validationMessage = "";
  if (template && requirements) {
    try {
      preview = parseWhatsAppTemplateInput(
        JSON.stringify(input),
        template.components,
      ).preview;
    } catch (error) {
      validationMessage =
        error instanceof Error ? error.message : "Complete all required template fields.";
    }
  }

  const updateBody = (index: number, value: string) => {
    const body = [...(input.body ?? [])];
    body[index] = value;
    onChange({ ...input, body });
  };
  const updateHeaderText = (index: number, value: string) => {
    const header = input.header?.format === "TEXT" ? input.header : { format: "TEXT" as const };
    const values = [...(header.values ?? [])];
    values[index] = value;
    onChange({ ...input, header: { ...header, values } });
  };
  const updateImageHeader = (
    field: "mediaType" | "value",
    value: string,
  ) => {
    const header = input.header?.format === "IMAGE" ? input.header : { format: "IMAGE" as const };
    onChange({ ...input, header: { ...header, [field]: value } as WhatsAppTemplateInput["header"] });
  };
  const updateButton = (buttonIndex: number, parameterIndex: number, value: string) => {
    const buttons = { ...(input.buttons ?? {}) };
    const values = [...(buttons[String(buttonIndex)] ?? [])];
    values[parameterIndex] = value;
    buttons[String(buttonIndex)] = values;
    onChange({ ...input, buttons });
  };

  return (
    <>
      <input
        type="hidden"
        name="templateInput"
        value={JSON.stringify(input)}
      />
      {template?.componentError && (
        <p className="bc-inbox-error" role="alert">{template.componentError}</p>
      )}
      {requirements?.unsupported && (
        <p className="bc-inbox-error" role="alert">{requirements.unsupported}</p>
      )}
      {requirements?.header?.format === "TEXT" &&
        requirements.header.variables.map((variable, index) => (
          <label className="bc-template-input" key={`header-${variable.key}`}>
            Text header · {variable.label}
            <input
              type="text"
              value={input.header?.format === "TEXT" ? input.header.values?.[index] ?? "" : ""}
              maxLength={1024}
              required
              disabled={disabled}
              onChange={(event) => updateHeaderText(index, event.target.value)}
            />
          </label>
        ))}
      {requirements?.header?.format === "IMAGE" && (
        <div className="bc-template-input">
          <label htmlFor={`${idPrefix}-header-source`}>Image header source</label>
          <select
            id={`${idPrefix}-header-source`}
            value={input.header?.format === "IMAGE" ? input.header.mediaType ?? "" : ""}
            required
            disabled={disabled}
            onChange={(event) => updateImageHeader("mediaType", event.target.value)}
          >
            <option value="">Choose image source</option>
            <option value="url">Public HTTPS image URL</option>
            <option value="id">WhatsApp media ID</option>
          </select>
          <label htmlFor={`${idPrefix}-header-image`}>
            {input.header?.format === "IMAGE" && input.header.mediaType === "id"
              ? "Image media ID"
              : "Image URL"}
          </label>
          <input
            id={`${idPrefix}-header-image`}
            type="text"
            value={input.header?.format === "IMAGE" ? input.header.value ?? "" : ""}
            placeholder={input.header?.format === "IMAGE" && input.header.mediaType === "id" ? "Numeric WhatsApp media ID" : "https://…"}
            maxLength={2048}
            required
            disabled={disabled}
            onChange={(event) => updateImageHeader("value", event.target.value)}
          />
          <p className="bc-inbox-hint">
            A URL must be publicly fetchable by Meta over HTTPS. Media IDs must belong to the configured WhatsApp Cloud API phone number.
          </p>
        </div>
      )}
      {requirements?.bodyVariables.map((variable, index) => (
        <label className="bc-template-input" key={`body-${variable.key}`}>
          Body · {variable.label}
          <input
            type="text"
            value={input.body?.[index] ?? ""}
            maxLength={1024}
            required
            disabled={disabled}
            onChange={(event) => updateBody(index, event.target.value)}
          />
        </label>
      ))}
      {requirements?.buttons.map((button) =>
        button.variables.map((variable, index) => (
          <label
            className="bc-template-input"
            key={`button-${button.index}-${variable.key}`}
          >
            Button URL · {button.label} · {variable.label}
            <input
              type="text"
              value={input.buttons?.[String(button.index)]?.[index] ?? ""}
              maxLength={1024}
              required
              disabled={disabled}
              onChange={(event) =>
                updateButton(button.index, index, event.target.value)
              }
            />
          </label>
        )),
      )}
      {requirements && template && !requirements.unsupported && (
        <div className="bc-template-preview" aria-live="polite">
          <strong>Message preview</strong>
          <p>{preview || requirements.bodyText || "Approved template with no body text."}</p>
          {validationMessage && (
            <p className="bc-template-preview-hint">{validationMessage}</p>
          )}
        </div>
      )}
    </>
  );
}

export default function InboxPage() {
  const {
    conversations,
    selectedConversation,
    messages,
    approvedTemplates,
    testRecipientPhone,
    testRecipientConfigured,
    testRecipientHasInbound,
    webhookVerified,
    testSendingOptIn,
    testSendingReady,
    inboxSendingOptIn,
    inboxSendingReady,
    activeShopDomain,
    configuredShopDomain,
    tenantBound,
    webhookConfigurationComplete,
  } = useLoaderData<typeof loader>();
  const actionFetcher = useFetcher<InboxActionData>();
  const newChatFetcher = useFetcher<InboxActionData>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const newChatDialogRef = useRef<HTMLDialogElement>(null);
  const handledNewChatMessageRef = useRef<string | null>(null);
  const [mode, setMode] = useState<"reply" | "template">("reply");
  const [templateId, setTemplateId] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatTemplateId, setNewChatTemplateId] = useState("");
  const [newChatRecipient, setNewChatRecipient] = useState("");
  const [newChatInput, setNewChatInput] = useState<WhatsAppTemplateInput>({});
  const [newChatRequestId, setNewChatRequestId] = useState("");
  const [testRecipientInput, setTestRecipientInput] = useState(
    testRecipientPhone ?? selectedConversation?.phoneNumber ?? "",
  );
  const [clientRequestId, setClientRequestId] = useState("");
  const [replyText, setReplyText] = useState("");
  const [replyTemplateInput, setReplyTemplateInput] = useState<WhatsAppTemplateInput>({});
  useEffect(() => {
    if (!clientRequestId) {
      setClientRequestId(globalThis.crypto.randomUUID());
    }
  }, [clientRequestId]);
  useEffect(() => {
    if (!newChatRequestId) setNewChatRequestId(globalThis.crypto.randomUUID());
  }, [newChatRequestId]);
  useEffect(() => {
    setTestRecipientInput(
      testRecipientPhone ?? selectedConversation?.phoneNumber ?? "",
    );
  }, [selectedConversation?.id, selectedConversation?.phoneNumber, testRecipientPhone]);
  useEffect(() => {
    if (actionFetcher.data?.success && actionFetcher.data.messageId) {
      setClientRequestId(globalThis.crypto.randomUUID());
      setReplyText("");
      setReplyTemplateInput({});
      setTemplateId("");
    }
  }, [actionFetcher.data?.messageId, actionFetcher.data?.success]);
  useEffect(() => {
    const data = newChatFetcher.data;
    if (
      !data?.conversationId ||
      !data.messageId ||
      handledNewChatMessageRef.current === data.messageId
    ) {
      return;
    }
    handledNewChatMessageRef.current = data.messageId;
    const conversationId = data.conversationId;
    void revalidator.revalidate();
    void navigate(`/app/inbox?conversation=${encodeURIComponent(conversationId)}`);
    if (data.success) {
      setNewChatOpen(false);
      setNewChatRecipient("");
      setNewChatTemplateId("");
      setNewChatInput({});
      setNewChatRequestId(globalThis.crypto.randomUUID());
    }
  }, [
    navigate,
    newChatFetcher.data,
    revalidator,
  ]);
  useEffect(() => {
    const dialog = newChatDialogRef.current;
    if (!dialog) return;
    if (newChatOpen && !dialog.open) dialog.showModal();
    if (!newChatOpen && dialog.open) dialog.close();
  }, [newChatOpen]);
  useEffect(() => {
    if (revalidator.state !== "idle") return;

    const refreshWhenVisible = () => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      ) {
        void revalidator.revalidate();
      }
    };
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [revalidator]);

  const selectedTemplate = approvedTemplates.find(
    (templateOption) => templateOption.id === templateId,
  );
  const newChatTemplate = approvedTemplates.find(
    (templateOption) => templateOption.id === newChatTemplateId,
  );
  const isSelectedTestRecipient = Boolean(
    selectedConversation &&
      !selectedConversation.isDemo &&
      testRecipientPhone === selectedConversation.phoneNumber,
  );
  const testSendAvailable =
    inboxSendingReady ||
    (testSendingReady &&
      testRecipientHasInbound &&
      isSelectedTestRecipient);
  const isReplyAllowed =
    selectedConversation?.isDemo ||
    isInsideCustomerServiceWindow(
      selectedConversation?.lastInboundAt
        ? new Date(selectedConversation.lastInboundAt)
        : null,
    );

  return (
    <s-page heading="WhatsApp Inbox">
      <section className="bc-inbox" aria-labelledby="inbox-heading">
        <header className="bc-inbox-header">
          <div>
            <h1 id="inbox-heading">WhatsApp Inbox</h1>
            <p>Review customer conversations and respond within WhatsApp rules.</p>
          </div>
          <actionFetcher.Form method="post">
            <input type="hidden" name="intent" value="seed-demo" />
            <button
              className="bc-button"
              type="submit"
              disabled={actionFetcher.state !== "idle"}
            >
              {actionFetcher.state === "idle" ? "Add sample conversation" : "Preparing…"}
            </button>
          </actionFetcher.Form>
        </header>

        <section className="bc-test-gate" aria-labelledby="test-gate-heading">
          <div>
            <h2 id="test-gate-heading">WhatsApp sending controls</h2>
            <p>
              General Inbox sending and the restricted personal-phone test path are separately gated. Campaign and scheduled sending remain disabled.
            </p>
          </div>
          <ul>
            <li data-ready={tenantBound}>
              Shop binding:{" "}
              {tenantBound
                ? "matched"
                : configuredShopDomain
                  ? "blocked — configured shop does not match this Shopify session"
                  : "blocked — WHATSAPP_SHOP_DOMAIN is missing"}
            </li>
            <li data-ready={webhookConfigurationComplete}>
              Cloud API credentials and Meta app secret: {webhookConfigurationComplete ? "configured" : "blocked — incomplete"}
            </li>
            <li data-ready={webhookVerified}>
              Meta GET webhook verification: {webhookVerified ? "verified" : "blocked — not verified"}
            </li>
            <li data-ready={testRecipientHasInbound}>
              Signed inbound test message: {testRecipientHasInbound ? "received" : "blocked — waiting for the configured phone's first message"}
            </li>
            <li data-ready={testRecipientConfigured}>
              Allow-listed test phone: {testRecipientConfigured ? "configured" : "blocked — configure WHATSAPP_TEST_RECIPIENT_PHONE"}
            </li>
            <li data-ready={approvedTemplates.length > 0}>
              Approved template: {approvedTemplates.length > 0 ? `${approvedTemplates.length} synced` : "blocked — sync an approved template"}
            </li>
            <li data-ready={testSendingOptIn}>
              Test-only sending switch: {testSendingOptIn ? "enabled" : "disabled"}
            </li>
            <li data-ready={inboxSendingOptIn}>
              General Inbox sending switch: {inboxSendingOptIn ? "enabled" : "disabled"}
            </li>
            <li data-ready={inboxSendingReady}>
              Outbound WhatsApp sending: {inboxSendingReady ? "ready" : "blocked until the sending switch, shop binding, and Cloud API credentials are ready"}
            </li>
          </ul>
          <p className="bc-inbox-shop-binding">
            Current authenticated shop: <strong>{activeShopDomain}</strong>
            <br />
            WHATSAPP_SHOP_DOMAIN:{" "}
            <strong>{configuredShopDomain ?? "not configured"}</strong>
          </p>
          <div className="bc-inbox-setup">
            <h3>Meta webhook setup</h3>
            <ol>
              <li>
                Set <code>WHATSAPP_SHOP_DOMAIN</code> to the exact shop shown
                above only if it is the intended shop. The app will not
                substitute the development shop for another store. Restart
                <code> shopify app dev</code> after changing server environment
                values.
              </li>
              <li>
                In Meta for Developers, open your app&apos;s WhatsApp
                configuration and set the callback URL to the current public
                HTTPS Shopify CLI tunnel URL followed by{" "}
                <code>/webhooks/whatsapp</code>. Do not use localhost or a
                previous tunnel URL.
              </li>
              <li>
                Enter the configured verification token in Meta and verify the
                callback. The GET check uses{" "}
                <code>WHATSAPP_WEBHOOK_VERIFY_TOKEN</code>; its value is never
                shown here.
              </li>
              <li>
                Subscribe the WhatsApp Business Account to the{" "}
                <code>messages</code> webhook field (and to this app if Meta
                requires it). A signed inbound message from the configured test
                phone completes the inbound check.
              </li>
            </ol>
            <p>
              POST signature checks use the existing{" "}
              <code>META_APP_SECRET</code>. General Inbox sending remains
              disabled unless{" "}
              <code> WHATSAPP_INBOX_SENDING_ENABLED=true</code> is explicitly
              set after webhook verification and policy/consent review. The
              older test switch and its recipient allowlist only enable the
              restricted test path; they do not unlock general Inbox sends.
            </p>
          </div>
          <p className="bc-inbox-hint">
            Sample conversations always stay local. The Sidekick/assistant bar, if visible at the bottom of Shopify Admin, is part of Shopify Admin and is outside this app&apos;s styling boundary.
          </p>
        </section>

        <div className="bc-inbox-shell">
          <aside className="bc-conversation-list" aria-label="Conversations">
            <div className="bc-conversation-list-heading">
              <h2>Conversations</h2>
              <button
                className="bc-button bc-button-primary"
                type="button"
                onClick={() => setNewChatOpen(true)}
              >
                Start New Chat
              </button>
            </div>
            {newChatOpen &&
              createPortal(
                <dialog
                  className="bc-new-chat-dialog"
                  ref={newChatDialogRef}
                  aria-labelledby="bc-new-chat-heading"
                  onCancel={() => setNewChatOpen(false)}
                >
                  <header>
                    <div>
                      <h2 id="bc-new-chat-heading">Start New Chat</h2>
                      <p>Send an approved template to begin a WhatsApp conversation.</p>
                    </div>
                    <button
                      className="bc-button"
                      type="button"
                      onClick={() => setNewChatOpen(false)}
                      disabled={newChatFetcher.state !== "idle"}
                    >
                      Close
                    </button>
                  </header>
                  <newChatFetcher.Form method="post" className="bc-new-chat-form">
                    <input type="hidden" name="intent" value="start-new-chat" />
                    <input
                      type="hidden"
                      name="clientRequestId"
                      value={newChatRequestId}
                    />
                    <label htmlFor="bc-new-chat-phone">
                      Recipient phone number (international format)
                    </label>
                    <input
                      id="bc-new-chat-phone"
                      name="recipientPhone"
                      type="tel"
                      autoComplete="tel"
                      placeholder="+15551234567"
                      value={newChatRecipient}
                      onChange={(event) => setNewChatRecipient(event.target.value)}
                      required
                      pattern="\\+[0-9 ()-]{7,24}"
                      disabled={newChatFetcher.state !== "idle"}
                    />
                    <label htmlFor="bc-new-chat-template">
                      Approved template and language
                    </label>
                    <select
                      id="bc-new-chat-template"
                      name="templateId"
                      value={newChatTemplateId}
                      required
                      disabled={newChatFetcher.state !== "idle"}
                      onChange={(event) => {
                        setNewChatTemplateId(event.target.value);
                        setNewChatInput({});
                      }}
                    >
                      <option value="">Choose a synced approved template</option>
                      {approvedTemplates.map((templateOption) => (
                        <option
                          key={templateOption.id}
                          value={templateOption.id}
                          disabled={!templateOption.requirements || Boolean(templateOption.componentError)}
                        >
                          {templateOption.name} · {templateOption.language} · {templateOption.category}
                        </option>
                      ))}
                    </select>
                    {newChatTemplate && (
                      <TemplateInputFields
                        template={newChatTemplate}
                        input={newChatInput}
                        onChange={setNewChatInput}
                        disabled={newChatFetcher.state !== "idle"}
                        idPrefix="new-chat"
                      />
                    )}
                    <label className="bc-marketing-opt-in">
                      <input
                        type="checkbox"
                        name="confirmRecipientOptIn"
                        value="yes"
                        required
                        disabled={newChatFetcher.state !== "idle"}
                      />
                      I confirm this recipient opted in to receive WhatsApp messages from this business. Shopify email consent is not WhatsApp consent.
                    </label>
                    {!inboxSendingReady && (
                      <p className="bc-inbox-notice" role="status">
                        Outbound sending needs the sending switch, matching Shopify shop, and valid Cloud API credentials. Webhook verification is only needed for receiving messages and delivery updates.
                      </p>
                    )}
                    {newChatFetcher.data?.error && (
                      <p className="bc-inbox-error" role="alert">
                        {newChatFetcher.data.error}
                      </p>
                    )}
                    <footer>
                      <button
                        className="bc-button"
                        type="button"
                        onClick={() => setNewChatOpen(false)}
                        disabled={newChatFetcher.state !== "idle"}
                      >
                        Cancel
                      </button>
                      <button
                        className="bc-button bc-button-primary"
                        type="submit"
                        disabled={
                          !newChatRequestId ||
                          !inboxSendingReady ||
                          !newChatTemplate ||
                          !newChatTemplate.requirements ||
                          Boolean(newChatTemplate.requirements.unsupported) ||
                          Boolean(newChatTemplate.componentError) ||
                          normalizeE164Phone(newChatRecipient) === null ||
                          !newChatRecipient.trim().startsWith("+") ||
                          newChatFetcher.state !== "idle"
                        }
                      >
                        {newChatFetcher.state !== "idle" ? "Sending template…" : "Start chat"}
                      </button>
                    </footer>
                  </newChatFetcher.Form>
                </dialog>,
                document.body,
              )}
            {conversations.length === 0 ? (
              <p className="bc-empty-state">
                No conversations yet. Start a chat with an approved template or add a local sample.
              </p>
            ) : (
              conversations.map((conversation) => (
                <Link
                  key={conversation.id}
                  to={`/app/inbox?conversation=${encodeURIComponent(conversation.id)}`}
                  className={`bc-conversation${selectedConversation?.id === conversation.id ? " is-selected" : ""}`}
                >
                  <span className="bc-conversation-top">
                    <strong>{conversation.customerName || conversation.phoneNumber}</strong>
                    {conversation.unreadCount > 0 && (
                      <span className="bc-unread-count" aria-label={`${conversation.unreadCount} unread`}>
                        {conversation.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="bc-conversation-phone">{conversation.phoneNumber}</span>
                  <span className="bc-conversation-bottom">
                    <span>{conversation.isDemo ? "Sample" : "WhatsApp"}</span>
                    <time dateTime={conversation.lastMessageAt.toISOString()}>
                      {conversation.lastMessageAt.toLocaleString()}
                    </time>
                  </span>
                </Link>
              ))
            )}
          </aside>

          <section className="bc-message-panel" aria-label="Message history">
            {selectedConversation ? (
              <>
                <header className="bc-message-header">
                  <div>
                    <h2>{selectedConversation.customerName || "Customer"}</h2>
                    <p>{selectedConversation.phoneNumber}</p>
                  </div>
                  {selectedConversation.unreadCount > 0 && (
                    <actionFetcher.Form method="post">
                      <input type="hidden" name="intent" value="mark-read" />
                      <input
                        type="hidden"
                        name="conversationId"
                        value={selectedConversation.id}
                      />
                      <button
                        className="bc-button"
                        type="submit"
                        disabled={actionFetcher.state !== "idle"}
                      >
                        Mark read ({selectedConversation.unreadCount})
                      </button>
                    </actionFetcher.Form>
                  )}
                  <span className={`bc-status ${selectedConversation.isDemo ? "bc-status-demo" : "bc-status-whatsapp"}`}>
                    {selectedConversation.isDemo ? "Demo only" : "WhatsApp"}
                  </span>
                </header>

                <div className="bc-message-history" aria-live="polite">
                  {messages.map((message) => (
                    <article
                      key={message.id}
                      className={`bc-message bc-message-${message.direction.toLowerCase()}`}
                    >
                      <div className="bc-message-kind">
                        {message.direction === "INBOUND" ? "Customer" : "You"}
                        {message.type !== "TEXT" && ` · ${message.type.toLowerCase()}`}
                      </div>
                      <p>{message.text}</p>
                      <footer>
                        <time dateTime={message.createdAt.toISOString()}>
                          {message.createdAt.toLocaleString()}
                        </time>
                        {message.direction === "OUTBOUND" && (
                          <span className="bc-delivery-status">{message.status}</span>
                        )}
                      </footer>
                    </article>
                  ))}
                  {messages.length === 0 && (
                    <p className="bc-empty-state">No messages in this conversation yet.</p>
                  )}
                </div>

                {selectedConversation.isDemo ? (
                  <p className="bc-inbox-notice" role="status">
                    Demo mode: replies are saved locally only; nothing is sent to WhatsApp.
                  </p>
                ) : !testSendAvailable ? (
                  <p className="bc-inbox-notice" role="status">
                    {inboxSendingOptIn
                      ? "General Inbox sending is blocked until the authenticated shop, Cloud API configuration, and Meta webhook verification all match."
                      : "Test sends require the configured allow-listed phone, a signed inbound message, verified webhook, matching shop, and test-only switch. Normal Inbox sending has a separate explicit switch."}
                  </p>
                ) : null}

                {actionFetcher.data?.error && (
                  <p className="bc-inbox-error" role="alert">{actionFetcher.data.error}</p>
                )}
                {actionFetcher.data?.success && (
                  <p className="bc-inbox-success" role="status">{actionFetcher.data.success}</p>
                )}

                <actionFetcher.Form method="post" className="bc-reply-form">
                  <input type="hidden" name="conversationId" value={selectedConversation.id} />
                  <input type="hidden" name="clientRequestId" value={clientRequestId} />
                  <div className="bc-reply-mode" role="group" aria-label="Message type">
                    <button
                      type="button"
                      aria-pressed={mode === "reply"}
                      onClick={() => setMode("reply")}
                    >
                      Text reply
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === "template"}
                      onClick={() => setMode("template")}
                    >
                      Approved template
                    </button>
                  </div>
                  {mode === "reply" ? (
                    <>
                      <input type="hidden" name="intent" value="send-reply" />
                      {!selectedConversation.isDemo && (
                        <>
                          {inboxSendingOptIn ? (
                            <input
                              type="hidden"
                              name="testRecipientPhone"
                              value={selectedConversation.phoneNumber}
                            />
                          ) : (
                            <>
                              <label htmlFor="inbox-test-recipient">Configured test recipient</label>
                              <input
                                id="inbox-test-recipient"
                                name="testRecipientPhone"
                                type="tel"
                                autoComplete="tel"
                                value={testRecipientInput}
                                onChange={(event) => setTestRecipientInput(event.target.value)}
                                placeholder="+15551234567"
                                required
                                disabled={actionFetcher.state !== "idle"}
                              />
                              <p className="bc-inbox-hint">
                                Test-only sending must match the configured single-recipient allow-list. Normal Inbox sending uses the conversation number only when explicitly enabled.
                              </p>
                            </>
                          )}
                        </>
                      )}
                      {!isReplyAllowed && (
                        <p className="bc-inbox-notice">
                          The 24-hour customer-service window has closed. Use an approved template.
                        </p>
                      )}
                      <label htmlFor="inbox-reply">Reply</label>
                      <textarea
                        id="inbox-reply"
                        name="text"
                        rows={3}
                        maxLength={4096}
                        placeholder="Write a reply…"
                        value={replyText}
                        onChange={(event) => setReplyText(event.target.value)}
                        required
                        disabled={
                          (!selectedConversation.isDemo && (!testSendAvailable || !isReplyAllowed)) ||
                          !clientRequestId ||
                          actionFetcher.state !== "idle"
                        }
                      />
                      <button
                        className="bc-button bc-button-primary"
                        type="submit"
                        disabled={
                          (!selectedConversation.isDemo && (!testSendAvailable || !isReplyAllowed)) ||
                          !clientRequestId ||
                          actionFetcher.state !== "idle"
                        }
                      >
                        {actionFetcher.state !== "idle" ? "Sending…" : "Send reply"}
                      </button>
                    </>
                  ) : (
                    <>
                      <input type="hidden" name="intent" value="send-template" />
                      {!selectedConversation.isDemo &&
                        (inboxSendingOptIn ? (
                          <input
                            type="hidden"
                            name="testRecipientPhone"
                            value={selectedConversation.phoneNumber}
                          />
                        ) : (
                          <>
                            <label htmlFor="inbox-template-recipient">Configured test recipient</label>
                            <input
                              id="inbox-template-recipient"
                              name="testRecipientPhone"
                              type="tel"
                              autoComplete="tel"
                              value={testRecipientInput}
                              onChange={(event) => setTestRecipientInput(event.target.value)}
                              placeholder="+15551234567"
                              required
                              disabled={actionFetcher.state !== "idle"}
                            />
                          </>
                        ))}
                      <label htmlFor="inbox-template">Approved template</label>
                      <select
                        id="inbox-template"
                        name="templateId"
                        value={templateId}
                        onChange={(event) => {
                          setTemplateId(event.target.value);
                          setReplyTemplateInput({});
                        }}
                        required
                        disabled={actionFetcher.state !== "idle"}
                      >
                        <option value="">Choose a synced template</option>
                        {approvedTemplates.map((approvedTemplate) => (
                          <option key={approvedTemplate.id} value={approvedTemplate.id}>
                            {approvedTemplate.name} · {approvedTemplate.language}
                          </option>
                        ))}
                      </select>
                      {selectedTemplate && (
                        <TemplateInputFields
                          template={selectedTemplate}
                          input={replyTemplateInput}
                          onChange={setReplyTemplateInput}
                          disabled={actionFetcher.state !== "idle"}
                          idPrefix="reply-template"
                        />
                      )}
                      {selectedTemplate && (
                        <p className="bc-inbox-hint">
                          {selectedTemplate.name} · {selectedTemplate.language} · {selectedTemplate.bodyParameterCount === null ? "Template placeholders need review" : `${selectedTemplate.bodyParameterCount} body parameter${selectedTemplate.bodyParameterCount === 1 ? "" : "s"} required`}
                        </p>
                      )}
                      {!selectedConversation.isDemo && (
                          <label className="bc-marketing-opt-in">
                            <input
                              type="checkbox"
                              name="confirmRecipientOptIn"
                              value="yes"
                              required
                              disabled={actionFetcher.state !== "idle"}
                            />
                            I confirm this recipient explicitly opted in to receive WhatsApp messages from this business. Shopify email consent is not WhatsApp consent.
                          </label>
                      )}
                      <button
                        className="bc-button bc-button-primary"
                        type="submit"
                        disabled={
                          !templateId ||
                          approvedTemplates.length === 0 ||
                          (!selectedConversation.isDemo && !testSendAvailable) ||
                          !selectedTemplate?.requirements ||
                          Boolean(selectedTemplate.requirements.unsupported) ||
                          Boolean(selectedTemplate.componentError) ||
                          selectedTemplate?.bodyParameterCount === null ||
                          !clientRequestId ||
                          actionFetcher.state !== "idle"
                        }
                      >
                        {actionFetcher.state !== "idle" ? "Sending…" : "Send template"}
                      </button>
                    </>
                  )}
                </actionFetcher.Form>
              </>
            ) : (
              <div className="bc-inbox-empty">
                <h2>Select a conversation</h2>
                <p>Incoming WhatsApp conversations will appear here after the webhook is configured.</p>
              </div>
            )}
          </section>
        </div>
      </section>
    </s-page>
  );
}

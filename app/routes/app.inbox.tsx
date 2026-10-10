import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  isInsideCustomerServiceWindow,
  buildWhatsAppTemplatePayload,
  buildWhatsAppTextPayload,
  getTemplateBodyParameterCount,
  normalizeE164Phone,
  parseTemplateBodyParameters,
} from "../whatsapp-shared";
import {
  getConfiguredWhatsAppShop,
  getWhatsAppConfig,
  getWhatsAppTestRecipient,
  isWhatsAppTestSendingEnabled,
  isWhatsAppWebhookConfigurationComplete,
  recordWhatsAppMessageAccepted,
  sendWhatsAppApiRequest,
  whatsAppApiErrorMessage,
  WhatsAppConfigurationError,
} from "../whatsapp.server";

const json = (body: object, status = 200) =>
  Response.json(body, { status });

type InboxActionData = {
  error?: string;
  success?: string;
  messageId?: string;
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
    approvedTemplates: approvedTemplates.map(({ components, ...template }) => {
      try {
        return {
          ...template,
          bodyParameterCount: getTemplateBodyParameterCount(components),
        };
      } catch {
        return { ...template, bodyParameterCount: null };
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

  if (intent !== "send-reply" && intent !== "send-template") {
    return json({ error: "Unsupported inbox action." }, 400);
  }

  const conversationId = formText(formData, "conversationId");
  if (!conversationId) return json({ error: "Choose a conversation first." }, 400);
  const conversation = await prisma.whatsAppConversation.findFirst({
    where: { id: conversationId, shop: session.shop },
  });
  if (!conversation) {
    return json({ error: "That conversation was not found for this shop." }, 404);
  }

  let template: {
    name: string;
    language: string;
    category: string;
    components: string;
  } | null =
    null;
  let templateParameters: string[] = [];
  let text = "";
  if (intent === "send-reply") {
    text = formText(formData, "text");
    if (!text || text.length > 4096) {
      return json({ error: "Enter a reply between 1 and 4,096 characters." }, 400);
    }
    if (
      !conversation.isDemo &&
      !isInsideCustomerServiceWindow(conversation.lastInboundAt)
    ) {
      return json(
        { error: "The 24-hour customer-service window has closed. Send an approved template instead." },
        400,
      );
    }
  } else {
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
      templateParameters = parseTemplateBodyParameters(
        formText(formData, "templateParameters"),
        template.components,
      );
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid template parameters." },
        400,
      );
    }
    text = `Template: ${template.name}${templateParameters.length ? ` · ${templateParameters.join(", ")}` : ""}`;
  }

  if (conversation.isDemo) {
    const message = await prisma.$transaction(async (transaction) => {
      const created = await transaction.whatsAppMessage.create({
        data: {
          conversationId: conversation.id,
          shop: session.shop,
          direction: "OUTBOUND",
          type: intent === "send-template" ? "TEMPLATE" : "TEXT",
          text,
          status: "DEMO",
        },
        select: { id: true },
      });
      await transaction.whatsAppConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      return created;
    });
    return json({
      success: "Demo reply saved locally. No WhatsApp messages were sent.",
      messageId: message.id,
    });
  }

  if (
    intent === "send-template" &&
    template?.category.toUpperCase() === "MARKETING" &&
    formText(formData, "confirmMarketingOptIn") !== "yes"
  ) {
    return json(
      { error: "Confirm that this test recipient explicitly opted in to receive WhatsApp marketing messages." },
      400,
    );
  }

  const normalizedRecipient = normalizeE164Phone(
    formText(formData, "testRecipientPhone"),
  );
  const configuredRecipient = getWhatsAppTestRecipient();
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
    !isWhatsAppWebhookConfigurationComplete() ||
    getConfiguredWhatsAppShop() !== session.shop ||
    normalizedRecipient !== configuredRecipient ||
    !testConversation ||
    testConversation.id !== conversation.id ||
    testConversation.isDemo ||
    !testConversation.lastInboundAt
  ) {
    return json(
      { error: "Test sending is locked. Configure the single test recipient and shop, verify Meta's webhook, then receive a real inbound message from that recipient." },
      403,
    );
  }
  if (!configuredRecipient) {
    return json({ error: "A valid allow-listed test recipient is not configured." }, 403);
  }
  const verifiedWebhook = await prisma.whatsAppWebhookVerification.findFirst({
    where: {
      shop: session.shop,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "",
    },
    select: { shop: true },
  });
  if (!verifiedWebhook) {
    return json(
      { error: "Meta webhook verification is not recorded for this shop and phone number yet." },
      403,
    );
  }

  if (
    intent === "send-reply" &&
    !isInsideCustomerServiceWindow(testConversation.lastInboundAt)
  ) {
    return json(
      { error: "The 24-hour customer-service window has closed. Send an approved template instead." },
      400,
    );
  }

  let config;
  try {
    config = getWhatsAppConfig();
  } catch (error) {
    return json({ error: whatsAppApiErrorMessage(error) }, 503);
  }

  const messageType = intent === "send-template" ? "TEMPLATE" : "TEXT";
  const recipientPhone = configuredRecipient;
  let payload: Record<string, unknown>;
  if (intent === "send-reply") {
    payload = buildWhatsAppTextPayload(recipientPhone, text);
  } else {
    if (!template) {
      return json({ error: "Choose an approved template for this shop." }, 400);
    }
    payload = buildWhatsAppTemplatePayload(
      recipientPhone,
      template.name,
      template.language,
      templateParameters,
    );
  }
  const clientRequestId = formText(formData, "clientRequestId");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      clientRequestId,
    )
  ) {
    return json({ error: "Refresh the Inbox and retry; the send request identifier is invalid." }, 400);
  }
  const webhookPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  if (
    !webhookPhoneNumberId ||
    !(await prisma.whatsAppWebhookVerification.findFirst({
      where: { shop: session.shop, phoneNumberId: webhookPhoneNumberId },
      select: { shop: true },
    }))
  ) {
    return json({ error: "Meta webhook verification is not recorded for this shop and phone number yet." }, 403);
  }
  let pendingMessage;
  try {
    pendingMessage = await prisma.whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        shop: session.shop,
        direction: "OUTBOUND",
        type: messageType,
        text,
        status: "PENDING",
        clientRequestId,
      },
      select: { id: true },
    });
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
    throw error;
  }

  let whatsappMessageId: string;
  try {
    whatsappMessageId = await sendWhatsAppApiRequest(config, payload);
  } catch (error) {
    await prisma.whatsAppMessage.updateMany({
      where: { id: pendingMessage.id, shop: session.shop },
      data: { status: "FAILED" },
    });
    return json(
      {
        error: `${whatsAppApiErrorMessage(error)} Check the Inbox before retrying if Meta's response timed out.`,
        messageId: pendingMessage.id,
      },
      502,
    );
  }

  await prisma.$transaction((transaction) =>
    recordWhatsAppMessageAccepted(transaction, {
      id: pendingMessage.id,
      conversationId: conversation.id,
      shop: session.shop,
      whatsappMessageId,
    }),
  );
  return json({ success: "Message accepted by Meta.", messageId: pendingMessage.id });
};

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
    activeShopDomain,
    configuredShopDomain,
    tenantBound,
    webhookConfigurationComplete,
  } = useLoaderData<typeof loader>();
  const actionFetcher = useFetcher<InboxActionData>();
  const revalidator = useRevalidator();
  const [mode, setMode] = useState<"reply" | "template">("reply");
  const [templateId, setTemplateId] = useState("");
  const [testRecipientInput, setTestRecipientInput] = useState(
    testRecipientPhone ?? selectedConversation?.phoneNumber ?? "",
  );
  const [clientRequestId, setClientRequestId] = useState("");
  const [replyText, setReplyText] = useState("");
  const [templateParametersInput, setTemplateParametersInput] = useState("");
  useEffect(() => {
    if (!clientRequestId) {
      setClientRequestId(globalThis.crypto.randomUUID());
    }
  }, [clientRequestId]);
  useEffect(() => {
    setTestRecipientInput(
      testRecipientPhone ?? selectedConversation?.phoneNumber ?? "",
    );
  }, [selectedConversation?.id, selectedConversation?.phoneNumber, testRecipientPhone]);
  useEffect(() => {
    if (actionFetcher.data?.success && actionFetcher.data.messageId) {
      setClientRequestId(globalThis.crypto.randomUUID());
      setReplyText("");
      setTemplateParametersInput("");
      setTemplateId("");
    }
  }, [actionFetcher.data?.messageId, actionFetcher.data?.success]);
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
  const isSelectedTestRecipient = Boolean(
    selectedConversation &&
      !selectedConversation.isDemo &&
      testRecipientPhone === selectedConversation.phoneNumber,
  );
  const testSendAvailable =
    testSendingReady &&
    testRecipientHasInbound &&
    isSelectedTestRecipient;
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
            <h2 id="test-gate-heading">Personal-phone test only</h2>
            <p>
              Real sends are restricted to one server-configured test recipient. No campaign or other customer sends are enabled.
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
              <code>META_APP_SECRET</code>. Sending remains disabled unless you
              explicitly enable the test-only switch after the webhook and
              recipient checks succeed.
            </p>
          </div>
          <p className="bc-inbox-hint">
            Sample conversations always stay local. The Sidekick/assistant bar, if visible at the bottom of Shopify Admin, is part of Shopify Admin and is outside this app&apos;s styling boundary.
          </p>
        </section>

        <div className="bc-inbox-shell">
          <aside className="bc-conversation-list" aria-label="Conversations">
            <h2>Conversations</h2>
            {conversations.length === 0 ? (
              <p className="bc-empty-state">
                No conversations yet. Add the sample conversation to explore the inbox.
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
                    Real sends are locked unless this is your allow-listed test recipient and the shop, credentials, Meta webhook verification, first inbound message, and test-only switch are all ready.
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
                          <label htmlFor="inbox-test-recipient">Confirmed test recipient</label>
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
                            Must match the single server allow-list. This form cannot send to another customer.
                          </p>
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
                      {!selectedConversation.isDemo && (
                        <>
                          <label htmlFor="inbox-template-recipient">Confirmed test recipient</label>
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
                      )}
                      <label htmlFor="inbox-template">Approved template</label>
                      <select
                        id="inbox-template"
                        name="templateId"
                        value={templateId}
                        onChange={(event) => setTemplateId(event.target.value)}
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
                      <label htmlFor="inbox-template-parameters">
                        Body parameters (JSON string array, if required)
                      </label>
                      <textarea
                        id="inbox-template-parameters"
                        name="templateParameters"
                        rows={2}
                        placeholder={'["Alex", "order 123"]'}
                        value={templateParametersInput}
                        onChange={(event) => setTemplateParametersInput(event.target.value)}
                        disabled={actionFetcher.state !== "idle"}
                      />
                      {selectedTemplate && (
                        <p className="bc-inbox-hint">
                          {selectedTemplate.name} · {selectedTemplate.language} · {selectedTemplate.bodyParameterCount === null ? "Template placeholders need review" : `${selectedTemplate.bodyParameterCount} body parameter${selectedTemplate.bodyParameterCount === 1 ? "" : "s"} required`}
                        </p>
                      )}
                      {!selectedConversation.isDemo &&
                        selectedTemplate?.category.toUpperCase() === "MARKETING" && (
                          <label className="bc-marketing-opt-in">
                            <input
                              type="checkbox"
                              name="confirmMarketingOptIn"
                              value="yes"
                              required
                              disabled={actionFetcher.state !== "idle"}
                            />
                            I have verified this test recipient explicitly opted in to WhatsApp marketing.
                          </label>
                        )}
                      <button
                        className="bc-button bc-button-primary"
                        type="submit"
                        disabled={
                          !templateId ||
                          approvedTemplates.length === 0 ||
                          (!selectedConversation.isDemo && !testSendAvailable) ||
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

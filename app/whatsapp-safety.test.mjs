import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
  buildWhatsAppTemplatePayload,
  buildWhatsAppTextPayload,
  getTemplateBodyParameterCount,
  getWhatsAppTemplateRequirements,
  isInsideCustomerServiceWindow,
  normalizeE164Phone,
  parseTemplateBodyParameters,
  parseWhatsAppTemplateInput,
} from "./whatsapp-shared.ts";

const shop = `whatsapp-smoke-${randomUUID().replaceAll("-", "")}.myshopify.com`;
const phoneNumberId = "123456789012345";
const businessAccountId = "123456789098765";
const verificationToken = "local-webhook-smoke-verification-token";
const appSecret = "local-only-test-meta-app-secret";
const recipient = "+15555551234";
const timestamp = Math.floor(Date.now() / 1000).toString();

process.env.WHATSAPP_SHOP_DOMAIN = shop;
process.env.WHATSAPP_PHONE_NUMBER_ID = phoneNumberId;
process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = businessAccountId;
process.env.WHATSAPP_ACCESS_TOKEN = "local-only-not-a-real-access-token";
process.env.META_APP_SECRET = appSecret;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = verificationToken;
process.env.WHATSAPP_TEST_RECIPIENT_PHONE = recipient;
process.env.WHATSAPP_TEST_SENDING_ENABLED = "false";
process.env.WHATSAPP_INBOX_SENDING_ENABLED = "false";
process.env.WHATSAPP_LIVE_SENDING_ENABLED = "false";

const [{ loader, action }, { default: prisma }, whatsappServer] =
  await Promise.all([
    import("./routes/webhooks.whatsapp.tsx"),
    import("./db.server.ts"),
    import("./whatsapp.server.ts"),
  ]);
const {
  getConfiguredWhatsAppShop,
  isWhatsAppInboxSendingEnabled,
  isWhatsAppWebhookConfigurationComplete,
} = whatsappServer;

const sign = (body) =>
  `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;

const webhookRequest = (body, signature = sign(body), extraHeaders = {}) =>
  new Request("https://local.test/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": signature,
      ...extraHeaders,
    },
    body,
  });

const sendEvent = (value, options = {}) => {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: options.wabaId ?? businessAccountId,
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                phone_number_id: options.phoneId ?? phoneNumberId,
              },
              ...value,
            },
          },
        ],
      },
    ],
  });
  return action({ request: webhookRequest(body) });
};

const verifyRequest = (token) =>
  loader({
    request: new Request(
      `https://local.test/webhooks/whatsapp?${new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": token,
        "hub.challenge": "local-challenge",
      })}`,
    ),
  });

const checked = [];
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => checked.push(name));

try {
  await check("general Inbox sending remains explicitly opt-in", () => {
    assert.equal(isWhatsAppInboxSendingEnabled(), false);
    process.env.WHATSAPP_INBOX_SENDING_ENABLED = "true";
    assert.equal(isWhatsAppInboxSendingEnabled(), true);
    process.env.WHATSAPP_INBOX_SENDING_ENABLED = "false";
    assert.equal(isWhatsAppInboxSendingEnabled(), false);
  });

  const templateComponents = JSON.stringify([
    { type: "BODY", text: "Hi {{1}}, your order {{2}} is ready." },
  ]);
  await check("phone, 24-hour window, and template parameter validation", () => {
    assert.equal(normalizeE164Phone("+1 (555) 555-1234"), recipient);
    assert.equal(normalizeE164Phone("+0123456789"), null);
    assert.equal(
      isInsideCustomerServiceWindow(new Date(Date.now() - 23 * 60 * 60 * 1000)),
      true,
    );
    assert.equal(
      isInsideCustomerServiceWindow(new Date(Date.now() - 25 * 60 * 60 * 1000)),
      false,
    );
    assert.equal(getTemplateBodyParameterCount(templateComponents), 2);
    assert.deepEqual(
      parseTemplateBodyParameters('["Ari", "order-42"]', templateComponents),
      ["Ari", "order-42"],
    );
    assert.deepEqual(
      buildWhatsAppTextPayload(recipient, "A quick reply"),
      {
        messaging_product: "whatsapp",
        to: "15555551234",
        type: "text",
        text: { body: "A quick reply" },
      },
    );
    assert.deepEqual(
      buildWhatsAppTemplatePayload(
        recipient,
        "order_update",
        "en_US",
        [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ari" },
              { type: "text", text: "order-42" },
            ],
          },
        ],
      ),
      {
        messaging_product: "whatsapp",
        to: "15555551234",
        type: "template",
        template: {
          name: "order_update",
          language: { code: "en_US" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Ari" },
                { type: "text", text: "order-42" },
              ],
            },
          ],
        },
      },
    );
    assert.throws(
      () => parseTemplateBodyParameters('["Ari"]', templateComponents),
      /requires 2 non-empty body parameters/,
    );
    assert.throws(
      () => parseTemplateBodyParameters('{"name":"Ari"}', templateComponents),
      /JSON string array/,
    );
  });

  await check("template text/media headers and dynamic URL button parameters", () => {
    const textHeaderDefinition = JSON.stringify([
      { type: "HEADER", format: "TEXT", text: "Hi {{name}}" },
      { type: "BODY", text: "Your order {{1}} is ready." },
      { type: "FOOTER", text: "Bowchika" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Track order", url: "https://bowchika.in/track/{{1}}" },
          { type: "QUICK_REPLY", text: "Contact us" },
        ],
      },
    ]);
    const parsedTextHeader = parseWhatsAppTemplateInput(
      JSON.stringify({
        header: { format: "TEXT", values: ["Ari"] },
        body: ["order 42"],
        buttons: { "0": ["order-42"] },
      }),
      textHeaderDefinition,
    );
    assert.deepEqual(parsedTextHeader.components, [
      {
        type: "header",
        parameters: [{ type: "text", text: "Ari", parameter_name: "name" }],
      },
      { type: "body", parameters: [{ type: "text", text: "order 42" }] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "order-42" }],
      },
    ]);
    assert.match(parsedTextHeader.preview, /Hi Ari/);
    assert.match(parsedTextHeader.preview, /Bowchika/);
    assert.match(parsedTextHeader.preview, /https:\/\/bowchika\.in\/track\/order-42/);

    const imageDefinition = JSON.stringify([
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["media"] } },
      { type: "BODY", text: "Look at this." },
    ]);
    const imageByUrl = parseWhatsAppTemplateInput(
      JSON.stringify({
        header: { format: "IMAGE", mediaType: "url", value: "https://cdn.example.test/image.jpg" },
      }),
      imageDefinition,
    );
    assert.deepEqual(imageByUrl.components[0], {
      type: "header",
      parameters: [
        { type: "image", image: { link: "https://cdn.example.test/image.jpg" } },
      ],
    });
    const imageById = parseWhatsAppTemplateInput(
      JSON.stringify({
        header: { format: "IMAGE", mediaType: "id", value: "123456789012345" },
      }),
      imageDefinition,
    );
    assert.deepEqual(imageById.components[0], {
      type: "header",
      parameters: [
        { type: "image", image: { id: "123456789012345" } },
      ],
    });
    assert.throws(
      () =>
        parseWhatsAppTemplateInput(
          JSON.stringify({
            header: { format: "IMAGE", mediaType: "url", value: "http://cdn.example.test/image.jpg" },
          }),
          imageDefinition,
        ),
      /must use HTTPS/,
    );
    assert.throws(
      () =>
        parseWhatsAppTemplateInput(
          JSON.stringify({
            header: { format: "IMAGE", mediaType: "id", value: "not-a-media-id" },
          }),
          imageDefinition,
        ),
      /numeric WhatsApp media ID/,
    );
    assert.equal(
      getWhatsAppTemplateRequirements(
        JSON.stringify([{ type: "HEADER", format: "VIDEO" }]),
      ).unsupported,
      "The VIDEO header type is not supported for sending.",
    );
    assert.throws(
      () =>
        parseWhatsAppTemplateInput(
          JSON.stringify({
            header: { format: "TEXT", values: ["Ari"] },
            body: ["order 42"],
            buttons: { "0": [""] },
          }),
          textHeaderDefinition,
        ),
      /must be non-empty/,
    );
    assert.throws(
      () => parseWhatsAppTemplateInput("{}", textHeaderDefinition),
      /Text header requires exactly 1 parameter/,
    );
    assert.equal(normalizeE164Phone("555-123"), null);
  });

  await check("shop binding normalization without development-store fallback", () => {
    process.env.WHATSAPP_SHOP_DOMAIN = ` ${shop.toUpperCase()} `;
    assert.equal(getConfiguredWhatsAppShop(), shop);
    assert.equal(isWhatsAppWebhookConfigurationComplete(), true);
    assert.notEqual(
      getConfiguredWhatsAppShop(),
      "bowchika-connect-dev.myshopify.com",
    );
    process.env.WHATSAPP_SHOP_DOMAIN = shop;
  });

  await check("webhook GET token verification and shop-scoped record", async () => {
    assert.equal((await verifyRequest("wrong-token")).status, 403);
    const response = await verifyRequest(verificationToken);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "local-challenge");
    const record = await prisma.whatsAppWebhookVerification.findUnique({
      where: { shop },
    });
    assert.equal(record?.phoneNumberId, phoneNumberId);
  });

  await check("signature rejection, malformed JSON, and payload size guard", async () => {
    const invalid = await action({
      request: webhookRequest("{}", "sha256=" + "0".repeat(64)),
    });
    assert.equal(invalid.status, 401);

    const malformedBody = "{";
    const malformed = await action({
      request: webhookRequest(malformedBody),
    });
    assert.equal(malformed.status, 400);

    const oversized = await action({
      request: webhookRequest("{}", sign("{}"), {
        "content-length": "1000001",
      }),
    });
    assert.equal(oversized.status, 413);
  });

  const inboundId = `wamid.local.${randomUUID()}`;
  const mediaId = `wamid.local.${randomUUID()}`;
  const inbound = {
    contacts: [
      { wa_id: recipient.slice(1), profile: { name: "Local smoke contact" } },
    ],
    messages: [
      {
        id: inboundId,
        from: recipient.slice(1),
        timestamp,
        type: "text",
        text: { body: "Local signed webhook smoke test." },
      },
    ],
  };

  await check("incoming message persistence, deduplication, and tenant binding", async () => {
    const first = await sendEvent(inbound);
    assert.equal(first.status, 200);
    const duplicate = await sendEvent(inbound);
    assert.equal(duplicate.status, 200);

    const wrongWaba = await sendEvent(inbound, {
      wabaId: "999999999999999",
    });
    assert.equal(wrongWaba.status, 200);
    const wrongPhone = await sendEvent(inbound, {
      phoneId: "999999999999999",
    });
    assert.equal(wrongPhone.status, 200);

    const conversation = await prisma.whatsAppConversation.findUnique({
      where: { shop_phoneNumber: { shop, phoneNumber: recipient } },
    });
    assert.ok(conversation);
    assert.equal(conversation.customerName, "Local smoke contact");
    assert.equal(conversation.unreadCount, 1);

    const messages = await prisma.whatsAppMessage.findMany({
      where: { shop, whatsappMessageId: inboundId },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "Local signed webhook smoke test.");

    const image = await sendEvent({
      messages: [
        {
          id: mediaId,
          from: recipient.slice(1),
          timestamp,
          type: "image",
          image: { caption: "Local image caption" },
        },
      ],
    });
    assert.equal(image.status, 200);
    const mediaMessage = await prisma.whatsAppMessage.findUnique({
      where: { shop_whatsappMessageId: { shop, whatsappMessageId: mediaId } },
    });
    assert.equal(mediaMessage?.type, "IMAGE");
    assert.equal(mediaMessage?.text, "Local image caption");
  });

  const { recordWhatsAppMessageAccepted } = whatsappServer;

  await check("delivery status updates and status-before-send-response recovery", async () => {
    const conversation = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: { shop_phoneNumber: { shop, phoneNumber: recipient } },
    });
    const deliveredId = `wamid.local.${randomUUID()}`;
    const failedId = `wamid.local.${randomUUID()}`;
    const raceId = `wamid.local.${randomUUID()}`;
    const sent = await prisma.whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        shop,
        direction: "OUTBOUND",
        type: "TEXT",
        text: "Local status smoke test",
        status: "PENDING",
        whatsappMessageId: deliveredId,
      },
    });
    const failed = await prisma.whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        shop,
        direction: "OUTBOUND",
        type: "TEMPLATE",
        text: "Local failure status smoke test",
        status: "PENDING",
        whatsappMessageId: failedId,
      },
    });

    for (const status of ["sent", "delivered", "read"]) {
      const response = await sendEvent({
        statuses: [{ id: deliveredId, status, timestamp }],
      });
      assert.equal(response.status, 200);
    }
    const duplicateRead = await sendEvent({
      statuses: [{ id: deliveredId, status: "read", timestamp }],
    });
    assert.equal(duplicateRead.status, 200);
    assert.equal(
      (
        await prisma.whatsAppMessage.findUniqueOrThrow({
          where: { id: sent.id },
        })
      ).status,
      "READ",
    );

    const failureResponse = await sendEvent({
      statuses: [{ id: failedId, status: "failed", timestamp }],
    });
    assert.equal(failureResponse.status, 200);
    assert.equal(
      (
        await prisma.whatsAppMessage.findUniqueOrThrow({
          where: { id: failed.id },
        })
      ).status,
      "FAILED",
    );

    const earlyStatus = await sendEvent({
      statuses: [{ id: raceId, status: "delivered", timestamp }],
    });
    assert.equal(earlyStatus.status, 200);
    const pending = await prisma.whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        shop,
        direction: "OUTBOUND",
        type: "TEXT",
        text: "Local webhook race smoke test",
        status: "PENDING",
      },
    });
    await prisma.$transaction((transaction) =>
      recordWhatsAppMessageAccepted(transaction, {
        id: pending.id,
        conversationId: conversation.id,
        shop,
        whatsappMessageId: raceId,
      }),
    );
    assert.equal(
      (
        await prisma.whatsAppMessage.findUniqueOrThrow({
          where: { id: pending.id },
        })
      ).status,
      "DELIVERED",
    );
    assert.ok(
      await prisma.whatsAppMessageStatusEvent.findUnique({
        where: {
          shop_whatsappMessageId_status: {
            shop,
            whatsappMessageId: raceId,
            status: "DELIVERED",
          },
        },
      }),
    );
  });

  await check("mocked Cloud API request and Meta rejection reporting", async () => {
    const originalFetch = globalThis.fetch;
    let capturedAuthorization = null;
    let capturedPayload = null;
    globalThis.fetch = async (_url, init) => {
      capturedAuthorization = new Headers(init?.headers).get("Authorization");
      capturedPayload = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ error: { code: 132000 } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      await assert.rejects(
        whatsappServer.sendWhatsAppApiRequest(
          {
            phoneNumberId,
            accessToken: "local-only-not-a-real-access-token",
            apiVersion: "v23.0",
          },
          buildWhatsAppTemplatePayload(
            recipient,
            "order_update",
            "en_US",
            [{
              type: "body",
              parameters: [
                { type: "text", text: "Ari" },
                { type: "text", text: "order-42" },
              ],
            }],
          ),
        ),
        (error) => {
          assert.match(
            whatsappServer.whatsAppApiErrorMessage(error),
            /rejected this template or its parameters/,
          );
          return true;
        },
      );
      assert.equal(
        capturedAuthorization,
        "Bearer local-only-not-a-real-access-token",
      );
      assert.deepEqual(
        capturedPayload,
        buildWhatsAppTemplatePayload(
          recipient,
          "order_update",
          "en_US",
          [{
            type: "body",
            parameters: [
              { type: "text", text: "Ari" },
              { type: "text", text: "order-42" },
            ],
          }],
        ),
      );

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ messages: [{ id: "wamid.local-mock-accepted" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      assert.equal(
        await whatsappServer.sendWhatsAppApiRequest(
          {
            phoneNumberId,
            accessToken: "local-only-not-a-real-access-token",
            apiVersion: "v23.0",
          },
          buildWhatsAppTextPayload(recipient, "No network request was made."),
        ),
        "wamid.local-mock-accepted",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await check("failed send persistence, conversation creation, and duplicate prevention", async () => {
    const phoneNumber = "+447700900123";
    const clientRequestId = randomUUID();
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ error: { code: 132001 } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const result = await whatsappServer.sendAndPersistWhatsAppMessage(
        prisma,
        {
          phoneNumberId,
          accessToken: "local-only-not-a-real-access-token",
          apiVersion: "v23.0",
        },
        buildWhatsAppTemplatePayload(
          phoneNumber,
          "order_update",
          "en_US",
          [],
        ),
        {
          shop,
          phoneNumber,
          clientRequestId,
          type: "TEMPLATE",
          text: "Local test template, not delivered.",
        },
      );
      assert.equal(result.error?.code, 132001);
      assert.equal(fetchCount, 1);
      const conversation = await prisma.whatsAppConversation.findUnique({
        where: { shop_phoneNumber: { shop, phoneNumber } },
      });
      assert.ok(conversation);
      assert.equal(conversation.isDemo, false);
      const message = await prisma.whatsAppMessage.findUnique({
        where: { id: result.pendingMessage.messageId },
      });
      assert.equal(message?.conversationId, conversation.id);
      assert.equal(message?.status, "FAILED");

      await assert.rejects(
        whatsappServer.sendAndPersistWhatsAppMessage(
          prisma,
          {
            phoneNumberId,
            accessToken: "local-only-not-a-real-access-token",
            apiVersion: "v23.0",
          },
          buildWhatsAppTemplatePayload(
            phoneNumber,
            "order_update",
            "en_US",
            [],
          ),
          {
            shop,
            phoneNumber,
            clientRequestId,
            type: "TEMPLATE",
            text: "Duplicate must not call the mocked API.",
          },
        ),
        (error) => error?.code === "P2002",
      );
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
      await prisma.whatsAppConversation.deleteMany({
        where: { shop, phoneNumber },
      });
    }
  });

  assert.equal(process.env.WHATSAPP_TEST_SENDING_ENABLED, "false");
  assert.equal(process.env.WHATSAPP_LIVE_SENDING_ENABLED, "false");
  console.log(`Passed ${checked.length} safe local WhatsApp checks; no Meta message send was attempted.`);
} finally {
  await prisma.whatsAppMessageStatusEvent.deleteMany({ where: { shop } });
  await prisma.whatsAppWebhookVerification.deleteMany({ where: { shop } });
  await prisma.whatsAppConversation.deleteMany({ where: { shop } });
  await prisma.$disconnect();
}

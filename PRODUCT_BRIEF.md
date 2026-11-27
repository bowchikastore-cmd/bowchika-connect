# Bowchika Connect — Product Brief

**Product:** Bowchika Connect  
**Owner:** Carepill Global Private Limited / Bowchika  
**Type:** Shopify-embedded WhatsApp operations workspace  
**Primary users:** Bowchika store operators and customer-support staff  
**Product shape:** Two primary screens — Campaigns and Inbox

## 1. Product purpose

Bowchika Connect brings WhatsApp campaign preparation and customer conversations into the Bowchika Shopify admin. It uses Shopify customer/order data to build audiences, Meta-approved WhatsApp templates to compose campaigns, and a shared Inbox to handle customer-initiated conversations.

The intended operator experience is deliberately small:

1. **Campaigns** — find an audience, build a template message, preview it, save a draft or schedule eligible recipients, and review campaign status.
2. **Inbox** — view conversations, read inbound messages, and reply using an eligible text reply or an approved template.

The old multi-tab workspace dashboard and appearance-only Settings screen are retired from the primary experience. The app opens directly at Campaigns. Internal configuration, authentication, webhooks, database and worker routes remain part of the application even though they are not visible as navigation items.

## 2. Primary screens

### Campaigns

Campaigns is the campaign-management workspace. It combines the audience tools and campaign composer in one screen.

**Audience and Shopify data**
- Full customer sync and incremental sync for new/updated records.
- Shopify order sync, with product and collection information retained from line items.
- Historical Shopify Orders CSV preview/import for older orders.
- Search by customer name, email, phone or order number.
- Audience filters for order count, spend, last-order recency, purchased product and purchased collection.
- Individual customer selection or select-all-matching.
- Product and collection partial-text matching is case-insensitive.

**Campaign composition**
- Synchronize Meta-approved WhatsApp templates from the configured WhatsApp Business Account.
- Choose an approved template and language.
- Map template variables to Shopify customer/order fields or operator-supplied custom values.
- Add an image header where the approved template requires it.
- Preview the message with sample customer data.
- Save a campaign draft or queue/schedule recipients that pass the application’s sending checks.
- Review campaign status, schedule and recipient-state counts.
- Duplicate/reuse a previous campaign.

**Draft behavior**
- A campaign with no currently eligible recipients is retained as a DRAFT; it is not deleted.
- Such a draft has no queued recipients and cannot be processed by the campaign worker.
- A campaign becomes QUEUED or SCHEDULED only when at least one recipient has been prepared.
- The campaign worker processes QUEUED, SCHEDULED and SENDING campaigns, not DRAFT campaigns.

### Inbox

Inbox is the shared conversation workspace.

- Lists WhatsApp conversations with unread counts and latest activity.
- Shows conversation history and delivery state for stored messages.
- Supports text replies when the customer-service window is open.
- Supports approved WhatsApp template messages where a template is required.
- Supports starting a new chat only when the live Inbox send gate and recipient confirmation checks permit it.
- Includes a local demo conversation for interface testing; demo activity is not a real WhatsApp delivery.

Inbound messages and delivery-status events are received through the WhatsApp webhook and stored against the connected Shopify shop.

## 3. WhatsApp sending and recipient safeguards

Bowchika Connect is not a generic phone-number blast tool. Its outbound campaign pipeline and Inbox composer apply different checks:

- Campaign audience construction only adds customers currently marked as subscribed in the connected customer data, with a valid phone number and without a local suppression record.
- The campaign worker checks the customer’s current opt-in state, phone and suppression record again immediately before delivery.
- A WhatsApp STOP, UNSUBSCRIBE, OPT OUT, CANCEL, QUIT or END inbound message records a suppression, marks a linked customer opted out, and skips their still-queued campaign recipients.
- Inbox free-text replies are restricted to the 24-hour customer-service window.
- New-chat/template flows require explicit recipient opt-in confirmation in the application.
- Meta-approved templates are used for template-based outbound messaging.
- Campaign and Inbox sending are controlled by separate server-side environment flags.

**Important operating distinction:** saving a draft is not sending. A draft with zero eligible recipients is retained for later review, but no one is placed in a send queue. A phone number in Shopify, an existing order, or a customer record by itself is not evidence of WhatsApp marketing permission.

## 4. Technical architecture

| Layer | Technology / responsibility |
|---|---|
| Embedded application | Shopify app using React Router and Shopify App React Router |
| Authentication | Shopify Admin authentication and shop-bound sessions |
| Application data | Prisma ORM |
| Local development database | SQLite schema at prisma/schema.prisma |
| Production database | PostgreSQL schema at prisma/postgresql/schema.prisma |
| Production hosting | Render web service |
| Production database host | Neon PostgreSQL |
| WhatsApp integration | Meta WhatsApp Cloud API |
| Inbound/status events | /webhooks/whatsapp with signature verification |
| Campaign execution | /api/campaign-worker |
| Scheduler | GitHub Actions scheduled workflow invoking the worker endpoint |
| Shopify lifecycle | App scope-update and uninstall webhooks |

### Important routes

- /app/campaigns — Campaign Manager.
- /app/inbox — Inbox.
- /app — redirects to Campaign Manager.
- /app/settings — legacy route redirects to Campaign Manager.
- /webhooks/whatsapp — Meta webhook callback.
- /api/campaign-worker — authenticated background campaign worker.

The two visible screens depend on supporting code outside the route files. Do not delete Shopify authentication, session storage, Prisma schemas/migrations, WhatsApp helpers, webhooks, worker code, scheduler workflows or environment configuration as “unused pages”; they are infrastructure for the product.

## 5. Key server-side environment configuration

Secret values must remain in Render/GitHub secret stores and must never be committed to the repository.

| Variable | Purpose |
|---|---|
| WHATSAPP_PHONE_NUMBER_ID | Meta WhatsApp sender phone-number ID |
| WHATSAPP_BUSINESS_ACCOUNT_ID | Meta WhatsApp Business Account ID |
| WHATSAPP_ACCESS_TOKEN | Server-side Meta access token |
| META_GRAPH_API_VERSION | Meta Graph API version |
| META_APP_SECRET | Webhook signature verification |
| WHATSAPP_WEBHOOK_VERIFY_TOKEN | Webhook subscription verification |
| WHATSAPP_SHOP_DOMAIN | Shop allowed to use the configured WhatsApp account |
| WHATSAPP_CAMPAIGN_SENDING_ENABLED | Independent campaign-worker send gate |
| WHATSAPP_INBOX_SENDING_ENABLED | Independent live Inbox send gate |
| WHATSAPP_TEST_SENDING_ENABLED | Restricted test-send gate |
| WHATSAPP_TEST_RECIPIENT_PHONE | Configured test recipient |
| CAMPAIGN_WORKER_SECRET | Authenticates scheduled worker requests; same value in Render and GitHub Actions |
| SHOPIFY_SERVICE_ACCOUNT_TOKEN | GitHub Actions credential for Shopify app release |

Never expose these values in the UI, repository, logs, screenshots or support messages.

## 6. Current project status

Last verified during the 27 November 2026 project session:

- Shopify production app version was released and the Bowchika store installation was granted the seven requested API scopes.
- A full Shopify sync reported 2,837 customers checked, 515 orders upserted and zero unlinked orders.
- Case-insensitive purchased-product/collection search and a database backfill were deployed.
- The no-cost GitHub Actions campaign-worker schedule was merged and successfully authenticated with Render.
- The worker was returning a disabled response because campaign sending was intentionally off.
- The Campaigns/Inbox simplification and draft/template-sync changes are being prepared in the refactor/two-screen-campaign-inbox branch. They are **not production until CI passes, the pull request is merged and Render completes the deployment**.

Historical sync counts are a point-in-time result, not a guarantee that all available store history has been imported.

## 7. Known operational limitations

- Render Free services can sleep when idle; the first request may be delayed while the app wakes.
- Neon Free can also scale to zero. This setup should be treated as a pilot, not a guaranteed real-time customer-support platform.
- The five-minute scheduled worker is best-effort and can be delayed; it is not a guaranteed real-time scheduler.
- Campaign delivery must not be described as live until the send flag is explicitly enabled by the operator and a controlled end-to-end test succeeds with an appropriately permissioned recipient.
- The codebase has no npm test package script; CI runs the individual test files with npx vite-node.

## 8. Product direction

Keep the operator experience focused on two destinations:

- **Campaigns:** one direct campaign workflow — audience → approved template → variable mapping → preview → draft/schedule → delivery status.
- **Inbox:** one direct conversation workflow — conversation list → message history → reply.

Avoid reintroducing a separate overview dashboard, customer-segment centre or appearance settings page into the main navigation unless there is a clear operational need. Keep advanced data sync and CSV import as supporting sections inside Campaigns rather than separate app destinations.

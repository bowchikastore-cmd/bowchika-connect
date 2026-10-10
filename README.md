# Shopify App Template - React Router

For beginner-friendly setup instructions for this existing private app on
another Mac, see [HOME_SETUP.md](./HOME_SETUP.md).

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Rather than cloning this repo, follow the [Quick Start steps](https://github.com/Shopify/shopify-app-template-react-router#quick-start).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

This app uses [Prisma](https://www.prisma.io/) for Shopify sessions, customer segments, templates, campaign drafts, and Inbox records. Local development keeps the existing SQLite schema at `prisma/schema.prisma`, using a local `DATABASE_URL` setting in the ignored `.env` file (for example `file:dev.sqlite`).

### Render Free + Neon Free evaluation

`render.yaml` prepares a $0 Render Free Node web service. Render's [official Free instance limits](https://render.com/docs/free) say Free web services sleep after 15 minutes without inbound traffic and take about one minute to wake, have an ephemeral filesystem, receive 750 Free instance hours per workspace per calendar month, and are explicitly not intended for production apps. No local SQLite file is used by this deployment. `render.yaml` uses Neon PostgreSQL; **do not change it to `DATABASE_URL=file:...`**.

Neon's [official Free plan limits](https://neon.com/docs/introduction/plans#free-plan) currently include 100 compute-hours per project, 1 GB Postgres storage per project (20 GB total per account), 5 GB public network transfer per project, and automatic scale-to-zero after five minutes. This plan has no uptime SLA. Database cold starts can also add latency. Check both providers' current limits before relying on the free tiers; if limits are exceeded, services may be suspended or require an upgrade, which would no longer meet the $0/month requirement.

The Render/Neon pairing is technically prepared for a **non-critical pilot only**, not dependable production: Render cold sleep can delay the first Shopify page request and a Meta webhook request by about a minute. If a webhook request arrives during sleep, Render's wake-up response may be returned before the app handler runs; in that case the event is not persisted by this app. A later Meta retry may deliver it after wake-up, but do not rely on retry timing or use this for time-sensitive inbound customer support. When the handler runs, it persists before acknowledging. Neon can independently take several seconds to wake. Do not rely on this $0 setup for unattended availability.

### Separate PostgreSQL schema and safe data migration

`prisma/postgresql/schema.prisma` and `prisma/postgresql/migrations/` are a separate PostgreSQL schema and baseline migration. They preserve the current models, including the Shopify `Session` model required by `PrismaSessionStorage`, and do not alter the SQLite migration history. The Render build generates the PostgreSQL Prisma Client from this schema; the Render start command deploys only its PostgreSQL migrations. Local development and the existing SQLite database remain separate.

The baseline migration creates an **empty schema only**. It has not been applied to Neon and does not copy local data. Do not use `migrate reset`, `db push`, or apply the SQLite SQL migrations to PostgreSQL. Before any future data move, make and verify a separate SQLite backup, provision a fresh/empty Neon database, apply the PostgreSQL baseline, then perform a reviewed copy with source and destination row-count/foreign-key checks. Keep the SQLite file and its migration history untouched until the copied data is verified. Development Shopify `Session` rows contain dev-store credentials and must not be copied as production sessions. Any required live-shop rows need an explicit shop/data review; synced templates can instead be re-synced from Meta after production access is configured. No data copy is included in this task.

### Manual Render and Neon setup (not performed here)

1. Create a Neon Free project and database. Choose a region close to the Render service. From Neon's **Connect** dialog copy both URLs: the **pooled** URL (hostname includes `-pooler`) for `DATABASE_URL`, and the direct/unpooled URL for `DATABASE_URL_UNPOOLED`. Keep Neon's TLS parameters as supplied. These are entered only in Render's environment settings; never commit them.
2. Connect the repository to Render and create a Blueprint from `render.yaml`. It prompts for `SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, both Neon URLs, and the existing WhatsApp secret values declared with `sync: false`. `SHOPIFY_APP_URL` must be the HTTPS Render service origin. Keep both `WHATSAPP_TEST_SENDING_ENABLED` and `WHATSAPP_INBOX_SENDING_ENABLED` unset/false; never enable campaign or scheduled sending.
3. The first deploy applies the PostgreSQL baseline to Neon. This creates schema but does not migrate any SQLite rows. Verify logs, tables, and app health before connecting any live Shopify configuration.
4. The separate production config is `shopify.app.production.toml`, with the Render app origin and the React Router OAuth callback at `/auth/callback`. In Shopify Dev Dashboard, set App URL to `https://bowchika-connect.onrender.com` and add `https://bowchika-connect.onrender.com/auth/callback` as an allowed redirection URL. Keep the current `shopify.app.toml` as the Shopify CLI-managed development config and continue using it for the dev store.
5. Do not change Meta webhook subscriptions or callback URLs until the permanent host is running and explicitly approved. Pabbly and Shiprocket are not part of this deployment configuration.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)

## WhatsApp Inbox

The Inbox is available at **Inbox** in the embedded app navigation. It stores shop-scoped conversations and message history in Prisma. **Add sample conversation** creates a local-only demo record; sending a reply in a demo conversation never calls Meta. Start New Chat uses the existing conversation/message tables, so this feature requires no Prisma schema change or database migration.

General Inbox sending is disabled by default with `WHATSAPP_INBOX_SENDING_ENABLED=false`. The Inbox has **Start New Chat**, which sends an approved synced template to an operator-entered international phone number, and collects body/header/media/dynamic URL-button values from the stored Meta definition. It creates the shop-scoped conversation and a pending outbound message before calling Meta, persists accepted/failed status and message IDs, and rejects duplicate client request IDs. The app does not infer WhatsApp consent from Shopify email consent: an operator must affirm explicit WhatsApp opt-in for every real template send. Verify opt-in and Meta policy outside the app before affirming it.

To deliberately enable regular Inbox messaging, first deploy the code with the switch off and verify the correct shop binding, Cloud API credentials, signed webhook, synced approved templates, and recipient-consent process. Only after those checks, set `WHATSAPP_INBOX_SENDING_ENABLED=true` in the Render service environment and restart/redeploy the service. This allows authenticated Inbox operators to send to the conversation's phone number (including initiating with an approved template); it is not an allowlist and can send to any entered/conversation number after the per-send consent attestation. It does not enable campaigns or scheduled sending. Keep it unset/false until explicitly approved. This production environment change is not made by this code task.

The existing `WHATSAPP_TEST_SENDING_ENABLED` switch remains an isolated personal-phone test path; it requires one exact shop binding and one allow-listed recipient, a successful Meta GET webhook verification, and a signed inbound message from that same recipient. It cannot send to other conversation numbers. General Inbox sends use their own explicit switch rather than being silently blocked by that test allowlist. The current server-environment credential model supports one configured shop/WhatsApp phone-number pairing per deployment; do not bind or move the Cloud API number.

The existing environment already uses `META_APP_ID` and `META_APP_SECRET`; webhook signature validation reuses `META_APP_SECRET` (do not create a duplicate app-secret variable). The existing Cloud API credential names are:

- `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` for the WhatsApp Cloud API.
- `WHATSAPP_BUSINESS_ACCOUNT_ID` for checking the subscribed business account.
- `META_APP_SECRET` for Meta `X-Hub-Signature-256` validation.
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` for Meta's initial webhook verification challenge.
- `WHATSAPP_SHOP_DOMAIN` set to the one bound shop's exact `*.myshopify.com` domain.
- `WHATSAPP_TEST_RECIPIENT_PHONE` set to your own test phone in E.164 form (for example `+15551234567`).
- `WHATSAPP_TEST_SENDING_ENABLED=true` only after webhook verification and a real inbound message from that allow-listed phone; leave it unset/false otherwise.
- `WHATSAPP_INBOX_SENDING_ENABLED=false` by default. Set it to `true` only after separately verifying the live shop binding, Cloud API configuration, Meta webhook verification, operator access, approved templates, and your WhatsApp opt-in process. This enables normal Inbox sends beyond the test recipient allowlist; it does not turn on campaigns.
- Optionally, `META_GRAPH_API_VERSION` (defaults to `v23.0`).

The configured shop must exactly match the shop returned by Shopify authentication (`session.shop`). The Inbox shows both domains and reports a mismatch separately from a missing variable. It never substitutes a development shop for another configured shop; authenticate the app on the intended store before expecting the binding check to pass. After editing `.env`, restart `shopify app dev` so the server reads the updated environment.

Vite explicitly loads the WhatsApp/Meta server settings from the active `.env` files into the Node server process. These variables are not prefixed with `VITE_` and are not exposed to browser code. An inherited shell/server value takes precedence over the file.

The development environment may also require the existing Shopify app variables `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL`. Keep every credential in the hosting provider's secret manager or ignored local `.env`; do not commit them or expose them to browser code. The Inbox enforces the 24-hour customer-service window for free-form replies, validates supported template header/body/button parameters against the synced approved definition, previews the substituted content, and requires explicit opt-in confirmation for every real template send. Unsupported template component types are blocked rather than omitted. Shopify email consent is not WhatsApp consent. Meta API errors are surfaced without logging credentials.

### Migration and webhook setup

Apply the additive migration without resetting the existing database:

```sh
npx prisma migrate deploy
npx prisma generate
```

The additive migrations add Inbox conversations, messages, idempotency keys, status-event receipts, and webhook-verification records. They preserve existing tables, migration history, and data.

For inbound traffic, open **Meta for Developers → your app → WhatsApp → Configuration** and set the callback URL to `https://<current-public-dev-tunnel-host>/webhooks/whatsapp`; enter the value already held in `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and verify it. Subscribe the WhatsApp Business Account to the `messages` webhook field, and ensure that WABA is subscribed to this app (the Graph API subscription operation, if needed, is `POST /<WABA_ID>/subscribed_apps`). In development mode, add and verify your personal phone as an allowed test recipient in WhatsApp API Setup if Meta requires it. Do not change or migrate either WhatsApp number.

Meta GET verification is recorded only after the configured shop, phone ID, WABA ID, token, and app secret all validate. POST events must contain a valid `X-Hub-Signature-256` signed using the existing `META_APP_SECRET`, and must match both configured WABA and phone-number IDs. For development, use the HTTPS host printed by the running `shopify app dev` command; the dev process and its tunnel must remain running, and a restarted development tunnel can have a different URL. The `example.com` values in `shopify.app.toml` are development placeholders only; production uses `shopify.app.production.toml`. No real Meta send/receive integration is claimed until Meta verification and an actual inbound test message have succeeded.

The Shopify Admin Sidekick/assistant bar is rendered outside this app, so this theme's CSS cannot style or move it. Inbox polling refreshes conversations and delivery statuses every 30 seconds while the page is visible, and refreshes when returning to the tab.

# Bowchika Connect: home computer setup

This guide gets the app running on your Mac. It does not copy this computer's
local database or secrets, deploy code, release a Shopify app version, or enable
WhatsApp sending.

## 1. Install the tools

1. Install [Visual Studio Code for Mac](https://code.visualstudio.com/).
2. Install Git. In Terminal, run `git --version`. If macOS offers to install
   Command Line Developer Tools, accept it, then check the command again.
3. Install Node.js **22.12 or newer** from [nodejs.org](https://nodejs.org/).
   Open a new Terminal and check `node --version` and `npm --version`.
4. Install Shopify CLI:

   ```sh
   npm install -g @shopify/cli@latest
   shopify version
   ```

## 2. Sign in and clone the private repository

1. Sign in to GitHub in your browser with an account that has access to the
   private `bowchikastore-cmd/bowchika-connect` repository. Complete any
   organization or two-factor access prompts.
2. In VS Code, use **Accounts → Sign in with GitHub** if prompted. HTTPS Git
   operations may open a browser for authentication. Never put a GitHub token
   in a command, source file, or chat.
3. In Terminal, choose a folder for projects and clone the repository:

   ```sh
   cd ~/Documents
   git clone https://github.com/bowchikastore-cmd/bowchika-connect.git
   cd bowchika-connect
   code .
   ```

4. Install exactly the dependency versions in the committed npm lockfile:

   ```sh
   npm ci
   ```

## 3. Configure this Mac privately

Create a file named `.env` in the project root. It is ignored by Git. Add the
variable names below with the values obtained from the appropriate trusted
Shopify, Meta, or hosting account. **This guide contains no credential values;
do not send values in chat or commit `.env`.** In VS Code, do not enable an
extension or setting that uploads this file.

| Variable name | Purpose |
| --- | --- |
| `SHOPIFY_API_KEY` | Shopify app client ID used by local authentication |
| `SHOPIFY_API_SECRET` | Server-side Shopify app secret |
| `SHOPIFY_APP_URL` | Current local Shopify CLI development tunnel URL; `shopify app dev` normally manages the development URL |
| `SCOPES` | Shopify API scopes; currently `read_customers,read_orders` |
| `DATABASE_URL` | Local SQLite database for this Mac, normally `file:dev.sqlite` (Prisma resolves it from the SQLite schema directory) |
| `SHOP_CUSTOM_DOMAIN` | Optional Shopify custom domain, only if the app setup requires one |
| `WHATSAPP_SHOP_DOMAIN` | Exact `*.myshopify.com` shop bound to this deployment |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Cloud API phone-number ID; not the phone number itself |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta WhatsApp Business Account ID |
| `WHATSAPP_ACCESS_TOKEN` | Server-only Meta Cloud API access token |
| `META_APP_SECRET` | Server-only Meta app secret used to validate webhook signatures |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Server-only value used for the Meta webhook GET challenge |
| `META_GRAPH_API_VERSION` | Graph API version; the app currently defaults to `v23.0` |
| `WHATSAPP_TEST_RECIPIENT_PHONE` | Optional E.164 phone for the restricted personal-phone test path |
| `WHATSAPP_TEST_SENDING_ENABLED` | Keep `false` or unset; enabling it is a separate test-send approval |
| `WHATSAPP_INBOX_SENDING_ENABLED` | Keep `false`; general Inbox sending must remain off until separately approved |

Do not put production Neon URLs or production Meta credentials in this Mac's
local environment. For ordinary local development use SQLite. If Shopify
credentials or Meta values are unavailable, leave those features unconfigured;
do not copy someone else's values. Never enable either send switch during
setup. Keep production secrets in the provider's secret settings.

`.env` is not in GitHub, by design. The ignored `.shopify` directory may also
hold local CLI link/development state and is not copied from Git. Authenticate
with Shopify CLI when it asks, and confirm you select the Bowchika Connect app
and intended development store. Keep `shopify.app.toml` for development and
`shopify.app.production.toml` for production configuration; do not run a
production deploy/release just to start local development.

## 4. Create the local database and run the app

In the project folder:

```sh
npm run setup
npm run dev
```

`npm run setup` generates the Prisma client and applies the existing additive
SQLite migrations. It does not copy data from another computer or from Neon.
`npm run dev` starts Shopify CLI and its development tunnel; follow the
terminal prompts to open the app on the development store. Keep the terminal
running while you use the app. A restarted tunnel may have a different public
URL.

Run the checks from another Terminal in the project:

```sh
npm run typecheck
npm run lint
node_modules/.bin/vite-node app/whatsapp-safety.test.mjs
npx prisma validate
npm run build
```

The WhatsApp safety test uses a mocked Meta API. Before running it, make sure
`DATABASE_URL` points to a local SQLite file, **not Neon or another shared
database**. The test creates and removes synthetic local records. It does not
send WhatsApp messages.

## 5. Find the hosted app and database

- Sign in to [Render](https://dashboard.render.com/) with the authorized
  account and open the existing `bowchika-connect` service. Its public app URL
  is `https://bowchika-connect.onrender.com`. Use the **Events** and **Logs**
  views to check deployments and startup. Render Free may sleep when idle; the
  first request can be slow.
- Sign in to [Neon](https://console.neon.tech/) with the authorized account to
  view the existing project. Do not change database settings or replace its
  credentials. The app uses the configured PostgreSQL database on Render;
  local development continues to use the separate ignored SQLite file.
- Do not copy the Render environment or Neon connection strings into this
  document, Git, or local SQLite configuration.

## 6. Sync code changes safely

Before starting work:

```sh
git status --short --branch
git pull --ff-only origin main
```

After changing code, run the relevant checks, review `git diff`, and stage only
the files intended for the change. Never stage `.env`, database files,
credentials, or customer exports. When ready to share:

```sh
git add <reviewed-file-1> <reviewed-file-2>
git diff --cached --check
git diff --cached --stat
git commit -m "Describe the change"
git push origin main
```

A **local change** exists only on this Mac. A **GitHub push** saves the commit
to the shared repository. A **Render deployment** publishes the app server
code; the connected Render service may deploy automatically after a push, so
check Render Events before starting another deployment. A **Shopify app
version release** publishes Shopify-side configuration/extensions to installed
stores; it is separate from a Render deployment. Do not release a Shopify
version unless explicitly planned and reviewed.

The ignored `.env` is not copied by Git. Local `prisma/dev.sqlite` data is also
ignored and stays on the computer where it was created. Do not copy development
Shopify sessions or customer data to production. The existing Neon database is
separate; this setup guide does not migrate or reset any database.

## 7. Remaining work and safe order

The repository already has a first Inbox and a Start New Chat flow, but that
does not prove live Meta communication works. Continue in this order:

1. **Customers and pagination:** the dashboard currently requests only the
   first 100 customers. Implement cursor-based Shopify GraphQL pagination,
   loading additional pages without duplicate requests, and apply search and
   segments consistently across the intended result set. Test end cursors,
   empty pages, GraphQL errors, and timeout/retry behavior.
2. **Order counts and segment accuracy:** the current display and segment
   rules use Shopify's per-customer `numberOfOrders` field from the fetched
   customer page. Verify this field's intended Shopify semantics for the
   store's use cases, then test zero/one/repeat/has rules against known
   development-store records. Do not estimate counts by counting a partial
   `orders` connection or by assuming the first 100 customers are the full
   set.
3. **Inbox review:** exercise inbound records, shop isolation, conversation
   selection, message/status refresh, new-chat template fields, previews,
   failures, and duplicate submits on a development setup with mocked sends.
   Unsupported template components must remain blocked.
4. **Meta webhook verification:** only after explicit approval, confirm the
   correct production shop/phone binding, HTTPS Render callback ending in
   `/webhooks/whatsapp`, verification token, app secret, and `messages`
   subscription in Meta. Record a successful GET verification and then test a
   signed inbound message. Do not change the live Meta callback or
   subscription during setup.
5. **Template sends:** first sync approved templates and test every supported
   component against Meta using an explicitly opted-in test recipient. Keep
   both `WHATSAPP_TEST_SENDING_ENABLED` and
   `WHATSAPP_INBOX_SENDING_ENABLED` false until separately authorized. Only
   after review and explicit approval should general Inbox sending be enabled
   in Render. Never infer WhatsApp opt-in from Shopify email consent.

Do not run Shopify app release, change production Shopify settings, enable
sending, or modify Meta, Pabbly, Shiprocket, Render secrets, or Neon while
following these setup steps.

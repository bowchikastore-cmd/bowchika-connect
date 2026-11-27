# Bowchika Connect

Bowchika Connect is Bowchika's Shopify-embedded WhatsApp workspace. The product has two primary screens: **Campaigns** for building template campaigns and **Inbox** for customer conversations.

See [PRODUCT_BRIEF.md](./PRODUCT_BRIEF.md) for the product brief, modules, safeguards and current operational status.

## Stack

- Shopify embedded app built with React Router and the Shopify App React Router package.
- Prisma with SQLite for local development and PostgreSQL for production.
- Meta WhatsApp Cloud API for approved templates, delivery, inbound webhooks and delivery-status events.
- Render hosts the web app; Neon PostgreSQL stores production data.
- GitHub Actions runs the campaign-worker schedule.

## Local development

1. Use Node.js 22.12 or newer.
2. Install dependencies with `npm ci`.
3. Configure local environment variables in an ignored `.env` file. Never commit credentials.
4. Run `npm run dev`.

Useful verification commands:

```bash
npm run typecheck
npm run lint
npm run build
```

Production uses `prisma/postgresql/schema.prisma`; local development uses `prisma/schema.prisma`. Do not point production at a local SQLite file.

## Core routes

- `/app/campaigns` — Campaign Manager, Shopify audience, approved template sync, message preview and campaign history.
- `/app/inbox` — WhatsApp conversation inbox.
- `/webhooks/whatsapp` — Meta webhook endpoint.
- Shopify app lifecycle webhooks remain under `/webhooks/*`.

The old workspace dashboard and appearance-only Settings screen redirect to Campaigns. Keep authentication, webhook, worker, schema and deployment files even though they are not visible in app navigation.

## Production safety and availability

Campaign and Inbox sending are controlled by separate server-side flags. The campaign worker rechecks recipient eligibility and the suppression list immediately before delivery. A saved draft is not a queued campaign. A Shopify phone number or order history alone is not proof of WhatsApp marketing permission.

Campaign sending is currently disabled pending end-to-end verification. Do not describe real delivery as live until a controlled test to an appropriately permissioned recipient has succeeded.

The current Render Free + Neon Free setup can sleep or scale to zero. Treat it as a pilot, not guaranteed real-time support or critical unattended delivery.

## Secrets

- Never commit Shopify, Meta, WhatsApp, database or worker credentials.
- Keep `CAMPAIGN_WORKER_SECRET` in Render and the matching GitHub Actions repository secret only.
- Keep `SHOPIFY_SERVICE_ACCOUNT_TOKEN` in GitHub Actions secrets only.
- Keep campaign and Inbox send flags separate.

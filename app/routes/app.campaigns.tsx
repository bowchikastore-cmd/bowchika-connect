import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { normalizeE164Phone, getWhatsAppTemplateRequirements } from "../whatsapp-shared";
import { parseShopifyOrderCsv } from "../shopify-order-csv.server";
import { buildUpdatedAtSearchQuery, getIncrementalSyncSince } from "../shopify-sync.shared";

const json = (body: object, status = 200) => Response.json(body, { status });
const field = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

type CampaignActionData = {
  success?: boolean | string;
  message?: string;
  error?: string;
  campaignId?: string;
  mediaUrl?: string;
  mediaAlt?: string;
  syncJobId?: string;
  syncPhase?: string;
  customersProcessed?: number;
  ordersProcessed?: number;
  ordersSkipped?: number;
  ordersUnlinked?: number;
  hasMore?: boolean;
  continuation?: string;
  importPreview?: {
    fileName: string;
    fileSize: number;
    sourceRows: number;
    orders: number;
    lineItems: number;
    duplicates: number;
    newOrders: number;
    matchedNewOrders: number;
    unmatchedNewOrders: number;
  };
  importStats?: {
    importedOrders: number;
    duplicateOrders: number;
    linkedExistingOrders: number;
    unmatchedOrders: number;
    importedLineItems: number;
  };
};
type ShopifyWhatsAppConsent = {
  state: string;
  updatedAt: string | null;
  collectedFrom: string | null;
  optInLevel: string | null;
};
type ShopifyPhoneNumber = {
  phoneNumber: string | null;
  whatsAppMarketingConsent?: ShopifyWhatsAppConsent | null;
};
type ShopifyCustomerData = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  tags?: string[];
  numberOfOrders?: number;
  defaultEmailAddress?: { emailAddress: string | null } | null;
  defaultPhoneNumber?: ShopifyPhoneNumber | null;
  amountSpent?: { amount: string; currencyCode: string } | null;
};
type ShopifyCustomerNode = ShopifyCustomerData & {
  firstName: string | null;
  lastName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  tags: string[];
  numberOfOrders: number;
};
type ShopifyOrderNode = {
  id: string;
  name: string;
  number: number | null;
  createdAt: string | null;
  processedAt: string | null;
  updatedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer?: ShopifyCustomerData | null;
  email: string | null;
  phone: string | null;
  billingAddress?: { phone: string | null; name: string | null } | null;
  totalPriceSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
  lineItems?: { nodes?: Array<{
    name: string;
    quantity: number;
    sku: string | null;
    variantTitle: string | null;
    product?: {
      id: string;
      title: string;
      productType: string;
      collections?: { nodes?: Array<{ id: string; title: string }> | null } | null;
    } | null;
    variant?: { id: string; title: string } | null;
  }> | null } | null;
};
const customerQuery = `#graphql
query BowchikaCustomerMirror($after: String) {
  customers(first: 100, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id firstName lastName createdAt updatedAt tags numberOfOrders defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber whatsAppMarketingConsent { state updatedAt collectedFrom optInLevel } } amountSpent { amount currencyCode } }
  }
}`;
const orderQuery = `#graphql
query BowchikaOrderMirror($after: String) {
  orders(first: 100, after: $after, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes { id name number createdAt processedAt updatedAt displayFinancialStatus displayFulfillmentStatus customer { id firstName lastName updatedAt tags numberOfOrders amountSpent { amount currencyCode } defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber whatsAppMarketingConsent { state updatedAt collectedFrom optInLevel } } } email phone billingAddress { phone name } totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 100) { nodes { name quantity sku variantTitle product { id title productType collections(first: 20) { nodes { id title } } } variant { id title } } } }
  }
}`;

const incrementalCustomerQuery = `#graphql
query BowchikaIncrementalCustomers($after: String, $query: String) {
  customers(first: 100, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id firstName lastName createdAt updatedAt tags numberOfOrders defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber whatsAppMarketingConsent { state updatedAt collectedFrom optInLevel } } amountSpent { amount currencyCode } }
  }
}`;

const incrementalOrderQuery = `#graphql
query BowchikaIncrementalOrders($after: String, $query: String) {
  orders(first: 100, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id name number createdAt processedAt updatedAt displayFinancialStatus displayFulfillmentStatus customer { id firstName lastName updatedAt tags numberOfOrders amountSpent { amount currencyCode } defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber whatsAppMarketingConsent { state updatedAt collectedFrom optInLevel } } } email phone billingAddress { phone name } totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 100) { nodes { name quantity sku variantTitle product { id title productType collections(first: 20) { nodes { id title } } } variant { id title } } } }
  }
}`;

const syncShopifyCustomerMirrors = async (
  shop: string,
  customers: ShopifyCustomerData[],
) => {
  if (!customers.length) return;
  const ids = customers.map((customer) => customer.id);
  const phones = [...new Set(customers
    .map((customer) => normalizeE164Phone(customer.defaultPhoneNumber?.phoneNumber ?? ""))
    .filter((phone): phone is string => Boolean(phone)))];
  const [existing, suppressions] = await Promise.all([
    prisma.shopifyCustomerMirror.findMany({
      where: { shop, id: { in: ids } },
      select: { id: true, phone: true, whatsappOptOutAt: true },
    }),
    phones.length
      ? prisma.whatsAppContactSuppression.findMany({
          where: { shop, phoneNumber: { in: phones } },
          select: { phoneNumber: true, lastOptOutAt: true },
        })
      : Promise.resolve([]),
  ]);
  const existingById = new Map(existing.map((customer) => [customer.id, customer]));
  const suppressionByPhone = new Map(suppressions.map((item) => [item.phoneNumber, item.lastOptOutAt]));
  const reconsentedPhones = new Set<string>();
  const now = new Date();
  const writes = customers.map((customer) => {
    const rawPhone = customer.defaultPhoneNumber?.phoneNumber ?? null;
    const normalizedPhone = normalizeE164Phone(rawPhone ?? "");
    const existingCustomer = existingById.get(customer.id);
    const samePhone = Boolean(
      existingCustomer &&
      normalizeE164Phone(existingCustomer.phone ?? "") === normalizedPhone,
    );
    const suppressionAt = normalizedPhone ? suppressionByPhone.get(normalizedPhone) ?? null : null;
    const customerOptOutAt = samePhone ? existingCustomer?.whatsappOptOutAt ?? null : null;
    const localOptOutAt = customerOptOutAt && suppressionAt
      ? (customerOptOutAt > suppressionAt ? customerOptOutAt : suppressionAt)
      : customerOptOutAt ?? suppressionAt;
    const nativeConsent = customer.defaultPhoneNumber?.whatsAppMarketingConsent;
    const consentState = nativeConsent?.state ?? "NEVER_SUBSCRIBED";
    const consentUpdatedAt = nativeConsent?.updatedAt ? new Date(nativeConsent.updatedAt) : null;
    const reconsented = Boolean(
      consentState === "SUBSCRIBED" &&
      consentUpdatedAt &&
      localOptOutAt &&
      consentUpdatedAt.getTime() > localOptOutAt.getTime(),
    );
    if (reconsented && normalizedPhone) reconsentedPhones.add(normalizedPhone);
    const fields = {
      firstName: customer.firstName ?? null,
      lastName: customer.lastName ?? null,
      email: customer.defaultEmailAddress?.emailAddress ?? null,
      phone: rawPhone,
      numberOfOrders: Number(customer.numberOfOrders ?? 0),
      amountSpent: Number(customer.amountSpent?.amount ?? 0),
      currencyCode: customer.amountSpent?.currencyCode ?? "INR",
      tagsJson: JSON.stringify(customer.tags ?? []),
      createdAtShopify: customer.createdAt ? new Date(customer.createdAt) : undefined,
      updatedAtShopify: customer.updatedAt ? new Date(customer.updatedAt) : null,
      whatsappConsentState: consentState,
      whatsappConsentUpdatedAt: consentUpdatedAt,
      whatsappConsentCollectedFrom: nativeConsent?.collectedFrom ?? null,
      whatsappConsentOptInLevel: nativeConsent?.optInLevel ?? null,
      whatsappOptOutAt: reconsented ? null : localOptOutAt,
      whatsappOptIn: consentState === "SUBSCRIBED" && (!localOptOutAt || reconsented),
      syncedAt: now,
    };
    return prisma.shopifyCustomerMirror.upsert({
      where: { id: customer.id },
      create: { id: customer.id, shop, ...fields },
      update: fields,
    });
  });
  const operations = [...writes];
  if (reconsentedPhones.size) {
    operations.push(prisma.whatsAppContactSuppression.deleteMany({
      where: { shop, phoneNumber: { in: [...reconsentedPhones] } },
    }) as never);
  }
  await prisma.$transaction(operations as never);
};

const buildAudienceWhere = (shop: string, filters: {
  search: string;
  orderedOnly: boolean;
  minOrders: number | null;
  maxOrders: number | null;
  minSpend: number | null;
  lastOrderDays: number | null;
  productQuery: string;
  collectionQuery: string;
}) => {
  const and: Record<string, unknown>[] = [];
  if (filters.search) {
    and.push({
      OR: [
        { firstName: { contains: filters.search } },
        { lastName: { contains: filters.search } },
        { email: { contains: filters.search } },
        { phone: { contains: filters.search } },
        { orders: { some: { orderName: { contains: filters.search } } } },
      ],
    });
  }
  if (filters.productQuery || filters.collectionQuery || filters.lastOrderDays !== null) {
    const orderAnd: Record<string, unknown>[] = [];
    if (filters.productQuery) orderAnd.push({ lineItemsJson: { contains: filters.productQuery } });
    if (filters.collectionQuery) orderAnd.push({ lineItemsJson: { contains: filters.collectionQuery } });
    if (filters.lastOrderDays !== null) {
      orderAnd.push({ processedAt: { gte: new Date(Date.now() - filters.lastOrderDays * 86400000) } });
    }
    and.push({ orders: { some: { AND: orderAnd } } });
  }
  const minimumOrders = filters.orderedOnly
    ? Math.max(1, filters.minOrders ?? 0)
    : filters.minOrders;
  const orderCountFilter = minimumOrders !== null || filters.maxOrders !== null
    ? {
        numberOfOrders: {
          ...(minimumOrders !== null ? { gte: minimumOrders } : {}),
          ...(filters.maxOrders !== null ? { lte: filters.maxOrders } : {}),
        },
      }
    : {};
  return {
    shop,
    ...orderCountFilter,
    ...(filters.minSpend !== null ? { amountSpent: { gte: filters.minSpend } } : {}),
    ...(and.length ? { AND: and } : {}),
  };
};

const parseAudienceFilters = (read: (key: string) => string) => {
  const positiveInteger = (raw: string) => raw && /^\d+$/.test(raw) ? Number(raw) : null;
  const nonNegativeAmount = (raw: string) => raw && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
  const days = positiveInteger(read("lastOrderDays"));
  return {
    search: read("q").slice(0, 120),
    orderedOnly: read("orderedOnly") !== "false" && read("ordered") !== "false",
    minOrders: positiveInteger(read("minOrders")),
    maxOrders: positiveInteger(read("maxOrders")),
    minSpend: nonNegativeAmount(read("minSpend")),
    lastOrderDays: days !== null && [30, 60, 90, 180, 365].includes(days) ? days : null,
    productQuery: read("productQuery").slice(0, 120),
    collectionQuery: read("collectionQuery").slice(0, 120),
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filters = parseAudienceFilters((key) => url.searchParams.get(key) ?? "");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const customerWhere = buildAudienceWhere(session.shop, filters);
  const [templates, customers, customerCount, eligibleCount, orderCount, campaigns, syncJob] = await Promise.all([
    prisma.approvedWhatsAppTemplate.findMany({ where: { shop: session.shop }, orderBy: [{name:"asc"},{language:"asc"}] }),
    prisma.shopifyCustomerMirror.findMany({
      where: customerWhere,
      orderBy: [{ updatedAtShopify: "desc" }, { lastName: "asc" }, { id: "asc" }],
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { orders: { orderBy: [{processedAt:"desc"},{createdAtShopify:"desc"}], take: 1 } },
    }),
    prisma.shopifyCustomerMirror.count({ where: customerWhere }),
    prisma.shopifyCustomerMirror.count({ where: { ...customerWhere, whatsappOptIn: true } }),
    prisma.shopifyOrderMirror.count({ where: { shop: session.shop } }),
    prisma.whatsAppCampaign.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" }, take: 50, include: { recipients: { select: { status: true } } } }),
    prisma.shopifySyncJob.findUnique({ where: { id: session.shop } }),
  ]);
  return {
    filters,
    search: filters.search,
    orderedOnly: filters.orderedOnly,
    nextCursor: customers.length === 50 ? customers[customers.length - 1]?.id ?? null : null,
    customerCount,
    eligibleCount,
    templates: templates.map(t => ({id:t.id,name:t.name,language:t.language,category:t.category,components:t.components})),
    customers: customers.map(c => ({...c,tags:JSON.parse(c.tagsJson || "[]") as string[],latestOrder:c.orders[0]??null})),
    orderCount,
    campaigns: campaigns.map(c => ({
      id:c.id,name:c.name,status:c.status,audienceCount:c.audienceCount,scheduledAt:c.scheduledAt,
      templateId:c.templateId,templateName:c.templateName,templateLanguage:c.templateLanguage,
      templateComponents:c.templateComponents,variableMappingJson:c.variableMappingJson,
      audienceCriteriaJson:c.audienceCriteriaJson,mediaUrl:c.mediaUrl,
      counts:c.recipients.reduce((acc,r)=>({...acc,[r.status]:(acc[r.status]??0)+1}),{} as Record<string,number>)
    })),
    syncJob,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const data = await request.formData();
  const intent = field(data, "intent");
  if (intent === "resolve-image-file") {
    const fileId = field(data, "fileId");
    if (!/^gid:\/\/shopify\/MediaImage\/\d+$/.test(fileId)) {
      return json({ error: "Choose an image from Shopify Files." }, 400);
    }
    try {
      const response = await admin.graphql(
        `#graphql
          query BowchikaCampaignMediaImage($id: ID!) {
            node(id: $id) {
              ... on MediaImage { id alt image { url } }
            }
          }`,
        { variables: { id: fileId }, signal: AbortSignal.timeout(15_000) },
      );
      const result = await response.json() as {
        errors?: unknown[];
        data?: { node?: { id?: string; alt?: string | null; image?: { url?: string } | null } | null };
      };
      const url = result.data?.node?.image?.url;
      if (result.errors?.length || !url || !url.startsWith("https://")) {
        return json({ error: "Shopify could not resolve this image. Choose another file." }, 400);
      }
      return json({ mediaUrl: url, mediaAlt: result.data?.node?.alt ?? "" });
    } catch {
      return json({ error: "Could not read the selected Shopify file. Try another image." }, 502);
    }
  }

  if (intent === "preview-csv" || intent === "import-csv") {
    const file = data.get("csvFile");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) {
      return json({ error: "Choose a Shopify orders export CSV file." }, 400);
    }
    if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
      return json({ error: "CSV file must be between 1 byte and 10 MB." }, 400);
    }

    let parsed;
    try {
      parsed = parseShopifyOrderCsv(await file.text());
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : "The Shopify CSV could not be parsed.",
      }, 400);
    }

    const customers = await prisma.shopifyCustomerMirror.findMany({
      where: { shop: session.shop },
      select: { id: true, email: true, phone: true },
    });
    const emailIndex = new Map<string, Set<string>>();
    const phoneIndex = new Map<string, Set<string>>();
    const addIndex = (index: Map<string, Set<string>>, key: string | null, id: string) => {
      if (!key) return;
      const ids = index.get(key) ?? new Set<string>();
      ids.add(id);
      index.set(key, ids);
    };
    for (const customer of customers) {
      const email = customer.email?.trim().toLowerCase() || null;
      const rawPhone = customer.phone?.trim() ?? "";
      const phone = rawPhone.startsWith("+") ? normalizeE164Phone(rawPhone) : null;
      addIndex(emailIndex, email, customer.id);
      addIndex(phoneIndex, phone, customer.id);
    }
    const uniqueId = (ids?: Set<string>) => ids?.size === 1 ? [...ids][0] : null;
    const matchedCustomerIds = new Map<string, string>();
    for (const order of parsed.orders) {
      const email = order.customerEmail?.trim().toLowerCase() || null;
      const rawPhone = order.customerPhone?.trim() ?? "";
      const phone = rawPhone.startsWith("+") ? normalizeE164Phone(rawPhone) : null;
      const emailIds = email ? emailIndex.get(email) : undefined;
      const phoneIds = phone ? phoneIndex.get(phone) : undefined;
      const emailId = uniqueId(emailIds);
      const phoneId = uniqueId(phoneIds);
      let customerId: string | null = null;
      if (emailId && phoneId) {
        customerId = emailId === phoneId ? emailId : null;
      } else if (emailId && (!phoneIds || phoneIds.has(emailId))) {
        customerId = emailId;
      } else if (phoneId && (!emailIds || emailIds.has(phoneId))) {
        customerId = phoneId;
      }
      if (customerId) matchedCustomerIds.set(order.id, customerId);
    }

    const existing = await prisma.shopifyOrderMirror.findMany({
      where: { shop: session.shop, id: { in: parsed.orders.map((order) => order.id) } },
      select: { id: true, customerId: true },
    });
    const existingById = new Map(existing.map((order) => [order.id, order]));
    const newOrders = parsed.orders.filter((order) => !existingById.has(order.id));
    const matchedNewOrders = newOrders.filter((order) => matchedCustomerIds.has(order.id)).length;
    const unmatchedNewOrders = newOrders.length - matchedNewOrders;

    if (intent === "preview-csv") {
      return json({
        importPreview: {
          fileName: file.name,
          fileSize: file.size,
          sourceRows: parsed.sourceRows,
          orders: parsed.orders.length,
          lineItems: parsed.lineItems,
          duplicates: existing.length,
          newOrders: newOrders.length,
          matchedNewOrders,
          unmatchedNewOrders,
        },
      });
    }

    const importedAt = new Date();
    const writes = newOrders.map((order) => {
      const customerId = matchedCustomerIds.get(order.id) ?? null;
      const fields = {
        shop: session.shop,
        customerId,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        customerName: order.customerName,
        csvImportedAt: importedAt,
        orderName: order.orderName,
        orderNumber: order.orderNumber,
        processedAt: order.processedAt,
        createdAtShopify: order.createdAtShopify,
        totalPrice: order.totalPrice,
        currencyCode: order.currencyCode,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        lineItemsJson: JSON.stringify(order.lineItems),
        syncedAt: importedAt,
      };
      return prisma.shopifyOrderMirror.upsert({
        where: { id: order.id },
        create: { id: order.id, ...fields },
        update: {},
      });
    });
    const linksToResolve = existing.flatMap((order) => {
      const customerId = matchedCustomerIds.get(order.id);
      return !order.customerId && customerId
        ? [prisma.shopifyOrderMirror.updateMany({
            where: { id: order.id, shop: session.shop, customerId: null },
            data: { customerId, csvImportedAt: importedAt },
          })]
        : [];
    });
    if (writes.length || linksToResolve.length) {
      await prisma.$transaction([...writes, ...linksToResolve]);
    }
    return json({
      success: `Historical import finished: ${newOrders.length.toLocaleString("en-IN")} new orders imported; ${existing.length.toLocaleString("en-IN")} already existed and were kept; ${unmatchedNewOrders.toLocaleString("en-IN")} new orders need customer matching.`,
      importStats: {
        importedOrders: newOrders.length,
        duplicateOrders: existing.length,
        linkedExistingOrders: linksToResolve.length,
        unmatchedOrders: unmatchedNewOrders,
        importedLineItems: newOrders.reduce((total, order) => total + order.lineItems.length, 0),
      },
    });
  }

  if (intent === "sync" || intent === "sync-incremental" || intent === "sync-next") {
    const shop = session.shop;
    let job = await prisma.shopifySyncJob.findUnique({ where: { id: shop } });

    if (intent === "sync-incremental") {
      if (!job || job.status !== "COMPLETED" || !job.completedAt) {
        return json({ error: "Complete the initial full Shopify sync before starting incremental sync." }, 409);
      }
      const incrementalSince = getIncrementalSyncSince(job.completedAt);
      job = await prisma.shopifySyncJob.update({
        where: { id: shop },
        data: {
          mode: "INCREMENTAL",
          incrementalSince,
          status: "RUNNING",
          phase: "CUSTOMERS_INCREMENTAL",
          customerCursor: null,
          orderCursor: null,
          customersProcessed: 0,
          ordersProcessed: 0,
          ordersSkipped: 0,
          ordersUnlinked: 0,
          customerPages: 0,
          orderPages: 0,
          lastError: null,
          leaseToken: null,
          leaseExpiresAt: null,
          startedAt: new Date(),
          completedAt: null,
        },
      });
    } else if (intent === "sync") {
      if (!job || job.status === "COMPLETED") {
        job = await prisma.shopifySyncJob.upsert({
          where: { id: shop },
          create: {
            id: shop,
            shop,
            mode: "FULL",
            status: "RUNNING",
            phase: "CUSTOMERS",
          },
          update: {
            mode: "FULL",
            incrementalSince: null,
            status: "RUNNING",
            phase: "CUSTOMERS",
            customerCursor: null,
            orderCursor: null,
            customersProcessed: 0,
            ordersProcessed: 0,
            ordersSkipped: 0,
            ordersUnlinked: 0,
            customerPages: 0,
            orderPages: 0,
            lastError: null,
            leaseToken: null,
            leaseExpiresAt: null,
            startedAt: new Date(),
            completedAt: null,
          },
        });
      }
    } else if (!job || job.status !== "RUNNING" || field(data, "jobId") !== shop) {
      return json({ error: "No resumable Shopify sync job was found. Start a new sync." }, 409);
    }

    if (!job || job.status !== "RUNNING") {
      return json({ error: "Shopify sync could not be started." }, 500);
    }

    const leaseToken = globalThis.crypto.randomUUID();
    const leaseStartedAt = new Date();
    const lease = await prisma.shopifySyncJob.updateMany({
      where: {
        id: shop,
        shop,
        status: "RUNNING",
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: leaseStartedAt } },
        ],
      },
      data: {
        leaseToken,
        leaseExpiresAt: new Date(leaseStartedAt.getTime() + 120_000),
        lastError: null,
      },
    });
    if (lease.count !== 1) {
      return json({ error: "A sync batch is already running. Wait briefly, then resume the sync." }, 409);
    }

    job = await prisma.shopifySyncJob.findUnique({ where: { id: shop } });
    if (!job || job.leaseToken !== leaseToken) {
      return json({ error: "The sync lease could not be confirmed. Resume the sync." }, 409);
    }

    try {
      if (job.phase === "CUSTOMERS" || job.phase === "CUSTOMERS_INCREMENTAL") {
        const incremental = job.phase === "CUSTOMERS_INCREMENTAL";
        if (incremental && !job.incrementalSince) {
          throw new Error("The incremental customer checkpoint is missing. Run a full sync and retry.");
        }
        const response = await admin.graphql(
          incremental ? incrementalCustomerQuery : customerQuery,
          {
            variables: incremental
              ? { after: job.customerCursor ?? null, query: buildUpdatedAtSearchQuery(job.incrementalSince!) }
              : { after: job.customerCursor ?? null },
            signal: AbortSignal.timeout(20_000),
          },
        );
        const result = await response.json() as {
          errors?: unknown[];
          data?: {
            customers?: {
              nodes?: ShopifyCustomerNode[];
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
        const connection = result.data?.customers;
        const pageInfo = connection?.pageInfo;
        if (result.errors?.length || !connection || !pageInfo) {
          throw new Error("Shopify customer page could not be read. Check customer access and retry.");
        }

        const customers = connection.nodes ?? [];
        await syncShopifyCustomerMirrors(shop, customers);

        const hasNextPage = pageInfo.hasNextPage;
        const nextCursor = hasNextPage ? pageInfo.endCursor : null;
        if (hasNextPage && (!nextCursor || nextCursor === job.customerCursor)) {
          throw new Error("Shopify customer pagination returned a missing or repeated cursor. Resume after checking the Shopify response.");
        }
        const nextPhase = hasNextPage
          ? job.phase
          : incremental
            ? "ORDERS_INCREMENTAL"
            : "ORDERS";
        const saved = await prisma.shopifySyncJob.updateMany({
          where: { id: shop, shop, leaseToken },
          data: {
            phase: nextPhase,
            customerCursor: nextCursor,
            customersProcessed: { increment: customers.length },
            customerPages: { increment: 1 },
            lastError: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (saved.count !== 1) throw new Error("The sync checkpoint could not be saved. Resume is safe; this page uses idempotent upserts.");
        const latest = await prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: shop } });
        return json({
          message: "Customer sync progress: " + latest.customersProcessed.toLocaleString("en-IN") + " records across " + latest.customerPages + " pages. " + (hasNextPage ? "Continuing…" : "Customers complete; starting orders…"),
          syncJobId: shop,
          syncPhase: latest.phase,
          customersProcessed: latest.customersProcessed,
          ordersProcessed: latest.ordersProcessed,
          ordersSkipped: latest.ordersSkipped,
          hasMore: true,
          continuation: latest.phase + "|" + (latest.customerCursor ?? "") + "|" + (latest.orderCursor ?? "") + "|" + latest.customerPages + "|" + latest.orderPages,
        });
      }

      if (job.phase === "ORDERS" || job.phase === "ORDERS_INCREMENTAL") {
        const incremental = job.phase === "ORDERS_INCREMENTAL";
        if (incremental && !job.incrementalSince) {
          throw new Error("The incremental order checkpoint is missing. Run a full sync and retry.");
        }
        const response = await admin.graphql(
          incremental ? incrementalOrderQuery : orderQuery,
          {
            variables: incremental
              ? { after: job.orderCursor ?? null, query: buildUpdatedAtSearchQuery(job.incrementalSince!) }
              : { after: job.orderCursor ?? null },
            signal: AbortSignal.timeout(20_000),
          },
        );
        const result = await response.json() as {
          errors?: unknown[];
          data?: {
            orders?: {
              nodes?: ShopifyOrderNode[];
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
        const connection = result.data?.orders;
        const pageInfo = connection?.pageInfo;
        if (result.errors?.length || !connection || !pageInfo) {
          throw new Error("Shopify order page could not be read. Check order access and retry.");
        }

        const orders = connection.nodes ?? [];
        const customerNodes = new Map(
          orders.flatMap((order) => order.customer ? [[order.customer.id, order.customer] as const] : []),
        );
        await syncShopifyCustomerMirrors(shop, [...customerNodes.values()]);
        const knownCustomerIds = new Set(customerNodes.keys());
        let unlinked = 0;
        const now = new Date();
        const writes = orders.map((order) => {
          const requestedCustomerId = order.customer?.id ?? null;
          const customerId = requestedCustomerId && knownCustomerIds.has(requestedCustomerId)
            ? requestedCustomerId
            : null;
          if (!customerId) unlinked++;
          const customerName = [order.customer?.firstName, order.customer?.lastName]
            .filter(Boolean)
            .join(" ") || order.billingAddress?.name || null;
          const fields = {
            shop,
            customerId,
            customerEmail: order.customer?.defaultEmailAddress?.emailAddress ?? order.email ?? null,
            customerPhone: order.customer?.defaultPhoneNumber?.phoneNumber ?? order.phone ?? order.billingAddress?.phone ?? null,
            customerName,
            orderName: order.name,
            orderNumber: order.number ?? null,
            createdAtShopify: order.createdAt ? new Date(order.createdAt) : null,
            processedAt: order.processedAt ? new Date(order.processedAt) : null,
            updatedAtShopify: order.updatedAt ? new Date(order.updatedAt) : null,
            financialStatus: order.displayFinancialStatus ?? null,
            fulfillmentStatus: order.displayFulfillmentStatus ?? null,
            totalPrice: Number(order.totalPriceSet?.shopMoney?.amount ?? 0),
            currencyCode: order.totalPriceSet?.shopMoney?.currencyCode ?? "INR",
            lineItemsJson: JSON.stringify(order.lineItems?.nodes ?? []),
            syncedAt: now,
          };
          return prisma.shopifyOrderMirror.upsert({
            where: { id: order.id },
            create: { id: order.id, ...fields },
            update: fields,
          });
        });
        if (writes.length) await prisma.$transaction(writes);

        const hasNextPage = pageInfo.hasNextPage;
        const nextCursor = hasNextPage ? pageInfo.endCursor : null;
        if (hasNextPage && (!nextCursor || nextCursor === job.orderCursor)) {
          throw new Error("Shopify order pagination returned a missing or repeated cursor. Resume after checking the Shopify response.");
        }
        const saved = await prisma.shopifySyncJob.updateMany({
          where: { id: shop, shop, leaseToken },
          data: {
            phase: hasNextPage ? job.phase : "ORDERS",
            orderCursor: nextCursor,
            ordersProcessed: { increment: writes.length },
            ordersSkipped: { increment: 0 },
            ordersUnlinked: { increment: unlinked },
            orderPages: { increment: 1 },
            lastError: null,
            status: hasNextPage ? "RUNNING" : "COMPLETED",
            completedAt: hasNextPage ? null : new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (saved.count !== 1) throw new Error("The sync checkpoint could not be saved. Resume is safe; this page uses idempotent upserts.");
        const latest = await prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: shop } });
        return json({
          message: hasNextPage
            ? "Order sync progress: " + latest.ordersProcessed.toLocaleString("en-IN") + " imported; " + latest.ordersSkipped.toLocaleString("en-IN") + " skipped. Continuing…"
            : (incremental
              ? "Incremental sync complete: "
              : "Full sync complete: ")
              + latest.customersProcessed.toLocaleString("en-IN") + " customers checked, "
              + latest.ordersProcessed.toLocaleString("en-IN") + " orders upserted, "
              + latest.ordersUnlinked.toLocaleString("en-IN") + " orders stored without a linked local customer. A 24-hour overlap protects updates made during the previous sync; Shopify order access still follows the store's approved API scopes.",
          syncJobId: shop,
          syncPhase: latest.phase,
          customersProcessed: latest.customersProcessed,
          ordersProcessed: latest.ordersProcessed,
          ordersSkipped: latest.ordersSkipped,
          ordersUnlinked: latest.ordersUnlinked,
          hasMore: hasNextPage,
          continuation: hasNextPage ? latest.phase + "|" + (latest.customerCursor ?? "") + "|" + (latest.orderCursor ?? "") + "|" + latest.customerPages + "|" + latest.orderPages : undefined,
        });
      }

      throw new Error("Unknown Shopify sync phase. Start a new sync.");
    } catch (error) {
      console.error("Shopify customer/order sync batch failed", error);
      const message = error instanceof Error ? error.message : "Unexpected Shopify sync error.";
      await prisma.shopifySyncJob.updateMany({
        where: { id: shop, shop, leaseToken },
        data: {
          lastError: message.slice(0, 1000),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return json({
        error: message,
        syncJobId: shop,
        syncPhase: job.phase,
        customersProcessed: job.customersProcessed,
        ordersProcessed: job.ordersProcessed,
        ordersSkipped: job.ordersSkipped,
        ordersUnlinked: job.ordersUnlinked,
      }, 500);
    }
  }
  if (intent === "create-campaign") {
    const name = field(data,"name").slice(0,120) || "Bowchika campaign";
    const templateId = field(data,"templateId");
    const scheduledAtRaw = field(data,"scheduledAt");
    const mediaUrlRaw = field(data,"mediaUrl");
    const selectedIds = [...new Set(data.getAll("customerId").map(String).filter(Boolean))].slice(0,10000);
    const selectAllMatching = field(data, "selectAllMatching") === "true";
    const filters = parseAudienceFilters((key) => {
      const formKey: Record<string,string> = { search: "audienceSearch", orderedOnly: "orderedOnly" };
      return field(data, formKey[key] ?? key);
    });
    const where = buildAudienceWhere(session.shop, filters);
    if (!selectAllMatching && !selectedIds.length) return json({error:"Select at least one customer."},400);
    const template = await prisma.approvedWhatsAppTemplate.findFirst({where:{id:templateId,shop:session.shop}});
    if (!template) return json({error:"Choose a synced approved WhatsApp template."},400);
    let scheduledAt: Date | null = null;
    if (scheduledAtRaw) {
      scheduledAt = new Date(scheduledAtRaw);
      if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now()+60000) return json({error:"Choose a schedule at least one minute in the future."},400);
    }
    let mediaUrl: string | null = null;
    if (mediaUrlRaw) {
      try { const url = new URL(mediaUrlRaw); if(url.protocol!=="https:") throw new Error(); mediaUrl=url.toString(); } catch { return json({error:"Media URL must be a valid HTTPS URL."},400); }
    }
    const mapping: Record<string,string> = {};
    for (const [key,value] of data.entries()) {
      if (key.startsWith("map_")) mapping[key.slice(4)] = String(value).slice(0,100);
      else if (key.startsWith("custom_")) mapping["custom."+key.slice(7)] = String(value).slice(0,1024);
    }
    let templateRequirements;
    try {
      templateRequirements = getWhatsAppTemplateRequirements(template.components);
    } catch {
      return json({error:"This approved template definition is invalid. Sync approved templates again."},400);
    }
    if (templateRequirements.unsupported) return json({error:templateRequirements.unsupported},400);
    if (templateRequirements.header?.format === "IMAGE" && !mediaUrl) {
      return json({error:"Choose a header image for this WhatsApp template."},400);
    }
    const requiredMappings = [
      ...(templateRequirements.header?.format === "TEXT" ? templateRequirements.header.variables.map(v=>({section:"header",key:v.key})) : []),
      ...templateRequirements.bodyVariables.map(v=>({section:"body",key:v.key})),
      ...templateRequirements.buttons.flatMap(button=>button.variables.map(v=>({section:"button"+button.index,key:v.key}))),
    ];
    for (const item of requiredMappings) {
      const path = mapping[item.section+"."+item.key] ?? "name";
      const customValue = mapping["custom."+item.section+"."+item.key] ?? "";
      if (path === "custom" && !customValue.trim()) {
        return json({error:"Complete every custom template variable before saving this campaign."},400);
      }
    }
    const audienceWhere = selectAllMatching
      ? { ...where, whatsappOptIn: true }
      : { shop: session.shop, id: { in: selectedIds }, whatsappOptIn: true };
    const audienceCriteria = {
      ...filters,
      selectAllMatching,
      selectedCustomerIds: selectAllMatching ? [] : selectedIds,
    };
    const campaign = await prisma.whatsAppCampaign.create({data:{
      shop:session.shop,name,templateId:template.id,templateName:template.name,
      templateLanguage:template.language,templateComponents:template.components,
      variableMappingJson:JSON.stringify(mapping),audienceCriteriaJson:JSON.stringify(audienceCriteria),
      mediaUrl,scheduledAt,status:"PREPARING",audienceCount:0,
    }});
    let recipientCount = 0;
    let afterId: string | undefined;
    const seenPhones = new Set<string>();
    const suppressionRows = await prisma.whatsAppContactSuppression.findMany({
      where: { shop: session.shop },
      select: { phoneNumber: true },
    });
    const suppressedPhones = new Set(suppressionRows.map((item) => item.phoneNumber));
    try {
      let hasMoreRecipients = true;
      while (hasMoreRecipients) {
        const customers = await prisma.shopifyCustomerMirror.findMany({
          where: audienceWhere,
          orderBy: { id: "asc" },
          take: 500,
          ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
          include: { orders: { orderBy: [{processedAt:"desc"},{createdAtShopify:"desc"}], take: 1 } },
        });
        if (!customers.length) break;
        const recipients = customers.flatMap((customer) => {
          const phoneNumber = normalizeE164Phone(customer.phone ?? "");
          if (!phoneNumber || seenPhones.has(phoneNumber) || suppressedPhones.has(phoneNumber)) return [];
          seenPhones.add(phoneNumber);
          let tags: string[] = [];
          try { tags = JSON.parse(customer.tagsJson || "[]") as string[]; } catch { tags = []; }
          return [{
            shop: session.shop,
            campaignId: campaign.id,
            customerId: customer.id,
            phoneNumber,
            customerName: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null,
            snapshotJson: JSON.stringify({
              firstName: customer.firstName ?? "",
              lastName: customer.lastName ?? "",
              name: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
              email: customer.email ?? "",
              phone: customer.phone ?? "",
              numberOfOrders: customer.numberOfOrders,
              amountSpent: customer.amountSpent,
              currencyCode: customer.currencyCode,
              tags,
              latestOrder: customer.orders[0] ?? null,
            }),
            status: "QUEUED",
          }];
        });
        if (recipients.length) {
          await prisma.whatsAppCampaignRecipient.createMany({ data: recipients });
          recipientCount += recipients.length;
          await prisma.whatsAppCampaign.update({ where: { id: campaign.id }, data: { audienceCount: recipientCount } });
        }
        afterId = customers[customers.length - 1]?.id;
        hasMoreRecipients = customers.length === 500 && Boolean(afterId);
      }
    } catch {
      await prisma.whatsAppCampaign.update({where:{id:campaign.id},data:{status:"FAILED"}});
      return json({error:"Campaign audience preparation failed. The campaign was not queued for sending; review the local customer data and retry."},500);
    }
    if (!recipientCount) {
      await prisma.whatsAppCampaign.delete({where:{id:campaign.id}});
      return json({error:"No matching customer has both a valid phone number and verified WhatsApp opt-in recorded in Bowchika Connect. No campaign was queued."},400);
    }
    const finalStatus = scheduledAt ? "SCHEDULED" : "QUEUED";
    await prisma.whatsAppCampaign.update({where:{id:campaign.id},data:{status:finalStatus}});
    return json({success:`Campaign saved for ${recipientCount} opted-in customers. ${scheduledAt ? "Scheduled for "+scheduledAt.toLocaleString("en-IN") : "Queued for sending"}. Sending worker must be active before any message is sent.`,campaignId:campaign.id});
  }
  return json({error:"Unknown action."},400);
};

export default function CampaignCenter() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<CampaignActionData>();
  const syncFetcher = useFetcher<CampaignActionData>();
  const autoSyncContinuation = useRef<string | null>(null);
  const importFetcher = useFetcher<CampaignActionData>();
  const imageFetcher = useFetcher<CampaignActionData>();
  const shopify = useAppBridge() as unknown as { intents: { invoke: (intent: string, options?: unknown) => Promise<{ complete: Promise<{ code: string; data?: { ids?: string[] }; message?: string }> }> } };
  const [csvFileKey, setCsvFileKey] = useState("");
  const [query,setQuery] = useState(data.search);
  const [selected,setSelected] = useState<string[]>([]);
  const [selectAllMatching,setSelectAllMatching] = useState(false);
  const [orderedOnly,setOrderedOnly] = useState(data.orderedOnly);
  const [chosenTemplate,setChosenTemplate] = useState(data.templates[0]?.id ?? "");
  const [name,setName] = useState("Bowchika customer campaign");
  const [scheduledAt,setScheduledAt] = useState("");
  const [mediaUrl,setMediaUrl] = useState("");
  const [imageAlt,setImageAlt] = useState("");
  const [imagePickerBusy,setImagePickerBusy] = useState(false);
  const [imagePickerError,setImagePickerError] = useState("");
  const [minOrders,setMinOrders] = useState(data.filters.minOrders === null ? "" : String(data.filters.minOrders));
  const [maxOrders,setMaxOrders] = useState(data.filters.maxOrders === null ? "" : String(data.filters.maxOrders));
  const [minSpend,setMinSpend] = useState(data.filters.minSpend === null ? "" : String(data.filters.minSpend));
  const [lastOrderDays,setLastOrderDays] = useState(data.filters.lastOrderDays === null ? "" : String(data.filters.lastOrderDays));
  const [productQuery,setProductQuery] = useState(data.filters.productQuery);
  const [collectionQuery,setCollectionQuery] = useState(data.filters.collectionQuery);
  const [variableMapping,setVariableMapping] = useState<Record<string,string>>({});
  const [customMapping,setCustomMapping] = useState<Record<string,string>>({});

  useEffect(() => {
    if (imageFetcher.state === "idle" && imageFetcher.data?.mediaUrl) {
      setMediaUrl(imageFetcher.data.mediaUrl);
      setImageAlt(String(imageFetcher.data.mediaAlt ?? ""));
      setImagePickerError("");
    } else if (imageFetcher.state === "idle" && imageFetcher.data?.error) {
      setImagePickerError(imageFetcher.data.error);
    }
  }, [imageFetcher.state, imageFetcher.data]);

  const pickShopifyImage = async () => {
    setImagePickerBusy(true);
    setImagePickerError("");
    try {
      const activity = await shopify.intents.invoke("pick:shopify/File", {
        data: { mediaTypes: ["MediaImage"], multiSelect: false },
      });
      const response = await activity.complete;
      if (response.code === "ok") {
        const fileId = response.data?.ids?.[0];
        if (!fileId) {
          setImagePickerError("No image was selected.");
        } else {
          imageFetcher.submit(
            { intent: "resolve-image-file", fileId },
            { method: "post" },
          );
        }
      } else if (response.code === "error") {
        setImagePickerError(response.message || "Shopify could not open the Files picker.");
      }
    } catch {
      setImagePickerError("Shopify Files picker is unavailable in this session. Paste a public HTTPS image URL instead.");
    } finally {
      setImagePickerBusy(false);
    }
  };

  const reuseCampaign = (campaign: (typeof data.campaigns)[number]) => {
    try {
      const criteria = JSON.parse(campaign.audienceCriteriaJson || "{}") as {
        search?: string; orderedOnly?: boolean; minOrders?: number | null; maxOrders?: number | null;
        minSpend?: number | null; lastOrderDays?: number | null; productQuery?: string;
        collectionQuery?: string; selectAllMatching?: boolean; selectedCustomerIds?: string[];
      };
      const savedMapping = JSON.parse(campaign.variableMappingJson || "{}") as Record<string,string>;
      const nextCustom: Record<string,string> = {};
      const nextMapping: Record<string,string> = {};
      for (const [key,value] of Object.entries(savedMapping)) {
        if (key.startsWith("custom.")) nextCustom[key.slice(7)] = value;
        else nextMapping[key] = value;
      }
      setName(campaign.name + " (Copy)");
      setChosenTemplate(campaign.templateId);
      setVariableMapping(nextMapping);
      setCustomMapping(nextCustom);
      setScheduledAt("");
      setMediaUrl(campaign.mediaUrl || "");
      setQuery(criteria.search || "");
      setOrderedOnly(criteria.orderedOnly !== false);
      setMinOrders(criteria.minOrders == null ? "" : String(criteria.minOrders));
      setMaxOrders(criteria.maxOrders == null ? "" : String(criteria.maxOrders));
      setMinSpend(criteria.minSpend == null ? "" : String(criteria.minSpend));
      setLastOrderDays(criteria.lastOrderDays == null ? "" : String(criteria.lastOrderDays));
      setProductQuery(criteria.productQuery || "");
      setCollectionQuery(criteria.collectionQuery || "");
      setSelectAllMatching(Boolean(criteria.selectAllMatching));
      setSelected(criteria.selectedCustomerIds || []);
      setImageAlt("");
    } catch {
      setImagePickerError("This campaign's saved audience settings could not be reopened. Start a new audience instead.");
    }
  };

  const sampleCustomer = {
    firstName: "Alex",
    lastName: "Morgan",
    name: "Alex Morgan",
    email: "alex@example.com",
    phone: "+91 98765 43210",
    numberOfOrders: "3",
    amountSpent: "₹4,299",
    "latestOrder.orderName": "#1538",
    "latestOrder.totalPrice": "₹949",
    "latestOrder.productName": "Raze – Blast Artist T-Shirt",
  };
  const previewValue = (section: string, key: string) => {
    const path = variableMapping[section + "." + key] || "name";
    if (path === "custom") return customMapping[section + "." + key] || "[Custom text]";
    return sampleCustomer[path as keyof typeof sampleCustomer] ?? "[Sample value]";
  };
  const previewText = (text: string, section: string) => text.replace(
    /\\{\\{\\s*([A-Za-z0-9_]+)\\s*\\}\\}/g,
    (_match, key: string) => previewValue(section, key),
  );
  const previewHeader = requirements?.header?.format === "TEXT"
    ? previewText(requirements.header.text, "header")
    : "";
  const previewBody = requirements ? previewText(requirements.bodyText, "body") : "";
  useEffect(() => {
    const result = syncFetcher.data;
    if (syncFetcher.state !== "idle" || !result?.hasMore || !result.syncJobId || !result.continuation) return;
    if (autoSyncContinuation.current === result.continuation) return;
    autoSyncContinuation.current = result.continuation;
    syncFetcher.submit(
      { intent: "sync-next", jobId: result.syncJobId },
      { method: "post" },
    );
  }, [syncFetcher.state, syncFetcher.data, syncFetcher.submit]);

  const template = data.templates.find(t=>t.id===chosenTemplate);
  const requirements = useMemo(()=>{try{return template?getWhatsAppTemplateRequirements(template.components):null}catch{return null}},[template]);
  const fields = [{label:"Customer first name",value:"firstName"},{label:"Customer full name",value:"name"},{label:"Customer email",value:"email"},{label:"Customer phone",value:"phone"},{label:"Latest order number",value:"latestOrder.orderName"},{label:"Latest order total",value:"latestOrder.totalPrice"},{label:"Product name (latest order)",value:"latestOrder.productName"},{label:"Order count",value:"numberOfOrders"},{label:"Total spend",value:"amountSpent"},{label:"Custom text",value:"custom"}];
  const style = {padding:10,border:"1px solid #d0d5dd",borderRadius:8,background:"white",color:"#222"} as const;
  const inputStyle = { ...style, width: "100%", boxSizing: "border-box" as const };
  const nextPageParams = new URLSearchParams({
    q: data.filters.search,
    ordered: String(data.filters.orderedOnly),
    minOrders: minOrders,
    maxOrders: maxOrders,
    minSpend: minSpend,
    lastOrderDays: lastOrderDays,
    productQuery: productQuery,
    collectionQuery: collectionQuery,
  });
  if (data.nextCursor) nextPageParams.set("cursor", data.nextCursor);

  return <s-page heading="Customer & Campaign Center"><div style={{maxWidth:1400,margin:"0 auto",padding:20,color:"var(--bc-text, #222)"}}>
    <h1>Shopify customers → WhatsApp campaigns</h1>
    <p>Synced customer and order records, full-store search, bulk selection, approved template mapping and scheduled campaign drafts.</p>
    <syncFetcher.Form method="post" onSubmit={() => { autoSyncContinuation.current = null; }} style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:16}}>
      <button name="intent" value="sync" style={style} disabled={syncFetcher.state!=="idle"}>
        {data.syncJob?.status === "RUNNING" ? "Resume current sync" : "Run full sync (all accessible records)"}
      </button>
      <button name="intent" value="sync-incremental" style={{...style,background:"#e8f5ee",borderColor:"#a6d7b8"}} disabled={syncFetcher.state!=="idle" || data.syncJob?.status === "RUNNING" || !data.syncJob?.completedAt}>
        Sync new & updated only
      </button>
      <span>{data.customerCount.toLocaleString("en-IN")} local customers · {data.orderCount.toLocaleString("en-IN")} local orders</span>
    </syncFetcher.Form>
    <p style={{fontSize:13,color:"#667085",marginTop:0}}>Use incremental sync for normal daily updates. It checks Shopify customers and orders changed since the previous completed sync, with a 24-hour overlap to catch late updates safely; records are upserted by Shopify ID. A full sync is only for initial setup or deliberate reconciliation. Shopify exposes only the default recent 60-day order window unless the app receives read_all_orders approval.</p>
    <div style={{padding:14,border:"1px solid #d0d5dd",borderRadius:8,margin:"16px 0",background:"white"}}>
      <h2 style={{marginTop:0}}>Import historical Shopify orders</h2>
      <p style={{fontSize:13,color:"#667085"}}>Upload the Shopify Orders CSV export. Bowchika Connect groups line items by Shopify order ID, matches customers by unique email/phone, and keeps existing API orders instead of duplicating or overwriting them. Unmatched orders are still stored, but remain unlinked until they can be matched.</p>
      <importFetcher.Form method="post" encType="multipart/form-data" style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <input type="file" name="csvFile" accept=".csv,text/csv" required onChange={event=>{const selectedFile=event.currentTarget.files?.[0];setCsvFileKey(selectedFile?selectedFile.name+":"+selectedFile.size:"");}}/>
        <button type="submit" name="intent" value="preview-csv" style={style} disabled={importFetcher.state!=="idle"}>Preview CSV</button>
        {importFetcher.data?.importPreview && (importFetcher.data.importPreview.fileName+":"+importFetcher.data.importPreview.fileSize)===csvFileKey && <button type="submit" name="intent" value="import-csv" style={{...style,background:"#155eef",color:"white"}} disabled={importFetcher.state!=="idle" || importFetcher.data.importPreview.newOrders===0}>Confirm import {importFetcher.data.importPreview.newOrders.toLocaleString("en-IN")} new orders</button>}
      </importFetcher.Form>
      {importFetcher.data?.importPreview && (importFetcher.data.importPreview.fileName+":"+importFetcher.data.importPreview.fileSize)===csvFileKey && <div role="status" style={{marginTop:12,padding:12,background:"#f2f4f7",borderRadius:8}}>
        <strong>Import preview</strong>
        <p style={{margin:"6px 0"}}>{importFetcher.data.importPreview.orders.toLocaleString("en-IN")} unique orders · {importFetcher.data.importPreview.lineItems.toLocaleString("en-IN")} line items · {importFetcher.data.importPreview.sourceRows.toLocaleString("en-IN")} CSV rows</p>
        <p style={{margin:"6px 0"}}>{importFetcher.data.importPreview.duplicates.toLocaleString("en-IN")} already in Bowchika Connect · {importFetcher.data.importPreview.newOrders.toLocaleString("en-IN")} new orders</p>
        <p style={{margin:"6px 0"}}>{importFetcher.data.importPreview.matchedNewOrders.toLocaleString("en-IN")} new orders matched to a Shopify customer · {importFetcher.data.importPreview.unmatchedNewOrders.toLocaleString("en-IN")} will be stored without a customer link for later reconciliation</p>
      </div>}
      {importFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{importFetcher.data.error}</p>}
      {importFetcher.data?.success && <p role="status">{importFetcher.data.success}</p>}
      {importFetcher.data?.importStats && <p style={{fontSize:13,color:"#667085"}}>Imported line items: {importFetcher.data.importStats.importedLineItems.toLocaleString("en-IN")} · Existing orders linked: {importFetcher.data.importStats.linkedExistingOrders.toLocaleString("en-IN")} · Unmatched new orders: {importFetcher.data.importStats.unmatchedOrders.toLocaleString("en-IN")}</p>}
    </div>

    {(syncFetcher.data?.message || data.syncJob) && <p role="status">{syncFetcher.data?.message || ("Last sync: " + data.syncJob?.status + " · " + (data.syncJob?.customersProcessed ?? 0).toLocaleString("en-IN") + " customers · " + (data.syncJob?.ordersProcessed ?? 0).toLocaleString("en-IN") + " orders")}</p>}
    {syncFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{syncFetcher.data.error}</p>}
    {data.syncJob?.lastError && !syncFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{data.syncJob.lastError}</p>}{typeof fetcher.data?.success === "string" && <p role="status">{fetcher.data.success}</p>}{fetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{fetcher.data.error}</p>}
    <form method="get" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:16,padding:14,border:"1px solid #d0d5dd",borderRadius:8,background:"white"}}>
      <label style={{gridColumn:"1 / -1"}}>Search customers<input name="q" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name, email, phone or order number" style={{...inputStyle,marginTop:6}}/></label>
      <label>Minimum orders<input name="minOrders" type="number" min="0" value={minOrders} onChange={e=>setMinOrders(e.target.value)} placeholder="e.g. 2" style={{...inputStyle,marginTop:6}}/></label>
      <label>Maximum orders<input name="maxOrders" type="number" min="0" value={maxOrders} onChange={e=>setMaxOrders(e.target.value)} placeholder="Any" style={{...inputStyle,marginTop:6}}/></label>
      <label>Minimum lifetime spend<input name="minSpend" type="number" min="0" value={minSpend} onChange={e=>setMinSpend(e.target.value)} placeholder="Amount in INR" style={{...inputStyle,marginTop:6}}/></label>
      <label>Last order<select name="lastOrderDays" value={lastOrderDays} onChange={e=>setLastOrderDays(e.target.value)} style={{...inputStyle,marginTop:6}}>
        <option value="">Any time</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option><option value="180">Last 180 days</option><option value="365">Last 365 days</option>
      </select></label>
      <label>Purchased product<input name="productQuery" value={productQuery} onChange={e=>setProductQuery(e.target.value)} placeholder="Product title or Shopify product ID" style={{...inputStyle,marginTop:6}}/></label>
      <label>Purchased collection<input name="collectionQuery" value={collectionQuery} onChange={e=>setCollectionQuery(e.target.value)} placeholder="e.g. Valorant Armory" style={{...inputStyle,marginTop:6}}/></label>
      <label style={{display:"flex",gap:8,alignItems:"center"}}><input type="checkbox" checked={orderedOnly} onChange={e=>setOrderedOnly(e.target.checked)}/> Customers who have ordered</label>
      <input type="hidden" name="ordered" value={String(orderedOnly)}/>
      <div style={{display:"flex",gap:8,alignItems:"end"}}><button type="submit" style={{...style,background:"#155eef",color:"white"}}>Apply filters</button><a href="/app/campaigns" style={{...style,textDecoration:"none"}}>Clear filters</a></div>
      <div style={{gridColumn:"1 / -1",fontSize:12,color:"#667085"}}>Product and collection filters use synced Shopify line-item IDs, titles and collections. Orders available through Shopify's standard access or the historic CSV data are included where their line-item details support the selected filter.</div>
    </form>
    <fetcher.Form method="post" onSubmit={e=>{if(!window.confirm("Save a campaign for the selected audience? Only recipients with verified WhatsApp opt-in are eligible.")){e.preventDefault();return;}}}>
      <input type="hidden" name="intent" value="create-campaign"/><input type="hidden" name="selectAllMatching" value={String(selectAllMatching)}/><input type="hidden" name="audienceSearch" value={query}/><input type="hidden" name="orderedOnly" value={String(orderedOnly)}/>
      <input type="hidden" name="minOrders" value={minOrders}/><input type="hidden" name="maxOrders" value={maxOrders}/><input type="hidden" name="minSpend" value={minSpend}/><input type="hidden" name="lastOrderDays" value={lastOrderDays}/><input type="hidden" name="productQuery" value={productQuery}/><input type="hidden" name="collectionQuery" value={collectionQuery}/>
      {selected.map(id=><input key={id} type="hidden" name="customerId" value={id}/>)}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:10}}><button type="button" style={style} onClick={()=>{setSelected(data.customers.map(c=>c.id));setSelectAllMatching(true)}}>Select all matching ({data.customerCount} customers)</button><span style={{fontSize:13,color:"#667085"}}>{data.eligibleCount} Shopify WhatsApp subscribers</span><button type="button" style={style} onClick={()=>{setSelected([]);setSelectAllMatching(false)}}>Clear selection</button><strong>{selected.length} selected</strong></div>
      {data.nextCursor && <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}><a href={`?${nextPageParams.toString()}`} style={{...style,textDecoration:"none"}}>Next 50 customers →</a></div>}
      <div style={{overflowX:"auto",border:"1px solid #d0d5dd",borderRadius:8,marginBottom:20}}><table style={{borderCollapse:"collapse",width:"100%",minWidth:900}}><thead><tr>{["Select","Customer","Email","Phone","Orders","Latest order","WhatsApp consent"].map(x=><th key={x} style={{padding:10,textAlign:"left",background:"#f2f4f7"}}>{x}</th>)}</tr></thead><tbody>{data.customers.map(c=><tr key={c.id} style={{borderTop:"1px solid #eaecf0"}}><td style={{padding:10}}><input type="checkbox" checked={selected.includes(c.id)} onChange={e=>{setSelectAllMatching(false);setSelected(old=>e.target.checked?[...new Set([...old,c.id])]:old.filter(id=>id!==c.id))}}/></td><td style={{padding:10}}>{[c.firstName,c.lastName].filter(Boolean).join(" ")||"Unnamed"}</td><td style={{padding:10}}>{c.email||"—"}</td><td style={{padding:10}}>{c.phone||"—"}</td><td style={{padding:10}}>{c.numberOfOrders}</td><td style={{padding:10}}>{c.latestOrder?.orderName||"—"}</td><td style={{padding:10}}><strong>{c.whatsappOptOutAt ? "Suppressed" : c.whatsappConsentState}</strong><div style={{fontSize:12,color:"#667085"}}>{c.whatsappConsentUpdatedAt ? new Date(c.whatsappConsentUpdatedAt).toLocaleDateString("en-IN") : "No Shopify consent record"}</div></td></tr>)}</tbody></table></div>
      <h2>Create campaign</h2><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12}}>
      <label>Campaign name<input name="name" value={name} onChange={e=>setName(e.target.value)} style={{...style,width:"100%",marginTop:6}}/></label>
      <label>Approved template<select name="templateId" value={chosenTemplate} onChange={e=>{setChosenTemplate(e.target.value);setVariableMapping({});setCustomMapping({});}} style={{...style,width:"100%",marginTop:6}}>{data.templates.map(t=><option key={t.id} value={t.id}>{t.name} · {t.language}</option>)}</select></label>
      <label>Schedule (blank = queue now)<input type="datetime-local" name="scheduledAt" value={scheduledAt} onChange={e=>setScheduledAt(e.target.value)} style={{...style,width:"100%",marginTop:6}}/></label>
      {requirements?.header?.format==="IMAGE"&&<div style={{display:"grid",gap:8}}>
        <label>Image header<input name="mediaUrl" value={mediaUrl} onChange={e=>setMediaUrl(e.target.value)} placeholder="Paste a public HTTPS image URL" style={{...inputStyle,marginTop:6}}/></label>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}><button type="button" style={style} onClick={pickShopifyImage} disabled={imagePickerBusy || imageFetcher.state!=="idle"}>{imagePickerBusy || imageFetcher.state!=="idle" ? "Opening Shopify Files…" : "Choose from Shopify Files"}</button><small style={{color:"#667085"}}>Uses your store's native Files picker</small></div>
        {imagePickerError && <p role="alert" style={{color:"#b42318",margin:0}}>{imagePickerError}</p>}
      </div>}
      </div>
      {requirements?.unsupported&&<p style={{color:"#b42318"}}>Current sender does not support this template: {requirements.unsupported}</p>}
      {requirements&&<div style={{marginTop:16,padding:14,border:"1px solid #d0d5dd",borderRadius:8}}>
        <h3>Choose what each variable means</h3>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:12}}>
          <div>{[...(requirements.header?.format==="TEXT"?requirements.header.variables:[]).map(v=>({section:"header",key:v.key,label:"Header "+v.label})),...requirements.bodyVariables.map(v=>({section:"body",key:v.key,label:"Body "+v.label})),...requirements.buttons.flatMap(b=>b.variables.map(v=>({section:"button"+b.index,key:v.key,label:b.label+" "+v.label})))].map(v=><div key={v.section+v.key} style={{display:"grid",gridTemplateColumns:"110px 1fr",gap:8,alignItems:"center",margin:"8px 0"}}>
            <span>{v.label}</span><div style={{display:"grid",gap:5}}>
              <select name={"map_"+v.section+"."+v.key} value={variableMapping[v.section+"."+v.key] || "name"} onChange={e=>setVariableMapping(old=>({...old,[v.section+"."+v.key]:e.target.value}))} style={inputStyle}>
                <option value="name">Customer full name</option>{fields.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <input name={"custom_"+v.section+"."+v.key} value={customMapping[v.section+"."+v.key] || ""} onChange={e=>setCustomMapping(old=>({...old,[v.section+"."+v.key]:e.target.value}))} placeholder="Custom text if selected" style={inputStyle}/>
            </div></div>)}</div>
          <aside style={{border:"1px solid #d0d5dd",borderRadius:12,background:"#f2f4f7",padding:12,alignSelf:"start",position:"sticky",top:16}}>
            <strong>WhatsApp message preview</strong>
            <div style={{marginTop:12,background:"white",borderRadius:12,padding:12,boxShadow:"0 1px 3px #00000012",minHeight:150}}>
              {requirements.header?.format==="IMAGE" && (mediaUrl ? <img src={mediaUrl} alt={imageAlt || "WhatsApp template header"} style={{width:"100%",borderRadius:8,marginBottom:8,maxHeight:180,objectFit:"cover"}}/> : <div style={{background:"#e5e7eb",padding:28,borderRadius:8,textAlign:"center",color:"#667085",marginBottom:8}}>Image header preview</div>)}
              {previewHeader && <strong style={{display:"block",marginBottom:8}}>{previewHeader}</strong>}
              <p style={{whiteSpace:"pre-wrap",margin:"0 0 8px"}}>{previewBody || "Your approved template body will appear here."}</p>
              {requirements.footerText && <small style={{color:"#667085"}}>{requirements.footerText}</small>}
              {requirements.previewButtons.length>0 && <div style={{borderTop:"1px solid #eaecf0",marginTop:10,paddingTop:8,display:"grid",gap:6}}>{requirements.previewButtons.map((button,i)=><div key={i} style={{color:"#1677c8",textAlign:"center",fontWeight:600,fontSize:13}}>{button.label}</div>)}</div>}
            </div>
            <p style={{fontSize:12,color:"#667085",marginBottom:0}}>Preview uses sample customer data. Actual recipients receive their own mapped Shopify fields.</p>
          </aside>
        </div>
      </div>}
      <button style={{...style,marginTop:16,background:"#155eef",color:"white"}} disabled={(!selectAllMatching&&!selected.length)||!template||Boolean(requirements?.unsupported)||fetcher.state!=="idle"}>Save / schedule campaign</button>
    </fetcher.Form>
    <h2 style={{marginTop:32}}>Campaign delivery log</h2><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["Campaign","Status","Audience","Schedule","Recipient states"].map(x=><th key={x} style={{padding:10,textAlign:"left",background:"#f2f4f7"}}>{x}</th>)}</tr></thead><tbody>{data.campaigns.map(c=><tr key={c.id} style={{borderTop:"1px solid #eaecf0"}}><td style={{padding:10}}>{c.name}<div style={{fontSize:12,color:"#667085"}}>{c.templateName}</div></td><td style={{padding:10}}>{c.status}</td><td style={{padding:10}}>{c.audienceCount}</td><td style={{padding:10}}>{c.scheduledAt?new Date(c.scheduledAt).toLocaleString():"Immediate"}</td><td style={{padding:10}}>{Object.entries(c.counts).map(([k,v])=>k+": "+v).join(" · ")}<div style={{marginTop:6}}><button type="button" style={style} onClick={()=>reuseCampaign(c)}>Duplicate & reuse</button></div></td></tr>)}</tbody></table></div>
    <p style={{fontSize:12,color:"#667085",marginTop:20}}>Campaigns are persisted, but delivery is not enabled until the background worker is deployed and verified.</p>
  </div></s-page>;
}

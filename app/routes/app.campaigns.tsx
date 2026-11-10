import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { normalizeE164Phone, getWhatsAppTemplateRequirements } from "../whatsapp-shared";

const json = (body: object, status = 200) => Response.json(body, { status });
const field = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

type CampaignActionData = {
  success?: boolean | string;
  message?: string;
  error?: string;
  campaignId?: string;
  syncJobId?: string;
  syncPhase?: string;
  customersProcessed?: number;
  ordersProcessed?: number;
  ordersSkipped?: number;
  hasMore?: boolean;
  continuation?: string;
};
type ShopifyCustomerNode = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  tags: string[];
  numberOfOrders: number;
  defaultEmailAddress?: { emailAddress: string | null } | null;
  defaultPhoneNumber?: { phoneNumber: string | null } | null;
  amountSpent?: { amount: string; currencyCode: string } | null;
};
type ShopifyOrderNode = {
  id: string;
  name: string;
  number: number | null;
  createdAt: string | null;
  processedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer?: { id: string } | null;
  totalPriceSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
  lineItems?: { nodes?: Array<{ name: string; quantity: number; sku: string | null; variantTitle: string | null }> | null } | null;
};
const customerQuery = `#graphql
query BowchikaCustomerMirror($after: String) {
  customers(first: 100, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id firstName lastName createdAt updatedAt tags numberOfOrders defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } amountSpent { amount currencyCode } }
  }
}`;
const orderQuery = `#graphql
query BowchikaOrderMirror($after: String) {
  orders(first: 100, after: $after, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes { id name number createdAt processedAt displayFinancialStatus displayFulfillmentStatus customer { id } totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 100) { nodes { name quantity sku variantTitle } } }
  }
}`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const orderedOnly = url.searchParams.get("ordered") !== "false";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const customerWhere = { shop: session.shop, ...(orderedOnly ? { numberOfOrders: { gt: 0 } } : {}), ...(search ? { OR: [{firstName:{contains:search}},{lastName:{contains:search}},{email:{contains:search}},{phone:{contains:search}},{orders:{some:{orderName:{contains:search}}}}] } : {}) };
  const [templates, customers, customerCount, orderCount, campaigns, syncJob] = await Promise.all([
    prisma.approvedWhatsAppTemplate.findMany({ where: { shop: session.shop }, orderBy: [{name:"asc"},{language:"asc"}] }),
    prisma.shopifyCustomerMirror.findMany({
      where: customerWhere,
      orderBy: [{ updatedAtShopify: "desc" }, { lastName: "asc" }, { id: "asc" }],
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { orders: { orderBy: [{processedAt:"desc"},{createdAtShopify:"desc"}], take: 1 } },
    }),
    prisma.shopifyCustomerMirror.count({ where: customerWhere }),
    prisma.shopifyOrderMirror.count({ where: { shop: session.shop } }),
    prisma.whatsAppCampaign.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" }, take: 50, include: { recipients: { select: { status: true } } } }),
    prisma.shopifySyncJob.findUnique({ where: { id: session.shop } }),
  ]);
  return {
    search, orderedOnly, nextCursor: customers.length === 50 ? customers[customers.length - 1]?.id ?? null : null, customerCount, templates: templates.map(t => ({id:t.id,name:t.name,language:t.language,category:t.category,components:t.components})),
    customers: customers.map(c => ({...c,tags:JSON.parse(c.tagsJson || "[]") as string[],latestOrder:c.orders[0]??null})),
    orderCount,
    campaigns: campaigns.map(c => ({id:c.id,name:c.name,status:c.status,audienceCount:c.audienceCount,scheduledAt:c.scheduledAt,templateName:c.templateName,counts:c.recipients.reduce((acc,r)=>({...acc,[r.status]:(acc[r.status]??0)+1}),{} as Record<string,number>)})),
    syncJob,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const data = await request.formData();
  const intent = field(data, "intent");
  if (intent === "sync" || intent === "sync-next") {
    const shop = session.shop;
    let job = await prisma.shopifySyncJob.findUnique({ where: { id: shop } });

    if (intent === "sync") {
      if (!job || job.status === "COMPLETED") {
        job = await prisma.shopifySyncJob.upsert({
          where: { id: shop },
          create: {
            id: shop,
            shop,
            status: "RUNNING",
            phase: "CUSTOMERS",
          },
          update: {
            status: "RUNNING",
            phase: "CUSTOMERS",
            customerCursor: null,
            orderCursor: null,
            customersProcessed: 0,
            ordersProcessed: 0,
            ordersSkipped: 0,
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
      if (job.phase === "CUSTOMERS") {
        const response = await admin.graphql(customerQuery, {
          variables: { after: job.customerCursor ?? null },
          signal: AbortSignal.timeout(20_000),
        });
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
        const now = new Date();
        const writes = customers.map((customer) => {
          const fields = {
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.defaultEmailAddress?.emailAddress ?? null,
            phone: customer.defaultPhoneNumber?.phoneNumber ?? null,
            numberOfOrders: Number(customer.numberOfOrders ?? 0),
            amountSpent: Number(customer.amountSpent?.amount ?? 0),
            currencyCode: customer.amountSpent?.currencyCode ?? "INR",
            tagsJson: JSON.stringify(customer.tags ?? []),
            createdAtShopify: customer.createdAt ? new Date(customer.createdAt) : null,
            updatedAtShopify: customer.updatedAt ? new Date(customer.updatedAt) : null,
            syncedAt: now,
          };
          return prisma.shopifyCustomerMirror.upsert({
            where: { id: customer.id },
            create: { id: customer.id, shop, ...fields },
            update: fields,
          });
        });
        if (writes.length) await prisma.$transaction(writes);

        const hasNextPage = pageInfo.hasNextPage;
        const nextCursor = hasNextPage ? pageInfo.endCursor : null;
        if (hasNextPage && (!nextCursor || nextCursor === job.customerCursor)) {
          throw new Error("Shopify customer pagination returned a missing or repeated cursor. Resume after checking the Shopify response.");
        }
        const nextPhase = hasNextPage ? "CUSTOMERS" : "ORDERS";
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

      if (job.phase === "ORDERS") {
        const response = await admin.graphql(orderQuery, {
          variables: { after: job.orderCursor ?? null },
          signal: AbortSignal.timeout(20_000),
        });
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
        const customerIds = [...new Set(orders.flatMap((order) => order.customer?.id ? [order.customer.id] : []))];
        const customers = customerIds.length
          ? await prisma.shopifyCustomerMirror.findMany({
              where: { shop, id: { in: customerIds } },
              select: { id: true },
            })
          : [];
        const knownCustomerIds = new Set(customers.map((customer) => customer.id));
        let skipped = 0;
        const now = new Date();
        const writes = orders.flatMap((order) => {
          const customerId = order.customer?.id;
          if (!customerId || !knownCustomerIds.has(customerId)) {
            skipped++;
            return [];
          }
          const fields = {
            shop,
            customerId,
            orderName: order.name,
            orderNumber: order.number ?? null,
            createdAtShopify: order.createdAt ? new Date(order.createdAt) : null,
            processedAt: order.processedAt ? new Date(order.processedAt) : null,
            financialStatus: order.displayFinancialStatus ?? null,
            fulfillmentStatus: order.displayFulfillmentStatus ?? null,
            totalPrice: Number(order.totalPriceSet?.shopMoney?.amount ?? 0),
            currencyCode: order.totalPriceSet?.shopMoney?.currencyCode ?? "INR",
            lineItemsJson: JSON.stringify(order.lineItems?.nodes ?? []),
            syncedAt: now,
          };
          return [prisma.shopifyOrderMirror.upsert({
            where: { id: order.id },
            create: { id: order.id, ...fields },
            update: fields,
          })];
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
            phase: "ORDERS",
            orderCursor: nextCursor,
            ordersProcessed: { increment: writes.length },
            ordersSkipped: { increment: skipped },
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
            : "Sync complete: " + latest.customersProcessed.toLocaleString("en-IN") + " customers, " + latest.ordersProcessed.toLocaleString("en-IN") + " orders imported, " + latest.ordersSkipped.toLocaleString("en-IN") + " orders skipped because they had no matching local customer.",
          syncJobId: shop,
          syncPhase: latest.phase,
          customersProcessed: latest.customersProcessed,
          ordersProcessed: latest.ordersProcessed,
          ordersSkipped: latest.ordersSkipped,
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
      }, 500);
    }
  }
  if (intent === "consent") {
    const customerId = field(data,"customerId");
    const optedIn = field(data,"optedIn") === "true";
    const updated = await prisma.shopifyCustomerMirror.updateMany({ where:{id:customerId,shop:session.shop}, data:{whatsappOptIn:optedIn} });
    return json(updated.count ? {success: optedIn ? "WhatsApp opt-in recorded. Only mark this after verifying the customer's consent." : "WhatsApp opt-in removed."} : {error:"Customer not found."}, updated.count ? 200 : 404);
  }
  if (intent === "create-campaign") {
    const name = field(data,"name").slice(0,120) || "Bowchika campaign";
    const templateId = field(data,"templateId");
    const scheduledAtRaw = field(data,"scheduledAt");
    const mediaUrlRaw = field(data,"mediaUrl");
    const selectedIds = [...new Set(data.getAll("customerId").map(String).filter(Boolean))].slice(0,10000);
    const selectAllMatching = field(data, "selectAllMatching") === "true";
    const search = field(data, "audienceSearch").slice(0,120);
    const orderedOnly = field(data, "orderedOnly") !== "false";
    const where = { shop: session.shop, ...(orderedOnly ? { numberOfOrders: { gt: 0 } } : {}), ...(search ? { OR: [{firstName:{contains:search}},{lastName:{contains:search}},{email:{contains:search}},{phone:{contains:search}},{orders:{some:{orderName:{contains:search}}}}] } : {}) };
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
    for (const [key,value] of data.entries()) { if (key.startsWith("map_")) mapping[key.slice(4)] = String(value).slice(0,100); else if (key.startsWith("custom_")) mapping["custom."+key.slice(7)] = String(value).slice(0,1024); }
    const audienceWhere = selectAllMatching
      ? { ...where, whatsappOptIn: true }
      : { shop: session.shop, id: { in: selectedIds }, whatsappOptIn: true };
    const campaign = await prisma.whatsAppCampaign.create({data:{
      shop:session.shop,name,templateId:template.id,templateName:template.name,
      templateLanguage:template.language,templateComponents:template.components,
      variableMappingJson:JSON.stringify(mapping),mediaUrl,scheduledAt,status:"PREPARING",audienceCount:0,
    }});
    let recipientCount = 0;
    let afterId: string | undefined;
    const seenPhones = new Set<string>();
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
          if (!phoneNumber || seenPhones.has(phoneNumber)) return [];
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
  const consentFetcher = useFetcher<CampaignActionData>();
  const [query,setQuery] = useState(data.search);
  const [selected,setSelected] = useState<string[]>([]);
  const [selectAllMatching,setSelectAllMatching] = useState(false);
  const [orderedOnly,setOrderedOnly] = useState(data.orderedOnly);
  const [chosenTemplate,setChosenTemplate] = useState(data.templates[0]?.id ?? "");
  const [name,setName] = useState("Bowchika customer campaign");
  const [scheduledAt,setScheduledAt] = useState("");
  const [mediaUrl,setMediaUrl] = useState("");
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
  return <s-page heading="Customer & Campaign Center"><div style={{maxWidth:1400,margin:"0 auto",padding:20,color:"var(--bc-text, #222)"}}>
    <h1>Shopify customers → WhatsApp campaigns</h1>
    <p>Synced customer and order records, full-store search, bulk selection, approved template mapping and scheduled campaign drafts.</p>
    <syncFetcher.Form method="post" onSubmit={() => { autoSyncContinuation.current = null; }} style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:16}}>
      <input type="hidden" name="intent" value="sync"/>
      <button style={style} disabled={syncFetcher.state!=="idle"}>
        {data.syncJob?.status === "RUNNING" ? "Resume customer & order sync" : "Sync all Shopify customers & orders"}
      </button>
      <span>{data.customerCount.toLocaleString("en-IN")} local customers · {data.orderCount.toLocaleString("en-IN")} local orders</span>
    </syncFetcher.Form>
    <p style={{fontSize:13,color:"#667085",marginTop:0}}>Sync runs in resumable 100-record Shopify pages. Keep this page open while it processes; after interruption, press Resume. Shopify exposes only the default recent 60-day order window unless the app receives read_all_orders approval.</p>
    {(syncFetcher.data?.message || data.syncJob) && <p role="status">{syncFetcher.data?.message || ("Last sync: " + data.syncJob?.status + " · " + (data.syncJob?.customersProcessed ?? 0).toLocaleString("en-IN") + " customers · " + (data.syncJob?.ordersProcessed ?? 0).toLocaleString("en-IN") + " orders")}</p>}
    {syncFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{syncFetcher.data.error}</p>}
    {data.syncJob?.lastError && !syncFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{data.syncJob.lastError}</p>}{typeof fetcher.data?.success === "string" && <p role="status">{fetcher.data.success}</p>}{fetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{fetcher.data.error}</p>}{typeof consentFetcher.data?.success === "string" && <p role="status">{consentFetcher.data.success}</p>}{consentFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{consentFetcher.data.error}</p>}
    <form method="get" style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}><input name="q" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search name, email, phone, order ID" style={{...style,flex:1,minWidth:220}}/><label style={{display:"flex",gap:6,alignItems:"center"}}><input type="checkbox" checked={orderedOnly} onChange={e=>setOrderedOnly(e.target.checked)}/> Customers who have ordered</label><input type="hidden" name="ordered" value={String(orderedOnly)}/><button style={style}>Search</button></form>
    <fetcher.Form method="post" onSubmit={e=>{if(!window.confirm("Save a campaign for the selected audience? Only recipients with verified WhatsApp opt-in are eligible.")){e.preventDefault();return;}}}>
      <input type="hidden" name="intent" value="create-campaign"/><input type="hidden" name="selectAllMatching" value={String(selectAllMatching)}/><input type="hidden" name="audienceSearch" value={query}/><input type="hidden" name="orderedOnly" value={String(orderedOnly)}/>{selected.map(id=><input key={id} type="hidden" name="customerId" value={id}/>)}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:10}}><button type="button" style={style} onClick={()=>{setSelected(data.customers.map(c=>c.id));setSelectAllMatching(true)}}>Select all matching ({data.customerCount})</button><button type="button" style={style} onClick={()=>{setSelected([]);setSelectAllMatching(false)}}>Clear selection</button><strong>{selected.length} selected</strong></div>
      {data.nextCursor && <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}><a href={`?q=${encodeURIComponent(data.search)}&ordered=${String(data.orderedOnly)}&cursor=${encodeURIComponent(data.nextCursor)}`} style={{...style,textDecoration:"none"}}>Next 50 customers →</a></div>}
      <div style={{overflowX:"auto",border:"1px solid #d0d5dd",borderRadius:8,marginBottom:20}}><table style={{borderCollapse:"collapse",width:"100%",minWidth:900}}><thead><tr>{["Select","Customer","Email","Phone","Orders","Latest order","WhatsApp consent"].map(x=><th key={x} style={{padding:10,textAlign:"left",background:"#f2f4f7"}}>{x}</th>)}</tr></thead><tbody>{data.customers.map(c=><tr key={c.id} style={{borderTop:"1px solid #eaecf0"}}><td style={{padding:10}}><input type="checkbox" checked={selected.includes(c.id)} onChange={e=>{setSelectAllMatching(false);setSelected(old=>e.target.checked?[...new Set([...old,c.id])]:old.filter(id=>id!==c.id))}}/></td><td style={{padding:10}}>{[c.firstName,c.lastName].filter(Boolean).join(" ")||"Unnamed"}</td><td style={{padding:10}}>{c.email||"—"}</td><td style={{padding:10}}>{c.phone||"—"}</td><td style={{padding:10}}>{c.numberOfOrders}</td><td style={{padding:10}}>{c.latestOrder?.orderName||"—"}</td><td style={{padding:10}}><button style={style} type="button" onClick={()=>{const consentData=new FormData();consentData.set("intent","consent");consentData.set("customerId",c.id);consentData.set("optedIn",String(!c.whatsappOptIn));consentFetcher.submit(consentData,{method:"post"});}}>{c.whatsappOptIn?"Opted in ✓":"Record verified opt-in"}</button></td></tr>)}</tbody></table></div>
      <h2>Create campaign</h2><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12}}>
      <label>Campaign name<input name="name" value={name} onChange={e=>setName(e.target.value)} style={{...style,width:"100%",marginTop:6}}/></label>
      <label>Approved template<select name="templateId" value={chosenTemplate} onChange={e=>setChosenTemplate(e.target.value)} style={{...style,width:"100%",marginTop:6}}>{data.templates.map(t=><option key={t.id} value={t.id}>{t.name} · {t.language}</option>)}</select></label>
      <label>Schedule (blank = queue now)<input type="datetime-local" name="scheduledAt" value={scheduledAt} onChange={e=>setScheduledAt(e.target.value)} style={{...style,width:"100%",marginTop:6}}/></label>
      {requirements?.header?.format==="IMAGE"&&<label>Header image HTTPS URL<input name="mediaUrl" value={mediaUrl} onChange={e=>setMediaUrl(e.target.value)} placeholder="https://..." style={{...style,width:"100%",marginTop:6}}/></label>}
      </div>
      {requirements?.unsupported&&<p style={{color:"#b42318"}}>Current sender does not support this template: {requirements.unsupported}</p>}
      {requirements&&<div style={{marginTop:16,padding:14,border:"1px solid #d0d5dd",borderRadius:8}}><h3>Choose what each variable means</h3>{[...(requirements.header?.format==="TEXT"?requirements.header.variables:[]).map(v=>({section:"header",key:v.key,label:"Header "+v.label})),...requirements.bodyVariables.map(v=>({section:"body",key:v.key,label:"Body "+v.label})),...requirements.buttons.flatMap(b=>b.variables.map(v=>({section:"button"+b.index,key:v.key,label:b.label+" "+v.label})))].map(v=><div key={v.section+v.key} style={{display:"grid",gridTemplateColumns:"180px 1fr 1fr",gap:8,alignItems:"center",margin:"8px 0"}}><span>{v.label}</span><select name={"map_"+v.section+"."+v.key} style={style}><option value="name">Customer full name</option>{fields.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}</select><input name={"custom_"+v.section+"."+v.key} placeholder="Custom text (if selected)" style={style}/></div>)}<p style={{color:"#667085",fontSize:13}}>Variable mapping is saved with the campaign. Shopify media picker and actual per-recipient preview are follow-up integration work.</p></div>}
      <button style={{...style,marginTop:16,background:"#155eef",color:"white"}} disabled={(!selectAllMatching&&!selected.length)||!template||Boolean(requirements?.unsupported)||fetcher.state!=="idle"}>Save / schedule campaign</button>
    </fetcher.Form>
    <h2 style={{marginTop:32}}>Campaign delivery log</h2><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["Campaign","Status","Audience","Schedule","Recipient states"].map(x=><th key={x} style={{padding:10,textAlign:"left",background:"#f2f4f7"}}>{x}</th>)}</tr></thead><tbody>{data.campaigns.map(c=><tr key={c.id} style={{borderTop:"1px solid #eaecf0"}}><td style={{padding:10}}>{c.name}<div style={{fontSize:12,color:"#667085"}}>{c.templateName}</div></td><td style={{padding:10}}>{c.status}</td><td style={{padding:10}}>{c.audienceCount}</td><td style={{padding:10}}>{c.scheduledAt?new Date(c.scheduledAt).toLocaleString():"Immediate"}</td><td style={{padding:10}}>{Object.entries(c.counts).map(([k,v])=>k+": "+v).join(" · ")}</td></tr>)}</tbody></table></div>
    <p style={{fontSize:12,color:"#667085",marginTop:20}}>Campaigns are persisted, but delivery is not enabled until the background worker is deployed and verified.</p>
  </div></s-page>;
}

import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { normalizeE164Phone, getWhatsAppTemplateRequirements } from "../whatsapp-shared";

const json = (body: object, status = 200) => Response.json(body, { status });
const field = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

type CampaignActionData = { success?: boolean | string; message?: string; error?: string; campaignId?: string };
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
  const [templates, customers, customerCount, orderCount, campaigns] = await Promise.all([
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
  ]);
  return {
    search, orderedOnly, nextCursor: customers.length === 50 ? customers[customers.length - 1]?.id ?? null : null, customerCount, templates: templates.map(t => ({id:t.id,name:t.name,language:t.language,category:t.category,components:t.components})),
    customers: customers.map(c => ({...c,tags:JSON.parse(c.tagsJson || "[]") as string[],latestOrder:c.orders[0]??null})),
    orderCount,
    campaigns: campaigns.map(c => ({id:c.id,name:c.name,status:c.status,audienceCount:c.audienceCount,scheduledAt:c.scheduledAt,templateName:c.templateName,counts:c.recipients.reduce((acc,r)=>({...acc,[r.status]:(acc[r.status]??0)+1}),{} as Record<string,number>)})),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const data = await request.formData();
  const intent = field(data, "intent");
  if (intent === "sync") {
    let customerAfter: string | undefined;
    let customerCount = 0;
    let orderAfter: string | undefined;
    let orderCount = 0;
    const seenCustomerCursors = new Set<string>();
    const seenOrderCursors = new Set<string>();
    try {
      do {
        const response = await admin.graphql(customerQuery, { variables: { after: customerAfter ?? null }, signal: AbortSignal.timeout(20000) });
        const result = await response.json() as { errors?: unknown[]; data?: { customers?: { nodes?: Array<{ id:string; firstName:string|null; lastName:string|null; createdAt:string|null; updatedAt:string|null; tags:string[]; numberOfOrders:number; defaultEmailAddress?:{emailAddress:string|null}|null; defaultPhoneNumber?:{phoneNumber:string|null}|null; amountSpent?:{amount:string;currencyCode:string}|null }>; pageInfo?:{hasNextPage:boolean;endCursor:string|null} }; orders?: { nodes?: Array<{ id:string; name:string; number:number|null; createdAt:string|null; processedAt:string|null; displayFinancialStatus:string|null; displayFulfillmentStatus:string|null; customer?:{id:string}|null; totalPriceSet?:{shopMoney?:{amount:string;currencyCode:string}|null}|null; lineItems?:{nodes?:Array<{name:string;quantity:number;sku:string|null;variantTitle:string|null}>}|null }>; pageInfo?:{hasNextPage:boolean;endCursor:string|null} } } };
        if (result.errors?.length) throw new Error("Shopify customer sync query failed.");
        const connection = result.data?.customers;
        for (const c of connection?.nodes ?? []) {
          await prisma.shopifyCustomerMirror.upsert({
            where: { id: c.id },
            create: { id:c.id, shop:session.shop, firstName:c.firstName, lastName:c.lastName, email:c.defaultEmailAddress?.emailAddress ?? null, phone:c.defaultPhoneNumber?.phoneNumber ?? null, numberOfOrders:Number(c.numberOfOrders ?? 0), amountSpent:Number(c.amountSpent?.amount ?? 0), currencyCode:c.amountSpent?.currencyCode ?? "INR", tagsJson:JSON.stringify(c.tags ?? []), createdAtShopify:c.createdAt ? new Date(c.createdAt) : null, updatedAtShopify:c.updatedAt ? new Date(c.updatedAt) : null },
            update: { firstName:c.firstName, lastName:c.lastName, email:c.defaultEmailAddress?.emailAddress ?? null, phone:c.defaultPhoneNumber?.phoneNumber ?? null, numberOfOrders:Number(c.numberOfOrders ?? 0), amountSpent:Number(c.amountSpent?.amount ?? 0), currencyCode:c.amountSpent?.currencyCode ?? "INR", tagsJson:JSON.stringify(c.tags ?? []), createdAtShopify:c.createdAt ? new Date(c.createdAt) : null, updatedAtShopify:c.updatedAt ? new Date(c.updatedAt) : null, syncedAt:new Date() },
          });
          customerCount++;
        }
        const nextCursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
        if (connection?.pageInfo?.hasNextPage && (!nextCursor || seenCustomerCursors.has(nextCursor))) {
          throw new Error("Shopify customer pagination returned a missing or repeated cursor.");
        }
        if (nextCursor) seenCustomerCursors.add(nextCursor);
        customerAfter = nextCursor ?? undefined;
      } while (customerAfter);
      do {
        const response = await admin.graphql(orderQuery, { variables: { after: orderAfter ?? null }, signal: AbortSignal.timeout(20000) });
        const result = await response.json() as { errors?: unknown[]; data?: { customers?: { nodes?: Array<{ id:string; firstName:string|null; lastName:string|null; createdAt:string|null; updatedAt:string|null; tags:string[]; numberOfOrders:number; defaultEmailAddress?:{emailAddress:string|null}|null; defaultPhoneNumber?:{phoneNumber:string|null}|null; amountSpent?:{amount:string;currencyCode:string}|null }>; pageInfo?:{hasNextPage:boolean;endCursor:string|null} }; orders?: { nodes?: Array<{ id:string; name:string; number:number|null; createdAt:string|null; processedAt:string|null; displayFinancialStatus:string|null; displayFulfillmentStatus:string|null; customer?:{id:string}|null; totalPriceSet?:{shopMoney?:{amount:string;currencyCode:string}|null}|null; lineItems?:{nodes?:Array<{name:string;quantity:number;sku:string|null;variantTitle:string|null}>}|null }>; pageInfo?:{hasNextPage:boolean;endCursor:string|null} } } };
        if (result.errors?.length) throw new Error("Shopify order sync query failed.");
        const connection = result.data?.orders;
        for (const o of connection?.nodes ?? []) {
          if (!o.customer?.id) continue;
          const exists = await prisma.shopifyCustomerMirror.findFirst({ where: { id:o.customer.id, shop:session.shop }, select:{id:true} });
          if (!exists) continue;
          await prisma.shopifyOrderMirror.upsert({
            where: { id:o.id },
            create: { id:o.id, shop:session.shop, customerId:o.customer.id, orderName:o.name, orderNumber:o.number ?? null, createdAtShopify:o.createdAt ? new Date(o.createdAt) : null, processedAt:o.processedAt ? new Date(o.processedAt) : null, financialStatus:o.displayFinancialStatus ?? null, fulfillmentStatus:o.displayFulfillmentStatus ?? null, totalPrice:Number(o.totalPriceSet?.shopMoney?.amount ?? 0), currencyCode:o.totalPriceSet?.shopMoney?.currencyCode ?? "INR", lineItemsJson:JSON.stringify(o.lineItems?.nodes ?? []) },
            update: { orderName:o.name, orderNumber:o.number ?? null, createdAtShopify:o.createdAt ? new Date(o.createdAt) : null, processedAt:o.processedAt ? new Date(o.processedAt) : null, financialStatus:o.displayFinancialStatus ?? null, fulfillmentStatus:o.displayFulfillmentStatus ?? null, totalPrice:Number(o.totalPriceSet?.shopMoney?.amount ?? 0), currencyCode:o.totalPriceSet?.shopMoney?.currencyCode ?? "INR", lineItemsJson:JSON.stringify(o.lineItems?.nodes ?? []), syncedAt:new Date() },
          });
          orderCount++;
        }
        const nextCursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
        if (connection?.pageInfo?.hasNextPage && (!nextCursor || seenOrderCursors.has(nextCursor))) {
          throw new Error("Shopify order pagination returned a missing or repeated cursor.");
        }
        if (nextCursor) seenOrderCursors.add(nextCursor);
        orderAfter = nextCursor ?? undefined;
      } while (orderAfter);
      return json({success:true, message:`Sync complete: ${customerCount} customer records and ${orderCount} order records processed.`});
    } catch {
      return json({error:"Sync stopped before completion. Retry the sync; existing local data has been preserved."}, 500);
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
    const ids = selectAllMatching ? (await prisma.shopifyCustomerMirror.findMany({ where, select: { id: true }, orderBy: { id: "asc" } })).map(c => c.id) : selectedIds;
    if (!ids.length) return json({error:"Select at least one customer."},400);
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
    const customers = await prisma.shopifyCustomerMirror.findMany({where:{shop:session.shop,id:{in:ids}},orderBy:{updatedAtShopify:"desc"},include:{orders:{orderBy:{processedAt:"desc"},take:1}}});
    const recipients = customers.filter(c=>c.whatsappOptIn && normalizeE164Phone(c.phone ?? "")).map(c=>({
      shop:session.shop, customerId:c.id, phoneNumber:normalizeE164Phone(c.phone ?? "")!, customerName:[c.firstName,c.lastName].filter(Boolean).join(" ") || null,
      snapshotJson:JSON.stringify({firstName:c.firstName??"",lastName:c.lastName??"",name:[c.firstName,c.lastName].filter(Boolean).join(" "),email:c.email??"",phone:c.phone??"",numberOfOrders:c.numberOfOrders,amountSpent:c.amountSpent,currencyCode:c.currencyCode,tags:JSON.parse(c.tagsJson||"[]"),latestOrder:c.orders[0]??null}),
      status:"QUEUED",
    }));
    if (!recipients.length) return json({error:"No selected customer has both a valid phone number and verified WhatsApp opt-in recorded in Bowchika Connect. No campaign was created."},400);
    const campaign = await prisma.whatsAppCampaign.create({data:{shop:session.shop,name,templateId:template.id,templateName:template.name,templateLanguage:template.language,templateComponents:template.components,variableMappingJson:JSON.stringify(mapping),mediaUrl,scheduledAt,status:scheduledAt?"SCHEDULED":"QUEUED",audienceCount:recipients.length,recipients:{create:recipients}}});
    return json({success:`Campaign saved for ${recipients.length} opted-in customers. ${scheduledAt ? "Scheduled for "+scheduledAt.toLocaleString("en-IN") : "Queued for sending"}. Sending worker must be active before any message is sent.`,campaignId:campaign.id});
  }
  return json({error:"Unknown action."},400);
};

export default function CampaignCenter() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<CampaignActionData>();
  const syncFetcher = useFetcher<CampaignActionData>();
  const consentFetcher = useFetcher<CampaignActionData>();
  const [query,setQuery] = useState(data.search);
  const [selected,setSelected] = useState<string[]>([]);
  const [selectAllMatching,setSelectAllMatching] = useState(false);
  const [orderedOnly,setOrderedOnly] = useState(data.orderedOnly);
  const [chosenTemplate,setChosenTemplate] = useState(data.templates[0]?.id ?? "");
  const [name,setName] = useState("Bowchika customer campaign");
  const [scheduledAt,setScheduledAt] = useState("");
  const [mediaUrl,setMediaUrl] = useState("");
  const template = data.templates.find(t=>t.id===chosenTemplate);
  const requirements = useMemo(()=>{try{return template?getWhatsAppTemplateRequirements(template.components):null}catch{return null}},[template]);
  const fields = [{label:"Customer first name",value:"firstName"},{label:"Customer full name",value:"name"},{label:"Customer email",value:"email"},{label:"Customer phone",value:"phone"},{label:"Latest order number",value:"latestOrder.orderName"},{label:"Latest order total",value:"latestOrder.totalPrice"},{label:"Product name (latest order)",value:"latestOrder.productName"},{label:"Order count",value:"numberOfOrders"},{label:"Total spend",value:"amountSpent"},{label:"Custom text",value:"custom"}];
  const style = {padding:10,border:"1px solid #d0d5dd",borderRadius:8,background:"white",color:"#222"} as const;
  return <s-page heading="Customer & Campaign Center"><div style={{maxWidth:1400,margin:"0 auto",padding:20,color:"var(--bc-text, #222)"}}>
    <h1>Shopify customers → WhatsApp campaigns</h1>
    <p>Synced customer and order records, full-store search, bulk selection, approved template mapping and scheduled campaign drafts.</p>
    <syncFetcher.Form method="post" style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:16}}><input type="hidden" name="intent" value="sync"/><button style={style} disabled={syncFetcher.state!=="idle"}>Sync all Shopify customers & orders</button><span>{data.customerCount.toLocaleString("en-IN")} matching local customers · showing {data.customers.length} on this page · {data.orderCount.toLocaleString("en-IN")} local orders</span></syncFetcher.Form>
    {syncFetcher.data?.message && <p role="status">{syncFetcher.data.message}</p>}{syncFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{syncFetcher.data.error}</p>}{typeof fetcher.data?.success === "string" && <p role="status">{fetcher.data.success}</p>}{fetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{fetcher.data.error}</p>}{typeof consentFetcher.data?.success === "string" && <p role="status">{consentFetcher.data.success}</p>}{consentFetcher.data?.error && <p role="alert" style={{color:"#b42318"}}>{consentFetcher.data.error}</p>}
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
      <button style={{...style,marginTop:16,background:"#155eef",color:"white"}} disabled={!selected.length||!template||Boolean(requirements?.unsupported)||fetcher.state!=="idle"}>Save / schedule campaign</button>
    </fetcher.Form>
    <h2 style={{marginTop:32}}>Campaign delivery log</h2><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["Campaign","Status","Audience","Schedule","Recipient states"].map(x=><th key={x} style={{padding:10,textAlign:"left",background:"#f2f4f7"}}>{x}</th>)}</tr></thead><tbody>{data.campaigns.map(c=><tr key={c.id} style={{borderTop:"1px solid #eaecf0"}}><td style={{padding:10}}>{c.name}<div style={{fontSize:12,color:"#667085"}}>{c.templateName}</div></td><td style={{padding:10}}>{c.status}</td><td style={{padding:10}}>{c.audienceCount}</td><td style={{padding:10}}>{c.scheduledAt?new Date(c.scheduledAt).toLocaleString():"Immediate"}</td><td style={{padding:10}}>{Object.entries(c.counts).map(([k,v])=>k+": "+v).join(" · ")}</td></tr>)}</tbody></table></div>
    <p style={{fontSize:12,color:"#667085",marginTop:20}}>Campaigns are persisted, but delivery is not enabled until the background worker is deployed and verified.</p>
  </div></s-page>;
}

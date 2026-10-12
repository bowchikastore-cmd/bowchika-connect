import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator } from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  getWhatsAppBusinessAccountId,
  getWhatsAppConfig,
  WhatsAppConfigurationError,
} from "../whatsapp.server";

type ShopifyCustomer = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  numberOfOrders: number;
  createdAt: string;
  tags: string[];
  amountSpent: number;
  currencyCode: string;
  lastOrderAt: string | null;
};

type ShopifyCustomerNode = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  defaultEmailAddress: { emailAddress: string } | null;
  defaultPhoneNumber: { phoneNumber: string } | null;
  numberOfOrders: number;
  createdAt: string;
  tags: string[];
  amountSpent: { amount: string; currencyCode: string } | null;
  lastOrder: { createdAt: string } | null;
};

type CustomerQueryResult = {
  errors?: unknown[];
  data?: {
    customers?: {
      nodes?: ShopifyCustomerNode[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
};

type SavedSegment = {
  id: string;
  name: string;
  orderRule: string;
  tag: string;
  spendRule: string;
  spendAmount: number | null;
  lastOrderDays: number | null;
};

type SegmentActionData = {
  error?: string;
  success?: string;
};

type CampaignPreviewActionData = {
  error?: string;
  success?: string;
  segmentName?: string;
  segmentId?: string;
};

type CampaignDraftActionData = {
  error?: string;
  success?: string;
  draftId?: string;
  deletedDraftId?: string;
};

type WhatsAppActionData = {
  error?: string;
  success?: string;
  phoneNumber?: string;
  verifiedName?: string;
  templateCount?: number;
};

type MetaConfig = {
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  apiVersion: string;
};

type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components?: unknown[];
};

type MetaErrorResponse = {
  error?: { code?: number };
};

type MetaTemplatePage = {
  data?: MetaTemplate[];
  paging?: { cursors?: { after?: string } };
};

type MetaPhoneNumber = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
};

type MetaPhonePage = {
  data?: MetaPhoneNumber[];
  paging?: { cursors?: { after?: string } };
};

class MetaRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
  ) {
    super("Meta API request failed");
  }
}

const getMetaConfig = (): MetaConfig => {
  const config = getWhatsAppConfig();
  const businessAccountId = getWhatsAppBusinessAccountId();
  if (!businessAccountId) {
    throw new WhatsAppConfigurationError(
      "WhatsApp Business Account ID is not configured.",
    );
  }

  return { ...config, businessAccountId };
};

const metaGet = async <T,>(
  config: MetaConfig,
  resource: string,
  fields: string,
  after?: string,
): Promise<T> => {
  const url = new URL(`https://graph.facebook.com/${config.apiVersion}/${resource}`);
  url.searchParams.set("fields", fields);
  if (after) url.searchParams.set("after", after);
  if (resource.endsWith("/message_templates") || resource.endsWith("/phone_numbers")) {
    url.searchParams.set("limit", "100");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MetaRequestError(0);
  }

  const body = (await response.json().catch(() => null)) as
    | (T & MetaErrorResponse)
    | null;
  const code = body && "error" in body ? body.error?.code : undefined;
  if (!response.ok || code !== undefined) {
    throw new MetaRequestError(response.status, code);
  }
  if (!body) throw new MetaRequestError(response.status);
  return body;
};

const metaActionError = (error: unknown) => {
  if (error instanceof WhatsAppConfigurationError) return error.message;
  if (error instanceof MetaRequestError) {
    if (error.code === 190) return "Meta rejected the access token. Check that it is active.";
    if (error.code === 10 || error.code === 200) {
      return "Meta denied access. Check that this token has WhatsApp business management permission.";
    }
    if (error.status === 0) return "Could not reach Meta. Check the server connection and try again.";
    return `Meta returned an error (HTTP ${error.status}${error.code ? `, code ${error.code}` : ""}).`;
  }
  return "The WhatsApp operation could not be completed. Please try again.";
};

const hasMetaConfiguration = () => {
  try {
    getMetaConfig();
    return true;
  } catch (error) {
    if (error instanceof WhatsAppConfigurationError) return false;
    throw error;
  }
};

const orderRules = new Set(["any", "zero", "one", "has", "repeat"]);
const spendRules = new Set(["any", "atLeast", "under"]);
const lastOrderDayOptions = new Set([30, 60, 90, 180, 365]);

const textField = (formData: FormData, key: string) =>
  String(formData.get(key) ?? "").trim();

const actionResult = (body: object, status = 200) =>
  Response.json(body, { status });

const CUSTOMER_QUERY_TIMEOUT_MS = 15_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const requestedCursor = new URL(request.url).searchParams.get("customerCursor");
  const customerCursor = requestedCursor && requestedCursor.length <= 2048 ? requestedCursor : null;

  const [savedSegments, approvedTemplates, campaignDrafts] = await Promise.all([
    prisma.customerSegment.findMany({
      where: { shop: session.shop },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        orderRule: true,
        tag: true,
        spendRule: true,
        spendAmount: true,
        lastOrderDays: true,
      },
    }),
    prisma.approvedWhatsAppTemplate.findMany({
      where: { shop: session.shop },
      orderBy: [{ name: "asc" }, { language: "asc" }],
      select: { id: true, name: true, language: true, category: true, syncedAt: true },
    }),
    prisma.campaignDraft.findMany({
      where: { shop: session.shop },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, templateId: true, segmentId: true, status: true, updatedAt: true },
    }),
  ]);

  try {
    const response = await admin.graphql(
      `#graphql
        query BowchikaConnectCustomers($after: String) {
          customers(first: 100, after: $after, sortKey: CREATED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              firstName
              lastName
              defaultEmailAddress { emailAddress }
              defaultPhoneNumber { phoneNumber }
              numberOfOrders
              createdAt
              tags
              amountSpent { amount currencyCode }
              lastOrder { createdAt }
            }
          }
        }`,
      { variables: { after: customerCursor }, signal: AbortSignal.timeout(CUSTOMER_QUERY_TIMEOUT_MS) },
    );

    const result = (await response.json()) as CustomerQueryResult;
    const graphQLErrors = result.errors ?? [];

    if (graphQLErrors.length) {
      console.error("Shopify customer query returned GraphQL errors.");
      return {
        customers: [] as ShopifyCustomer[],
        customerPageInfo: { hasNextPage: false, endCursor: null },
        savedSegments,
        approvedTemplates,
        campaignDrafts,
        whatsappConfigured: hasMetaConfiguration(),
        customerError:
            "Shopify returned an error while loading customers. Retry the request or check the server logs.",
      };
    }

    const customers: ShopifyCustomer[] = (
      result.data?.customers?.nodes ?? []
    ).map((customer) => ({
      id: customer.id,
      firstName: customer.firstName ?? null,
      lastName: customer.lastName ?? null,
      email: customer.defaultEmailAddress?.emailAddress ?? null,
      phone: customer.defaultPhoneNumber?.phoneNumber ?? null,
      numberOfOrders: Number(customer.numberOfOrders ?? 0),
      createdAt: customer.createdAt,
      tags: customer.tags ?? [],
      amountSpent: Number(customer.amountSpent?.amount ?? 0),
      currencyCode: customer.amountSpent?.currencyCode ?? "INR",
      lastOrderAt: customer.lastOrder?.createdAt ?? null,
    }));

    return {
      customers,
      customerPageInfo: {
        hasNextPage: Boolean(result.data?.customers?.pageInfo?.hasNextPage),
        endCursor: result.data?.customers?.pageInfo?.endCursor ?? null,
      },
      savedSegments,
      approvedTemplates,
      campaignDrafts,
      whatsappConfigured: hasMetaConfiguration(),
      customerError: null,
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    console.error(
      timedOut
        ? "Shopify customer query timed out."
        : "Shopify customer query failed.",
    );
    return {
      customers: [] as ShopifyCustomer[],
      customerPageInfo: { hasNextPage: false, endCursor: null },
      savedSegments,
      approvedTemplates,
      campaignDrafts,
      whatsappConfigured: hasMetaConfiguration(),
      customerError:
        timedOut
          ? "Shopify customer loading timed out after 15 seconds. Check the connection and retry."
          : "Could not load customers from Shopify. Check the connection and retry.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = textField(formData, "intent");

  if (intent === "check-whatsapp") {
    try {
      const config = getMetaConfig();
      const [business, initialPhonePage] = await Promise.all([
        metaGet<{ id: string; name?: string }>(
          config,
          encodeURIComponent(config.businessAccountId),
          "id,name",
        ),
        metaGet<MetaPhonePage>(
          config,
          `${encodeURIComponent(config.businessAccountId)}/phone_numbers`,
          "id,display_phone_number,verified_name",
        ),
      ]);

      if (business.id !== config.businessAccountId || !Array.isArray(initialPhonePage.data)) {
        throw new MetaRequestError(200);
      }
      const phoneNumbers = [...initialPhonePage.data];
      const seenCursors = new Set<string>();
      let after = initialPhonePage.paging?.cursors?.after;
      while (
        after &&
        !phoneNumbers.some((phone) => phone.id === config.phoneNumberId) &&
        !seenCursors.has(after)
      ) {
        seenCursors.add(after);
        const page = await metaGet<MetaPhonePage>(
          config,
          `${encodeURIComponent(config.businessAccountId)}/phone_numbers`,
          "id,display_phone_number,verified_name",
          after,
        );
        if (!Array.isArray(page.data)) throw new MetaRequestError(200);
        phoneNumbers.push(...page.data);
        after = page.paging?.cursors?.after;
      }
      const phone = phoneNumbers.find((item) => item.id === config.phoneNumberId);
      if (!phone) throw new MetaRequestError(404);

      return actionResult({
        success: `Connected to ${business.name || "your WhatsApp Business Account"}.`,
        phoneNumber: phone.display_phone_number,
        verifiedName: phone.verified_name,
      });
    } catch (error) {
      return actionResult({ error: metaActionError(error) }, 400);
    }
  }

  if (intent === "sync-whatsapp-templates") {
    try {
      const config = getMetaConfig();
      const templates: MetaTemplate[] = [];
      let after: string | undefined;
      let previousCursor: string | undefined;

      do {
        const page = await metaGet<MetaTemplatePage>(
          config,
          `${encodeURIComponent(config.businessAccountId)}/message_templates`,
          "id,name,language,category,status,components",
          after,
        );
        if (!Array.isArray(page.data)) throw new MetaRequestError(200);
        templates.push(...page.data.filter((template) => template.status === "APPROVED"));
        previousCursor = after;
        after = page.paging?.cursors?.after;
      } while (after && after !== previousCursor);

      const syncedAt = new Date();
      await prisma.$transaction(async (transaction) => {
        await transaction.approvedWhatsAppTemplate.deleteMany({
          where: { shop: session.shop },
        });
        if (templates.length) {
          await transaction.approvedWhatsAppTemplate.createMany({
            data: templates.map((template) => ({
              shop: session.shop,
              metaTemplateId: template.id,
              name: template.name,
              language: template.language,
              category: template.category,
              components: JSON.stringify(template.components ?? []),
              syncedAt,
            })),
          });
        }
      });

      return actionResult({
        success: `Synced ${templates.length} approved template${templates.length === 1 ? "" : "s"}.`,
        templateCount: templates.length,
      });
    } catch (error) {
      return actionResult({ error: metaActionError(error) }, 400);
    }
  }

  if (intent === "save-campaign-draft") {
    const draftId = textField(formData, "draftId");
    const name = textField(formData, "name");
    const templateId = textField(formData, "templateId");
    const segmentId = textField(formData, "segmentId");

    if (!name || name.length > 100) {
      return actionResult({ error: "Enter a campaign name between 1 and 100 characters." }, 400);
    }
    if (!templateId || !segmentId) {
      return actionResult({ error: "Choose an approved template and a saved customer segment." }, 400);
    }

    const [approvedTemplate, savedSegment] = await Promise.all([
      prisma.approvedWhatsAppTemplate.findFirst({
        where: { id: templateId, shop: session.shop },
        select: { id: true },
      }),
      prisma.customerSegment.findFirst({
        where: { id: segmentId, shop: session.shop },
        select: { id: true },
      }),
    ]);
    if (!approvedTemplate) {
      return actionResult({ error: "Choose a currently synced approved template for this shop." }, 400);
    }
    if (!savedSegment) {
      return actionResult({ error: "Choose a saved customer segment for this shop." }, 400);
    }

    if (draftId) {
      const updated = await prisma.campaignDraft.updateMany({
        where: { id: draftId, shop: session.shop, status: "DRAFT" },
        data: { name, templateId, segmentId },
      });
      if (updated.count === 0) {
        return actionResult({ error: "This draft no longer exists. Start a new draft or reopen a saved one." }, 404);
      }
      return actionResult({ success: "Campaign draft updated.", draftId });
    }

    const draft = await prisma.campaignDraft.create({
      data: { shop: session.shop, name, templateId, segmentId, status: "DRAFT" },
      select: { id: true },
    });
    return actionResult({ success: "Campaign draft saved.", draftId: draft.id });
  }

  if (intent === "delete-campaign-draft") {
    const draftId = textField(formData, "draftId");
    if (!draftId) return actionResult({ error: "Campaign draft not found." }, 400);

    const deleted = await prisma.campaignDraft.deleteMany({
      where: { id: draftId, shop: session.shop, status: "DRAFT" },
    });
    if (deleted.count === 0) {
      return actionResult({ error: "Campaign draft not found for this shop." }, 404);
    }
    return actionResult({ success: "Campaign draft deleted.", deletedDraftId: draftId });
  }

  if (intent === "preview-campaign") {
    const segmentId = textField(formData, "audienceSegmentId");
    if (!segmentId) {
      return actionResult({ error: "Choose a saved customer segment before previewing." }, 400);
    }

    const segment = await prisma.customerSegment.findFirst({
      where: { id: segmentId, shop: session.shop },
      select: { name: true },
    });
    if (!segment) {
      return actionResult({ error: "That saved segment no longer exists. Choose another audience." }, 404);
    }
    return actionResult({
      success: "Campaign preview is ready. No message was sent.",
      segmentName: segment.name,
      segmentId,
    });
  }

  if (intent === "delete") {
    const id = textField(formData, "id");
    if (!id) return actionResult({ error: "Segment not found." }, 400);

    await prisma.customerSegment.deleteMany({
      where: { id, shop: session.shop },
    });
    return actionResult({ success: "Segment deleted." });
  }

  if (intent !== "save") {
    return actionResult({ error: "Unsupported segment action." }, 400);
  }

  const name = textField(formData, "name");
  const orderRule = textField(formData, "orderRule");
  const tag = textField(formData, "tag");
  const spendRule = textField(formData, "spendRule");
  const spendAmountInput = textField(formData, "spendAmount");
  const lastOrderDaysInput = textField(formData, "lastOrderDays");

  if (!name || name.length > 80) {
    return actionResult({ error: "Use a segment name between 1 and 80 characters." }, 400);
  }
  if (!orderRules.has(orderRule) || !spendRules.has(spendRule)) {
    return actionResult({ error: "One of the selected segment rules is invalid." }, 400);
  }
  if (tag.length > 100) {
    return actionResult({ error: "Customer tag filters can be at most 100 characters." }, 400);
  }

  const parsedSpendAmount = Number(spendAmountInput);
  if (spendRule !== "any" && (!spendAmountInput || !Number.isFinite(parsedSpendAmount) || parsedSpendAmount < 0)) {
    return actionResult({ error: "Enter a valid non-negative spend amount." }, 400);
  }
  const spendAmount = spendRule === "any" ? null : parsedSpendAmount;

  const lastOrderDays = lastOrderDaysInput === "any" ? null : Number(lastOrderDaysInput);
  if (lastOrderDays !== null && !lastOrderDayOptions.has(lastOrderDays)) {
    return actionResult({ error: "Select a supported last-order period." }, 400);
  }

  try {
    const segment = await prisma.customerSegment.create({
      data: {
        shop: session.shop,
        name,
        orderRule,
        tag,
        spendRule,
        spendAmount,
        lastOrderDays,
      },
      select: { id: true, name: true },
    });
    return actionResult({ success: `Saved segment: ${segment.name}`, segment });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return actionResult({ error: "A segment with this name already exists for this shop." }, 409);
    }
    console.error("Failed to save customer segment:", error);
    return actionResult({ error: "Could not save this segment. Please try again." }, 500);
  }
};

const navItems = [
  { name: "Overview", icon: "◫" },
  { name: "Customers", icon: "♙" },
  { name: "Segments", icon: "⚙" },
  { name: "Templates", icon: "▤" },
  { name: "Campaigns", icon: "✉" },
  { name: "Delivery health", icon: "◷" },
];

const initialFilters = {
  orderRule: "any",
  tag: "",
  spendRule: "any",
  spendAmount: "",
  lastOrderDays: "any",
};

const money = (amount: number, currencyCode: string) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currencyCode || "INR",
    maximumFractionDigits: 0,
  }).format(amount);

const dateLabel = (date: string | null) => {
  if (!date) return "No orders recorded";
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const matchesSavedSegment = (customer: ShopifyCustomer, segment: SavedSegment) => {
  if (segment.orderRule === "zero" && customer.numberOfOrders !== 0) return false;
  if (segment.orderRule === "one" && customer.numberOfOrders !== 1) return false;
  if (segment.orderRule === "repeat" && customer.numberOfOrders < 2) return false;
  if (segment.orderRule === "has" && customer.numberOfOrders < 1) return false;
  if (
    segment.tag.trim() &&
    !customer.tags.some((item) => item.toLowerCase().includes(segment.tag.trim().toLowerCase()))
  ) return false;
  if (segment.spendRule === "atLeast" && customer.amountSpent < (segment.spendAmount ?? 0)) return false;
  if (segment.spendRule === "under" && customer.amountSpent >= (segment.spendAmount ?? 0)) return false;

  if (segment.lastOrderDays !== null) {
    if (!customer.lastOrderAt) return false;
    const cutoff = Date.now() - segment.lastOrderDays * 24 * 60 * 60 * 1000;
    if (new Date(customer.lastOrderAt).getTime() < cutoff) return false;
  }
  return true;
};

export default function Index() {
  const {
    customers: shopifyCustomers,
    customerError,
    savedSegments,
    approvedTemplates,
    campaignDrafts,
    whatsappConfigured,
    customerPageInfo,
  } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const saveSegmentFetcher = useFetcher<SegmentActionData>();
  const deleteSegmentFetcher = useFetcher<SegmentActionData>();
  const campaignPreviewFetcher = useFetcher<CampaignPreviewActionData>();
  const campaignDraftFetcher = useFetcher<CampaignDraftActionData>();
  const deleteCampaignDraftFetcher = useFetcher<CampaignDraftActionData>();
  const connectionFetcher = useFetcher<WhatsAppActionData>();
  const syncTemplatesFetcher = useFetcher<WhatsAppActionData>();

  const [tab, setTab] = useState("Overview");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [campaign, setCampaign] = useState("Bowchika customer campaign");
  const [template, setTemplate] = useState("");
  const [notice, setNotice] = useState("");
  const [orderRule, setOrderRule] = useState(initialFilters.orderRule);
  const [tag, setTag] = useState(initialFilters.tag);
  const [spendRule, setSpendRule] = useState(initialFilters.spendRule);
  const [spendAmount, setSpendAmount] = useState(initialFilters.spendAmount);
  const [lastOrderDays, setLastOrderDays] = useState(initialFilters.lastOrderDays);
  const [segmentName, setSegmentName] = useState("");
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [audienceSegmentId, setAudienceSegmentId] = useState("");
  const [editingCampaignDraftId, setEditingCampaignDraftId] = useState("");

  useEffect(() => {
    if (campaignDraftFetcher.data?.draftId) {
      setEditingCampaignDraftId(campaignDraftFetcher.data.draftId);
    }
  }, [campaignDraftFetcher.data]);

  useEffect(() => {
    const deletedDraftId = deleteCampaignDraftFetcher.data?.deletedDraftId;
    if (deletedDraftId && deletedDraftId === editingCampaignDraftId) {
      setEditingCampaignDraftId("");
      setCampaign("Bowchika customer campaign");
      setTemplate("");
      setAudienceSegmentId("");
    }
  }, [deleteCampaignDraftFetcher.data, editingCampaignDraftId]);

  const filteredCustomers = useMemo(() => {
    const query = search.trim().toLowerCase();
    const spendThreshold = Number(spendAmount || 0);
    const cutoff = lastOrderDays === "any"
      ? null
      : Date.now() - Number(lastOrderDays) * 24 * 60 * 60 * 1000;

    return shopifyCustomers.filter((customer) => {
      const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
      const searchable = `${name} ${customer.email ?? ""} ${customer.phone ?? ""} ${customer.tags.join(" ")}`.toLowerCase();
      if (query && !searchable.includes(query)) return false;

      if (orderRule === "zero" && customer.numberOfOrders !== 0) return false;
      if (orderRule === "one" && customer.numberOfOrders !== 1) return false;
      if (orderRule === "repeat" && customer.numberOfOrders < 2) return false;
      if (orderRule === "has" && customer.numberOfOrders < 1) return false;

      if (tag.trim() && !customer.tags.some((item) => item.toLowerCase().includes(tag.trim().toLowerCase()))) return false;

      if (spendRule === "atLeast" && customer.amountSpent < spendThreshold) return false;
      if (spendRule === "under" && customer.amountSpent >= spendThreshold) return false;

      if (cutoff !== null) {
        if (!customer.lastOrderAt) return false;
        if (new Date(customer.lastOrderAt).getTime() < cutoff) return false;
      }
      return true;
    });
  }, [shopifyCustomers, search, orderRule, tag, spendRule, spendAmount, lastOrderDays]);

  const audienceSegment = savedSegments.find((segment) => segment.id === audienceSegmentId);
  const audienceCustomerCount = audienceSegment
    ? shopifyCustomers.filter((customer) => matchesSavedSegment(customer, audienceSegment)).length
    : 0;
  const canPreviewCampaign = Boolean(audienceSegment && !customerError);

  const cardStyle = {
    background: "var(--bc-surface)",
    border: "1px solid var(--bc-border)",
    borderRadius: 8,
    padding: "var(--bc-card-padding)",
  } as const;
  const muted = { color: "var(--bc-muted)", fontSize: 13 } as const;
  const inputStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "var(--bc-control-padding)",
    border: "1px solid var(--bc-border)",
    borderRadius: 6,
    marginTop: 6,
    background: "var(--bc-surface)",
  };
  const buttonStyle = {
    padding: "var(--bc-control-padding)",
    border: "1px solid var(--bc-border)",
    borderRadius: 6,
    background: "var(--bc-secondary-button)",
    color: "var(--bc-text)",
    cursor: "pointer",
    fontWeight: 600,
  } as const;

  const resetFilters = () => {
    setSearch("");
    setOrderRule("any");
    setTag("");
    setSpendRule("any");
    setSpendAmount("");
    setLastOrderDays("any");
    setActiveSegmentId(null);
  };

  const applySegment = (segment: SavedSegment) => {
    setOrderRule(segment.orderRule);
    setTag(segment.tag);
    setSpendRule(segment.spendRule);
    setSpendAmount(segment.spendAmount === null ? "" : String(segment.spendAmount));
    setLastOrderDays(segment.lastOrderDays === null ? "any" : String(segment.lastOrderDays));
    setSearch("");
    setActiveSegmentId(segment.id);
    setTab("Segments");
    setNotice(`Applied segment: ${segment.name}`);
  };

  const openCampaignDraft = (draft: (typeof campaignDrafts)[number]) => {
    setEditingCampaignDraftId(draft.id);
    setCampaign(draft.name);
    setTemplate(draft.templateId);
    setAudienceSegmentId(draft.segmentId);
    setTab("Campaigns");
    setNotice("");
  };

  const startNewCampaignDraft = () => {
    setEditingCampaignDraftId("");
    setCampaign("Bowchika customer campaign");
    setTemplate("");
    setAudienceSegmentId("");
  };

  return (
    <s-page heading="Bowchika Connect">
      <div className="bc-dashboard" style={{ color: "var(--bc-text)" }}>
        <div style={{ marginBottom: 22 }}>
          <div style={{ color: "var(--bc-muted)", fontSize: 12 }}>BOWCHIKA CONNECT</div>
          <h1 style={{ fontSize: 24, margin: "8px 0" }}>Your customers. Your campaigns.</h1>
          <p style={{ margin: 0, color: "var(--bc-muted)" }}>Customer conversations. Made simpler.</p>
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--bc-warning)" }}>DEVELOPMENT MODE · Messages are not sent</div>
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--bc-muted)" }}>
            Showing 100 customers per page. Segment counts and campaign previews use the currently loaded page only; they are not whole-store audience totals.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {navItems.map((item) => (
            <button key={item.name} onClick={() => { setTab(item.name); setNotice(""); }} style={{
              padding: "var(--bc-control-padding)", borderRadius: 6, cursor: "pointer",
              border: tab === item.name ? "1px solid var(--bc-primary)" : "1px solid var(--bc-border)",
              background: tab === item.name ? "var(--bc-primary)" : "var(--bc-surface)",
              color: tab === item.name ? "var(--bc-primary-contrast)" : "var(--bc-text)", fontWeight: 600,
            }}>{item.icon} &nbsp; {item.name}</button>
          ))}
        </div>

        {tab === "Overview" && (
          <>
            <h2 style={{ fontSize: 20 }}>Campaign overview</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
              {[
                [String(shopifyCustomers.length), "Customers loaded", "Recent records from the connected Shopify store"],
                ["—", "Messages sent", "Meta connection not configured"],
                ["—", "Delivery rate", "Requires Meta delivery webhooks"],
                ["—", "Ecosystem errors", "Requires Meta delivery webhooks"],
              ].map(([value, label, description]) => (
                <div key={label} style={cardStyle}>
                  <div style={muted}>{label}</div><div style={{ fontSize: 28, fontWeight: 700, margin: "10px 0" }}>{value}</div><div style={muted}>{description}</div>
                </div>
              ))}
            </div>
            {customerError && <p style={{ color: "var(--bc-danger)" }}>{customerError}</p>}
            <div style={cardStyle}>
              <h3 style={{ marginTop: 0 }}>Quick actions</h3>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button style={buttonStyle} onClick={() => setTab("Customers")}>Browse customers →</button>
                <button style={buttonStyle} onClick={() => setTab("Segments")}>Build segments →</button>
                <button style={buttonStyle} onClick={() => setTab("Templates")}>View templates →</button>
                <button style={buttonStyle} onClick={() => setTab("Campaigns")}>Build a campaign →</button>
              </div>
            </div>
          </>
        )}

        {tab === "Customers" && (
          <>
            <h2 style={{ fontSize: 20 }}>Customer audience</h2>
            <p style={muted}>Live customer records from Shopify, newest first. Browse pages to reach older customers. Filters and counts apply to the current page; WhatsApp consent is not verified by this list.</p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <p style={{ ...muted, margin: 0 }}>
                Page contains {shopifyCustomers.length} customers{customerPageInfo.hasNextPage ? " · more customers available" : " · end of customer list"}.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} disabled={!new URLSearchParams(location.search).has("customerCursor")} onClick={() => navigate("/app")}>First page</button>
                <button type="button" style={buttonStyle} disabled={!customerPageInfo.hasNextPage || !customerPageInfo.endCursor} onClick={() => navigate("?customerCursor=" + encodeURIComponent(customerPageInfo.endCursor ?? ""))}>Load next 100 customers →</button>
              </div>
            </div>
            {customerError && (
              <div role="alert" style={{ ...cardStyle, color: "var(--bc-danger)", marginBottom: 12 }}>
                <p style={{ marginTop: 0 }}>{customerError}</p>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={revalidator.state !== "idle"}
                  onClick={() => revalidator.revalidate()}
                >
                  {revalidator.state === "idle" ? "Retry customer load" : "Retrying…"}
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <input placeholder="Search name, email, phone or tag" value={search} onChange={(event) => setSearch(event.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 220, marginTop: 0 }} />
              <button style={buttonStyle} onClick={() => setSelected(filteredCustomers.map((customer) => customer.id))}>Select all shown</button>
              <button style={buttonStyle} onClick={() => setSelected([])}>Clear selection</button>
              <button style={buttonStyle} onClick={resetFilters}>Clear filters</button>
            </div>
            <div style={{ ...cardStyle, overflowX: "auto", padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <thead><tr style={{ background: "var(--bc-surface-muted)" }}>{["Select", "Customer", "Email", "Phone", "Orders", "Spent", "Last order", "Tags"].map((heading) => <th key={heading} style={{ padding: 12, fontSize: 12 }}>{heading}</th>)}</tr></thead>
                <tbody>
                  {filteredCustomers.map((customer) => {
                    const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unnamed customer";
                    return <tr key={customer.id} style={{ borderTop: "1px solid var(--bc-border)" }}>
                      <td style={{ padding: 12 }}><input type="checkbox" checked={selected.includes(customer.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, customer.id])] : current.filter((id) => id !== customer.id))} aria-label={`Select ${name}`} /></td>
                      <td style={{ padding: 12 }}>{name}</td><td style={{ padding: 12 }}>{customer.email ?? "—"}</td><td style={{ padding: 12 }}>{customer.phone ?? "—"}</td>
                      <td style={{ padding: 12 }}>{customer.numberOfOrders}</td><td style={{ padding: 12 }}>{money(customer.amountSpent, customer.currencyCode)}</td><td style={{ padding: 12 }}>{dateLabel(customer.lastOrderAt)}</td><td style={{ padding: 12 }}>{customer.tags.length ? customer.tags.join(", ") : "—"}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
              {filteredCustomers.length === 0 && <p style={{ padding: 16 }}>{customerError ? "Customers could not be loaded." : "No customers match these filters."}</p>}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
              <p style={{ ...muted, margin: 0 }}>{filteredCustomers.length} shown on this page · {selected.length} selected</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={buttonStyle} disabled={!new URLSearchParams(location.search).has("customerCursor")} onClick={() => navigate("/app")}>First page</button>
                <button type="button" style={buttonStyle} disabled={!customerPageInfo.hasNextPage || !customerPageInfo.endCursor} onClick={() => navigate("?customerCursor=" + encodeURIComponent(customerPageInfo.endCursor ?? ""))}>Next 100 customers →</button>
              </div>
            </div>
          </>
        )}

        {tab === "Segments" && (
          <>
            <h2 style={{ fontSize: 20 }}>Customer segment builder</h2>
            <p style={muted}>Combine filters to build an audience. Saved segments are stored privately for this Shopify shop and can be reused after refreshing.</p>
            <div style={{ ...cardStyle, maxWidth: 900, display: "grid", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <label>Order history
                  <select value={orderRule} onChange={(event) => setOrderRule(event.target.value)} style={inputStyle}>
                    <option value="any">Any order count</option><option value="zero">No orders</option><option value="one">Exactly 1 order</option><option value="has">At least 1 order</option><option value="repeat">Repeat buyers (2+ orders)</option>
                  </select>
                </label>
                <label>Customer tag contains
                  <input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="e.g. VIP" style={inputStyle} />
                </label>
                <label>Amount spent
                  <select value={spendRule} onChange={(event) => setSpendRule(event.target.value)} style={inputStyle}>
                    <option value="any">Any amount</option><option value="atLeast">At least</option><option value="under">Less than</option>
                  </select>
                  <input type="number" min="0" value={spendAmount} onChange={(event) => setSpendAmount(event.target.value)} placeholder="Amount in each customer's currency" style={inputStyle} disabled={spendRule === "any"} />
                </label>
                <label>Last order date
                  <select value={lastOrderDays} onChange={(event) => setLastOrderDays(event.target.value)} style={inputStyle}>
                    <option value="any">Any date / include no order date</option><option value="30">Ordered in last 30 days</option><option value="60">Ordered in last 60 days</option><option value="90">Ordered in last 90 days</option><option value="180">Ordered in last 180 days</option><option value="365">Ordered in last 365 days</option>
                  </select>
                </label>
              </div>
              <div style={{ padding: 14, background: "var(--bc-surface-muted)", borderRadius: 8 }}>
                <strong>{filteredCustomers.length} customers match</strong>
                <p style={{ ...muted, marginBottom: 0 }}>This is a Shopify customer filter preview, not a WhatsApp-eligible audience count. Consent must be verified separately before any marketing send.</p>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button style={buttonStyle} onClick={resetFilters}>Reset filters</button>
                <button className="bc-button-primary" style={{ ...buttonStyle, background: "var(--bc-primary)", color: "var(--bc-primary-contrast)" }} onClick={() => { setSelected(filteredCustomers.map((customer) => customer.id)); setNotice(`${filteredCustomers.length} matching customers selected.`); }}>Select matching customers</button>
              </div>
              <saveSegmentFetcher.Form method="post" style={{ borderTop: "1px solid var(--bc-border)", paddingTop: 16 }}>
                <h3 style={{ marginTop: 0 }}>Save this segment</h3>
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="orderRule" value={orderRule} />
                <input type="hidden" name="tag" value={tag} />
                <input type="hidden" name="spendRule" value={spendRule} />
                <input type="hidden" name="spendAmount" value={spendAmount} />
                <input type="hidden" name="lastOrderDays" value={lastOrderDays} />
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <input name="name" value={segmentName} onChange={(event) => setSegmentName(event.target.value)} placeholder="e.g. VIP repeat buyers" style={{ ...inputStyle, flex: 1, minWidth: 220, marginTop: 0 }} />
                  <button type="submit" style={buttonStyle} disabled={saveSegmentFetcher.state !== "idle"}>{saveSegmentFetcher.state === "idle" ? "Save segment" : "Saving…"}</button>
                </div>
                {saveSegmentFetcher.data?.error && <p style={{ color: "var(--bc-danger)", marginBottom: 0 }}>{saveSegmentFetcher.data.error}</p>}
                {saveSegmentFetcher.data?.success && <p style={{ color: "var(--bc-success)", marginBottom: 0 }}>{saveSegmentFetcher.data.success}</p>}
              </saveSegmentFetcher.Form>
            </div>
            <h3>Saved segments ({savedSegments.length})</h3>
            {savedSegments.length === 0 ? <p className="bc-empty-state">No saved segments in this session yet.</p> : savedSegments.map((segment) => (
              <div key={segment.id} style={{ ...cardStyle, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", borderColor: activeSegmentId === segment.id ? "var(--bc-primary)" : "var(--bc-border)" }}>
                <div><strong>{segment.name}</strong><div style={muted}>Order rule: {segment.orderRule} · Tag: {segment.tag || "any"} · Spend: {segment.spendRule === "any" ? "any" : `${segment.spendRule} ${segment.spendAmount}`} · Last order: {segment.lastOrderDays === null ? "any date" : `last ${segment.lastOrderDays} days`}</div></div>
                <div style={{ display: "flex", gap: 8 }}><button style={buttonStyle} onClick={() => applySegment(segment)}>Apply</button><deleteSegmentFetcher.Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={segment.id} /><button type="submit" style={buttonStyle} disabled={deleteSegmentFetcher.state !== "idle"}>{deleteSegmentFetcher.state === "idle" ? "Delete" : "Deleting…"}</button></deleteSegmentFetcher.Form></div>
              </div>
            ))}
            {deleteSegmentFetcher.data?.error && <p style={{ color: "var(--bc-danger)" }}>{deleteSegmentFetcher.data.error}</p>}
            {notice && <p style={{ ...muted, marginTop: 12 }}>{notice}</p>}
          </>
        )}

        {tab === "Templates" && (
          <>
            <h2 style={{ fontSize: 20 }}>WhatsApp templates</h2>
            <p style={muted}>Check the Meta connection and sync templates approved for your WhatsApp Business Account. This does not send messages.</p>
            <div style={{ ...cardStyle, maxWidth: 760, marginBottom: 16 }}>
              <strong>{whatsappConfigured ? "Meta credentials found" : "Meta credentials missing"}</strong>
              <p style={{ ...muted, marginBottom: 12 }}>
                {whatsappConfigured
                  ? "Credentials are read on the server and are never shown in the app."
                  : "Add the WhatsApp phone number ID, business account ID, and access token to the server environment."}
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <connectionFetcher.Form method="post">
                  <input type="hidden" name="intent" value="check-whatsapp" />
                  <button type="submit" style={buttonStyle} disabled={!whatsappConfigured || connectionFetcher.state !== "idle"}>
                    {connectionFetcher.state === "idle" ? "Check connection" : "Checking…"}
                  </button>
                </connectionFetcher.Form>
                <syncTemplatesFetcher.Form method="post">
                  <input type="hidden" name="intent" value="sync-whatsapp-templates" />
                  <button type="submit" className="bc-button-primary" style={{ ...buttonStyle, background: "var(--bc-primary)", color: "var(--bc-primary-contrast)" }} disabled={!whatsappConfigured || syncTemplatesFetcher.state !== "idle"}>
                    {syncTemplatesFetcher.state === "idle" ? "Sync approved templates" : "Syncing…"}
                  </button>
                </syncTemplatesFetcher.Form>
              </div>
              {connectionFetcher.data?.success && <p style={{ color: "var(--bc-success)", marginBottom: 0 }}>{connectionFetcher.data.success}{connectionFetcher.data.verifiedName ? ` · ${connectionFetcher.data.verifiedName}` : ""}{connectionFetcher.data.phoneNumber ? ` · ${connectionFetcher.data.phoneNumber}` : ""}</p>}
              {connectionFetcher.data?.error && <p style={{ color: "var(--bc-danger)", marginBottom: 0 }}>{connectionFetcher.data.error}</p>}
              {syncTemplatesFetcher.data?.success && <p style={{ color: "var(--bc-success)", marginBottom: 0 }}>{syncTemplatesFetcher.data.success}</p>}
              {syncTemplatesFetcher.data?.error && <p style={{ color: "var(--bc-danger)", marginBottom: 0 }}>{syncTemplatesFetcher.data.error}</p>}
            </div>
            <h3>Approved templates ({approvedTemplates.length})</h3>
            {approvedTemplates.length === 0 ? (
              <div className="bc-empty-state">No approved templates synced yet.</div>
            ) : approvedTemplates.map((item) => (
              <div key={item.id} style={{ ...cardStyle, marginBottom: 10, display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div><strong>{item.name}</strong><div style={muted}>{item.category} · {item.language}</div></div>
                <span className="bc-status bc-status-success">Approved</span>
              </div>
            ))}
            {approvedTemplates[0]?.syncedAt && <p style={muted}>Last synced {new Date(approvedTemplates[0].syncedAt).toLocaleString()}</p>}
          </>
        )}

        {tab === "Campaigns" && (
          <>
            <h2 style={{ fontSize: 20 }}>Campaign builder</h2>
            <p style={muted}>Drafts are saved for this Shopify shop. Campaigns stay in draft mode; nothing is scheduled or sent.</p>
            <button type="button" style={buttonStyle} onClick={startNewCampaignDraft}>New draft</button>
            <div style={{ ...cardStyle, display: "grid", gap: 16, maxWidth: 680 }}>
              <campaignDraftFetcher.Form method="post" style={{ display: "grid", gap: 16 }}>
                <input type="hidden" name="intent" value="save-campaign-draft" />
                <input type="hidden" name="draftId" value={editingCampaignDraftId} />
                <label>Campaign name<input name="name" maxLength={100} required value={campaign} onChange={(event) => setCampaign(event.target.value)} style={inputStyle} /></label>
                <label>Approved template<select name="templateId" value={template} onChange={(event) => setTemplate(event.target.value)} style={inputStyle} required><option value="">Choose synced approved template</option>{approvedTemplates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.language}</option>)}</select></label>
                <label>Saved customer segment
                  <select name="segmentId" value={audienceSegmentId} onChange={(event) => setAudienceSegmentId(event.target.value)} style={inputStyle} required>
                    <option value="">Choose a saved segment</option>
                    {savedSegments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
                  </select>
                </label>
                <div style={muted}>Status: Draft · Preview only</div>
                <button type="submit" className="bc-button-primary" style={{ ...buttonStyle, background: "var(--bc-primary)", color: "var(--bc-primary-contrast)" }} disabled={campaignDraftFetcher.state !== "idle"}>
                  {campaignDraftFetcher.state !== "idle" ? "Saving…" : editingCampaignDraftId ? "Save changes" : "Save draft"}
                </button>
              </campaignDraftFetcher.Form>
              {campaignDraftFetcher.data?.error && <p role="alert" style={{ color: "var(--bc-danger)", margin: 0 }}>{campaignDraftFetcher.data.error}</p>}
              {campaignDraftFetcher.data?.success && <p role="status" style={{ color: "var(--bc-success)", margin: 0 }}>{campaignDraftFetcher.data.success}</p>}
              <div style={{ ...muted, borderTop: "1px solid var(--bc-border)", paddingTop: 12 }}>Preview-only mode. Sending and scheduling are unavailable.</div>
              {savedSegments.length === 0 && <p style={muted}>Save a segment in Segments before building a campaign audience.</p>}
              <div style={{ ...cardStyle, borderColor: audienceSegment && !customerError ? "var(--bc-success-border)" : "var(--bc-border)", background: "var(--bc-surface-muted)" }}>
                <strong>Audience summary</strong>
                <p style={{ margin: "8px 0 0" }}>
                  {audienceSegment
                    ? `${audienceSegment.name}: ${audienceCustomerCount} matching Shopify customers in the loaded customer list.`
                    : "Choose a saved segment to see its matching customer count."}
                </p>
                {customerError && <p style={{ color: "var(--bc-danger)", marginBottom: 0 }}>Customer records could not be loaded, so a preview is unavailable.</p>}
                {!customerError && audienceSegmentId && !audienceSegment && <p style={{ color: "var(--bc-danger)", marginBottom: 0 }}>This segment is no longer available. Choose another saved segment.</p>}
                <p style={{ ...muted, marginBottom: 0 }}>This is a Shopify customer match count, not a WhatsApp consent count. Verify marketing consent separately before any future send.</p>
              </div>
              <campaignPreviewFetcher.Form method="post">
                <input type="hidden" name="intent" value="preview-campaign" />
                <input type="hidden" name="audienceSegmentId" value={audienceSegmentId} />
                <button type="submit" className="bc-button-primary" style={{ ...buttonStyle, background: "var(--bc-primary)", color: "var(--bc-primary-contrast)" }} disabled={!canPreviewCampaign || campaignPreviewFetcher.state !== "idle"}>
                  {campaignPreviewFetcher.state === "idle" ? "Preview campaign" : "Validating audience…"}
                </button>
              </campaignPreviewFetcher.Form>
              {campaignPreviewFetcher.data?.error && <div role="alert" style={{ padding: 12, background: "var(--bc-danger-bg)", color: "var(--bc-danger)", borderRadius: 8 }}>{campaignPreviewFetcher.data.error}</div>}
              {campaignPreviewFetcher.data?.success && campaignPreviewFetcher.data.segmentId === audienceSegmentId && <div role="status" style={{ padding: 12, background: "var(--bc-success-bg)", borderRadius: 8 }}>Preview: “{campaign}” · {approvedTemplates.find((item) => item.id === template)?.name ?? "No template selected"} · Audience: {campaignPreviewFetcher.data.segmentName} ({audienceCustomerCount} matching Shopify customers) · Preview only. No message sent.</div>}
            </div>
            <h3>Saved campaign drafts ({campaignDrafts.length})</h3>
            {campaignDrafts.length === 0 ? <p className="bc-empty-state">No saved campaign drafts yet.</p> : campaignDrafts.map((draft) => (
              <div key={draft.id} style={{ ...cardStyle, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <strong>{draft.name}</strong>
                  <div style={muted}>Draft · {approvedTemplates.find((item) => item.id === draft.templateId)?.name ?? "Template unavailable"} · {savedSegments.find((item) => item.id === draft.segmentId)?.name ?? "Segment unavailable"}</div>
                  <div style={muted}>Updated {new Date(draft.updatedAt).toLocaleString()}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" style={buttonStyle} onClick={() => openCampaignDraft(draft)}>Open</button>
                  <deleteCampaignDraftFetcher.Form method="post">
                    <input type="hidden" name="intent" value="delete-campaign-draft" />
                    <input type="hidden" name="draftId" value={draft.id} />
                    <button type="submit" style={buttonStyle} disabled={deleteCampaignDraftFetcher.state !== "idle"}>{deleteCampaignDraftFetcher.state === "idle" ? "Delete" : "Deleting…"}</button>
                  </deleteCampaignDraftFetcher.Form>
                </div>
              </div>
            ))}
            {deleteCampaignDraftFetcher.data?.error && <p role="alert" style={{ color: "var(--bc-danger)" }}>{deleteCampaignDraftFetcher.data.error}</p>}
            {deleteCampaignDraftFetcher.data?.success && <p role="status" style={{ color: "var(--bc-success)" }}>{deleteCampaignDraftFetcher.data.success}</p>}
          </>
        )}

        {tab === "Delivery health" && (
          <>
            <h2 style={{ fontSize: 20 }}>Delivery health</h2>
            <p style={muted}>Real delivery statuses require Meta Cloud API integration and webhook configuration.</p>
            <div style={cardStyle}><strong>Not connected yet</strong><p style={{ ...muted, marginBottom: 0 }}>Delivered, read, failed, and Healthy Ecosystem (131049) counts will appear here once message sending and webhook tracking are implemented.</p></div>
          </>
        )}

      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

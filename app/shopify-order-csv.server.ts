export type ImportedShopifyLineItem = {
  name: string;
  quantity: number;
  sku: string | null;
  variantTitle: null;
  price: number | null;
  vendor: string | null;
};

export type ImportedShopifyOrder = {
  id: string;
  orderName: string;
  orderNumber: number | null;
  createdAtShopify: Date;
  processedAt: Date | null;
  totalPrice: number;
  currencyCode: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerName: string | null;
  lineItems: ImportedShopifyLineItem[];
};

export type ParsedShopifyOrderCsv = {
  orders: ImportedShopifyOrder[];
  sourceRows: number;
  lineItems: number;
};

const parseRows = (input: string): string[][] => {
  const source = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"' && value.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n" || char === "\r") {
      row.push(value);
      value = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      if (char === "\r" && source[index + 1] === "\n") index += 1;
    } else {
      value += char;
    }
  }

  if (quoted) throw new Error("The CSV contains an unfinished quoted field.");
  if (value.length || row.length) {
    row.push(value);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
};

const parseNumber = (value: string): number | null => {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/[,₹$\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const parseShopifyDate = (value: string): Date | null => {
  const text = value.trim();
  if (!text) return null;
  const shopifyDate = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(text);
  const normalized = shopifyDate
    ? `${shopifyDate[1]}T${shopifyDate[2]}${shopifyDate[3]}:${shopifyDate[4]}`
    : text;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

export const parseShopifyOrderCsv = (input: string): ParsedShopifyOrderCsv => {
  const rows = parseRows(input);
  if (rows.length < 2) throw new Error("The CSV has no order rows.");

  const headers = rows[0].map((header) => header.trim());
  const indexes = new Map(headers.map((header, index) => [header, index]));
  for (const required of ["Id", "Name", "Created at", "Total", "Lineitem name"]) {
    if (!indexes.has(required)) {
      throw new Error(`This does not look like a Shopify orders export: missing "${required}".`);
    }
  }

  const get = (row: string[], key: string) => {
    const index = indexes.get(key);
    return index === undefined ? "" : (row[index] ?? "").trim();
  };
  const orders = new Map<string, ImportedShopifyOrder>();
  let currentId = "";
  let lineItems = 0;

  for (const row of rows.slice(1)) {
    const rowId = get(row, "Id");
    if (rowId) currentId = rowId;
    if (!currentId) continue;
    if (!/^\d{5,30}$/.test(currentId)) {
      throw new Error("The CSV contains an invalid Shopify order ID.");
    }

    let order = orders.get(currentId);
    if (!order) {
      const orderName = get(row, "Name");
      const createdAt = parseShopifyDate(get(row, "Created at"));
      const total = parseNumber(get(row, "Total"));
      if (!orderName || !createdAt || total === null) {
        throw new Error(`Order ${orderName || currentId} is missing a valid name, date, or total.`);
      }
      const orderNumberText = orderName.replace(/^#/, "");
      order = {
        id: `gid://shopify/Order/${currentId}`,
        orderName,
        orderNumber: /^\d+$/.test(orderNumberText) ? Number(orderNumberText) : null,
        createdAtShopify: createdAt,
        processedAt: parseShopifyDate(get(row, "Paid at")),
        totalPrice: total,
        currencyCode: get(row, "Currency") || "INR",
        financialStatus: get(row, "Financial Status").toUpperCase() || null,
        fulfillmentStatus: get(row, "Fulfillment Status").toUpperCase() || null,
        customerEmail: get(row, "Email").toLowerCase() || null,
        customerPhone: get(row, "Phone") || get(row, "Billing Phone") || get(row, "Shipping Phone") || null,
        customerName: get(row, "Billing Name") || get(row, "Shipping Name") || null,
        lineItems: [],
      };
      orders.set(currentId, order);
    }

    const lineName = get(row, "Lineitem name");
    if (lineName) {
      order.lineItems.push({
        name: lineName,
        quantity: Math.max(0, Math.trunc(parseNumber(get(row, "Lineitem quantity")) ?? 0)),
        sku: get(row, "Lineitem sku") || null,
        variantTitle: null,
        price: parseNumber(get(row, "Lineitem price")),
        vendor: get(row, "Vendor") || null,
      });
      lineItems += 1;
    }
  }

  if (!orders.size) throw new Error("No valid Shopify orders were found in this CSV.");
  return { orders: [...orders.values()], sourceRows: rows.length - 1, lineItems };
};

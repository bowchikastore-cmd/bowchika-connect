import assert from "node:assert/strict";
import { parseShopifyOrderCsv } from "./shopify-order-csv.server.ts";

const csv = [
  "Name,Email,Financial Status,Paid at,Fulfillment Status,Currency,Total,Created at,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Billing Name,Phone,Id,Notes,Note Attributes",
  `#1538,customer@example.com,paid,"2026-11-11 00:21:30 +0530",unfulfilled,INR,949.05,"2026-11-11 00:21:29 +0530",1,"Raze – Blast Artist, Valorant Tee",999.00,SKU-1,Customer,"+918013268316",19015108985061,"note with a comma, and a newline
second line","attribute: value"`,
  ",,,,,,,,,Shipping protection,0.00,,customer,,19015108985061,,",
  '#1537,second@example.com,partially_paid,,unfulfilled,INR,999.00,"2026-11-10 00:39:00 +0530",1,"Omen Shadow Reaper Tee",999.00,SKU-2,Second,"+919515406470",19012977197285,,',
].join("\r\n");

const parsed = parseShopifyOrderCsv(csv);
assert.equal(parsed.orders.length, 2);
assert.equal(parsed.sourceRows, 3);
assert.equal(parsed.lineItems, 3);
assert.equal(parsed.orders[0].id, "gid://shopify/Order/19015108985061");
assert.equal(parsed.orders[0].orderNumber, 1538);
assert.equal(parsed.orders[0].lineItems.length, 2);
assert.equal(parsed.orders[0].lineItems[0].name, "Raze – Blast Artist, Valorant Tee");
assert.equal(parsed.orders[0].lineItems[1].name, "Shipping protection");
assert.equal(parsed.orders[0].customerEmail, "customer@example.com");
assert.equal(parsed.orders[0].customerPhone, "+918013268316");
assert.equal(parsed.orders[1].financialStatus, "PARTIALLY_PAID");
assert.equal(parsed.orders[1].lineItems[0].sku, "SKU-2");

assert.throws(
  () => parseShopifyOrderCsv("Name,Email\n#1,test@example.com"),
  /missing "Id"/,
);
assert.throws(
  () => parseShopifyOrderCsv('Id,Name,Created at,Total,Lineitem name\n12345,#1,"unfinished,1,item'),
  /unfinished quoted field/,
);
console.log("Passed Shopify order CSV parser tests.");

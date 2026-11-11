import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "./db.server.ts";

const suffix = randomUUID().replaceAll("-", "");
const shop = `sync-smoke-${suffix}.myshopify.com`;
const customerId = `gid://shopify/Customer/${suffix}`;
const orderId = `gid://shopify/Order/${suffix}`;
const leaseToken = randomUUID();
const secondLeaseToken = randomUUID();
const checks = [];

const check = async (name, run) => {
  await run();
  checks.push(name);
};

try {
  await check("a shop has a durable resumable sync checkpoint", async () => {
    const job = await prisma.shopifySyncJob.create({
      data: { id: shop, shop, status: "RUNNING", phase: "CUSTOMERS" },
    });
    assert.equal(job.customerCursor, null);
    assert.equal(job.customersProcessed, 0);
    assert.equal(job.ordersProcessed, 0);
  });

  await check("only one worker can claim an unexpired batch lease", async () => {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 120_000);
    const first = await prisma.shopifySyncJob.updateMany({
      where: {
        id: shop,
        shop,
        status: "RUNNING",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseToken, leaseExpiresAt: leaseUntil },
    });
    assert.equal(first.count, 1);

    const second = await prisma.shopifySyncJob.updateMany({
      where: {
        id: shop,
        shop,
        status: "RUNNING",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseToken: secondLeaseToken, leaseExpiresAt: leaseUntil },
    });
    assert.equal(second.count, 0);
  });

  await check("upserting a replayed customer page does not duplicate customer rows", async () => {
    const createFields = {
      id: customerId,
      shop,
      firstName: "Sync",
      lastName: "Test",
      email: `${suffix}@example.test`,
      phone: "+919000000001",
      numberOfOrders: 1,
      amountSpent: 100,
      currencyCode: "INR",
      tagsJson: JSON.stringify(["sync-test"]),
      syncedAt: new Date(),
    };
    await prisma.shopifyCustomerMirror.upsert({
      where: { id: customerId },
      create: createFields,
      update: createFields,
    });
    await prisma.shopifyCustomerMirror.upsert({
      where: { id: customerId },
      create: createFields,
      update: { ...createFields, firstName: "Resumed" },
    });
    assert.equal(
      await prisma.shopifyCustomerMirror.count({ where: { shop, id: customerId } }),
      1,
    );
    const customer = await prisma.shopifyCustomerMirror.findUniqueOrThrow({
      where: { id: customerId },
    });
    assert.equal(customer.firstName, "Resumed");
  });

  await check("cursor and counters persist before the next batch starts", async () => {
    const saved = await prisma.shopifySyncJob.updateMany({
      where: { id: shop, shop, leaseToken },
      data: {
        phase: "ORDERS",
        customerCursor: "customer-cursor-1",
        customersProcessed: { increment: 100 },
        customerPages: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    assert.equal(saved.count, 1);
    const job = await prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: shop } });
    assert.equal(job.phase, "ORDERS");
    assert.equal(job.customerCursor, "customer-cursor-1");
    assert.equal(job.customersProcessed, 100);
    assert.equal(job.customerPages, 1);
    assert.equal(job.leaseToken, null);
  });

  await check("order upserts are safe to replay and the sync can complete", async () => {
    const orderFields = {
      id: orderId,
      shop,
      customerId,
      orderName: "#SYNC-1",
      orderNumber: 1,
      totalPrice: 100,
      currencyCode: "INR",
      lineItemsJson: JSON.stringify([{ name: "Sync test product", quantity: 1 }]),
      syncedAt: new Date(),
    };
    await prisma.shopifyOrderMirror.upsert({
      where: { id: orderId },
      create: orderFields,
      update: orderFields,
    });
    await prisma.shopifyOrderMirror.upsert({
      where: { id: orderId },
      create: orderFields,
      update: { ...orderFields, orderName: "#SYNC-1-UPDATED" },
    });
    assert.equal(
      await prisma.shopifyOrderMirror.count({ where: { shop, id: orderId } }),
      1,
    );

    await prisma.shopifySyncJob.update({
      where: { id: shop },
      data: {
        orderCursor: null,
        ordersProcessed: { increment: 1 },
        orderPages: { increment: 1 },
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    const completed = await prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: shop } });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.ordersProcessed, 1);
    assert.ok(completed.completedAt);
  });

  await check("historical CSV orders can be stored before customer reconciliation", async () => {
    const csvOrderId = `gid://shopify/Order/${suffix}-csv`;
    const imported = await prisma.shopifyOrderMirror.create({
      data: {
        id: csvOrderId,
        shop,
        customerId: null,
        customerEmail: `${suffix}@example.test`,
        customerPhone: "+919000000099",
        customerName: "CSV Import Test",
        csvImportedAt: new Date(),
        orderName: "#CSV-1",
        totalPrice: 1499,
        currencyCode: "INR",
        lineItemsJson: JSON.stringify([{ name: "Historical test product", quantity: 1 }]),
      },
    });
    assert.equal(imported.customerId, null);
    assert.equal(imported.customerEmail, `${suffix}@example.test`);
    assert.ok(imported.csvImportedAt);
  });

  console.log(`Passed ${checks.length} Shopify sync checkpoint tests.`);
} finally {
  await prisma.shopifyOrderMirror.deleteMany({ where: { shop } });
  await prisma.shopifyCustomerMirror.deleteMany({ where: { shop } });
  await prisma.shopifySyncJob.deleteMany({ where: { shop } });
  await prisma.$disconnect();
}

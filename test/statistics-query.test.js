'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shopFixture, buyer, owner, staff } = require('./support/shop-fixture');
const { MemoryRepository } = require('./support/memory-repository');
const { StatisticsService } = require('../cloudfunctions/api/domain/statistics-service');
const { page, collect } = require('../cloudfunctions/api/domain/service-utils');
const code = expected => error => error.code === expected;
const range = { startAt: 1000000, endAt: 1001000 };

test('FR-10 成交、退款、净额分别对账，未支付/支付失败不计收入', async () => {
  const { paid, orders, fulfillment, afterSales, refunds, statistics } = shopFixture();
  let delivered = await paid({ delivery: true });
  delivered = await fulfillment.act(staff, 'accept', { orderId: delivered._id, expectedVersion: delivered.version, requestId: 'accept-stats-001' });
  delivered = await fulfillment.act(staff, 'ship', { orderId: delivered._id, expectedVersion: delivered.version,
    carrier: '测试', trackingNo: 'DEMO-0001', requestId: 'ship-stats-001' });
  await fulfillment.act(staff, 'complete', { orderId: delivered._id, expectedVersion: delivered.version, requestId: 'complete-stats-001' });
  const returned = await paid({ quantity: 1 });
  const sale = await afterSales.apply(buyer, { orderId: returned._id, reason: '测试', requestId: 'after-stats-001' });
  await afterSales.review(owner, { afterSaleId: sale._id, expectedVersion: 1, decision: 'approve', reason: '同意', requestId: 'review-stats-001' });
  await refunds.refundApproved(owner, sale._id);
  const unpaid = await orders.create(buyer, { requestId: 'unpaid-stats-001', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 1 }] });
  await orders.simulatePay(buyer, unpaid._id, { outcome: 'failure', attemptId: 'payment-stats-001' });
  const result = await statistics.summary(owner, range);
  assert.equal(result.grossCents, 4750);
  assert.equal(result.refundCents, 1250);
  assert.equal(result.netCents, 3500);
  assert.equal(result.paidOrderCount, 2);
  assert.equal(result.completedOrderCount, 1);
  assert.equal(result.productSales[0].quantity, 2);
});

test('FR-10 按收款/退款各自发生时间统计，允许跨期退款令本期净额为负', async () => {
  const { paid, refunds, statistics, setTime } = shopFixture();
  const order = await paid();
  setTime(1001000);
  await refunds.rejectOrder(owner, { orderId: order._id, expectedVersion: order.version, reason: '测试', requestId: 'reject-stats-001' });
  const result = await statistics.summary(owner, { startAt: 1001000, endAt: 1002000 });
  assert.equal(result.grossCents, 0);
  assert.equal(result.refundCents, 2500);
  assert.equal(result.netCents, -2500);
});

test('FR-10 超过100条记录跨页汇总，不受前端一页或筛选页大小影响', async () => {
  const payments = Object.fromEntries(Array.from({ length: 205 }, (_, i) => ['pay-' + String(i).padStart(4, '0'),
    { status: 'SUCCEEDED', mode: 'SIMULATED', amountCents: 100, createdAt: 1000000 }]));
  const repository = new MemoryRepository({ payments, refunds: {
    'refund-a': { status: 'SUCCEEDED', mode: 'SIMULATED', amountCents: 50, createdAt: 1000000 },
    'refund-b': { status: 'SUCCEEDED', mode: 'SIMULATED', amountCents: 50, createdAt: 1000000 }
  } });
  const result = await new StatisticsService(repository).summary(owner, range);
  assert.equal(result.paidOrderCount, 205);
  assert.equal(result.grossCents, 20500);
  assert.equal(result.refundCents, 100);
  assert.equal(result.netCents, 20400);
});

test('FR-10 已完成订单退款后不计当前有效销量，成交额原记录仍保留', async () => {
  const { paid, fulfillment, afterSales, refunds, statistics } = shopFixture();
  let order = await paid();
  for (const action of ['accept', 'readyForPickup']) order = await fulfillment.act(staff, action,
    { orderId: order._id, expectedVersion: order.version, requestId: 'sales-' + action + '-001' });
  const pickup = await fulfillment.pickupCode(buyer, order._id);
  order = await fulfillment.act(staff, 'complete', { orderId: order._id, expectedVersion: order.version,
    requestId: 'sales-complete-001', pickupCode: pickup.code });
  assert.equal((await statistics.summary(owner, range)).completedOrderCount, 1);
  const sale = await afterSales.apply(buyer, { orderId: order._id, reason: '测试', requestId: 'sales-after-001' });
  await afterSales.review(owner, { afterSaleId: sale._id, expectedVersion: 1, decision: 'approve', reason: '同意', requestId: 'sales-review-001' });
  await refunds.refundApproved(owner, sale._id);
  const result = await statistics.summary(owner, range);
  assert.equal(result.completedOrderCount, 0);
  assert.deepEqual(result.productSales, []);
  assert.equal(result.grossCents, 2500);
  assert.equal(result.refundCents, 2500);
});

test('FR-10 仅店主可统计，日期范围和半开区间边界受校验', async () => {
  const { statistics, repository } = shopFixture();
  await assert.rejects(statistics.summary(staff, range), code('FORBIDDEN'));
  await assert.rejects(statistics.summary(buyer, range), code('FORBIDDEN'));
  for (const input of [{ startAt: 0, endAt: 32 * 86400000 }, { startAt: 10, endAt: 10 }, { startAt: -1, endAt: 10 }]) {
    await assert.rejects(statistics.summary(owner, input), code('INVALID_REQUEST'));
  }
  await repository.transaction(async tx => {
    await tx.set('payments', 'start', { status: 'SUCCEEDED', mode: 'SIMULATED', createdAt: 1000000, amountCents: 100 });
    await tx.set('payments', 'end', { status: 'SUCCEEDED', mode: 'SIMULATED', createdAt: 1001000, amountCents: 999 });
  });
  assert.equal((await statistics.summary(owner, range)).grossCents, 100);
});

test('FR-10 损坏财务金额拒绝统计，不静默凑出错误总额', async () => {
  const { statistics, repository } = shopFixture();
  await repository.transaction(tx => tx.set('payments', 'bad', {
    status: 'SUCCEEDED', mode: 'SIMULATED', createdAt: 1000000, amountCents: 1.5 }));
  await assert.rejects(statistics.summary(owner, range), code('INVALID_AMOUNT'));
});

test('查询契约：页大小、损坏游标、缺适配器和不前进游标明确拒绝', async () => {
  const repository = new MemoryRepository();
  await assert.rejects(repository.transaction(tx => page(tx, 'orders', { scope: 'test', limit: 51 })), code('INVALID_REQUEST'));
  await assert.rejects(repository.transaction(tx => page(tx, 'orders', { scope: 'test', cursor: 'not-json' })), code('INVALID_CURSOR'));
  await assert.rejects(page({}, 'orders'), code('INVALID_CONFIG'));
  await assert.rejects(collect({}, 'orders', []), code('INVALID_CONFIG'));
  await assert.rejects(collect({ query: async () => Array.from({ length: 100 }, () => ({ _id: 'same' })) }, 'orders', []), code('INVALID_ADAPTER'));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shopFixture, buyer, other, owner, staff } = require('./support/shop-fixture');
const code = expected => error => error.code === expected;
const act = (service, action, order, extra = {}) => service.act(staff, action,
  { orderId: order._id, expectedVersion: order.version, requestId: 'fulfill-' + action + '-001', ...extra });

test('FR-07 配送接单→发货→完成，记录手工物流与完整版本时间线', async () => {
  const { paid, fulfillment, queries, repository } = shopFixture();
  let order = await paid({ delivery: true });
  order = await act(fulfillment, 'accept', order);
  order = await act(fulfillment, 'ship', order, { carrier: '测试承运方', trackingNo: 'DEMO-0001' });
  order = await act(fulfillment, 'complete', order);
  assert.equal(order.status, 'COMPLETED');
  assert.equal(order.fulfillment.trackingMode, 'MANUAL');
  assert.equal(order.fulfillment.trackingNo, 'DEMO-0001');
  const timeline = await queries.timeline(buyer, { orderId: order._id });
  assert.deepEqual(timeline.items.map(item => item.action), ['create', 'pay', 'accept', 'ship', 'complete']);
  assert.deepEqual(timeline.items.map(item => item.version), [1, 2, 3, 4, 5]);
  assert.equal(repository.snapshot().products.bread.onHand, 28);
});

test('FR-07 自取核销码仅本人读取，错误码不完成，成功只使用一次', async () => {
  const { paid, fulfillment, repository } = shopFixture();
  let order = await paid();
  order = await act(fulfillment, 'accept', order);
  order = await act(fulfillment, 'readyForPickup', order);
  assert.equal(order.pickupCode, undefined);
  const pickup = await fulfillment.pickupCode(buyer, order._id);
  assert.match(pickup.code, /^[0-9A-F]{12}$/);
  await assert.rejects(fulfillment.pickupCode(other, order._id), code('FORBIDDEN'));
  await assert.rejects(fulfillment.pickupCode(staff, order._id), code('FORBIDDEN'));
  await assert.rejects(act(fulfillment, 'complete', order, { pickupCode: 'wrong' }), code('INVALID_PICKUP_CODE'));
  const result = await act(fulfillment, 'complete', order, { pickupCode: pickup.code });
  assert.equal(result.status, 'COMPLETED');
  await act(fulfillment, 'complete', order, { pickupCode: pickup.code });
  assert.notEqual(repository.snapshot().pickup_codes[order._id].usedAt, null);
  await assert.rejects(fulfillment.pickupCode(buyer, order._id), code('INVALID_STATE'));
});

test('FR-07 顾客不能履约，未接单不能发货，自取与配送不可混用', async () => {
  const { paid, fulfillment } = shopFixture();
  let order = await paid();
  const input = { orderId: order._id, expectedVersion: order.version, requestId: 'fulfill-test-001' };
  await assert.rejects(fulfillment.act(buyer, 'accept', input), code('FORBIDDEN'));
  await assert.rejects(act(fulfillment, 'ship', order, { carrier: '测试', trackingNo: 'DEMO-0001' }), code('INVALID_STATE'));
  order = await act(fulfillment, 'accept', order);
  await assert.rejects(act(fulfillment, 'ship', order, { carrier: '测试', trackingNo: 'DEMO-0001' }), code('INVALID_DELIVERY'));
  await assert.rejects(act(fulfillment, 'complete', order), code('INVALID_STATE'));
});

test('FR-07 重复接单去重，旧版本和同请求变参拒绝，不多写事件', async () => {
  const { paid, fulfillment, repository } = shopFixture();
  const order = await paid();
  await Promise.all([act(fulfillment, 'accept', order), act(fulfillment, 'accept', order)]);
  assert.equal(Object.values(repository.snapshot().order_events).filter(row => row.action === 'accept').length, 1);
  await assert.rejects(act(fulfillment, 'accept', { ...order, version: 1 }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(act(fulfillment, 'accept', order, { requestId: 'fulfill-accept-002' }), code('VERSION_CONFLICT'));
});

test('FR-07 履约提交失败不留下状态、核销码、事件或去重记录', async () => {
  const { paid, fulfillment, repository } = shopFixture();
  let order = await paid();
  order = await act(fulfillment, 'accept', order);
  const before = repository.snapshot();
  repository.failNextCommit = true;
  await assert.rejects(act(fulfillment, 'readyForPickup', order), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), before);
  assert.equal((await act(fulfillment, 'readyForPickup', order)).status, 'READY_FOR_PICKUP');
});

test('FR-08 顾客申请→店主批准→整单模拟退款，无预置APPROVED夹具', async () => {
  const { paid, afterSales, refunds, repository } = shopFixture();
  const order = await paid();
  const applied = await afterSales.apply(buyer, { orderId: order._id, reason: '测试退款', requestId: 'after-apply-001' });
  assert.equal(applied.status, 'REQUESTED');
  const approved = await afterSales.review(owner, { afterSaleId: applied._id, decision: 'approve',
    expectedVersion: 1, reason: '同意退款', requestId: 'after-review-001' });
  assert.equal(approved.status, 'APPROVED');
  const refund = await refunds.refundApproved(owner, approved._id);
  assert.equal(refund.amountCents, 2500);
  assert.equal((await afterSales.get(buyer, approved._id)).status, 'REFUNDED');
  assert.equal((await afterSales.get(buyer, approved._id)).version, 3);
  assert.equal(repository.snapshot().products.bread.onHand, 30);
  assert.deepEqual(Object.values(repository.snapshot().after_sale_events).map(event => event.action), ['APPLY', 'APPROVED', 'REFUNDED']);
});

test('FR-08 售后归属和审核角色检查，申请不能自行批准或传退款金额', async () => {
  const { paid, afterSales } = shopFixture();
  const order = await paid();
  await assert.rejects(afterSales.apply(other, { orderId: order._id, reason: '测试', requestId: 'after-apply-001' }), code('FORBIDDEN'));
  const applied = await afterSales.apply(buyer, { orderId: order._id, reason: '测试', status: 'APPROVED', amountCents: 1, requestId: 'after-apply-002' });
  assert.equal(applied.status, 'REQUESTED');
  assert.equal(applied.amountCents, undefined);
  const input = { afterSaleId: applied._id, decision: 'approve', expectedVersion: 1, reason: '测试', requestId: 'after-review-001' };
  for (const actor of [buyer, staff]) await assert.rejects(afterSales.review(actor, input), code('FORBIDDEN'));
  await assert.rejects(afterSales.get(other, applied._id), code('FORBIDDEN'));
  await assert.rejects(afterSales.list(staff, { manage: true }), code('FORBIDDEN'));
});

test('FR-08 拒绝售后记录原因，可新请求重新申请，但不能并存两份处理中售后', async () => {
  const { paid, afterSales } = shopFixture();
  const order = await paid();
  const input = { orderId: order._id, reason: '测试售后', requestId: 'after-apply-001' };
  const first = await afterSales.apply(buyer, input);
  assert.equal((await afterSales.apply(buyer, input))._id, first._id);
  await assert.rejects(afterSales.apply(buyer, { ...input, requestId: 'after-apply-002' }), code('AFTER_SALE_EXISTS'));
  const reviewed = await afterSales.review(owner, { afterSaleId: first._id, decision: 'reject', expectedVersion: 1,
    reason: '需补充信息', requestId: 'after-review-001' });
  assert.equal(reviewed.status, 'REJECTED');
  const second = await afterSales.apply(buyer, { ...input, reason: '补充信息', requestId: 'after-apply-002' });
  assert.notEqual(second._id, first._id);
  assert.equal((await afterSales.list(buyer)).items.length, 2);
});

test('FR-08 售后审核去重/版本保护；事务失败无半成品申请', async () => {
  const { paid, afterSales, repository } = shopFixture();
  const order = await paid();
  const before = repository.snapshot();
  const input = { orderId: order._id, reason: '测试', requestId: 'after-apply-001' };
  repository.failNextCommit = true;
  await assert.rejects(afterSales.apply(buyer, input), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), before);
  const applied = await afterSales.apply(buyer, input);
  const review = { afterSaleId: applied._id, decision: 'approve', expectedVersion: 1, reason: '同意', requestId: 'after-review-001' };
  await assert.rejects(afterSales.review(owner, { ...review, expectedVersion: 2 }), code('VERSION_CONFLICT'));
  await afterSales.review(owner, review);
  await afterSales.review(owner, review);
  assert.equal(Object.keys(repository.snapshot().after_sale_events).length, 2);
});

test('FR-08 批准售后后冻结履约和商家拒单，退款失败可重试恢复', async () => {
  const { paid, afterSales, fulfillment, refunds, repository } = shopFixture();
  const order = await paid();
  const applied = await afterSales.apply(buyer, { orderId: order._id, reason: '测试', requestId: 'after-apply-001' });
  await afterSales.review(owner, { afterSaleId: applied._id, decision: 'approve', expectedVersion: 1, reason: '同意', requestId: 'after-review-001' });
  await assert.rejects(act(fulfillment, 'accept', order), code('AFTER_SALE_PENDING'));
  await assert.rejects(refunds.rejectOrder(owner, { orderId: order._id, expectedVersion: 2, requestId: 'reject-001', reason: '拒单' }), code('AFTER_SALE_PENDING'));
  repository.failNextCommit = true;
  await assert.rejects(refunds.refundApproved(owner, applied._id), /INJECTED_COMMIT_FAILURE/);
  assert.equal((await afterSales.get(buyer, applied._id)).status, 'APPROVED');
  await refunds.refundApproved(owner, applied._id);
  await refunds.refundApproved(owner, applied._id);
  assert.equal(Object.keys(repository.snapshot().refunds).length, 1);
  await assert.rejects(act(fulfillment, 'accept', order), code('INVALID_STATE'));
});

test('FR-07/08 接单与售后批准竞争遵循当前状态，退款不错误恢复已备货库存', async () => {
  const { paid, afterSales, fulfillment, refunds, repository } = shopFixture();
  const order = await paid();
  const applied = await afterSales.apply(buyer, { orderId: order._id, reason: '测试', requestId: 'after-apply-001' });
  await act(fulfillment, 'accept', order);
  await afterSales.review(owner, { afterSaleId: applied._id, decision: 'approve', expectedVersion: 1, reason: '同意', requestId: 'after-review-001' });
  const refund = await refunds.refundApproved(owner, applied._id);
  assert.equal(refund.restocked, false);
  assert.equal(repository.snapshot().products.bread.onHand, 28);
});

test('FR-07 订单列表和时间线按角色过滤，游标不能换查询或换用户复用', async () => {
  const { paid, queries } = shopFixture();
  const first = await paid();
  await paid(); await paid({ actor: other });
  const page1 = await queries.list(buyer, { limit: 1 });
  const page2 = await queries.list(buyer, { limit: 1, cursor: page1.nextCursor });
  assert.equal(page1.items.length + page2.items.length, 2);
  assert.notEqual(page1.items[0]._id, page2.items[0]._id);
  assert.equal((await queries.list(staff, { manage: true })).items.length, 3);
  await assert.rejects(queries.list(buyer, { manage: true }), code('FORBIDDEN'));
  await assert.rejects(queries.list(other, { cursor: page1.nextCursor }), code('INVALID_CURSOR'));
  await assert.rejects(queries.list(buyer, { status: 'COMPLETED', cursor: page1.nextCursor }), code('INVALID_CURSOR'));
  await assert.rejects(queries.timeline(other, { orderId: first._id }), code('FORBIDDEN'));
  assert.equal((await queries.timeline(staff, { orderId: first._id, manage: true })).items.length, 2);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../cloudfunctions/api/domain/order-service');
const { RefundService } = require('../cloudfunctions/api/domain/refund-service');
const { STATUS } = require('../cloudfunctions/api/domain/order-state');
const { MemoryRepository } = require('./support/memory-repository');

const buyer = { openid: 'buyer-demo', role: 'customer' };
const owner = { openid: 'owner-demo', role: 'owner', staffVerified: true };
const staff = { openid: 'staff-demo', role: 'staff', staffVerified: true };
const code = expected => error => error.code === expected;
const rows = (repository, table) => Object.values(repository.snapshot()[table] || {});

async function fixture({ paid = true, delivery = false } = {}) {
  const repository = new MemoryRepository({
    products: { bread: { _id: 'bread', name: '测试司康', priceCents: 1250, isOnSale: true,
      onHand: 10, reserved: 0, inventoryVersion: 0 } },
    addresses: { home: { _id: 'home', ownerOpenid: buyer.openid, name: '测试顾客', phone: 'TEST-PHONE',
      province: '内蒙古', city: '测试市', district: '测试区', detail: '测试地址' } }
  });
  const orders = new OrderService(repository, { clock: () => 1000000 });
  const refunds = new RefundService(repository, { clock: () => 1000000 });
  const checkout = { requestId: 'checkout-reject-001', items: [{ productId: 'bread', quantity: 2 }],
    deliveryType: delivery ? 'delivery' : 'pickup', ...(delivery ? { addressId: 'home' } : {}) };
  let order = await orders.create(buyer, checkout);
  if (paid) order = await orders.simulatePay(buyer, order._id);
  const input = { orderId: order._id, requestId: 'reject-001', reason: '当日无法备货', expectedVersion: order.version };
  const approval = { _id: 'after-sale-001', orderId: order._id, ownerOpenid: buyer.openid,
    status: 'APPROVED', approvedBy: owner.openid, approvedAt: 1000000, reason: '顾客退款申请' };
  return { repository, orders, refunds, order, checkout, input, approval };
}

test('FR-06 拒单原子退款含原运费，恢复库存并记录真实原因，不伪造售后单', async () => {
  const { repository, refunds, order, input } = await fixture({ delivery: true });
  const refund = await refunds.rejectOrder(owner, { ...input, amountCents: 1 });
  const result = rows(repository, 'orders')[0];
  assert.equal(refund.amountCents, order.amounts.totalCents);
  assert.equal(refund.amountCents, 3500);
  assert.equal(refund.source, 'MERCHANT_REJECTION');
  assert.equal(refund.mode, 'SIMULATED');
  assert.equal(refund.restocked, true);
  assert.equal(result.status, STATUS.CANCELLED);
  assert.equal(result.paymentStatus, 'REFUNDED');
  assert.equal(result.cancelReason, 'MERCHANT_REJECTION');
  assert.equal(result.rejectionReason, input.reason);
  assert.equal(result.version, 3);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().products.bread.inventoryVersion, 3);
  assert.equal(rows(repository, 'after_sales').length, 0);
  assert.equal(rows(repository, 'payments')[0].status, 'SUCCEEDED');
  assert.equal(rows(repository, 'order_events').at(-1).action, 'merchantReject');
});

test('FR-06 十次并发重试只退一次、恢复一次库存、记录一个拒单事件', async () => {
  const { repository, refunds, input } = await fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => refunds.rejectOrder(owner, input)));
  assert.equal(new Set(results.map(result => result._id)).size, 1);
  assert.equal(rows(repository, 'refunds').length, 1);
  assert.equal(rows(repository, 'order_events').length, 3);
  assert.equal(rows(repository, 'inventory_movements').filter(row => row.action === 'refundRestock').length, 1);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
});

test('FR-06 同一拒单请求不能变更原因、订单或预期版本', async () => {
  const { refunds, orders, input, checkout } = await fixture();
  await refunds.rejectOrder(owner, input);
  for (const change of [{ reason: '更改原因' }, { expectedVersion: 3 }]) {
    await assert.rejects(refunds.rejectOrder(owner, { ...input, ...change }), code('IDEMPOTENCY_CONFLICT'));
  }
  const other = await orders.create(buyer, { ...checkout, requestId: 'checkout-reject-002' });
  await assert.rejects(refunds.rejectOrder(owner, { ...input, orderId: other._id }), code('IDEMPOTENCY_CONFLICT'));
});

test('FR-01 顾客、店员、未认证店主不能拒单退款，重试也需认证', async () => {
  const { refunds, input } = await fixture();
  await refunds.rejectOrder(owner, input);
  for (const actor of [buyer, staff, { openid: owner.openid, role: 'owner' }]) {
    await assert.rejects(refunds.rejectOrder(actor, input), code('FORBIDDEN'));
  }
});

test('FR-06 未支付订单不能从商家拒单入口变成已退款', async () => {
  const { repository, refunds, input } = await fixture({ paid: false });
  await assert.rejects(refunds.rejectOrder(owner, input), code('INVALID_STATE'));
  assert.equal(repository.snapshot().products.bread.reserved, 2);
  assert.equal(rows(repository, 'refunds').length, 0);
});

test('FR-06 拒单必须填写原因、请求ID和版本，空白与超长原因无效', async () => {
  const { refunds, input } = await fixture();
  for (const change of [{ reason: '' }, { reason: '  ' }, { reason: '字'.repeat(201) },
    { expectedVersion: undefined }, { expectedVersion: 1.5 }, { requestId: 'short' }, { orderId: '../bad' }]) {
    await assert.rejects(refunds.rejectOrder(owner, { ...input, ...change }), code('INVALID_REQUEST'));
  }
});

test('FR-06 旧版本拒单不会覆盖新业务状态', async () => {
  const { repository, refunds, input } = await fixture();
  const before = repository.snapshot();
  await assert.rejects(refunds.rejectOrder(owner, { ...input, expectedVersion: 1 }), code('VERSION_CONFLICT'));
  assert.deepEqual(repository.snapshot(), before);
});

test('FR-06 已接单即使带最新版本也不能走拒单入口，应进入售后流程', async () => {
  const { repository, refunds, input } = await fixture();
  // 模拟C未来的接单提交；此夹具不表示履约服务已完成。
  await repository.transaction(async tx => {
    const order = await tx.get('orders', input.orderId);
    await tx.set('orders', order._id, { ...order, status: STATUS.ACCEPTED, version: 3 });
  });
  await assert.rejects(refunds.rejectOrder(owner, input), code('VERSION_CONFLICT'));
  await assert.rejects(refunds.rejectOrder(owner, { ...input, expectedVersion: 3 }), code('INVALID_STATE'));
  assert.equal(repository.snapshot().products.bread.onHand, 8);
});

test('FR-06 拒单提交失败时订单、退款、流水与去重记录全部回滚，可按原参数重试', async () => {
  const { repository, refunds, input } = await fixture();
  const before = repository.snapshot();
  repository.failNextCommit = true;
  await assert.rejects(refunds.rejectOrder(owner, input), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), before);
  await refunds.rejectOrder(owner, input);
  assert.equal(rows(repository, 'refunds').length, 1);
});

test('FR-06 原支付金额不一致时拒单失败且不修改库存', async () => {
  const { repository, refunds, input } = await fixture();
  await repository.transaction(async tx => {
    const id = 'pay_' + input.orderId;
    await tx.set('payments', id, { ...await tx.get('payments', id), amountCents: 1 });
  });
  const before = repository.snapshot();
  await assert.rejects(refunds.rejectOrder(owner, input), code('INVALID_PAYMENT'));
  assert.deepEqual(repository.snapshot(), before);
});

test('FR-06 拒单不影响其他订单的预留，商品下架仍能恢复已支付库存', async () => {
  const { repository, refunds, orders, checkout, input } = await fixture();
  await orders.create({ ...buyer, openid: 'buyer-other' }, { ...checkout, requestId: 'checkout-other' });
  await repository.transaction(async tx => {
    await tx.set('products', 'bread', { ...await tx.get('products', 'bread'), isOnSale: false });
  });
  await refunds.rejectOrder(owner, input);
  const product = repository.snapshot().products.bread;
  assert.equal(product.reserved, 2);
  assert.equal(product.onHand, 10);
  assert.equal(product.isOnSale, false);
});

test('FR-08 拒单和售后退款竞争最多一笔成功，重试不得产生第二次退款', async () => {
  for (const rejectFirst of [true, false]) {
    const { repository, refunds, input, approval } = await fixture();
    await repository.transaction(tx => tx.set('after_sales', approval._id, approval));
    const actions = [() => refunds.rejectOrder(owner, input), () => refunds.refundApproved(owner, approval._id)];
    if (!rejectFirst) actions.reverse();
    const results = await Promise.allSettled(actions.map(action => action()));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ALREADY_REFUNDED');
    assert.equal(rows(repository, 'refunds').length, 1);
    assert.equal(repository.snapshot().products.bread.onHand, 10);
  }
});

test('FR-06 同一订单换新请求也不能再次拒单退款', async () => {
  const { refunds, input } = await fixture();
  await refunds.rejectOrder(owner, input);
  await assert.rejects(refunds.rejectOrder(owner, { ...input, requestId: 'reject-002' }), code('ALREADY_REFUNDED'));
});

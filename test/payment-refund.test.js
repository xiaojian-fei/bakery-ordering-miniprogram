'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../cloudfunctions/api/domain/order-service');
const { RefundService } = require('../cloudfunctions/api/domain/refund-service');
const { STATUS } = require('../cloudfunctions/api/domain/order-state');
const { MemoryRepository } = require('./support/memory-repository');

const buyer = { openid: 'buyer-demo', role: 'customer' };
const stranger = { openid: 'other-demo', role: 'customer' };
const owner = { openid: 'owner-demo', role: 'owner', staffVerified: true };
const staff = { openid: 'staff-demo', role: 'staff', staffVerified: true };
const code = value => error => error.code === value;
const rows = (repository, collection) => Object.values(repository.snapshot()[collection] || {});

async function fixture({ paid = false, status } = {}) {
  let now = 1000000;
  const repository = new MemoryRepository({ products: {
    bread: { _id: 'bread', name: '测试商品', priceCents: 1250, isOnSale: true, onHand: 10, reserved: 0 }
  } });
  const orders = new OrderService(repository, { clock: () => now });
  const refunds = new RefundService(repository, { clock: () => now });
  const input = { requestId: 'checkout-001', items: [{ productId: 'bread', quantity: 2 }], deliveryType: 'pickup' };
  let order = await orders.create(buyer, input);
  if (paid) order = await orders.simulatePay(buyer, order._id);
  if (status) {
    await repository.transaction(async tx => {
      const record = await tx.get('orders', order._id);
      record.status = status;
      await tx.set('orders', order._id, record);
    });
  }
  // 测试夹具模拟C未来的受保护审核服务输出，不表示真实审核流程已实现。
  const approval = { _id: 'after-sale-001', orderId: order._id, ownerOpenid: buyer.openid,
    status: 'APPROVED', approvedBy: owner.openid, approvedAt: now, reason: '演示整单退款' };
  await repository.transaction(tx => tx.set('after_sales', approval._id, approval));
  return { repository, orders, refunds, order, approval, input, setTime: value => { now = value; } };
}

test('FR-06 模拟支付失败保留待支付与原库存，不形成成功收款记录', async () => {
  const { repository, orders, order } = await fixture();
  const result = await orders.simulatePay(buyer, order._id,
    { outcome: 'failure', attemptId: 'attempt-001', reasonCode: 'DECLINED' });
  assert.equal(result.status, STATUS.PENDING_PAYMENT);
  assert.equal(result.paymentStatus, 'UNPAID');
  assert.equal(result.version, 2);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
  assert.equal(rows(repository, 'payments').length, 0);
  assert.equal(rows(repository, 'payment_attempts')[0].outcome, 'FAILED');
  assert.equal(rows(repository, 'order_events').at(-1).action, 'paymentFailed');
});

test('FR-06 相同失败支付尝试重试十次，只记录一次；之后可以成功支付', async () => {
  const { repository, orders, order } = await fixture();
  await Promise.all(Array.from({ length: 10 }, () => orders.simulatePay(buyer, order._id,
    { outcome: 'failure', attemptId: 'attempt-001', expectedVersion: 1 })));
  assert.equal(rows(repository, 'payment_attempts').length, 1);
  assert.equal(rows(repository, 'order_events').length, 2);
  const paid = await orders.simulatePay(buyer, order._id, { expectedVersion: 2 });
  assert.equal(paid.paymentStatus, 'PAID');
  assert.equal(repository.snapshot().products.bread.onHand, 8);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
});

test('FR-06 失败尝试ID不能修改原因或用于不同订单', async () => {
  const { orders, order, input } = await fixture();
  const options = { outcome: 'failure', attemptId: 'attempt-001' };
  await orders.simulatePay(buyer, order._id, options);
  await assert.rejects(orders.simulatePay(buyer, order._id, { ...options, reasonCode: 'NETWORK_ERROR' }), code('IDEMPOTENCY_CONFLICT'));
  const second = await orders.create(buyer, { ...input, requestId: 'checkout-002' });
  await assert.rejects(orders.simulatePay(buyer, second._id, options), code('IDEMPOTENCY_CONFLICT'));
});

test('FR-06 失败支付提交异常时，尝试日志、订单版本与事件全部回滚', async () => {
  const { repository, orders, order } = await fixture();
  repository.failNextCommit = true;
  await assert.rejects(orders.simulatePay(buyer, order._id, { outcome: 'failure', attemptId: 'attempt-001' }), /INJECTED_COMMIT_FAILURE/);
  assert.equal(rows(repository, 'payment_attempts').length, 0);
  assert.equal(rows(repository, 'orders')[0].version, 1);
  assert.equal(rows(repository, 'order_events').length, 1);
});

test('FR-01 不能给其他人的订单写入失败支付记录', async () => {
  const { repository, orders, order } = await fixture();
  await assert.rejects(orders.simulatePay(stranger, order._id, { outcome: 'failure', attemptId: 'attempt-001' }), code('FORBIDDEN'));
  assert.equal(rows(repository, 'payment_attempts').length, 0);
});

test('FR-06 支付失败也受截止时间、版本和当前状态限制', async () => {
  const { orders, order, setTime } = await fixture();
  const options = { outcome: 'failure', attemptId: 'attempt-001' };
  await assert.rejects(orders.simulatePay(buyer, order._id, { ...options, expectedVersion: 2 }), code('VERSION_CONFLICT'));
  setTime(order.expiresAt);
  await assert.rejects(orders.simulatePay(buyer, order._id, options), code('ORDER_EXPIRED'));
  const paid = await fixture({ paid: true });
  await assert.rejects(paid.orders.simulatePay(buyer, paid.order._id, options), code('INVALID_STATE'));
});

test('FR-06 不接受含糊的success:false或未知模拟支付结果', async () => {
  const { orders, order } = await fixture();
  await assert.rejects(orders.simulatePay(buyer, order._id, { success: false }), code('INVALID_REQUEST'));
  await assert.rejects(orders.simulatePay(buyer, order._id, { outcome: 'unknown' }), code('INVALID_REQUEST'));
  await assert.rejects(orders.simulatePay(buyer, order._id, { outcome: 'failure' }), code('INVALID_REQUEST'));
});

test('FR-08 待接单整单退款按已支付金额执行，恢复库存并关闭待履约订单', async () => {
  const { repository, refunds, order, approval } = await fixture({ paid: true });
  const result = await refunds.refundApproved(owner, approval._id);
  assert.equal(result.amountCents, 2500);
  assert.equal(result.mode, 'SIMULATED');
  assert.equal(result.restocked, true);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
  assert.equal(rows(repository, 'orders')[0].status, STATUS.CANCELLED);
  assert.equal(rows(repository, 'orders')[0].paymentStatus, 'REFUNDED');
  assert.equal(rows(repository, 'after_sales')[0].status, 'REFUNDED');
  assert.equal(rows(repository, 'payments')[0].status, 'SUCCEEDED');
  assert.equal(rows(repository, 'order_events').at(-1).action, 'refund');
  assert.equal(result.orderId, order._id);
});

test('FR-08 重复退款十次只产生一条退款、一次库存恢复和一个事件', async () => {
  const { repository, refunds, approval } = await fixture({ paid: true });
  const results = await Promise.all(Array.from({ length: 10 }, () => refunds.refundApproved(owner, approval._id, { expectedOrderVersion: 2 })));
  assert.equal(new Set(results.map(row => row._id)).size, 1);
  assert.equal(rows(repository, 'refunds').length, 1);
  assert.equal(rows(repository, 'order_events').length, 3);
  assert.equal(rows(repository, 'inventory_movements').filter(row => row.action === 'refundRestock').length, 1);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
});

for (const status of [STATUS.ACCEPTED, STATUS.READY_FOR_PICKUP, STATUS.SHIPPING, STATUS.COMPLETED]) {
  test('FR-08 ' + status + '退款不自动恢复烘焙品可售库存', async () => {
    const { repository, refunds, approval } = await fixture({ paid: true, status });
    const result = await refunds.refundApproved(owner, approval._id);
    assert.equal(result.restocked, false);
    assert.equal(repository.snapshot().products.bread.onHand, 8);
    assert.equal(rows(repository, 'orders')[0].paymentStatus, 'REFUNDED');
    assert.equal(rows(repository, 'orders')[0].status,
      [STATUS.SHIPPING, STATUS.COMPLETED].includes(status) ? status : STATUS.CANCELLED);
  });
}

test('FR-08 未支付订单、未审批售后与错配归属都不允许退款', async () => {
  const unpaid = await fixture();
  await assert.rejects(unpaid.refunds.refundApproved(owner, unpaid.approval._id), code('INVALID_STATE'));
  const { repository, refunds, approval } = await fixture({ paid: true });
  await repository.transaction(tx => tx.set('after_sales', approval._id, { ...approval, status: 'REQUESTED' }));
  await assert.rejects(refunds.refundApproved(owner, approval._id), code('AFTER_SALE_NOT_APPROVED'));
  await repository.transaction(tx => tx.set('after_sales', approval._id, { ...approval, ownerOpenid: stranger.openid }));
  await assert.rejects(refunds.refundApproved(owner, approval._id), code('INVALID_AFTER_SALE'));
});

test('FR-01 顾客、店员和未验证的店主都不能执行退款', async () => {
  const { refunds, approval } = await fixture({ paid: true });
  for (const actor of [buyer, staff, { openid: owner.openid, role: 'owner' }]) {
    await assert.rejects(refunds.refundApproved(actor, approval._id), code('FORBIDDEN'));
  }
});

test('FR-08 退款提交失败时，财务、库存、售后与订单记录全部回滚并可重试', async () => {
  const { repository, refunds, approval } = await fixture({ paid: true });
  repository.failNextCommit = true;
  await assert.rejects(refunds.refundApproved(owner, approval._id), /INJECTED_COMMIT_FAILURE/);
  assert.equal(rows(repository, 'refunds').length, 0);
  assert.equal(repository.snapshot().products.bread.onHand, 8);
  assert.equal(rows(repository, 'orders')[0].paymentStatus, 'PAID');
  assert.equal(rows(repository, 'after_sales')[0].status, 'APPROVED');
  await refunds.refundApproved(owner, approval._id);
  assert.equal(rows(repository, 'refunds').length, 1);
});

test('FR-08 同一订单另一个已审批售后不能再次退款', async () => {
  const { repository, refunds, approval } = await fixture({ paid: true });
  await repository.transaction(tx => tx.set('after_sales', 'after-sale-002', { ...approval, _id: 'after-sale-002' }));
  await refunds.refundApproved(owner, approval._id);
  await assert.rejects(refunds.refundApproved(owner, 'after-sale-002'), code('ALREADY_REFUNDED'));
  assert.equal(rows(repository, 'refunds').length, 1);
});

test('FR-08 订单版本或原支付金额不一致时拒绝退款', async () => {
  const { repository, refunds, approval, order } = await fixture({ paid: true });
  await assert.rejects(refunds.refundApproved(owner, approval._id, { expectedOrderVersion: 1 }), code('VERSION_CONFLICT'));
  await repository.transaction(async tx => {
    const payment = await tx.get('payments', 'pay_' + order._id);
    payment.amountCents = 1;
    await tx.set('payments', 'pay_' + order._id, payment);
  });
  await assert.rejects(refunds.refundApproved(owner, approval._id), code('INVALID_PAYMENT'));
  assert.equal(rows(repository, 'refunds').length, 0);
});

test('FR-08 已退款订单不能再次支付；库存恢复不影响其他订单的预留', async () => {
  const { repository, orders, refunds, approval, order, input } = await fixture({ paid: true });
  await orders.create(stranger, { ...input, requestId: 'checkout-other' });
  await refunds.refundApproved(owner, approval._id);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
  await assert.rejects(orders.simulatePay(buyer, order._id), code('INVALID_STATE'));
});

test('FR-07 不能误用交易修改器履约而释放其他订单的预留', async () => {
  const { repository, orders, order, input } = await fixture({ paid: true });
  await orders.create(stranger, { ...input, requestId: 'checkout-other' });
  const ownerAsBuyer = { ...owner, openid: buyer.openid };
  await assert.rejects(orders.change(ownerAsBuyer, order._id, 'accept'), code('INVALID_ACTION'));
  assert.equal(repository.snapshot().products.bread.reserved, 2);
  assert.equal(repository.snapshot().products.bread.onHand, 8);
});

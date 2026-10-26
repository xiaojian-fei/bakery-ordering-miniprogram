'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../cloudfunctions/api/application');
const { createTradeClient } = require('../services/trade-client');
const { authFixture, DEMO_PASSWORD } = require('./support/auth-fixture');
const { addressInput } = require('./support/shop-fixture');

async function fixture() {
  const base = await authFixture();
  const app = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.demoSubject }) });
  const client = openid => createTradeClient({ clock: base.clock, send: request => app.handle(request, { demoSubject: openid }) });
  const owner = client('owner-demo'), staff = client('staff-demo'), buyer = client('buyer-demo');
  await owner.staff.login(DEMO_PASSWORD); await staff.staff.login(DEMO_PASSWORD);
  return { ...base, app, owner, staff, buyer, other: client('other-demo') };
}

test('全流程客户端：商品→地址→购物车→可信结算→支付→配送→完成→统计', async () => {
  const { owner, staff, buyer, repository } = await fixture();
  assert.equal((await buyer.catalog.list()).items.length, 1);
  await buyer.addresses.save(addressInput());
  const address = (await buyer.addresses.list()).items[0];
  const cart = await buyer.cart.setLine({ productId: 'bread', quantity: 2, expectedVersion: 0, requestId: 'cart-full-001' });
  const checked = await buyer.cart.get();
  assert.equal(checked.canCheckout, true);
  const attempt = await buyer.prepareCheckout({ requestId: 'checkout-full-001', deliveryType: 'delivery',
    addressId: address._id, items: checked.items.map(({ productId, quantity }) => ({ productId, quantity })) });
  let order = await attempt.submit();
  await buyer.cart.clear({ expectedVersion: cart.version, requestId: 'clear-full-001' });
  order = await buyer.orders.pay(order._id);
  assert.equal((await staff.orders.list({ manage: true })).items.length, 1);
  order = await staff.fulfillment.accept({ orderId: order._id, expectedVersion: order.version, requestId: 'accept-full-001' });
  order = await staff.fulfillment.ship({ orderId: order._id, expectedVersion: order.version,
    requestId: 'ship-full-001', carrier: '测试承运方', trackingNo: 'DEMO-FULL-001' });
  order = await staff.fulfillment.complete({ orderId: order._id, expectedVersion: order.version, requestId: 'complete-full-001' });
  assert.equal(order.status, 'COMPLETED');
  assert.equal((await buyer.orders.timeline({ orderId: order._id })).items.length, 5);
  const summary = await owner.statistics.summary({ startAt: 1000000, endAt: 1001000 });
  assert.equal(summary.grossCents, 3500);
  assert.equal(summary.netCents, 3500);
  assert.equal(summary.completedOrderCount, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
});

test('全流程客户端：自取准备→本人取码→店员核销，不输出码到订单列表', async () => {
  const { staff, buyer } = await fixture();
  let order = await (await buyer.prepareCheckout({ requestId: 'checkout-pickup-001', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 1 }] })).submit();
  order = await buyer.orders.pay(order._id);
  order = await staff.fulfillment.accept({ orderId: order._id, expectedVersion: order.version, requestId: 'accept-pickup-001' });
  order = await staff.fulfillment.readyForPickup({ orderId: order._id, expectedVersion: order.version, requestId: 'ready-pickup-001' });
  const code = (await buyer.orders.pickupCode(order._id)).code;
  assert.ok(!JSON.stringify(await staff.orders.list({ manage: true })).includes(code));
  const completed = await staff.fulfillment.complete({ orderId: order._id, expectedVersion: order.version,
    pickupCode: code, requestId: 'complete-pickup-001' });
  assert.equal(completed.status, 'COMPLETED');
});

test('全流程客户端：顾客申请→店主审核→退款→售后查询及经营对账', async () => {
  const { owner, buyer, staff } = await fixture();
  let order = await (await buyer.prepareCheckout({ requestId: 'checkout-after-001', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 2 }] })).submit();
  order = await buyer.orders.pay(order._id);
  const after = await buyer.afterSales.apply({ orderId: order._id, reason: '演示售后', requestId: 'after-full-001' });
  assert.equal((await owner.afterSales.list({ manage: true, status: 'REQUESTED' })).items.length, 1);
  await assert.rejects(staff.afterSales.review({ afterSaleId: after._id, decision: 'approve', expectedVersion: 1,
    reason: '越权', requestId: 'review-full-denied' }), error => error.code === 'FORBIDDEN');
  await owner.afterSales.review({ afterSaleId: after._id, decision: 'approve', expectedVersion: 1,
    reason: '同意模拟退款', requestId: 'review-full-001' });
  await owner.refunds.executeApproved({ afterSaleId: after._id });
  assert.equal((await buyer.afterSales.get(after._id)).status, 'REFUNDED');
  const summary = await owner.statistics.summary({ startAt: 1000000, endAt: 1001000 });
  assert.equal(summary.grossCents, 2500);
  assert.equal(summary.refundCents, 2500);
  assert.equal(summary.netCents, 0);
});

test('统一入口：顾客/店员不能伪造管理角色，其他顾客数据不可读写', async () => {
  const { app, buyer, other, staff } = await fixture();
  await buyer.addresses.save(addressInput());
  await assert.rejects(other.addresses.remove({ addressId: 'home', expectedVersion: 1, requestId: 'remove-forged-001' }), error => error.code === 'FORBIDDEN');
  await assert.rejects(buyer.orders.list({ manage: true }), error => error.code === 'FORBIDDEN');
  await assert.rejects(staff.statistics.summary({ startAt: 1000000, endAt: 1001000 }), error => error.code === 'FORBIDDEN');
  for (const action of ['catalog.save', 'afterSales.review', 'statistics.summary']) {
    const response = await app.handle({ action, role: 'owner', data: { role: 'owner', staffVerified: true } }, { demoSubject: 'buyer-demo' });
    assert.equal(response.error.code, 'FORBIDDEN');
  }
});

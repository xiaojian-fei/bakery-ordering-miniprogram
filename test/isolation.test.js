'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shopFixture, buyer, other, owner, staff, addressInput } = require('./support/shop-fixture');

const code = expected => error => error.code === expected;

/**
 * 可见性矩阵：顾客只能看到自己的订单、地址、购物车、售后；店员与店主按职责看全部；
 * 商品与库存对所有已登录用户可见。
 *
 * 这条矩阵是"多人共用一个部署"的前提：数据存在同一个库里，但谁能看到什么由服务端判定，
 * 不靠前端隐藏。
 */
async function fixtureWithPaidOrder() {
  const base = shopFixture();
  const order = await base.paid({ delivery: true, quantity: 1 });
  const address = await base.addresses.get(buyer, 'home-1');
  return { ...base, order, address };
}

test('可见性：顾客只能列出自己的订单', async () => {
  const { queries, order } = await fixtureWithPaidOrder();
  const mine = await queries.list(buyer, {});
  assert.ok(mine.items.some(item => item._id === order._id));
  const theirs = await queries.list(other, {});
  assert.equal(theirs.items.length, 0, '其他顾客不能看到别人的订单');
});

test('可见性：顾客不能按订单号直接读取、支付或取消他人订单', async () => {
  const { orders, queries, order } = await fixtureWithPaidOrder();
  await assert.rejects(orders.get(other, order._id), code('FORBIDDEN'));
  await assert.rejects(queries.timeline(other, { orderId: order._id }), code('FORBIDDEN'));
  await assert.rejects(orders.cancel(other, order._id, { expectedVersion: order.version }), code('FORBIDDEN'));
  // 自己读自己的订单是允许的
  assert.equal((await orders.get(buyer, order._id))._id, order._id);
});

test('可见性：顾客不能使用员工视角的 manage 参数', async () => {
  const { queries } = await fixtureWithPaidOrder();
  await assert.rejects(queries.list(other, { manage: true }), code('FORBIDDEN'));
});

test('可见性：店员与店主可以查看全部订单', async () => {
  const { queries, order } = await fixtureWithPaidOrder();
  for (const actor of [staff, owner]) {
    const list = await queries.list(actor, { manage: true });
    assert.ok(list.items.some(item => item._id === order._id), actor.role + ' 应能看到顾客订单');
  }
});

test('可见性：收货地址按顾客隔离', async () => {
  const { addresses, address } = await fixtureWithPaidOrder();
  await assert.rejects(addresses.get(other, address._id), code('FORBIDDEN'));
  const theirs = await addresses.list(other, {});
  assert.equal(theirs.items.length, 0, '其他顾客不能列出别人地址');
  assert.equal((await addresses.get(buyer, address._id))._id, address._id);
});

test('可见性：购物车按顾客隔离', async () => {
  const { cart } = shopFixture();
  await cart.setLine(buyer, { productId: 'bread', quantity: 2, expectedVersion: 0, requestId: 'cart-buyer-1' });
  const mine = await cart.get(buyer);
  const theirs = await cart.get(other);
  assert.equal(mine.items.length, 1);
  assert.equal(theirs.items.length, 0, '其他顾客的购物车是空的');
  assert.equal(theirs.version, 0);
});

test('可见性：不能对他人的订单发起售后，售后列表也按顾客隔离', async () => {
  const { afterSales, order } = await fixtureWithPaidOrder();
  await assert.rejects(afterSales.apply(other, {
    orderId: order._id, requestId: 'after-other-1', reason: '不是我的订单'
  }), code('FORBIDDEN'));

  const applied = await afterSales.apply(buyer, {
    orderId: order._id, requestId: 'after-buyer-1', reason: '商品破损'
  });
  assert.equal((await afterSales.list(buyer, {})).items.length, 1);
  assert.equal((await afterSales.list(other, {})).items.length, 0, '其他顾客看不到别人的售后');
  await assert.rejects(afterSales.get(other, afterSaleIdOf(applied)), code('FORBIDDEN'));
});

const afterSaleIdOf = record => record._id;

test('可见性：经营统计只对店主开放', async () => {
  const { statistics } = await fixtureWithPaidOrder();
  // 夹具时钟从 1000000 起，区间必须非负
  const range = { startAt: 0, endAt: 1000000 };
  await assert.rejects(statistics.summary(buyer, range), code('FORBIDDEN'));
  await assert.rejects(statistics.summary(staff, range), code('FORBIDDEN'));
  const summary = await statistics.summary(owner, range);
  assert.ok(Number.isSafeInteger(summary.grossCents));
});

test('可见性：商品与库存对所有已登录用户可见', async () => {
  const { catalog } = shopFixture();
  const mine = await catalog.list(buyer, {});
  const theirs = await catalog.list(other, {});
  assert.deepEqual(theirs.items.map(item => item._id), mine.items.map(item => item._id));
  const product = await catalog.get(other, 'bread');
  assert.equal(product.available, product.onHandAvailable ?? product.available);
  assert.equal(typeof product.available, 'number', '库存可售数量对顾客可见');
  // 但"看得到库存"不等于"能改库存"
  const { InventoryService } = require('../core/domain/inventory-service');
  const inventory = new InventoryService(shopFixture().repository, { clock: () => 1000000 });
  await assert.rejects(inventory.adjust(other, {
    requestId: 'stock-other-1', productId: 'bread', onHand: 999, expectedVersion: 0, reason: '越权改库存'
  }), code('FORBIDDEN'));
});

test('可见性：自取核销码只给下单顾客，店员不能代替查询', async () => {
  const base = shopFixture();
  let order = await base.paid({ delivery: false, quantity: 1 });
  order = await base.fulfillment.act(staff, 'accept', {
    orderId: order._id, expectedVersion: order.version, requestId: 'iso-accept-1'
  });
  order = await base.fulfillment.act(staff, 'readyForPickup', {
    orderId: order._id, expectedVersion: order.version, requestId: 'iso-ready-1'
  });
  assert.equal(order.status, 'READY_FOR_PICKUP');

  const codeForCustomer = await base.fulfillment.pickupCode(buyer, order._id);
  assert.match(codeForCustomer.code, /^[0-9A-F]{12}$/);
  await assert.rejects(base.fulfillment.pickupCode(staff, order._id), code('FORBIDDEN'));
  await assert.rejects(base.fulfillment.pickupCode(other, order._id), code('FORBIDDEN'));
});

test('可见性：系统身份不能代顾客下单', async () => {
  const { orders } = shopFixture();
  const system = { openid: 'scheduled-task', role: 'system', trustedSystem: true };
  await assert.rejects(orders.create(system, {
    requestId: 'sys-order-1', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 1 }]
  }), code('FORBIDDEN'));
});
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../cloudfunctions/api/application');
const { createTradeClient } = require('../services/trade-client');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { shopFixture, buyer, staff } = require('./support/shop-fixture');
const { miniappHarness } = require('./support/miniapp-harness');

const event = id => ({ currentTarget: { dataset: { id } } });

async function fixture() {
  const shop = shopFixture();
  let sequence = 0, subject = buyer.openid, dropAction = '';
  const requests = [];
  const app = createApplication({ repository: shop.repository, clock: shop.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const client = createTradeClient({ clock: shop.clock, send: async request => {
    requests.push(structuredClone(request));
    const result = await app.handle(request, { subject });
    if (request.action === dropAction) {
      dropAction = '';
      throw new Error('response lost');
    }
    return result;
  } });
  const runtime = createMiniappRuntime({ client, subjectId: buyer.openid, requestId: () => 'page-actions-' + (++sequence) });
  const ui = miniappHarness(runtime);
  const page = ui.loadPage('pages/orders/orders');
  const order = await shop.orders.create(buyer, { requestId: 'action-order-1', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 1 }] });
  await page.onShow();
  async function choose(task, confirm = true) {
    const previous = ui.events.filter(entry => entry.name === 'showModal').length;
    const operation = task();
    for (let i = 0; i < 20 && ui.events.filter(entry => entry.name === 'showModal').length === previous; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const dialogs = ui.events.filter(entry => entry.name === 'showModal');
    assert.equal(dialogs.length, previous + 1);
    dialogs.at(-1).options.success({ confirm });
    await operation;
  }
  return { ...shop, page, order, requests, choose, runtime, ui, drop: action => { dropAction = action; },
    switchSubject: value => { subject = value; } };
}

test('订单操作：模拟支付需要确认，成功后刷新为待接单', async () => {
  const { page, order, orders, choose, requests } = await fixture();
  await choose(() => page.payOrder(event(order._id)), false);
  assert.equal(requests.some(row => row.action === 'orders.pay'), false);
  await choose(() => page.payOrder(event(order._id)));
  assert.equal((await orders.get(buyer, order._id)).paymentStatus, 'PAID');
  assert.equal(page.data.orderRows[0].status, '待接单');
  assert.equal(page.data.orderRows[0].canPay, false);
  assert.equal(page.data.actionNotice, '模拟支付成功');
});

test('订单操作：取消待支付订单后释放预留库存', async () => {
  const { page, order, repository, choose } = await fixture();
  assert.equal(repository.snapshot().products.bread.reserved, 1);
  await choose(() => page.cancelPendingOrder(event(order._id)));
  assert.equal(repository.snapshot().products.bread.reserved, 0);
  assert.equal(page.data.orderRows[0].status, '已取消');
});

test('订单操作：支付响应丢失时只查询状态，不重复发送支付', async () => {
  const { page, order, choose, requests, drop } = await fixture();
  drop('orders.pay');
  await choose(() => page.payOrder(event(order._id)));
  assert.equal(requests.filter(row => row.action === 'orders.pay').length, 1);
  assert.equal(page.data.orderRows[0].status, '待接单');
  assert.match(page.data.actionError, /待核对/);
});

test('订单操作：旧版本取消被拒绝，刷新显示已经支付的状态', async () => {
  const { page, order, orders, choose } = await fixture();
  await orders.simulatePay(buyer, order._id);
  await choose(() => page.cancelPendingOrder(event(order._id)));
  assert.equal(page.data.orderRows[0].status, '待接单');
  assert.ok(page.data.actionError);
});

test('订单操作：确认前离开页面，随后确认也不发送支付', async () => {
  const { page, order, choose, requests } = await fixture();
  await choose(() => page.payOrder(event(order._id)), {
    get confirm() { page.onHide(); return true; }
  });
  assert.equal(requests.some(row => row.action === 'orders.pay'), false);
});

test('订单操作：过期订单拒绝模拟支付，库存仍待过期处理释放', async () => {
  const { page, order, orders, choose, setTime, repository } = await fixture();
  setTime(order.expiresAt);
  await choose(() => page.payOrder(event(order._id)));
  assert.equal((await orders.get(buyer, order._id)).status, 'PENDING_PAYMENT');
  assert.equal(repository.snapshot().products.bread.reserved, 1);
  assert.ok(page.data.actionError);
});

test('订单操作：待自取时按需读取核销码，离开页面清除显示', async () => {
  const { page, order, orders, fulfillment, requests } = await fixture();
  let updated = await orders.simulatePay(buyer, order._id);
  for (const action of ['accept', 'readyForPickup']) {
    updated = await fulfillment.act(staff, action, { orderId: order._id, expectedVersion: updated.version,
      requestId: 'pickup-page-' + action });
  }
  await page.refreshOrders();
  assert.equal(requests.some(row => row.action === 'orders.pickupCode'), false);
  await page.revealPickup(event(order._id));
  assert.match(page.data.pickup.code, /^[A-F0-9]{12}$/);
  page.onHide();
  assert.equal(page.data.pickup, null);
});

test('订单操作：售后响应丢失时重试原申请，历史只显示一条记录', async () => {
  const { page, order, orders, requests, drop } = await fixture();
  await orders.simulatePay(buyer, order._id);
  await page.refreshOrders();
  page.openSaleForm(event(order._id));
  await page.submitSale();
  assert.match(page.data.actionError, /售后原因/);
  page.editSaleReason({ detail: { value: '商品有破损' } });
  drop('afterSales.apply');
  await page.submitSale();
  assert.equal(page.data.salePending, true);
  await page.retrySale();
  assert.equal(page.data.salePending, false);
  const attempts = requests.filter(row => row.action === 'afterSales.apply');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].data, attempts[1].data);
  await page.toggleSaleHistory();
  assert.equal(page.data.saleRows.length, 1);
  assert.equal(page.data.saleRows[0].status, '待审核');
  assert.equal(page.data.saleRows[0].reason, '商品有破损');
});

test('售后恢复：申请响应丢失后重建页面，显式重试使用相同请求', async () => {
  const base = await fixture();
  await base.orders.simulatePay(buyer, base.order._id);
  await base.page.refreshOrders();
  base.page.openSaleForm(event(base.order._id));
  base.page.editSaleReason({ detail: { value: '破损' } });
  base.drop('afterSales.apply');
  await base.page.submitSale();
  const fresh = miniappHarness(base.runtime, { storage: base.ui.storage }).loadPage('pages/orders/orders');
  await fresh.onShow();
  assert.equal(fresh.data.salePending, true);
  assert.equal(fresh.data.pendingSaleOrderId, base.order._id);
  assert.equal(base.requests.filter(row => row.action === 'afterSales.apply').length, 1);
  await fresh.retrySale();
  const requests = base.requests.filter(row => row.action === 'afterSales.apply');
  assert.deepEqual(requests[0].data, requests[1].data);
  assert.equal(fresh.data.salePending, false);
});

test('售后恢复：损坏记录和缓存写入失败阻止申请，清理失败仍显示成功', async () => {
  const base = await fixture();
  await base.orders.simulatePay(buyer, base.order._id);
  await base.page.refreshOrders();
  base.page.openSaleForm(event(base.order._id));
  base.page.editSaleReason({ detail: { value: '破损' } });
  const originalSet = base.ui.wx.setStorageSync;
  base.ui.wx.setStorageSync = () => { throw new Error('full'); };
  await base.page.submitSale();
  assert.equal(base.requests.some(row => row.action === 'afterSales.apply'), false);
  base.ui.wx.setStorageSync = originalSet;
  base.ui.wx.removeStorageSync = () => { throw new Error('locked'); };
  await base.page.submitSale();
  assert.match(base.page.data.actionNotice, /售后已提交/);
  assert.equal(base.page.data.salePending, true);
  const key = [...base.ui.storage.keys()][0];
  base.ui.storage.set(key, { corrupt: true });
  await base.page.restoreSale();
  assert.equal(base.page.data.saleRecoveryReady, false);
});

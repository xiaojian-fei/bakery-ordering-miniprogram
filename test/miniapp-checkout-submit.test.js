'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { miniappHarness } = require('./support/miniapp-harness');
const { shopFixture, buyer, other, addressInput } = require('./support/shop-fixture');
const change = value => ({ detail: { value } });
const click = (id, op) => ({ currentTarget: { dataset: { id, op } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function waitFor(check) {
  for (let i = 0; i < 30 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(check(), '异步步骤未完成');
}
async function fixture() {
  const base = shopFixture(), requests = [], storage = new Map();
  let sequence = 0, subject = buyer.openid, intercept = null;
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const makeRuntime = () => createMiniappRuntime({ subjectId: buyer.openid, requestId: () => 'submit-page-' + (++sequence),
    client: createTradeClient({ clock: base.clock, send: async request => {
      requests.push(structuredClone(request));
      const result = await application.handle(request, { subject });
      return intercept ? intercept(request, result) : result;
    } }) });
  const runtime = makeRuntime(); await runtime.addProduct('bread');
  async function open(selectedRuntime = runtime) {
    const ui = miniappHarness(selectedRuntime, { storage }), page = ui.loadPage('pages/cart/cart');
    await page.onShow(); return { ui, page };
  }
  const { ui, page } = await open();
  async function delivery() {
    await base.addresses.save(buyer, addressInput()); page.onDeliveryTypeChange(change('delivery')); page.openAddressPicker();
    await ui.events.findLast(row => row.name === 'navigateTo').options.events.addressSelected({ addressId: 'home' });
  }
  return { ...base, runtime, ui, page, requests, storage, makeRuntime, open, delivery,
    intercept: fn => { intercept = fn; }, switchSubject: id => { subject = id; } };
}
const creates = base => base.requests.filter(row => row.action === 'orders.create');
const record = base => [...base.storage.values()][0];
const orders = base => Object.values(base.repository.snapshot().orders || {});
async function price(base, priceCents) {
  await base.repository.transaction(async tx => {
    const product = await tx.get('products', 'bread'); await tx.set('products', 'bread', { ...product, priceCents });
  });
}

test('页面下单：必须先预览，确认后创建待支付订单，只预留一次且保留购物车', async () => {
  const base = await fixture(); await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 0);
  await base.page.goToOrder(); assert.equal(base.storage.size, 0);
  await base.page.submitQuotedOrder();
  assert.equal(base.page.data.checkoutState, 'CONFIRMED'); assert.equal(base.page.data.placedOrder.status, 'PENDING_PAYMENT');
  assert.equal(base.page.data.placedOrder.total, '12.50'); assert.equal(base.page.data.checkoutQuote, null);
  assert.equal(record(base).state, 'CONFIRMED'); assert.equal(orders(base).length, 1);
  assert.equal(base.repository.snapshot().products.bread.reserved, 1);
  assert.equal((await base.runtime.readCart()).items[0].quantity, 1); assert.equal(base.ui.cloudReads(), 0);
  assert.equal(base.requests.some(row => row.action === 'orders.pay'), false);
  await base.page.goToOrder(); await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 1);
});

test('页面下单：配送快照及金额来自原报价，存储只保留结算白名单', async () => {
  const base = await fixture(); await base.delivery(); await base.page.goToOrder(); await base.page.submitQuotedOrder();
  assert.equal(base.page.data.placedOrder.total, '22.50'); assert.equal(orders(base)[0].addressSnapshot.detail, '虚构地址');
  assert.deepEqual(creates(base)[0].data.items, [{ productId: 'bread', quantity: 1 }]);
  assert.equal(creates(base)[0].data.addressId, 'home');
  const serialized = JSON.stringify(record(base));
  for (const field of ['phone', 'password', 'staffToken', 'role', 'name":"测试顾客']) assert.equal(serialized.includes(field), false);
});

test('页面下单：重复点击合并为一次提交，提交期间数量和配送方式不被修改', async () => {
  const base = await fixture(), gate = deferred(); await base.page.goToOrder();
  base.intercept(async (request, result) => { if (request.action === 'orders.create') await gate.promise; return result; });
  const first = base.page.submitQuotedOrder(); await waitFor(() => creates(base).length === 1);
  await base.page.submitQuotedOrder(); await base.page.changeQuantity(click('bread', 'plus'));
  base.page.onDeliveryTypeChange(change('delivery')); assert.equal(base.page.data.deliveryType, 'pickup');
  gate.resolve(); await first; assert.equal(creates(base).length, 1); assert.equal(orders(base).length, 1);
});

test('页面下单：响应丢失后重试原请求，购物车变化不替换原商品/金额/请求ID', async () => {
  const base = await fixture(); await base.page.goToOrder(); let drop = true;
  base.intercept((request, result) => { if (drop && request.action === 'orders.create') { drop = false; throw new Error('LOST'); } return result; });
  await base.page.submitQuotedOrder(); assert.equal(base.page.data.checkoutState, 'UNCERTAIN');
  assert.equal(base.page.data.checkoutDraftTotal, '12.50');
  await base.page.changeQuantity(click('bread', 'plus')); await base.page.goToOrder();
  await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 1);
  await base.page.retryCheckoutOrder(); assert.deepEqual(creates(base)[1].data, creates(base)[0].data);
  assert.equal(orders(base).length, 1); assert.equal(base.repository.snapshot().products.bread.reserved, 1);
  assert.equal(base.page.data.placedOrder.total, '12.50');
});

test('页面下单：重建运行时恢复未知记录但不自动提交，人工重试仍得到原订单', async () => {
  const base = await fixture(); await base.page.goToOrder();
  base.intercept((request, result) => { if (request.action === 'orders.create') throw new Error('LOST'); return result; });
  await base.page.submitQuotedOrder(); base.intercept(null);
  const next = await base.open(base.makeRuntime());
  assert.equal(next.page.data.checkoutState, 'UNCERTAIN'); assert.equal(creates(base).length, 1);
  assert.equal(next.page.data.checkoutDraftTotal, '12.50'); await next.page.retryCheckoutOrder();
  assert.equal(creates(base).length, 2); assert.equal(orders(base).length, 1);
  assert.equal(next.page.data.placedOrder.id, orders(base)[0]._id);
});

test('页面下单：已确认记录重建后只读取原订单，不再创建或允许再次提交', async () => {
  const base = await fixture(); await base.page.goToOrder(); await base.page.submitQuotedOrder();
  const next = await base.open(base.makeRuntime());
  assert.equal(next.page.data.placedOrder.id, orders(base)[0]._id);
  assert.equal(next.page.data.checkoutState, 'CONFIRMED'); assert.equal(creates(base).length, 1);
  assert.ok(base.requests.some(row => row.action === 'orders.get'));
  await next.page.goToOrder(); await next.page.submitQuotedOrder(); assert.equal(creates(base).length, 1);
});

test('页面下单：价格变化需重新预览确认，不自动接受prepare得到的新金额', async () => {
  const base = await fixture(); await base.page.goToOrder(); await price(base, 1500);
  await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 0);
  assert.equal(base.page.data.checkoutQuote, null); assert.match(base.page.data.checkoutError, /价格或运费已变化/);
  const next = await base.open(base.makeRuntime()); assert.equal(next.page.data.checkoutState, 'PREPARED');
  await next.page.retryCheckoutOrder(); assert.equal(creates(base).length, 0);
  await next.page.goToOrder(); await next.page.submitQuotedOrder(); assert.equal(next.page.data.placedOrder.total, '15.00');
});

test('页面下单：prepare之后价格再变化，由服务拒绝，不能保留可直接提交的旧报价', async () => {
  const base = await fixture(); await base.page.goToOrder();
  base.intercept(async (request, result) => { if (request.action === 'orders.quote') await price(base, 2000); return result; });
  await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 1); assert.equal(orders(base).length, 0);
  assert.equal(base.page.data.checkoutState, 'REJECTED'); assert.equal(base.page.data.checkoutQuote, null);
  assert.match(base.page.data.checkoutError, /价格或运费已变化/);
});

test('页面下单：外部购物车改量及地址编辑/删除后阻止提交并要求重新核对', async () => {
  for (const scenario of ['cart', 'address', 'deleted']) {
    const base = await fixture(); if (scenario !== 'cart') await base.delivery(); await base.page.goToOrder();
    if (scenario === 'cart') await base.cart.setLine(buyer, { productId: 'bread', quantity: 2, expectedVersion: 1, requestId: 'external-before-submit' });
    if (scenario === 'address') await base.addresses.save(buyer, addressInput({ expectedVersion: 1, requestId: 'edit-before-submit', detail: '已修改' }));
    if (scenario === 'deleted') await base.addresses.remove(buyer, { addressId: 'home', expectedVersion: 1, requestId: 'delete-before-submit' });
    await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 0); assert.ok(base.page.data.checkoutError);
  }
});

test('页面下单：本地缓存损坏或首次保存失败时阻止下单，不覆盖已有损坏记录', async () => {
  const base = await fixture(); base.storage.set('bakery.checkout.v1:' + buyer.openid, { broken: true });
  await base.page.syncCheckout(); assert.equal(base.page.data.checkoutReady, false);
  await base.page.goToOrder(); await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 0);
  assert.deepEqual(record(base), { broken: true });
  base.storage.clear(); await base.page.syncCheckout();
  base.ui.wx.setStorageSync = () => { throw new Error('DISK_FULL_PRIVATE'); };
  await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 0);
  assert.match(base.page.data.checkoutError, /结算草稿无法保存/); assert.equal(base.page.data.checkoutBusy, false);
});

test('页面下单：prepare期间地址发生变化，再次核对后阻止提交', async () => {
  const base = await fixture(); await base.delivery(); await base.page.goToOrder();
  base.intercept(async (request, result) => {
    if (request.action === 'orders.quote') await base.addresses.save(buyer, addressInput({ expectedVersion: 1,
      requestId: 'change-during-prepare', detail: '重新报价期间修改' }));
    return result;
  });
  await base.page.submitQuotedOrder(); assert.equal(creates(base).length, 0);
  assert.equal(base.page.data.checkoutQuote, null); assert.match(base.page.data.checkoutError, /收货地址已变化/);
});

test('页面下单：隐藏发生在prepare之后时不发送订单，留下可重新确认的草稿', async () => {
  const base = await fixture(), gate = deferred(); await base.page.goToOrder();
  base.intercept(async (request, result) => { if (request.action === 'orders.quote') await gate.promise; return result; });
  const task = base.page.submitQuotedOrder(); await waitFor(() => base.requests.filter(row => row.action === 'orders.quote').length === 2);
  base.page.onHide(); const updates = base.page.updates.length; gate.resolve(); await task;
  assert.equal(base.page.updates.length, updates); assert.equal(creates(base).length, 0);
  base.intercept(null); await base.page.onShow(); assert.equal(base.page.data.checkoutState, 'PREPARED');
});

test('页面下单：订单提交后卸载不更新隐藏页面，重建后能只读恢复成功订单', async () => {
  const base = await fixture(), gate = deferred(); await base.page.goToOrder();
  base.intercept(async (request, result) => { if (request.action === 'orders.create') await gate.promise; return result; });
  const task = base.page.submitQuotedOrder(); await waitFor(() => creates(base).length === 1);
  base.page.onUnload(); const updates = base.page.updates.length; gate.resolve(); await task;
  assert.equal(base.page.updates.length, updates); base.intercept(null);
  const next = await base.open(base.makeRuntime()); assert.equal(next.page.data.checkoutState, 'CONFIRMED');
  assert.equal(creates(base).length, 1); assert.equal(next.page.data.checkoutBusy, false);
});

test('页面下单：提交期间隐藏并返回同一页面，恢复完成后解除忙碌状态', async () => {
  const base = await fixture(), gate = deferred(); await base.page.goToOrder();
  base.intercept(async (request, result) => { if (request.action === 'orders.create') await gate.promise; return result; });
  const task = base.page.submitQuotedOrder(); await waitFor(() => creates(base).length === 1);
  base.page.onHide(); const showing = base.page.onShow(); gate.resolve(); await Promise.all([task, showing]);
  assert.equal(base.page.data.checkoutState, 'CONFIRMED'); assert.ok(base.page.data.placedOrder);
  assert.equal(base.page.data.checkoutBusy, false); assert.equal(creates(base).length, 1);
});

test('页面下单：提交前/返回后身份改变不展示原账号订单及地址，也不能开始新请求', async () => {
  for (const after of [false, true]) {
    const base = await fixture(); await base.delivery(); await base.page.goToOrder();
    if (after) base.intercept((request, result) => { if (request.action === 'orders.create') base.switchSubject(other.openid); return result; });
    else base.switchSubject(other.openid);
    await base.page.submitQuotedOrder(); assert.equal(base.page.data.checkoutReady, false);
    assert.equal(base.page.data.placedOrder, null); assert.equal(base.page.data.selectedAddress, null);
    assert.equal(base.page.data.checkoutQuote, null); assert.equal(base.page.data.checkoutState, 'BLOCKED');
    assert.equal(creates(base).length, after ? 1 : 0);
  }
});

test('页面下单：确认记录保存失败仍显示成功和警告，重建恢复后同请求仅预留一次', async () => {
  const base = await fixture(); await base.page.goToOrder();
  const original = base.ui.wx.setStorageSync;
  base.ui.wx.setStorageSync = (key, value) => { if (value.state === 'CONFIRMED') throw new Error('WRITE_FAILED'); return original(key, value); };
  await base.page.submitQuotedOrder(); assert.equal(base.page.data.checkoutState, 'CONFIRMED');
  assert.ok(base.page.data.placedOrder); assert.match(base.page.data.checkoutError, /订单已创建/);
  assert.equal(record(base).state, 'SUBMITTING');
  const next = await base.open(base.makeRuntime()); assert.equal(next.page.data.checkoutState, 'SUBMITTING');
  await next.page.retryCheckoutOrder(); assert.equal(orders(base).length, 1);
  assert.equal(base.repository.snapshot().products.bread.reserved, 1);
});

test('页面下单：畸形创建响应当作未知结果，重试不能创建第二张订单', async () => {
  const base = await fixture(); await base.page.goToOrder();
  base.intercept((request, result) => request.action === 'orders.create' ? { success: true, data: { ...result.data, requestId: 'wrong-request' } } : result);
  await base.page.submitQuotedOrder(); assert.equal(base.page.data.checkoutState, 'UNCERTAIN');
  assert.equal(base.page.data.placedOrder, null); base.intercept(null);
  await base.page.retryCheckoutOrder(); assert.equal(base.page.data.checkoutState, 'CONFIRMED'); assert.equal(orders(base).length, 1);
});

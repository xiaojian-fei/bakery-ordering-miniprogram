'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { shopFixture, buyer, other, addressInput } = require('./support/shop-fixture');
const { miniappHarness } = require('./support/miniapp-harness');

const change = value => ({ detail: { value } });
const click = (id, op) => ({ currentTarget: { dataset: { id, op } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function waitFor(check) {
  for (let i = 0; i < 30 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(check(), '预期异步步骤未完成');
}
async function fixture() {
  const base = shopFixture(), requests = [];
  let sequence = 0, subject = buyer.openid, intercept = null;
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const client = createTradeClient({ clock: base.clock, send: async request => {
    requests.push(structuredClone(request));
    const result = await application.handle(request, { subject });
    return intercept ? intercept(request, result) : result;
  } });
  const runtime = createMiniappRuntime({ client, subjectId: buyer.openid, requestId: () => 'quote-test-' + (++sequence) });
  await runtime.addProduct('bread');
  const ui = miniappHarness(runtime), page = ui.loadPage('pages/cart/cart'); await page.onShow();
  async function delivery() {
    await base.addresses.save(buyer, addressInput());
    page.onDeliveryTypeChange(change('delivery')); page.openAddressPicker();
    await ui.events.findLast(row => row.name === 'navigateTo').options.events.addressSelected({ addressId: 'home' });
  }
  return { ...base, runtime, client, ui, page, requests, delivery,
    intercept: handler => { intercept = handler; }, switchSubject: value => { subject = value; } };
}
const quoteCalls = base => base.requests.filter(row => row.action === 'orders.quote');

test('结算报价：真实页面自取金额来自报价接口，只读且不生成订单或预留库存', async () => {
  const base = await fixture(), before = base.repository.snapshot();
  await base.page.goToOrder();
  assert.equal(base.page.data.checkoutQuote.subtotal, '12.50');
  assert.equal(base.page.data.checkoutQuote.shipping, '0.00');
  assert.equal(base.page.data.checkoutQuote.total, '12.50');
  assert.equal(base.page.data.checkoutQuote.address, null);
  assert.deepEqual(quoteCalls(base)[0].data, { items: [{ productId: 'bread', quantity: 1 }], deliveryType: 'pickup' });
  assert.deepEqual(base.repository.snapshot(), before);
  assert.equal(base.ui.cloudReads(), 0); assert.equal(base.page.data.quoteLoading, false);
});

test('结算报价：配送缺少地址先提示，选址后展示运费和重新读取的地址', async () => {
  const base = await fixture(); base.page.onDeliveryTypeChange(change('delivery'));
  await base.page.goToOrder(); assert.equal(base.page.data.quoteError, '请先选择并核对收货地址');
  assert.equal(quoteCalls(base).length, 0);
  // 切回自取再通过真实EventChannel完成配送选址。
  base.page.onDeliveryTypeChange(change('pickup')); await base.delivery();
  await base.addresses.save(buyer, addressInput({ expectedVersion: 1, requestId: 'edit-before-quote', detail: '报价前更新的虚构地址' }));
  await base.page.goToOrder();
  assert.equal(base.page.data.checkoutQuote.shipping, '10.00'); assert.equal(base.page.data.checkoutQuote.total, '22.50');
  assert.equal(base.page.data.checkoutQuote.address.detail, '报价前更新的虚构地址');
  assert.equal(base.page.data.selectedAddress.detail, '报价前更新的虚构地址');
  assert.equal(quoteCalls(base)[0].data.addressId, 'home');
  assert.equal('ownerOpenid' in base.page.data.checkoutQuote.address, false);
});

test('结算报价：重新读取现价，达到包邮门槛时运费为零，不使用购物车显示价格', async () => {
  const base = await fixture(); await base.delivery();
  await base.repository.transaction(async tx => {
    const product = await tx.get('products', 'bread'); await tx.set('products', 'bread', { ...product, priceCents: 9000 });
  });
  assert.equal(base.page.data.totalPrice, '12.50'); await base.page.goToOrder();
  assert.equal(base.page.data.checkoutQuote.items[0].price, '90.00');
  assert.equal(base.page.data.checkoutQuote.subtotal, '90.00'); assert.equal(base.page.data.checkoutQuote.shipping, '0.00');
});

test('结算报价：改量、切换配送、重新核对地址以及返回页面均使旧报价失效', async () => {
  const base = await fixture(); await base.page.goToOrder();
  await base.page.changeQuantity(click('bread', 'plus')); assert.equal(base.page.data.checkoutQuote, null);
  await base.page.goToOrder(); assert.equal(base.page.data.checkoutQuote.total, '25.00');
  await base.delivery(); assert.equal(base.page.data.checkoutQuote, null);
  await base.page.goToOrder(); assert.ok(base.page.data.checkoutQuote);
  await base.page.refreshSelectedAddress(); assert.equal(base.page.data.checkoutQuote, null);
  await base.page.goToOrder(); base.page.onHide(); const updates = base.page.updates.length;
  await base.page.onShow(); assert.ok(base.page.updates.length > updates); assert.equal(base.page.data.checkoutQuote, null);
});

test('结算报价：外部修改购物车时刷新并要求再次确认，不直接报价另一组数量', async () => {
  const base = await fixture();
  await base.cart.setLine(buyer, { productId: 'bread', quantity: 3, expectedVersion: 1, requestId: 'external-cart-edit' });
  await base.page.goToOrder();
  assert.equal(base.page.data.checkoutQuote, null); assert.equal(base.page.data.cartItems[0].quantity, 3);
  assert.match(base.page.data.quoteError, /购物车已变化/); assert.equal(quoteCalls(base).length, 0);
  await base.page.goToOrder(); assert.equal(base.page.data.checkoutQuote.total, '37.50');
});

test('结算报价：新近售罄或下架会阻止报价并清除旧金额', async () => {
  for (const update of [{ onHand: 0 }, { isOnSale: false }]) {
    const base = await fixture(); await base.page.goToOrder();
    await base.repository.transaction(async tx => {
      const product = await tx.get('products', 'bread'); await tx.set('products', 'bread', { ...product, ...update });
    });
    await base.page.goToOrder(); assert.equal(base.page.data.checkoutQuote, null);
    assert.equal(base.page.data.canCheckout, false); assert.match(base.page.data.quoteError, /购物车已变化/);
  }
});

test('结算报价：读购物车之后库存发生变化，报价接口仍会拒绝并给出安全提示', async () => {
  const base = await fixture();
  base.intercept(async (request, result) => {
    if (request.action === 'cart.get') await base.repository.transaction(async tx => {
      const product = await tx.get('products', 'bread'); await tx.set('products', 'bread', { ...product, onHand: 0 });
    });
    return result;
  });
  await base.page.goToOrder(); assert.equal(quoteCalls(base).length, 1);
  assert.equal(base.page.data.checkoutQuote, null); assert.equal(base.page.data.quoteError, '商品可售库存不足，请调整数量');
});

test('结算报价：地址删除或身份变化时清除地址和旧报价，不调用创建或支付', async () => {
  for (const scenario of ['delete', 'identity']) {
    const base = await fixture(); await base.delivery(); await base.page.goToOrder();
    if (scenario === 'delete') await base.addresses.remove(buyer, { addressId: 'home', expectedVersion: 1, requestId: 'delete-before-quote' });
    else base.switchSubject(other.openid);
    await base.page.goToOrder();
    assert.equal(base.page.data.checkoutQuote, null); assert.equal(base.page.data.selectedAddress, null);
    assert.equal(base.page._selectedAddressId, null); assert.ok(base.page.data.quoteError);
    assert.equal(base.requests.some(row => ['orders.create', 'orders.pay'].includes(row.action)), false);
  }
});

test('结算报价：只读网络失败可明确重试，不泄露传输错误或保留旧金额', async () => {
  const base = await fixture(); await base.page.goToOrder();
  base.intercept((request, result) => { if (request.action === 'orders.quote') throw new Error('PRIVATE_URL_SECRET'); return result; });
  await base.page.goToOrder(); assert.equal(base.page.data.checkoutQuote, null);
  assert.equal(base.page.data.quoteError, '报价加载失败，请重试'); assert.equal(base.page.data.quoteLoading, false);
  base.intercept(null); await base.page.goToOrder(); assert.equal(base.page.data.checkoutQuote.total, '12.50');
});

test('结算报价：报价期间地址修改时更新地址并要求重新报价，不配用旧地址和新运费', async () => {
  const base = await fixture(); await base.delivery();
  base.intercept(async (request, result) => {
    if (request.action === 'orders.quote') await base.addresses.save(buyer, addressInput({ expectedVersion: 1,
      requestId: 'address-changed-during-quote', province: '测试省', detail: '报价期间修改的虚构地址' }));
    return result;
  });
  await base.page.goToOrder(); assert.equal(base.page.data.checkoutQuote, null);
  assert.match(base.page.data.quoteError, /收货地址已变化/);
  assert.equal(base.page.data.selectedAddress.detail, '报价期间修改的虚构地址');
  base.intercept(null); await base.page.goToOrder();
  assert.equal(base.page.data.checkoutQuote.shipping, '13.00');
});

test('结算报价：待确认购物车写入及地址保存/删除必须先恢复，不能交叉报价', async () => {
  const base = await fixture();
  base.intercept((request, result) => { if (request.action === 'cart.setLine') throw new Error('LOST'); return result; });
  await base.page.changeQuantity(click('bread', 'plus')); await base.page.goToOrder();
  assert.match(base.page.data.quoteError, /上次购物车修改/); assert.equal(quoteCalls(base).length, 0);
  base.intercept(null); await base.page.retryCartWrite(); await base.delivery();
  base.intercept((request, result) => { if (request.action === 'addresses.save') throw new Error('LOST'); return result; });
  await assert.rejects(base.runtime.addressEditor.save(addressInput({ expectedVersion: 1, requestId: 'unknown-save-quote' })));
  await base.page.goToOrder(); assert.match(base.page.data.quoteError, /上次地址保存/);
  base.intercept(null); await base.runtime.addressEditor.retry();
  base.intercept((request, result) => { if (request.action === 'addresses.remove') throw new Error('LOST'); return result; });
  await assert.rejects(base.runtime.addressEditor.remove({ addressId: 'home', expectedVersion: 2 }));
  await base.page.goToOrder(); assert.match(base.page.data.quoteError, /上次地址删除/);
  assert.equal(quoteCalls(base).length, 0);
});

test('结算报价：重复点击只发一次，切换配送后旧响应不能覆盖新报价', async () => {
  const base = await fixture(), gate = deferred();
  base.intercept(async (request, result) => { if (request.action === 'orders.quote') await gate.promise; return result; });
  const first = base.page.goToOrder(); await waitFor(() => quoteCalls(base).length === 1);
  await base.page.goToOrder(); assert.equal(quoteCalls(base).length, 1);
  base.page.onDeliveryTypeChange(change('delivery')); base.page.onDeliveryTypeChange(change('pickup'));
  base.intercept(null); await base.page.goToOrder(); const updates = base.page.updates.length;
  gate.resolve(); await first;
  assert.equal(base.page.updates.length, updates); assert.equal(base.page.data.checkoutQuote.total, '12.50');
});

test('结算报价：隐藏/卸载后的响应不更新页面，报价期间身份变化不能展示原账号数据', async () => {
  for (const scenario of ['hide', 'unload', 'identity']) {
    const base = await fixture(), gate = deferred();
    base.intercept(async (request, result) => { if (request.action === 'orders.quote') await gate.promise; return result; });
    const quoting = base.page.goToOrder(); await waitFor(() => quoteCalls(base).length === 1);
    if (scenario === 'identity') base.switchSubject(other.openid);
    else base.page[scenario === 'hide' ? 'onHide' : 'onUnload']();
    const updates = base.page.updates.length; gate.resolve(); await quoting;
    assert.equal(base.page.data.checkoutQuote, null);
    if (scenario !== 'identity') assert.equal(base.page.updates.length, updates);
    else assert.match(base.page.data.quoteError, /登录状态已变化/);
  }
});

test('结算报价：畸形金额/明细响应拒绝展示，不将错误金额显示给用户', async () => {
  for (const corrupt of [quote => ({ ...quote, totalCents: 1 }), quote => ({ ...quote, shippingCents: -1 }),
    quote => ({ ...quote, items: [{ ...quote.items[0], quantity: 2 }] }),
    quote => ({ ...quote, items: [{ ...quote.items[0], lineTotalCents: 1 }] })]) {
    const base = await fixture(); base.intercept((request, result) => request.action === 'orders.quote'
      ? { ...result, data: corrupt(result.data) } : result);
    await base.page.goToOrder(); assert.equal(base.page.data.checkoutQuote, null);
    assert.match(base.page.data.quoteError, /服务响应异常/); assert.equal(base.page.data.quoteLoading, false);
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { createTradeClient, TradeApiError } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { shopFixture } = require('./support/shop-fixture');
const { miniappHarness } = require('./support/miniapp-harness');
const manifest = require('../app.json');

function fixture() {
  const base = shopFixture();
  let sequence = 0, subject = 'buyer-demo', drop = false;
  const requests = [];
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const client = createTradeClient({ clock: base.clock, send: async request => {
    requests.push(structuredClone(request));
    const result = await application.handle(request, { subject });
    if (drop && request.action === 'cart.setLine') { drop = false; throw new Error('LOST_AFTER_CART_COMMIT'); }
    return result;
  } });
  const runtime = createMiniappRuntime({ client, subjectId: 'buyer-demo', requestId: () => 'miniapp-cart-' + (++sequence) });
  const harness = miniappHarness(runtime);
  return { ...base, runtime, client, ...harness, requests,
    dropNext: () => { drop = true; }, switchSubject: value => { subject = value; } };
}
const click = (id, op) => ({ currentTarget: { dataset: { id, op } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('原微信页面接入：真实App及首页/详情/购物车入口不访问wx.cloud', async () => {
  const { app, loadPage, cloudReads } = fixture();
  await app.onLaunch();
  const home = loadPage('pages/index/index'); await home.onShow();
  assert.equal(home.data.products.length, 2);
  assert.equal(home.data.products.find(row => row._id === 'bread').price, '12.50');
  const detail = loadPage('pages/detail/detail'); detail.onLoad({ id: 'bread' }); await detail.onShow();
  assert.equal(detail.data.product.available, 30);
  const cart = loadPage('pages/cart/cart'); await cart.onShow();
  assert.deepEqual(cart.data.cartItems, []);
  assert.equal(app.globalData.openid, 'buyer-demo');
  assert.equal(cloudReads(), 0);
});

test('原微信页面接入：首页分类/搜索走服务端，分页追加不重复商品', async () => {
  const { loadPage, repository } = fixture();
  await repository.transaction(async tx => {
    const product = await tx.get('products', 'bread');
    for (let i = 0; i < 23; i++) {
      const id = 'extra-' + String(i).padStart(2, '0');
      await tx.set('products', id, { ...product, _id: id });
    }
  });
  const home = loadPage('pages/index/index'); await home.onShow();
  assert.equal(home.data.products.length, 20); assert.ok(home.data.cursor);
  await home.loadMore();
  assert.equal(home.data.products.length, 25); assert.equal(home.data.cursor, null);
  home.onSearchInput({ detail: { value: '饼干' } }); await home.onSearchConfirm();
  assert.deepEqual(home.data.products.map(item => item._id), ['cookie']);
  await home.onCategoryChange({ currentTarget: { dataset: { category: '不存在分类' } } });
  assert.equal(home.data.products.length, 0);
});

test('原微信页面接入：切换筛选后旧响应不覆盖新列表，隐藏页面后不再setData', async () => {
  const { runtime, app } = fixture();
  const pending = [];
  const wrapped = { ...runtime, client: { ...runtime.client, catalog: { ...runtime.client.catalog,
    list: input => { const task = deferred(); pending.push({ ...task, input }); return task.promise; } } } };
  const { loadPage } = miniappHarness(wrapped);
  const page = loadPage('pages/index/index'); page._active = true;
  const first = page.loadProducts();
  page.setData({ keyword: '新条件' }); const second = page.loadProducts();
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  const product = { _id: 'new', name: '新商品', category: '司康', image: '', priceCents: 100, available: 3 };
  pending[1].resolve({ items: [product], nextCursor: null }); await second;
  pending[0].resolve({ items: [{ ...product, _id: 'old' }], nextCursor: null }); await first;
  assert.equal(page.data.products[0]._id, 'new');
  const third = page.loadProducts();
  while (pending.length < 3) await new Promise(resolve => setImmediate(resolve));
  page.onHide(); const before = page.updates.length;
  pending[2].resolve({ items: [], nextCursor: null }); await third;
  assert.equal(page.updates.length, before);
  assert.equal(app.globalData.cartCount, 0);
});

test('原微信页面接入：详情下架后隐藏旧商品，错误使用本地文案', async () => {
  const { loadPage, repository } = fixture();
  const detail = loadPage('pages/detail/detail'); detail.onLoad({ id: 'bread' }); await detail.onShow();
  await repository.transaction(async tx => tx.set('products', 'bread', { ...await tx.get('products', 'bread'), isOnSale: false }));
  await detail.loadProduct();
  assert.equal(detail.data.product, null);
  assert.equal(detail.data.error, '商品已下架，请重新选择');
});

test('原微信页面接入：同页面连续点击只加购一次，服务端金额与库存不被页面数据覆盖', async () => {
  const { loadPage, app, requests, repository } = fixture();
  const home = loadPage('pages/index/index'); await home.onShow();
  await Promise.all([home.addToCart(click('bread')), home.addToCart(click('bread'))]);
  const cart = loadPage('pages/cart/cart'); await cart.onShow();
  assert.equal(cart.data.totalPrice, '12.50'); assert.equal(cart.data.cartItems[0].quantity, 1);
  assert.equal(app.globalData.cartCount, 1);
  assert.equal(requests.filter(row => row.action === 'cart.setLine').length, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
  assert.deepEqual(Object.keys(requests.find(row => row.action === 'cart.setLine').data).sort(),
    ['expectedVersion', 'productId', 'quantity', 'requestId']);
});

test('原微信页面接入：详情加购与购物车增减贯通，减至0移除，估算不含运费', async () => {
  const { loadPage, app } = fixture();
  const detail = loadPage('pages/detail/detail'); detail.onLoad({ id: 'bread' }); await detail.onShow();
  await detail.addToCart();
  const cart = loadPage('pages/cart/cart'); await cart.onShow();
  await cart.changeQuantity(click('bread', 'plus'));
  assert.equal(cart.data.totalPrice, '25.00');
  await cart.changeQuantity(click('bread', 'minus')); await cart.changeQuantity(click('bread', 'minus'));
  assert.equal(cart.data.cartItems.length, 0); assert.equal(app.globalData.cartCount, 0);
});

test('原微信页面接入：购物车未知结果保留原命令，跨页面重试不多加一件', async () => {
  const { loadPage, dropNext, requests } = fixture();
  const home = loadPage('pages/index/index'); await home.onShow(); dropNext();
  await home.addToCart(click('bread'));
  assert.equal(home.data.cartWritePending, true);
  const cart = loadPage('pages/cart/cart'); await cart.onShow();
  assert.equal(cart.data.cartItems[0].quantity, 1); assert.equal(cart.data.cartWritePending, true);
  await cart.changeQuantity(click('bread', 'plus'));
  assert.equal(requests.filter(row => row.action === 'cart.setLine').length, 1);
  await cart.retryCartWrite();
  assert.equal(cart.data.cartItems[0].quantity, 1); assert.equal(cart.data.cartWritePending, false);
  const writes = requests.filter(row => row.action === 'cart.setLine');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].data, writes[1].data);
});

test('原微信页面接入：购物车版本冲突刷新，不覆盖其他页面的新数量', async () => {
  const { loadPage, runtime, client, events } = fixture();
  await runtime.addProduct('bread');
  const cart = loadPage('pages/cart/cart'); await cart.onShow();
  await client.cart.setLine({ productId: 'bread', quantity: 4, expectedVersion: 1, requestId: 'external-change-001' });
  await cart.changeQuantity(click('bread', 'plus'));
  assert.equal(cart.data.cartItems[0].quantity, 4);
  assert.equal(cart.data.cartWritePending, false);
  assert.ok(events.some(event => event.options.title === '数据已更新，请刷新后重新确认'));
});

test('原微信页面接入：所有未迁移页面入口受保护，不加载旧数据库模块', () => {
  const { runtime } = fixture();
  for (const route of manifest.pages.filter(route => !runtime.isRouteAvailable('/' + route))) {
    const { loadPage, cloudReads, events } = miniappHarness(runtime);
    const page = loadPage(route); page.onLoad();
    assert.equal(cloudReads(), 0, route);
    const modal = events.find(event => event.name === 'showModal');
    assert.ok(modal, route); modal.options.success();
    assert.ok(events.some(event => event.name === 'switchTab' && event.options.url === '/pages/index/index'));
  }
});

test('原微信页面接入：底栏/管理入口受保护，空购物车报价不跳入旧数据流程', async () => {
  const { loadPage, load, components, events } = fixture();
  load('components/custom-tab-bar/index.js');
  components[0].methods.switchTab({ currentTarget: { dataset: { path: '/pages/orders/orders' } } });
  const home = loadPage('pages/index/index'); home.goToAdmin();
  const cart = loadPage('pages/cart/cart'); await cart.onShow(); await cart.goToOrder();
  assert.equal(events.filter(event => event.name === 'switchTab' || event.name === 'navigateTo').length, 0);
  assert.equal(cart.data.quoteError, '请先加载并检查购物车商品');
});

test('原微信页面接入：配置为空时保留旧页面，未强制启用新后端', () => {
  const { loadPage, cloudReads } = miniappHarness(null, { legacyCloud: true });
  const page = loadPage('pages/index/index');
  assert.equal(cloudReads(), 1);
  assert.equal(page.data.unifiedMode, undefined);
  assert.equal(typeof page.showShopIntro, 'function');
});

test('页面运行时：可信主体变化后不能继续修改原账号购物车', async () => {
  const { runtime, switchSubject, requests } = fixture(); switchSubject('other-demo');
  await assert.rejects(runtime.addProduct('bread'), error => error.code === 'SESSION_CHANGED');
  assert.equal(requests.filter(row => row.action === 'cart.setLine').length, 0);
});

test('页面运行时：并发意图拒绝交叉写，非法requestId不能下发', async () => {
  const { client } = fixture(), gate = deferred();
  const blocked = { ...client, cart: { ...client.cart, get: () => gate.promise } };
  const runtime = createMiniappRuntime({ client: blocked, subjectId: 'buyer-demo', requestId: () => 'bad' });
  const first = runtime.addProduct('bread');
  await assert.rejects(runtime.addProduct('cookie'), error => error.code === 'CART_WRITE_BUSY');
  gate.resolve({ version: 0, items: [] });
  await assert.rejects(first, error => error.code === 'INVALID_REQUEST');
  assert.equal(runtime.hasPendingCartWrite(), false);
});

test('页面运行时：结果未知时阻止新意图和换商品，已知失败允许刷新后重新操作', async () => {
  const { runtime, dropNext, client } = fixture(); dropNext();
  await assert.rejects(runtime.addProduct('bread'), error => error.uncertain);
  await assert.rejects(runtime.addProduct('cookie'), error => error.code === 'CART_RECOVERY_REQUIRED');
  await runtime.retryCartWrite();
  await assert.rejects(runtime.setCartQuantity({ productId: 'bread', quantity: 2, expectedVersion: 0 }),
    error => error.code === 'VERSION_CONFLICT');
  assert.equal(runtime.hasPendingCartWrite(), false);
  assert.equal((await client.cart.get()).items[0].quantity, 1);
});

test('页面运行时：冷启动先从可信接口绑定主体，不需要从缓存读取openid', async () => {
  const { client, switchSubject } = fixture();
  const runtime = createMiniappRuntime({ client, requestId: () => 'cold-start-cart-001' });
  assert.equal(runtime.subjectId, null);
  const { app, cloudReads } = miniappHarness(runtime);
  await app.onLaunch();
  assert.equal(runtime.subjectId, 'buyer-demo'); assert.equal(app.globalData.openid, 'buyer-demo');
  switchSubject('other-demo');
  await assert.rejects(runtime.readCart(), error => error.code === 'SESSION_CHANGED');
  assert.equal(cloudReads(), 0);
});

test('页面运行时：畸形写响应和未知异常保留命令，不将未知结果误当作失败', async () => {
  const { client } = fixture();
  for (const response of [undefined, { version: 1, items: [] }, { version: 1,
    items: [{ productId: 'bread', quantity: 1 }, { productId: 'bread', quantity: 1 }] }]) {
    const modified = { ...client, cart: { ...client.cart, setLine: async () => response } };
    const runtime = createMiniappRuntime({ client: modified, requestId: () => 'protocol-cart-001' });
    await assert.rejects(runtime.addProduct('bread'), error => error.code === 'PROTOCOL_ERROR' && error.uncertain);
    assert.equal(runtime.hasPendingCartWrite(), true);
  }
  const broken = { ...client, cart: { ...client.cart, setLine: async () => { throw null; } } };
  const runtime = createMiniappRuntime({ client: broken, requestId: () => 'unknown-cart-001' });
  await assert.rejects(runtime.addProduct('bread'), error => error.code === 'NETWORK_ERROR' && error.uncertain);
  assert.equal(runtime.hasPendingCartWrite(), true);
});

test('页面运行时：身份接口返回空主体时不完成绑定或发送购物车写入', async () => {
  const { client } = fixture();
  for (const actor of [{ openid: null }, {}, undefined, { openid: 'invalid:subject' }]) {
    const modified = { ...client, identity: { me: async () => actor } };
    const runtime = createMiniappRuntime({ client: modified, requestId: () => 'identity-cart-001' });
    await assert.rejects(runtime.addProduct('bread'), error => error.code === 'SESSION_CHANGED');
    assert.equal(runtime.subjectId, null);
  }
});

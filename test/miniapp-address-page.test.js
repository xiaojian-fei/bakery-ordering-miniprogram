'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { shopFixture, buyer, other, addressInput } = require('./support/shop-fixture');
const { miniappHarness } = require('./support/miniapp-harness');

function fixture() {
  const base = shopFixture(), requests = [];
  let subject = buyer.openid, failList = false, sequence = 0;
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const client = createTradeClient({ clock: base.clock, send: async request => {
    requests.push(request.action);
    if (failList && request.action === 'addresses.list') throw new Error('private-network-detail');
    return application.handle(request, { subject });
  } });
  const runtime = createMiniappRuntime({ client, subjectId: buyer.openid, requestId: () => 'address-page-' + (++sequence) });
  return { ...base, runtime, ...miniappHarness(runtime), requests,
    switchSubject: value => { subject = value; }, failList: value => { failList = value; } };
}
async function seed(base, count) {
  for (let i = 0; i < count; i++) {
    const suffix = String(i).padStart(2, '0');
    await base.addresses.save(buyer, addressInput({ addressId: 'address-' + suffix,
      requestId: 'seed-address-' + suffix, makeDefault: i === 0 }));
  }
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const waitForTasks = async (tasks, count) => { while (tasks.length < count) await new Promise(resolve => setImmediate(resolve)); };

test('原地址列表：仅显示本人未删除地址与默认标记，不访问wx.cloud', async () => {
  const base = fixture();
  await base.addresses.save(buyer, addressInput());
  await base.addresses.save(buyer, addressInput({ addressId: 'deleted', requestId: 'seed-deleted', makeDefault: false }));
  await base.addresses.remove(buyer, { addressId: 'deleted', expectedVersion: 1, requestId: 'remove-deleted' });
  await base.addresses.save(other, addressInput({ addressId: 'others-home', requestId: 'seed-other-home' }));
  const page = base.loadPage('pages/address/address'); page.onLoad({ selectMode: 'true' }); await page.onShow();
  assert.deepEqual(page.data.addresses.map(item => item._id), ['home']);
  assert.equal(page.data.addresses[0].isDefault, true);
  assert.equal(page.data.addresses[0].phone, '00000000000');
  assert.equal(base.cloudReads(), 0);
  assert.equal(base.requests.filter(action => action === 'addresses.list').length, 1);
  assert.ok(base.requests.every(action => ['identity.me', 'addresses.list'].includes(action)));
});

test('原地址列表：有界分页追加，默认指针跨页改变后不会出现两个默认标记', async () => {
  const base = fixture(); await seed(base, 23);
  const page = base.loadPage('pages/address/address'); await page.onShow();
  assert.equal(page.data.addresses.length, 20); assert.ok(page.data.cursor);
  assert.equal(page.data.addresses.find(item => item.isDefault)._id, 'address-00');
  await base.addresses.save(buyer, addressInput({ addressId: 'address-22', requestId: 'change-default-22',
    expectedVersion: 1, makeDefault: true }));
  await page.loadMore();
  assert.equal(page.data.addresses.length, 23); assert.equal(page.data.cursor, null);
  assert.deepEqual(page.data.addresses.filter(item => item.isDefault).map(item => item._id), ['address-22']);
  const calls = base.requests.length; await page.loadMore(); assert.equal(base.requests.length, calls);
  await base.addresses.remove(buyer, { addressId: 'address-22', requestId: 'remove-default-22', expectedVersion: 2 });
  assert.equal((await base.addresses.list(buyer, { limit: 1 })).defaultAddressId, null);
  await page.refreshAddresses(); await page.loadMore();
  assert.equal(page.data.addresses.length, 22); assert.equal(page.data.addresses.some(item => item.isDefault), false);
});

test('原地址列表：加载失败可重试，提示不泄露原始异常且不会误报空地址', async () => {
  const base = fixture(); await seed(base, 1); base.failList(true);
  const page = base.loadPage('pages/address/address'); await page.onShow();
  assert.ok(page.data.error); assert.equal(page.data.error.includes('private-network'), false);
  assert.equal(page.data.loading, false); assert.equal(page.data.addresses.length, 0);
  base.failList(false); await page.refreshAddresses();
  assert.equal(page.data.error, ''); assert.equal(page.data.addresses.length, 1);
});

test('原地址列表：主体变化后分页拒绝，清除旧账号已显示地址', async () => {
  const base = fixture(); await seed(base, 21);
  const page = base.loadPage('pages/address/address'); await page.onShow();
  base.switchSubject(other.openid); await page.loadMore();
  assert.equal(page.data.error, '登录状态已变化，请重新操作');
  assert.equal(page.data.addresses.length, 0); assert.equal(page.data.cursor, null);
  assert.equal(base.requests.filter(action => action === 'addresses.list').length, 1);
});

test('原地址列表：刷新后旧响应不覆盖结果，隐藏后响应不再setData', async () => {
  const { runtime } = fixture(), tasks = [];
  const modified = { ...runtime, readAddresses: () => { const task = deferred(); tasks.push(task); return task.promise; } };
  const { loadPage } = miniappHarness(modified);
  const page = loadPage('pages/address/address');
  const first = page.onShow(), second = page.refreshAddresses(); await waitForTasks(tasks, 2);
  const result = id => ({ items: [{ _id: id, name: '虚构地址' }], nextCursor: null, defaultAddressId: id });
  tasks[1].resolve(result('new')); await second;
  tasks[0].resolve(result('old')); await first;
  assert.equal(page.data.addresses[0]._id, 'new');
  const third = page.refreshAddresses(); await waitForTasks(tasks, 3);
  page.onHide(); const updates = page.updates.length;
  tasks[2].resolve(result('late')); await third;
  assert.equal(page.updates.length, updates);
});

test('原地址列表：导航不直接发送写操作或选择事件，购物车可跳转查看', async () => {
  const base = fixture(), cart = base.loadPage('pages/cart/cart'); cart.openAddresses();
  const page = base.loadPage('pages/address/address'); await page.onShow();
  page.addAddress(); page.editAddress(); page.deleteAddress(); page.selectAddress();
  assert.ok(base.events.some(event => event.name === 'navigateTo' && event.options.url === '/pages/address/address'));
  assert.ok(base.requests.every(action => ['identity.me', 'addresses.list'].includes(action)));
  assert.equal(base.events.filter(event => event.name === 'navigateTo').length, 2);
  assert.equal(base.runtime.isRouteAvailable('/pages/add-address/add-address'), true);
});

test('原地址列表：旧模式保持原模块与编辑入口，新模式不混用旧数据', () => {
  const { loadPage, cloudReads } = miniappHarness(null, { legacyCloud: true });
  const page = loadPage('pages/address/address');
  assert.equal(cloudReads(), 1); assert.equal(page.data.unifiedMode, undefined);
  assert.equal(typeof page.editAddress, 'function'); assert.equal(typeof page.deleteAddress, 'function');
});

test('原地址列表：协议缺少默认指针或游标字段时拒绝展示', async () => {
  const { runtime } = fixture();
  const { loadPage } = miniappHarness({ ...runtime, readAddresses: async () => ({ items: [{ _id: 'home' }] }) });
  const page = loadPage('pages/address/address'); await page.onShow();
  assert.equal(page.data.addresses.length, 0);
  assert.equal(page.data.error, '服务响应异常，请先核对操作结果');
});

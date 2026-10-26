'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWechatCheckoutStorage } = require('../services/wechat-checkout-storage');
const { createCheckoutRecovery } = require('../services/checkout-recovery');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { shopFixture } = require('./support/shop-fixture');

// 模拟微信同步缓存调用形态；不是开发者工具或真机执行记录。
function fakeWechat() {
  const values = new Map(), calls = [];
  let failedMethod = null;
  const run = (method, work) => { calls.push(method); if (method === failedMethod) throw new Error('private-platform-detail'); return work(); };
  const wx = {
    getStorageInfoSync() { return run('info', () => ({ keys: [...values.keys()] })); },
    getStorageSync(key) { return run('get', () => values.has(key) ? values.get(key) : ''); },
    setStorageSync(key, value) { return run('set', () => values.set(key, value)); },
    removeStorageSync(key) { return run('remove', () => values.delete(key)); }
  };
  return { wx, values, calls, fail: method => { failedMethod = method; } };
}
const subjectId = 'buyer-demo', key = 'bakery.checkout.v1:' + subjectId;
const input = { requestId: 'wechat-recovery-001', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 2 }] };
const record = () => ({ subjectId, payload: { items: [{ productId: 'bread', quantity: 2 }] } });
function fixture() {
  const base = shopFixture(), platform = fakeWechat();
  let drop = false, subject = subjectId;
  const requests = [];
  const app = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const recovery = (who = subjectId) => {
    const client = createTradeClient({ clock: base.clock, send: async request => {
      requests.push(request.action);
      const result = await app.handle(request, { subject });
      if (drop && request.action === 'orders.create') { drop = false; throw new Error('LOST_RESPONSE'); }
      return result;
    } });
    return createCheckoutRecovery({ client, subjectId: who,
      storage: createWechatCheckoutStorage({ wx: platform.wx, subjectId: who }) });
  };
  return { ...base, ...platform, recovery, requests, dropNext: () => { drop = true; },
    switchSubject: value => { subject = value; } };
}

test('微信草稿缓存：缺失键返回null，不读取其他业务缓存', () => {
  const { wx, values, calls } = fakeWechat();
  values.set('legacy-cart', { private: true });
  assert.equal(createWechatCheckoutStorage({ wx, subjectId }).get(key), null);
  assert.deepEqual(calls, ['info']);
});

test('微信草稿缓存：保存/读取隔离对象引用，只移除指定草稿', () => {
  const { wx, values } = fakeWechat(), source = record();
  const storage = createWechatCheckoutStorage({ wx, subjectId });
  values.set('legacy-cart', { unchanged: true });
  storage.set(key, source); source.payload.items[0].quantity = 9;
  const loaded = storage.get(key); loaded.payload.items[0].quantity = 8;
  assert.equal(storage.get(key).payload.items[0].quantity, 2);
  storage.remove(key);
  assert.equal(storage.get(key), null);
  assert.deepEqual(values.get('legacy-cart'), { unchanged: true });
});

test('微信草稿缓存：其他主体和环境的键均拒绝，不调用平台', () => {
  const { wx, calls } = fakeWechat();
  const storage = createWechatCheckoutStorage({ wx, subjectId });
  for (const wrong of ['bakery.checkout.v1:other-demo', 'bakery.checkout.test:' + subjectId, 'openid']) {
    for (const method of ['get', 'set', 'remove']) {
      assert.throws(() => storage[method](wrong, record()), error => error.code === 'CHECKOUT_IDENTITY_MISMATCH');
    }
  }
  assert.deepEqual(calls, []);
  assert.throws(() => storage.set(key, { subjectId: 'other-demo' }), error => error.code === 'INVALID_CHECKOUT_DRAFT');
});

test('微信草稿缓存：不兼容平台和非法配置在创建时拒绝', () => {
  const { wx } = fakeWechat();
  for (const options of [{}, { wx, subjectId: '' }, { wx, subjectId, namespace: 'bad:namespace' },
    { wx: { ...wx, removeStorageSync: null }, subjectId }]) {
    assert.throws(() => createWechatCheckoutStorage(options), error => error.code === 'INVALID_REQUEST');
  }
});

test('微信草稿缓存：平台读写删除异常不泄露详情，读失败不冒充无草稿', () => {
  const { wx, values, fail } = fakeWechat(); values.set(key, record());
  const storage = createWechatCheckoutStorage({ wx, subjectId });
  for (const [method, action] of [['info', () => storage.get(key)], ['get', () => storage.get(key)],
    ['set', () => storage.set(key, record())], ['remove', () => storage.remove(key)]]) {
    fail(method);
    assert.throws(action, error => error.code === 'CHECKOUT_STORAGE_ERROR' && !error.message.includes('private-platform'));
  }
  assert.ok(values.has(key));
});

test('微信草稿缓存：畸形缓存清单拒绝，已存在空值不冒充缺失键', () => {
  const { wx, values } = fakeWechat();
  const storage = createWechatCheckoutStorage({ wx, subjectId });
  for (const value of [null, undefined, '']) {
    values.set(key, value); assert.notEqual(storage.get(key), null);
  }
  wx.getStorageInfoSync = () => ({ keys: null });
  assert.throws(() => storage.get(key), error => error.code === 'CHECKOUT_STORAGE_ERROR');
});

test('微信草稿缓存贯通：重建客户端和适配器后恢复原报价，确认后只查原订单', async () => {
  const { recovery, repository, requests } = fixture();
  const draft = await recovery().prepare(input);
  assert.equal(draft.quote.totalCents, 2500);
  const order = await (await recovery().restore()).submit();
  const before = requests.filter(action => action === 'orders.create').length;
  assert.equal((await (await recovery().restore()).submit())._id, order._id);
  assert.equal(requests.filter(action => action === 'orders.create').length, before);
  assert.equal(requests.filter(action => action === 'orders.quote').length, 1);
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
});

test('微信草稿缓存贯通：提交成功丢响应后重建，不重复订单或库存预留', async () => {
  const { recovery, repository, dropNext } = fixture();
  const draft = await recovery().prepare(input); dropNext();
  await assert.rejects(draft.submit(), error => error.uncertain);
  await (await recovery().restore()).retry();
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
});

test('微信草稿缓存贯通：配额写失败阻止下单，损坏空值需人工确认清理', async () => {
  const { recovery, values, fail, requests } = fixture();
  const draft = await recovery().prepare(input); fail('set');
  await assert.rejects(draft.submit(), error => error.code === 'CHECKOUT_STORAGE_ERROR');
  assert.equal(requests.filter(action => action === 'orders.create').length, 0);
  fail(null); values.set(key, null);
  await assert.rejects(recovery().restore(), error => error.code === 'INVALID_CHECKOUT_DRAFT');
  await assert.rejects(recovery().discard(), error => error.code === 'INVALID_CHECKOUT_DRAFT');
  assert.equal((await recovery().discard({ acknowledgeUncertain: true })).cancelledOrder, false);
  assert.equal(values.has(key), false);
});

test('微信草稿缓存贯通：账号切换不提交旧意图，独立环境不读旧草稿', async () => {
  const { recovery, wx, switchSubject, requests } = fixture();
  const draft = await recovery().prepare(input); switchSubject('other-demo');
  await assert.rejects(draft.submit(), error => error.code === 'CHECKOUT_IDENTITY_MISMATCH');
  assert.equal(await recovery('other-demo').restore(), null);
  const storage = createWechatCheckoutStorage({ wx, subjectId, namespace: 'bakery.checkout.test' });
  assert.equal(storage.get('bakery.checkout.test:' + subjectId), null);
  assert.equal(requests.filter(action => action === 'orders.create').length, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckoutRecovery } = require('../services/checkout-recovery');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { shopFixture } = require('./support/shop-fixture');

const input = (change = {}) => ({ requestId: 'recovery-checkout-001', deliveryType: 'pickup',
  items: [{ productId: 'bread', quantity: 2 }], ...change });
function fixture() {
  const base = shopFixture();
  const values = new Map();
  let subject = 'buyer-demo', drop = false, writes = 0, failWriteAt = 0;
  const seen = [];
  const app = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const storage = { get: key => structuredClone(values.get(key)),
    set: (key, value) => { writes += 1; if (writes === failWriteAt) throw new Error('LOCAL_STORAGE_FAILURE'); values.set(key, structuredClone(value)); },
    remove: key => { values.delete(key); } };
  const makeClient = () => createTradeClient({ clock: base.clock, send: async request => {
    seen.push(structuredClone(request));
    const response = await app.handle(request, { subject });
    if (drop && request.action === 'orders.create') { drop = false; throw new Error('LOST_AFTER_COMMIT'); }
    return response;
  } });
  const recover = (subjectId = 'buyer-demo') => createCheckoutRecovery({ client: makeClient(), storage, subjectId });
  return { ...base, recover, values, seen, storage, setSubject: value => { subject = value; },
    dropNext: () => { drop = true; }, failWrite: at => { failWriteAt = at; } };
}

test('结算恢复：保存原请求/报价，重建客户端后恢复，不重新报价或更换ID', async () => {
  const { recover, seen } = fixture();
  const original = await recover().prepare(input());
  assert.equal(original.quote.totalCents, 2500);
  assert.throws(() => { original.payload.items[0].quantity = 99; }, TypeError);
  const restored = await recover().restore();
  assert.equal(restored.restored, true);
  const order = await restored.submit();
  assert.equal(order.requestId, input().requestId);
  assert.equal(seen.filter(row => row.action === 'orders.quote').length, 1);
});

test('结算恢复：提交已成功但响应丢失，刷新后仍恢复同一张订单和一次库存预留', async () => {
  const { recover, dropNext, repository } = fixture();
  const recovery = recover();
  const draft = await recovery.prepare(input());
  dropNext();
  await assert.rejects(draft.submit(), error => error.code === 'NETWORK_ERROR' && error.uncertain);
  assert.equal((await recovery.inspect()).state, 'UNCERTAIN');
  const restored = await recover().restore();
  const order = await restored.retry();
  assert.equal(order.amounts.totalCents, 2500);
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
});

test('结算恢复：结果未知时禁止新请求覆盖，清理需明确确认且不会取消服务器订单', async () => {
  const { recover, dropNext, repository } = fixture();
  const recovery = recover();
  const draft = await recovery.prepare(input()); dropNext();
  await assert.rejects(draft.submit(), error => error.code === 'NETWORK_ERROR');
  await assert.rejects(recovery.prepare(input({ requestId: 'recovery-checkout-002' })), error => error.code === 'CHECKOUT_RECOVERY_REQUIRED');
  await assert.rejects(recovery.discard(), error => error.code === 'CHECKOUT_RECOVERY_REQUIRED');
  assert.deepEqual(await recovery.discard({ acknowledgeUncertain: true }), { discarded: true, cancelledOrder: false });
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
});

test('结算恢复：存储在发送前失败时不创建订单，不能绕过恢复记录提交', async () => {
  const { recover, failWrite, repository, seen } = fixture();
  const draft = await recover().prepare(input());
  failWrite(2);
  await assert.rejects(draft.submit(), error => error.code === 'CHECKOUT_STORAGE_ERROR' && !error.uncertain);
  assert.equal(Object.keys(repository.snapshot().orders || {}).length, 0);
  assert.equal(seen.filter(row => row.action === 'orders.create').length, 0);
});

test('结算恢复：成功后写本地确认失败，仍返回已知成功，刷新重试也不重复建单', async () => {
  const { recover, failWrite, repository } = fixture();
  const draft = await recover().prepare(input()); failWrite(3);
  const order = await draft.submit();
  assert.equal(draft.getRecoveryStatus().storageWarning, true);
  const restored = await recover().restore();
  assert.equal((await restored.submit())._id, order._id);
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
});

test('结算恢复：确认成功的记录刷新后只查最新订单，不再次调用创建', async () => {
  const { recover, seen, orders } = fixture();
  const order = await (await recover().prepare(input())).submit();
  await orders.simulatePay({ openid: 'buyer-demo', role: 'customer' }, order._id);
  const before = seen.filter(row => row.action === 'orders.create').length;
  const latest = await (await recover().restore()).submit();
  assert.equal(latest.paymentStatus, 'PAID');
  assert.equal(seen.filter(row => row.action === 'orders.create').length, before);
});

test('结算恢复：调价不自动接受新金额，旧报价拒绝后需人工准备新意图', async () => {
  const { recover, repository } = fixture();
  const recovery = recover();
  await recovery.prepare(input());
  await repository.transaction(async tx => tx.set('products', 'bread', { ...await tx.get('products', 'bread'), priceCents: 1500 }));
  await assert.rejects((await recover().restore()).submit(), error => error.code === 'PRICE_CHANGED');
  assert.equal((await recovery.inspect()).state, 'REJECTED');
  const confirmed = await recovery.prepare(input({ requestId: 'recovery-checkout-002' }));
  assert.equal(confirmed.quote.totalCents, 3000);
});

test('结算恢复：身份隔离，切换主体不能提交其他账号的草稿', async () => {
  const { recover, setSubject, repository } = fixture();
  const recovery = recover();
  const draft = await recovery.prepare(input());
  setSubject('other-demo');
  await assert.rejects(draft.submit(), error => error.code === 'CHECKOUT_IDENTITY_MISMATCH');
  assert.equal(await recover('other-demo').restore(), null);
  assert.equal(Object.keys(repository.snapshot().orders || {}).length, 0);
});

test('结算恢复：持久化白名单不包含口令、令牌、身份标记或任意请求字段', async () => {
  const { recover, values } = fixture();
  await recover().prepare(input({ password: 'must-not-store', staffToken: 'must-not-store', role: 'owner', actor: { trustedSystem: true } }));
  const saved = JSON.stringify([...values.values()]);
  assert.ok(!saved.includes('must-not-store'));
  assert.ok(!saved.includes('staffToken'));
  assert.ok(!saved.includes('trustedSystem'));
});

test('结算恢复：旧草稿被新确认意图替换后禁止提交；同ID变参拒绝', async () => {
  const { recover, repository } = fixture();
  const recovery = recover();
  const first = await recovery.prepare(input());
  await assert.rejects(recovery.prepare(input({ items: [{ productId: 'bread', quantity: 3 }] })), error => error.code === 'IDEMPOTENCY_CONFLICT');
  await recovery.prepare(input({ requestId: 'recovery-checkout-002' }));
  await assert.rejects(first.submit(), error => error.code === 'STALE_CHECKOUT_DRAFT');
  assert.equal(Object.keys(repository.snapshot().orders || {}).length, 0);
});

test('结算恢复：损坏版本或报价不能被恢复，存储读取失败不泄露原始异常', async () => {
  const { recover, values, storage } = fixture();
  await recover().prepare(input());
  const key = [...values.keys()][0];
  values.set(key, { ...values.get(key), schemaVersion: 999 });
  await assert.rejects(recover().restore(), error => error.code === 'INVALID_CHECKOUT_DRAFT');
  storage.get = () => { throw new Error('secret-local-io-detail'); };
  await assert.rejects(recover().restore(), error => error.code === 'CHECKOUT_STORAGE_ERROR' && !error.message.includes('secret-local'));
});

test('结算恢复：重复点击共用一次提交，不重复写预留', async () => {
  const { recover, repository, seen } = fixture();
  const draft = await recover().prepare(input());
  const results = await Promise.all(Array.from({ length: 10 }, () => draft.submit()));
  assert.equal(new Set(results.map(order => order._id)).size, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
  assert.equal(seen.filter(row => row.action === 'orders.create').length, 1);
});

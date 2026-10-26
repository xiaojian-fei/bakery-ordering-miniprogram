'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shopFixture, buyer, other, owner, staff, addressInput } = require('./support/shop-fixture');
const { ShopService } = require('../cloudfunctions/api/domain/shop-service');
const { NotificationService } = require('../cloudfunctions/api/domain/notification-service');
const { NotificationJob } = require('../cloudfunctions/api/jobs/notification-job');
const { DEFAULT_SHIPPING } = require('../cloudfunctions/api/domain/pricing');
const code = expected => error => error.code === expected;
const checkout = requestId => ({ requestId, deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 1 }] });
const shopInput = (change = {}) => ({ requestId: 'shop-save-001', expectedVersion: 0, name: '测试烘焙店',
  banners: ['cloud://test-only/banner.png'], shipping: { ...DEFAULT_SHIPPING, northernFeeCents: 500 }, ...change });

test('FR-11 店铺配置与运费只由店主修改，报价重读配置且保留订单规则快照', async () => {
  const { repository, clock, orders, addresses } = shopFixture();
  const shop = new ShopService(repository, { clock });
  await addresses.save(buyer, addressInput());
  const input = { ...checkout('checkout-shop-001'), deliveryType: 'delivery', addressId: 'home' };
  const quote = await orders.quote(buyer, input);
  const oldOrder = await orders.create(buyer, input);
  await assert.rejects(shop.save(staff, shopInput()), code('FORBIDDEN'));
  const saved = await shop.save(owner, shopInput());
  assert.equal(saved.shipping.version, 'shipping-config-v1');
  assert.equal((await shop.get(buyer)).banners.length, 1);
  await assert.rejects(orders.create(buyer, { ...input, requestId: 'checkout-shop-002', expectedTotalCents: quote.totalCents }), code('PRICE_CHANGED'));
  assert.equal((await orders.quote(buyer, input)).shippingCents, 500);
  assert.equal((await orders.get(buyer, oldOrder._id)).amounts.shippingCents, 1000);
});

test('FR-11 店铺配置去重、版本与回滚，非法运费和空地区列表拒绝', async () => {
  const { repository, clock } = shopFixture();
  const shop = new ShopService(repository, { clock });
  await Promise.all([shop.save(owner, shopInput()), shop.save(owner, shopInput())]);
  assert.equal(Object.keys(repository.snapshot().shop_events).length, 1);
  await assert.rejects(shop.save(owner, shopInput({ requestId: 'shop-save-002' })), code('VERSION_CONFLICT'));
  await assert.rejects(shop.save(owner, shopInput({ shipping: { ...DEFAULT_SHIPPING, northernFeeCents: -1 } })), code('INVALID_AMOUNT'));
  await assert.rejects(shop.save(owner, shopInput({ shipping: { ...DEFAULT_SHIPPING, northernProvinces: [''] } })), code('INVALID_REQUEST'));
  const before = repository.snapshot();
  repository.failNextCommit = true;
  await assert.rejects(shop.save(owner, shopInput({ requestId: 'shop-save-002', expectedVersion: 1 })), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), before);
});

test('通知事务：订单提交才创建任务，业务回滚不残留通知，重复操作不重建任务', async () => {
  const { repository, orders } = shopFixture();
  repository.failNextCommit = true;
  await assert.rejects(orders.create(buyer, checkout('checkout-notice-001')), /INJECTED_COMMIT_FAILURE/);
  assert.equal(Object.keys(repository.snapshot().notification_outbox || {}).length, 0);
  const order = await orders.create(buyer, checkout('checkout-notice-001'));
  await orders.create(buyer, checkout('checkout-notice-001'));
  await orders.simulatePay(buyer, order._id);
  await orders.simulatePay(buyer, order._id);
  assert.equal(Object.keys(repository.snapshot().notification_outbox).length, 2);
});

test('通知重试：通道失败不回滚订单，退避后重试，到上限停止，不保存原始异常', async () => {
  const { repository, clock, orders, setTime } = shopFixture();
  const order = await orders.create(buyer, checkout('checkout-notice-001'));
  const job = new NotificationJob({ repository, clock, maxAttempts: 2, send: async () => { throw new Error('secret-channel-detail'); } });
  assert.equal((await job.run()).retrying, 1);
  assert.equal((await job.run()).claimed, 0);
  assert.equal((await orders.get(buyer, order._id)).status, 'PENDING_PAYMENT');
  setTime(1001000);
  assert.equal((await job.run()).failed, 1);
  assert.equal((await job.run()).claimed, 0);
  assert.ok(!JSON.stringify(repository.snapshot()).includes('secret-channel-detail'));
});

test('通知发送成功只记录一次，站内列表仅本人可见且不暴露租约令牌', async () => {
  const { repository, clock, orders } = shopFixture();
  await orders.create(buyer, checkout('checkout-notice-001'));
  const events = [];
  const job = new NotificationJob({ repository, clock, send: async event => { events.push(event); return { delivered: true }; } });
  assert.equal((await job.run()).delivered, 1);
  assert.equal((await job.run()).claimed, 0);
  assert.equal(events.length, 1);
  const notifications = new NotificationService(repository);
  const mine = await notifications.list(buyer);
  assert.equal(mine.items[0].status, 'DELIVERED');
  assert.ok(!JSON.stringify(mine).includes('leaseToken'));
  assert.equal((await notifications.list(other)).items.length, 0);
  await assert.rejects(notifications.list(staff, { manage: true }), code('FORBIDDEN'));
});

test('通知竞争：两个任务同时运行不重复领取有效租约', async () => {
  const { repository, clock, orders } = shopFixture();
  await orders.create(buyer, checkout('checkout-notice-001'));
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const a = new NotificationJob({ repository, clock, send: async () => { entered(); await waiting; return { delivered: true }; } });
  const b = new NotificationJob({ repository, clock, send: async () => ({ delivered: true }) });
  const first = a.run(); await started;
  assert.equal((await b.run()).claimed, 0);
  release(); assert.equal((await first).delivered, 1);
});

test('通知恢复：发送后确认提交失败，租约到期后使用相同事件ID再次发送', async () => {
  const { repository, clock, orders, setTime } = shopFixture();
  await orders.create(buyer, checkout('checkout-notice-001'));
  const sent = [];
  let failAck = true;
  const job = new NotificationJob({ repository, clock, leaseMs: 10, send: async event => {
    sent.push(event.eventId);
    if (failAck) { failAck = false; repository.failNextCommit = true; }
    return { delivered: true };
  } });
  await assert.rejects(job.run(), /INJECTED_COMMIT_FAILURE/);
  assert.equal((await job.run()).claimed, 0);
  setTime(1000010);
  assert.equal((await job.run()).delivered, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
});

test('通知恢复：旧任务迟到的确认不能覆盖重新领取后的结果', async () => {
  const { repository, clock, orders, setTime } = shopFixture();
  await orders.create(buyer, checkout('checkout-notice-001'));
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const a = new NotificationJob({ repository, clock, leaseMs: 10, send: async () => { entered(); await waiting; return { delivered: true }; } });
  const b = new NotificationJob({ repository, clock, leaseMs: 10, send: async () => ({ delivered: true }) });
  const first = a.run(); await started; setTime(1000010);
  assert.equal((await b.run()).delivered, 1);
  release(); assert.equal((await first).leaseLost, 1);
  assert.equal(Object.values(repository.snapshot().notification_outbox)[0].attempts, 2);
});

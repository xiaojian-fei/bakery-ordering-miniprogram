'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderExpiryJob } = require('../cloudfunctions/api/jobs/order-expiry-job');
const { OrderService } = require('../cloudfunctions/api/domain/order-service');
const { STATUS } = require('../cloudfunctions/api/domain/order-state');
const { MemoryRepository } = require('./support/memory-repository');

const buyer = { openid: 'buyer-demo', role: 'customer' };
const system = { openid: 'expiry-job', role: 'system', trustedSystem: true };
const code = expected => error => error.code === expected;
const rows = (repository, table) => Object.values(repository.snapshot()[table] || {});

async function fixture(count = 5) {
  let now = 1000000;
  const repository = new MemoryRepository({ products: { bread: { _id: 'bread', name: '测试商品',
    priceCents: 1250, isOnSale: true, onHand: 100, reserved: 0, inventoryVersion: 0 } } });
  const clock = () => now;
  const orders = new OrderService(repository, { clock });
  const created = [];
  for (let i = 0; i < count; i += 1) {
    created.push(await orders.create(buyer, { requestId: 'checkout-expiry-' + i, deliveryType: 'pickup',
      items: [{ productId: 'bread', quantity: 1 }] }));
  }
  const findCandidates = options => repository.findExpiredOrders(options);
  const expireOrder = id => orders.expire(system, id);
  const job = new OrderExpiryJob({ clock, findCandidates, expireOrder });
  return { repository, orders, created, job, clock, findCandidates, expireOrder, setTime: value => { now = value; } };
}

test('FR-06 同一到期时刻按二元游标分批处理，不因待支付记录减少而漏单', async () => {
  const { repository, job, created, setTime } = await fixture();
  setTime(created[0].expiresAt);
  const result = await job.run({ batchSize: 2 });
  assert.deepEqual({ scanned: result.scanned, expired: result.expired, failed: result.failed, truncated: result.truncated },
    { scanned: 5, expired: 5, failed: 0, truncated: false });
  assert.equal(rows(repository, 'orders').filter(order => order.status === STATUS.EXPIRED).length, 5);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
  assert.equal(repository.snapshot().products.bread.onHand, 100);
});

test('FR-06 截止时刻前不释放，到达截止时刻才过期，重复扫描没有重复流水', async () => {
  const { repository, job, created, setTime } = await fixture(1);
  setTime(created[0].expiresAt - 1);
  assert.equal((await job.run()).scanned, 0);
  setTime(created[0].expiresAt);
  assert.equal((await job.run()).expired, 1);
  assert.equal((await job.run()).scanned, 0);
  assert.equal(rows(repository, 'inventory_movements').filter(row => row.action === 'expire').length, 1);
});

test('FR-06 单笔提交失败不阻塞其他订单，下次完整扫描重试失败项', async () => {
  const base = await fixture(3);
  base.setTime(base.created[0].expiresAt);
  let fail = true;
  const job = new OrderExpiryJob({ clock: base.clock, findCandidates: base.findCandidates,
    expireOrder: id => {
      if (fail) { fail = false; base.repository.failNextCommit = true; }
      return base.expireOrder(id);
    } });
  const result = await job.run({ batchSize: 2 });
  assert.equal(result.expired, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(result).includes('INJECTED_COMMIT_FAILURE'));
  assert.equal(base.repository.snapshot().products.bread.reserved, 1);
  assert.equal((await job.run()).expired, 1);
  assert.equal(base.repository.snapshot().products.bread.reserved, 0);
});

test('FR-06 批次数到限后保守标记截断，下次从头扫描继续', async () => {
  const { job, created, setTime, repository } = await fixture(5);
  setTime(created[0].expiresAt);
  const first = await job.run({ batchSize: 2, maxBatches: 1 });
  assert.equal(first.expired, 2);
  assert.equal(first.truncated, true);
  const next = await job.run({ batchSize: 2 });
  assert.equal(next.expired, 3);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
});

test('FR-06 两个后台任务重叠执行也只释放一次预留', async () => {
  const { job, created, setTime, repository } = await fixture(3);
  setTime(created[0].expiresAt);
  const results = await Promise.all([job.run({ batchSize: 2 }), job.run({ batchSize: 2 })]);
  assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
  assert.equal(rows(repository, 'inventory_movements').filter(row => row.action === 'expire').length, 3);
  assert.equal(rows(repository, 'order_events').filter(row => row.action === 'expire').length, 3);
});

test('FR-06 候选过期快照包含已支付/取消订单时，按最新事务状态跳过', async () => {
  const base = await fixture(2);
  const candidates = base.created.map(order => ({ orderId: order._id, expiresAt: order.expiresAt }))
    .sort((a, b) => a.orderId < b.orderId ? -1 : 1);
  await base.orders.simulatePay(buyer, base.created[0]._id);
  await base.orders.cancel(buyer, base.created[1]._id);
  base.setTime(base.created[0].expiresAt);
  const job = new OrderExpiryJob({ clock: base.clock, findCandidates: async () => candidates, expireOrder: base.expireOrder });
  const result = await job.run();
  assert.equal(result.skipped, 2);
  assert.equal(result.expired, 0);
  assert.equal(base.repository.snapshot().products.bread.onHand, 99);
  assert.equal(base.repository.snapshot().products.bread.reserved, 0);
});

test('FR-06 本轮使用固定截止时刻，新到期订单留给下一次扫描', async () => {
  const base = await fixture(1);
  const later = await base.repository.transaction(async tx => {
    const order = await tx.get('orders', base.created[0]._id);
    order.expiresAt += 1000;
    await tx.set('orders', order._id, order);
    return order;
  });
  base.setTime(later.expiresAt - 1000);
  let queryDueAt;
  const job = new OrderExpiryJob({ clock: base.clock, expireOrder: base.expireOrder,
    findCandidates: async options => {
      queryDueAt = options.dueAt;
      base.setTime(later.expiresAt);
      return base.findCandidates(options);
    } });
  assert.equal((await job.run()).scanned, 0);
  assert.equal(queryDueAt, later.expiresAt - 1000);
  assert.equal((await base.job.run()).expired, 1);
});

test('FR-06 查询失败停止任务但保留已提交结果，下次扫描可恢复', async () => {
  const base = await fixture(3);
  base.setTime(base.created[0].expiresAt);
  let queries = 0;
  const job = new OrderExpiryJob({ clock: base.clock, expireOrder: base.expireOrder,
    findCandidates: options => {
      queries += 1;
      if (queries === 2) throw new Error('SCAN_UNAVAILABLE');
      return base.findCandidates(options);
    } });
  await assert.rejects(job.run({ batchSize: 1 }), /SCAN_UNAVAILABLE/);
  assert.equal(base.repository.snapshot().products.bread.reserved, 2);
  assert.equal((await base.job.run()).expired, 2);
});

test('后台适配契约：无序、重复、超量、未来或非法候选在该批写入前拒绝', async () => {
  const good = { orderId: 'order-a', expiresAt: 1000 };
  const badPages = [[good, good], [{ ...good, orderId: 'order-z' }, good], [{ ...good, expiresAt: 1001 }],
    [{ ...good, orderId: '../bad' }], { rows: [good] }, [good, { ...good, orderId: 'order-b' }, { ...good, orderId: 'order-c' }]];
  for (const page of badPages) {
    let calls = 0;
    const job = new OrderExpiryJob({ clock: () => 1000, findCandidates: async () => page,
      expireOrder: async () => { calls += 1; } });
    await assert.rejects(job.run({ batchSize: 2 }), code('INVALID_ADAPTER'));
    assert.equal(calls, 0);
  }
});

test('后台适配契约：候选查询忽略游标会被拒绝，不无限重复扫描', async () => {
  let calls = 0;
  const job = new OrderExpiryJob({ clock: () => 1000,
    findCandidates: async () => [{ orderId: 'order-a', expiresAt: 1000 }],
    expireOrder: async () => { calls += 1; return { _id: 'order-a', status: STATUS.EXPIRED }; } });
  await assert.rejects(job.run({ batchSize: 1 }), code('INVALID_ADAPTER'));
  assert.equal(calls, 1);
});

test('后台适配契约：处理器没有返回已处理订单则报告失败', async () => {
  const job = new OrderExpiryJob({ clock: () => 1000,
    findCandidates: async () => [{ orderId: 'order-a', expiresAt: 1000 }],
    expireOrder: async () => ({ _id: 'order-a', status: STATUS.PENDING_PAYMENT }) });
  assert.equal((await job.run()).failures[0].code, 'INVALID_ADAPTER');
});

test('后台适配契约：无查询适配器、异常时钟或无界批大小均拒绝', async () => {
  assert.throws(() => new OrderExpiryJob(), code('INVALID_CONFIG'));
  const job = new OrderExpiryJob({ clock: () => NaN, findCandidates: async () => [], expireOrder: async () => {} });
  await assert.rejects(job.run(), code('INVALID_CONFIG'));
  const base = await fixture(0);
  for (const options of [{ batchSize: 0 }, { batchSize: 101 }, { batchSize: 1.5 }, { maxBatches: 21 }]) {
    await assert.rejects(base.job.run(options), code('INVALID_REQUEST'));
  }
});

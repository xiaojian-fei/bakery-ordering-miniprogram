'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../cloudfunctions/api/domain/order-service');
const { normalizeItems, calculateQuote } = require('../cloudfunctions/api/domain/pricing');
const { STATUS, nextStatus } = require('../cloudfunctions/api/domain/order-state');
const { requireRole } = require('../cloudfunctions/api/domain/auth');
const { MemoryRepository } = require('./support/memory-repository');

const customer = { openid: 'customer-a', role: 'customer' };
const another = { openid: 'customer-b', role: 'customer' };
const system = { openid: 'scheduled-task', role: 'system', trustedSystem: true };
const staff = { openid: 'staff-a', role: 'staff', staffVerified: true };
const owner = { openid: 'owner-a', role: 'owner', staffVerified: true };
const code = expected => error => error.code === expected;
const records = (repo, table) => Object.values(repo.snapshot()[table] || {});

function fixture() {
  let now = 1000000;
  const repo = new MemoryRepository({
    products: {
      berry: { _id: 'berry', name: '演示司康', priceCents: 1190, isOnSale: true, onHand: 5, reserved: 0 },
      cookie: { _id: 'cookie', name: '演示饼干', priceCents: 890, isOnSale: true, onHand: 2, reserved: 0 }
    },
    addresses: {
      'address-a': { _id: 'address-a', ownerOpenid: customer.openid, name: '演示顾客',
        phone: '13800000000', province: '北京市', city: '北京市', district: '海淀区', detail: '虚构教学楼' },
      'address-b': { _id: 'address-b', ownerOpenid: another.openid, name: '另一个演示用户',
        phone: '13900000000', province: '广东省', city: '示例市', district: '示例区', detail: '虚构地址' }
    }
  });
  const service = new OrderService(repo, { clock: () => now });
  const input = { requestId: 'request-001', deliveryType: 'pickup', items: [{ productId: 'berry', quantity: 2 }] };
  return { repo, service, input, setTime: value => { now = value; } };
}

test('FR-05 服务端查价，忽略客户端伪造金额与商品名称', async () => {
  const { repo, service, input } = fixture();
  const order = await service.create(customer, { ...input, totalPrice: 0.01, shippingFee: 0,
    items: [{ productId: 'berry', quantity: 2, price: 0.01, name: '伪造名称' }] });
  assert.equal(order.amounts.totalCents, 2380);
  assert.equal(order.items[0].name, '演示司康');
  assert.deepEqual(repo.snapshot().products.berry, { _id: 'berry', name: '演示司康', priceCents: 1190,
    isOnSale: true, onHand: 5, reserved: 2, inventoryVersion: 1 });
  assert.equal(records(repo, 'order_events').length, 1);
});

test('FR-05 预期金额与服务端报价不一致时不创建订单', async () => {
  const { repo, service, input } = fixture();
  await assert.rejects(service.create(customer, { ...input, expectedTotalCents: 1 }), code('PRICE_CHANGED'));
  assert.equal(records(repo, 'orders').length, 0);
  assert.equal(repo.snapshot().products.berry.reserved, 0);
});

test('FR-05 合并重复商品，统一校验数量', async () => {
  const { service, input } = fixture();
  const order = await service.create(customer, { ...input,
    items: [{ productId: 'berry', quantity: 1 }, { productId: 'berry', quantity: 2 }] });
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].quantity, 3);
});

for (const quantity of [0, -1, 1.5, '2', NaN, 100]) {
  test('FR-05 拒绝非法数量 ' + String(quantity), async () => {
    const { service, input } = fixture();
    await assert.rejects(service.create(customer, { ...input, items: [{ productId: 'berry', quantity }] }), code('INVALID_QUANTITY'));
  });
}

test('FR-05 拒绝空单和重复商品累加超限', async () => {
  const { service, input } = fixture();
  await assert.rejects(service.create(customer, { ...input, items: [] }), code('INVALID_ITEMS'));
  assert.throws(() => normalizeItems([{ productId: 'berry', quantity: 60 }, { productId: 'berry', quantity: 50 }]), code('INVALID_QUANTITY'));
});

test('FR-02 下架和不存在商品不能下单', async () => {
  const { repo, service, input } = fixture();
  await repo.transaction(async tx => { const p = await tx.get('products', 'berry'); p.isOnSale = false; await tx.set('products', 'berry', p); });
  await assert.rejects(service.create(customer, input), code('PRODUCT_UNAVAILABLE'));
  await assert.rejects(service.create(customer, { ...input, items: [{ productId: 'missing', quantity: 1 }] }), code('PRODUCT_NOT_FOUND'));
});

test('FR-05 同一请求并发重试十次，只创建一单并预留一次', async () => {
  const { repo, service, input } = fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => service.create(customer, input)));
  assert.equal(new Set(results.map(order => order._id)).size, 1);
  assert.equal(records(repo, 'orders').length, 1);
  assert.equal(records(repo, 'request_keys').length, 1);
  assert.equal(repo.snapshot().products.berry.reserved, 2);
});

test('FR-05 同请求ID修改业务参数应拒绝，忽略非业务展示字段', async () => {
  const { repo, service, input } = fixture();
  const first = await service.create(customer, input);
  const retry = await service.create(customer, { ...input, totalPrice: 0.01 });
  assert.equal(first._id, retry._id);
  await assert.rejects(service.create(customer, { ...input, remark: '更改参数' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(records(repo, 'orders').length, 1);
});

test('FR-05 请求去重按调用人隔离', async () => {
  const { service, input } = fixture();
  const first = await service.create(customer, { ...input, items: [{ productId: 'berry', quantity: 1 }] });
  const second = await service.create(another, { ...input, items: [{ productId: 'berry', quantity: 1 }] });
  assert.notEqual(first._id, second._id);
});

test('FR-05 五件库存二十个不同请求竞争，内存事务模型仅允许五单成功', async () => {
  const { repo, service, input } = fixture();
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => service.create(
    { openid: 'buyer-' + index, role: 'customer' }, { ...input, requestId: 'request-' + index,
      items: [{ productId: 'berry', quantity: 1 }] })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
  const failures = results.filter(result => result.status === 'rejected');
  assert.ok(failures.every(result => result.reason.code === 'OUT_OF_STOCK'));
  assert.equal(repo.snapshot().products.berry.reserved, 5);
  assert.equal(records(repo, 'orders').length, 5);
});

test('FR-05 第二商品不足时，第一商品预留和日志一起回滚', async () => {
  const { repo, service, input } = fixture();
  await assert.rejects(service.create(customer, { ...input,
    items: [{ productId: 'berry', quantity: 2 }, { productId: 'cookie', quantity: 3 }] }), code('OUT_OF_STOCK'));
  assert.equal(repo.snapshot().products.berry.reserved, 0);
  assert.equal(records(repo, 'inventory_movements').length, 0);
  assert.equal(records(repo, 'orders').length, 0);
});

test('FR-05 模拟提交失败不留下订单或请求记录，原请求可以安全重试', async () => {
  const { repo, service, input } = fixture();
  repo.failNextCommit = true;
  await assert.rejects(service.create(customer, input), /INJECTED_COMMIT_FAILURE/);
  assert.equal(records(repo, 'orders').length, 0);
  assert.equal(records(repo, 'request_keys').length, 0);
  assert.equal(repo.snapshot().products.berry.reserved, 0);
  await service.create(customer, input);
  assert.equal(records(repo, 'orders').length, 1);
});

test('FR-04 地址必须属于当前用户，地址快照来自服务端', async () => {
  const { service, input } = fixture();
  await assert.rejects(service.create(customer, { ...input, deliveryType: 'delivery', addressId: 'address-b' }), code('FORBIDDEN'));
  const order = await service.create(customer, { ...input, deliveryType: 'delivery', addressId: 'address-a',
    address: { province: '伪造地址' }, shippingFee: 0 });
  assert.equal(order.addressSnapshot.province, '北京市');
  assert.equal(order.amounts.shippingCents, 1000);
  assert.equal(order.amounts.totalCents, 3380);
});

for (const [province, amount, expected] of [
  ['北京市', 8799, 1000], ['北京市', 8800, 0],
  ['广东省', 10799, 1300], ['广东省', 10800, 0]
]) {
  test('FR-04 运费边界 ' + province + ' 商品金额' + amount + '分', () => {
    const quote = calculateQuote([{ productId: 'p', quantity: 1 }],
      new Map([['p', { name: '边界商品', isOnSale: true, priceCents: amount }]]), 'delivery', { province });
    assert.equal(quote.shippingCents, expected);
  });
}

test('FR-05 商品价格快照不随后续调价而改变', async () => {
  const { repo, service, input } = fixture();
  const order = await service.create(customer, input);
  await repo.transaction(async tx => { const p = await tx.get('products', 'berry'); p.priceCents = 9990; await tx.set('products', 'berry', p); });
  const retry = await service.create(customer, input);
  assert.equal(retry.amounts.totalCents, 2380);
  assert.equal(order.items[0].unitPriceCents, 1190);
});

test('FR-06 模拟支付重复请求只扣一次实物库存，金额取订单快照', async () => {
  const { repo, service, input } = fixture();
  const order = await service.create(customer, input);
  await Promise.all(Array.from({ length: 10 }, () => service.simulatePay(customer, order._id)));
  assert.equal(repo.snapshot().products.berry.onHand, 3);
  assert.equal(repo.snapshot().products.berry.reserved, 0);
  assert.equal(records(repo, 'payments').length, 1);
  assert.equal(records(repo, 'payments')[0].amountCents, 2380);
  assert.equal(records(repo, 'payments')[0].mode, 'SIMULATED');
  assert.equal(records(repo, 'order_events').length, 2);
});

test('FR-06 支付提交失败时库存、支付记录和订单状态一起回滚', async () => {
  const { repo, service, input } = fixture();
  const order = await service.create(customer, input);
  repo.failNextCommit = true;
  await assert.rejects(service.simulatePay(customer, order._id), /INJECTED_COMMIT_FAILURE/);
  assert.equal(repo.snapshot().products.berry.onHand, 5);
  assert.equal(repo.snapshot().products.berry.reserved, 2);
  assert.equal(records(repo, 'payments').length, 0);
  assert.equal(records(repo, 'orders')[0].status, STATUS.PENDING_PAYMENT);
});

test('FR-06 取消后只释放一次预留，且不能继续支付', async () => {
  const { repo, service, input } = fixture();
  const order = await service.create(customer, input);
  await service.cancel(customer, order._id);
  await service.cancel(customer, order._id);
  assert.equal(repo.snapshot().products.berry.onHand, 5);
  assert.equal(repo.snapshot().products.berry.reserved, 0);
  await assert.rejects(service.simulatePay(customer, order._id), code('INVALID_STATE'));
});

test('FR-06 支付和取消竞争只能有一个成功转换', async () => {
  for (const cancelFirst of [false, true]) {
    const { repo, service, input } = fixture();
    const order = await service.create(customer, input);
    const tasks = cancelFirst ? [() => service.cancel(customer, order._id), () => service.simulatePay(customer, order._id)]
      : [() => service.simulatePay(customer, order._id), () => service.cancel(customer, order._id)];
    const results = await Promise.allSettled(tasks.map(task => task()));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(repo.snapshot().products.berry.reserved, 0);
    assert.equal(repo.snapshot().products.berry.onHand, cancelFirst ? 5 : 3);
  }
});

test('FR-06 支付截止瞬间拒绝付款，由超时任务释放库存且只释放一次', async () => {
  const { repo, service, input, setTime } = fixture();
  const order = await service.create(customer, input);
  setTime(order.expiresAt);
  await assert.rejects(service.simulatePay(customer, order._id), code('ORDER_EXPIRED'));
  await service.expire(system, order._id);
  await service.expire(system, order._id);
  assert.equal(records(repo, 'orders')[0].status, STATUS.EXPIRED);
  assert.equal(repo.snapshot().products.berry.reserved, 0);
  assert.equal(repo.snapshot().products.berry.onHand, 5);
});

test('FR-06 超时任务不能撤销已支付订单，未到期也不能释放', async () => {
  const { service, input } = fixture();
  const order = await service.create(customer, input);
  await assert.rejects(service.expire(system, order._id), code('INVALID_STATE'));
  await service.simulatePay(customer, order._id);
  const result = await service.expire(system, order._id);
  assert.equal(result.status, STATUS.PENDING_ACCEPTANCE);
});

test('FR-01 不能支付或取消他人订单，不能伪造系统身份执行到期任务', async () => {
  const { service, input } = fixture();
  const order = await service.create(customer, input);
  await assert.rejects(service.simulatePay(another, order._id), code('FORBIDDEN'));
  await assert.rejects(service.cancel(another, order._id), code('FORBIDDEN'));
  await assert.rejects(service.expire(customer, order._id), code('FORBIDDEN'));
  await assert.rejects(service.expire({ role: 'system', openid: 'fake' }, order._id), code('FORBIDDEN'));
});

test('FR-01 未验证员工身份不能获得店员权限，店员不能获得店主权限', () => {
  assert.throws(() => requireRole({ openid: 'fake', role: 'staff' }, ['staff', 'owner']), code('FORBIDDEN'));
  assert.throws(() => requireRole(staff, ['owner']), code('FORBIDDEN'));
  assert.doesNotThrow(() => requireRole(owner, ['owner']));
});

test('FR-06 旧版本状态修改拒绝，不改变库存', async () => {
  const { repo, service, input } = fixture();
  const order = await service.create(customer, input);
  await assert.rejects(service.cancel(customer, order._id, { expectedVersion: 2 }), code('VERSION_CONFLICT'));
  assert.equal(repo.snapshot().products.berry.reserved, 2);
});

test('FR-07 履约规则提供给C：店员可接单，配送和自取路径不能混用', () => {
  const pending = { ownerOpenid: customer.openid, status: STATUS.PENDING_ACCEPTANCE, deliveryType: 'pickup' };
  assert.throws(() => nextStatus(pending, 'accept', customer, 0), code('FORBIDDEN'));
  const accepted = { ...pending, status: nextStatus(pending, 'accept', staff, 0) };
  assert.throws(() => nextStatus(accepted, 'ship', staff, 0), code('INVALID_DELIVERY'));
  const ready = { ...accepted, status: nextStatus(accepted, 'readyForPickup', staff, 0) };
  assert.equal(nextStatus(ready, 'complete', staff, 0), STATUS.COMPLETED);
});

test('FR-09 非法库存和非整数分价格拒绝进入订单事务', async () => {
  const { repo, service, input } = fixture();
  await repo.transaction(async tx => { const p = await tx.get('products', 'berry'); p.reserved = 6; await tx.set('products', 'berry', p); });
  await assert.rejects(service.create(customer, input), code('INVALID_INVENTORY'));
  await repo.transaction(async tx => { const p = await tx.get('products', 'berry'); p.reserved = 0; p.priceCents = 11.9; await tx.set('products', 'berry', p); });
  await assert.rejects(service.create(customer, input), code('INVALID_AMOUNT'));
});

test('FR-05 预览报价不预留库存、不建单；调价后旧报价下单会被拒绝', async () => {
  const { repo, service, input } = fixture();
  const quote = await service.quote(customer, input);
  assert.equal(quote.totalCents, 2380);
  assert.equal(repo.snapshot().products.berry.reserved, 0);
  assert.equal(records(repo, 'orders').length, 0);
  await repo.transaction(async tx => {
    const product = await tx.get('products', 'berry');
    product.priceCents = 1500;
    await tx.set('products', 'berry', product);
  });
  await assert.rejects(service.create(customer, { ...input, expectedTotalCents: quote.totalCents }), code('PRICE_CHANGED'));
});

test('FR-04 报价同样校验地址归属和可售库存', async () => {
  const { service, input } = fixture();
  await assert.rejects(service.quote(customer, { ...input, deliveryType: 'delivery', addressId: 'address-b' }), code('FORBIDDEN'));
  await assert.rejects(service.quote(customer, { ...input, items: [{ productId: 'berry', quantity: 6 }] }), code('OUT_OF_STOCK'));
});

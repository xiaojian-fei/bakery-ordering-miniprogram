'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InventoryService } = require('../cloudfunctions/api/domain/inventory-service');
const { OrderService } = require('../cloudfunctions/api/domain/order-service');
const { MemoryRepository } = require('./support/memory-repository');
const code = value => error => error.code === value;
const owner = { openid: 'owner-demo', role: 'owner', staffVerified: true };
const customer = { openid: 'buyer-demo', role: 'customer' };

function fixture() {
  const repository = new MemoryRepository({ products: {
    bread: { _id: 'bread', name: '测试商品', isOnSale: true, priceCents: 1250,
      onHand: 10, reserved: 0, inventoryVersion: 0 }
  } });
  const inventory = new InventoryService(repository, { clock: () => 1000000 });
  const orders = new OrderService(repository, { clock: () => 1000000 });
  const input = { requestId: 'adjust-001', productId: 'bread', onHand: 12,
    expectedVersion: 0, reason: '演示补货' };
  return { repository, inventory, orders, input };
}

test('FR-09 店主调整库存，保存原因、操作者、流水和版本', async () => {
  const { repository, inventory, input } = fixture();
  const result = await inventory.adjust(owner, input);
  assert.equal(result.before, 10);
  assert.equal(result.after, 12);
  assert.equal(result.operatorOpenid, owner.openid);
  assert.equal(result.inventoryVersion, 1);
  assert.equal(repository.snapshot().products.bread.onHand, 12);
  assert.equal(Object.values(repository.snapshot().inventory_movements)[0].onHandDelta, 2);
});

test('FR-09 普通用户、店员、未验证店主不能调整库存', async () => {
  const { inventory, input } = fixture();
  for (const actor of [customer, { openid: 'staff-demo', role: 'staff', staffVerified: true },
    { openid: owner.openid, role: 'owner' }]) await assert.rejects(inventory.adjust(actor, input), code('FORBIDDEN'));
});

test('FR-09 并发重试库存调整不重复累计版本或流水', async () => {
  const { repository, inventory, input } = fixture();
  await Promise.all(Array.from({ length: 10 }, () => inventory.adjust(owner, input)));
  assert.equal(repository.snapshot().products.bread.inventoryVersion, 1);
  assert.equal(Object.keys(repository.snapshot().stock_adjustments).length, 1);
  assert.equal(Object.keys(repository.snapshot().inventory_movements).length, 1);
  await assert.rejects(inventory.adjust(owner, { ...input, onHand: 13 }), code('IDEMPOTENCY_CONFLICT'));
});

test('FR-09 下单预留后旧库存版本立即失效，不能压低到预留数量以下', async () => {
  const { repository, inventory, orders, input } = fixture();
  await orders.create(customer, { requestId: 'checkout-001', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 2 }] });
  await assert.rejects(inventory.adjust(owner, input), code('VERSION_CONFLICT'));
  await assert.rejects(inventory.adjust(owner, { ...input, expectedVersion: 1, onHand: 1 }), code('RESERVED_STOCK_CONFLICT'));
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
});

test('FR-09 支付扣减和取消释放都递增库存版本', async () => {
  for (const action of ['simulatePay', 'cancel']) {
    const { repository, orders } = fixture();
    const order = await orders.create(customer, { requestId: 'checkout-001', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 2 }] });
    await orders[action](customer, order._id);
    assert.equal(repository.snapshot().products.bread.inventoryVersion, 2);
  }
});

test('FR-09 两个不同库存调整竞争时只接受持有当前版本的一个', async () => {
  const { inventory, input, repository } = fixture();
  const results = await Promise.allSettled([
    inventory.adjust(owner, input), inventory.adjust(owner, { ...input, requestId: 'adjust-002', onHand: 20 })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  assert.equal(Object.keys(repository.snapshot().stock_adjustments).length, 1);
});

test('FR-09 库存调整提交失败不留下库存变更、去重记录或流水', async () => {
  const { repository, inventory, input } = fixture();
  repository.failNextCommit = true;
  await assert.rejects(inventory.adjust(owner, input), /INJECTED_COMMIT_FAILURE/);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().products.bread.inventoryVersion, 0);
  assert.equal(Object.keys(repository.snapshot().request_keys || {}).length, 0);
  assert.equal(Object.keys(repository.snapshot().stock_adjustments || {}).length, 0);
});

test('FR-09 拒绝无原因、负数、浮点库存、缺失版本或不存在商品', async () => {
  const { inventory, input } = fixture();
  await assert.rejects(inventory.adjust(owner, { ...input, reason: ' ' }), code('INVALID_REQUEST'));
  for (const onHand of [-1, 1.5, '12']) await assert.rejects(inventory.adjust(owner, { ...input, onHand }), code('INVALID_INVENTORY'));
  await assert.rejects(inventory.adjust(owner, { ...input, expectedVersion: undefined }), code('INVALID_REQUEST'));
  await assert.rejects(inventory.adjust(owner, { ...input, productId: 'missing' }), code('PRODUCT_NOT_FOUND'));
});

test('存储契约：不会把constructor等继承属性误识别为数据库记录', async () => {
  const { repository } = fixture();
  assert.equal(await repository.transaction(tx => tx.get('products', 'constructor')), null);
  await repository.transaction(tx => tx.set('products', '__proto__', { name: '合法ID测试记录' }));
  assert.equal((await repository.transaction(tx => tx.get('products', '__proto__'))).name, '合法ID测试记录');
});

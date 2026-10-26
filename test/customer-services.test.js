'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shopFixture, buyer, other, owner, staff, addressInput } = require('./support/shop-fixture');
const code = expected => error => error.code === expected;
const productInput = (change = {}) => ({ productId: 'bread', requestId: 'product-001', expectedVersion: 0,
  name: '新版司康', priceCents: 1500, isOnSale: true, category: '司康', ...change });

test('FR-02 商品分类/关键字/分页，不返回下架商品，管理范围需要店主', async () => {
  const { catalog } = shopFixture();
  const first = await catalog.list(buyer, { limit: 1 });
  const second = await catalog.list(buyer, { limit: 1, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map(item => item._id), ['bread', 'cookie']);
  assert.equal(second.nextCursor, null);
  assert.equal((await catalog.list(buyer, { category: '司康', keyword: '司' })).items.length, 1);
  await catalog.save(owner, productInput({ isOnSale: false }));
  assert.deepEqual((await catalog.list(buyer)).items.map(item => item._id), ['cookie']);
  assert.equal((await catalog.list(owner, { includeUnavailable: true })).items.length, 2);
  await assert.rejects(catalog.list(staff, { includeUnavailable: true }), code('FORBIDDEN'));
  await assert.rejects(catalog.get(buyer, 'bread'), code('PRODUCT_UNAVAILABLE'));
  assert.equal((await catalog.get(owner, 'bread', { includeUnavailable: true })).isOnSale, false);
});

test('FR-02 商品改价保留库存与旧订单价格快照，旧编辑版本拒绝', async () => {
  const { catalog, orders, paid, repository } = shopFixture();
  const old = await paid();
  const before = repository.snapshot().products.bread;
  const edited = await catalog.save(owner, productInput());
  assert.equal(edited.onHand, before.onHand);
  assert.equal(edited.reserved, before.reserved);
  assert.equal(edited.inventoryVersion, before.inventoryVersion);
  assert.equal((await orders.get(buyer, old._id)).items[0].unitPriceCents, 1250);
  await assert.rejects(catalog.save(owner, productInput({ requestId: 'product-002' })), code('VERSION_CONFLICT'));
});

test('FR-02 新商品初始库存为0，编辑接口不能直接改库存或由店员使用', async () => {
  const { catalog, repository } = shopFixture();
  const created = await catalog.save(owner, productInput({ productId: 'cake' }));
  assert.equal(created.onHand, 0);
  assert.equal(created.available, 0);
  for (const change of [{ onHand: 100 }, { reserved: 0 }, { inventoryVersion: 999 }]) {
    await assert.rejects(catalog.save(owner, productInput(change)), code('INVALID_REQUEST'));
  }
  await assert.rejects(catalog.save(staff, productInput()), code('FORBIDDEN'));
  assert.equal(repository.snapshot().products.bread.onHand, 30);
});

test('FR-02 商品保存同请求重试去重，失败提交无部分商品或事件', async () => {
  const { catalog, repository } = shopFixture();
  await Promise.all([catalog.save(owner, productInput()), catalog.save(owner, productInput())]);
  assert.equal(Object.keys(repository.snapshot().catalog_events).length, 1);
  await assert.rejects(catalog.save(owner, productInput({ name: '变更' })), code('IDEMPOTENCY_CONFLICT'));
  const before = repository.snapshot();
  repository.failNextCommit = true;
  await assert.rejects(catalog.save(owner, productInput({ requestId: 'product-003', expectedVersion: 1 })), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), before);
});

test('FR-04 默认地址只有一个指针，编辑旧默认地址不会留下两个默认标记', async () => {
  const { addresses, repository } = shopFixture();
  await addresses.save(buyer, addressInput());
  await addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'address-002' }));
  let result = await addresses.list(buyer);
  assert.equal(result.items.filter(item => item.isDefault).length, 1);
  assert.equal(result.items.find(item => item.isDefault)._id, 'work');
  await addresses.save(buyer, addressInput({ expectedVersion: 1, requestId: 'address-003' }));
  result = await addresses.list(buyer);
  assert.equal(result.items.find(item => item.isDefault)._id, 'home');
  assert.equal(repository.snapshot().users[buyer.openid].defaultAddressId, 'home');
});

test('FR-04 编辑时不传默认标志保留选择，显式false才取消当前默认', async () => {
  const { addresses } = shopFixture();
  await addresses.save(buyer, addressInput());
  const edit = addressInput({ expectedVersion: 1, requestId: 'address-002', detail: '新测试地址' });
  delete edit.makeDefault;
  assert.equal((await addresses.save(buyer, edit)).isDefault, true);
  await addresses.save(buyer, addressInput({ expectedVersion: 2, requestId: 'address-003', makeDefault: false }));
  assert.equal((await addresses.list(buyer)).items.filter(item => item.isDefault).length, 0);
});

test('FR-04 地址归属、分页游标和删除都不能越权', async () => {
  const { addresses } = shopFixture();
  await addresses.save(buyer, addressInput());
  await addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'address-002' }));
  const first = await addresses.list(buyer, { limit: 1 });
  await assert.rejects(addresses.list(other, { limit: 1, cursor: first.nextCursor }), code('INVALID_CURSOR'));
  await assert.rejects(addresses.save(other, addressInput({ expectedVersion: 1 })), code('FORBIDDEN'));
  await assert.rejects(addresses.remove(other, { addressId: 'home', expectedVersion: 1, requestId: 'remove-001' }), code('FORBIDDEN'));
  assert.equal((await addresses.list(other)).items.length, 0);
});

test('FR-04 删除默认地址会清指针，不能再用于新订单，旧订单地址快照不变', async () => {
  const { addresses, orders, repository } = shopFixture();
  await addresses.save(buyer, addressInput());
  const input = { requestId: 'checkout-address', deliveryType: 'delivery', addressId: 'home', items: [{ productId: 'bread', quantity: 1 }] };
  const order = await orders.create(buyer, input);
  const remove = { addressId: 'home', expectedVersion: 1, requestId: 'remove-001' };
  await addresses.remove(buyer, remove);
  await addresses.remove(buyer, remove);
  assert.equal(repository.snapshot().users[buyer.openid].defaultAddressId, null);
  assert.equal((await addresses.list(buyer)).items.length, 0);
  await assert.rejects(orders.create(buyer, { ...input, requestId: 'checkout-address2' }), code('INVALID_ADDRESS'));
  assert.equal((await orders.get(buyer, order._id)).addressSnapshot.detail, '虚构地址');
});

test('FR-04 地址提交失败回滚默认指针，保存不能覆盖员工角色', async () => {
  const { addresses, repository } = shopFixture();
  await repository.transaction(tx => tx.set('users', owner.openid, { openid: owner.openid, role: 'owner', active: true, authVersion: 7 }));
  await addresses.save(owner, addressInput());
  assert.equal(repository.snapshot().users[owner.openid].role, 'owner');
  assert.equal(repository.snapshot().users[owner.openid].authVersion, 7);
  const before = repository.snapshot();
  repository.failNextCommit = true;
  await assert.rejects(addresses.save(owner, addressInput({ addressId: 'work', requestId: 'address-002' })), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), before);
});

test('FR-03 购物车绝对改量合并同商品，不预留库存，金额读取现价', async () => {
  const { cart, catalog, repository } = shopFixture();
  await cart.setLine(buyer, { productId: 'bread', quantity: 2, expectedVersion: 0, requestId: 'cart-line-001' });
  await cart.setLine(buyer, { productId: 'bread', quantity: 3, expectedVersion: 1, requestId: 'cart-line-002' });
  assert.equal((await cart.get(buyer)).items.length, 1);
  assert.equal((await cart.get(buyer)).estimatedSubtotalCents, 3750);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
  await catalog.save(owner, productInput());
  assert.equal((await cart.get(buyer)).estimatedSubtotalCents, 4500);
  assert.equal((await cart.get(other)).items.length, 0);
});

test('FR-03 重试不重复修改，旧版本不能覆盖购物车或清除新加商品', async () => {
  const { cart } = shopFixture();
  const input = { productId: 'bread', quantity: 2, expectedVersion: 0, requestId: 'cart-line-001' };
  await Promise.all([cart.setLine(buyer, input), cart.setLine(buyer, input)]);
  assert.equal((await cart.get(buyer)).version, 1);
  await assert.rejects(cart.setLine(buyer, { ...input, quantity: 3 }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(cart.clear(buyer, { expectedVersion: 0, requestId: 'cart-clear-001' }), code('VERSION_CONFLICT'));
  await cart.clear(buyer, { expectedVersion: 1, requestId: 'cart-clear-002' });
  assert.equal((await cart.get(buyer)).items.length, 0);
});

test('FR-03 下架或库存变化标记不可结算，但仍可移除失效商品', async () => {
  const { cart, catalog, repository } = shopFixture();
  await cart.setLine(buyer, { productId: 'bread', quantity: 2, expectedVersion: 0, requestId: 'cart-line-001' });
  await repository.transaction(async tx => tx.set('products', 'bread', { ...await tx.get('products', 'bread'), onHand: 1 }));
  assert.equal((await cart.get(buyer)).items[0].issue, 'OUT_OF_STOCK');
  await catalog.save(owner, productInput({ isOnSale: false }));
  const result = await cart.get(buyer);
  assert.equal(result.canCheckout, false);
  assert.equal(result.items[0].issue, 'PRODUCT_UNAVAILABLE');
  await cart.setLine(buyer, { productId: 'bread', quantity: 0, expectedVersion: 1, requestId: 'cart-line-002' });
  assert.equal((await cart.get(buyer)).items.length, 0);
});

test('FR-03 购物车非法数量或库存不足不写入，提交失败整体回滚', async () => {
  const { cart, repository } = shopFixture();
  for (const quantity of [-1, 1.5, 100]) {
    await assert.rejects(cart.setLine(buyer, { productId: 'bread', quantity, expectedVersion: 0, requestId: 'cart-line-001' }), code('INVALID_QUANTITY'));
  }
  await assert.rejects(cart.setLine(buyer, { productId: 'bread', quantity: 31, expectedVersion: 0, requestId: 'cart-line-001' }), code('OUT_OF_STOCK'));
  const before = repository.snapshot();
  repository.failNextCommit = true;
  await assert.rejects(cart.setLine(buyer, { productId: 'bread', quantity: 2, expectedVersion: 0, requestId: 'cart-line-001' }), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), before);
});

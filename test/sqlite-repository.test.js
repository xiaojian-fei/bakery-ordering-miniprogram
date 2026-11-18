'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteRepository } = require('../server/db/sqlite-repository');
const { ALL_COLLECTIONS } = require('../server/db/schema');

const open = (seed = {}) => new SqliteRepository(seed, { file: ':memory:' });

test('SQLite 仓储：建库时创建全部集合且业务集合不受污染', () => {
  const repository = open();
  assert.equal(repository.info.collections, ALL_COLLECTIONS.length);
  assert.deepEqual(repository.snapshot(), {});
  repository.close();
});

test('SQLite 仓储：set/get 往返保持对象结构与 _id', async () => {
  const repository = open();
  await repository.transaction(tx => tx.set('products', 'bread', { _id: 'bread', name: '司康', onHand: 5 }));
  const product = await repository.transaction(tx => tx.get('products', 'bread'));
  assert.equal(product.name, '司康');
  assert.equal(product.onHand, 5);
  assert.equal(product._id, 'bread');
  assert.equal(await repository.transaction(tx => tx.get('products', 'missing')), null);
  repository.close();
});

test('SQLite 仓储：提交失败整体回滚，与内存夹具语义一致', async () => {
  const repository = open({ products: { bread: { _id: 'bread', onHand: 10 } } });
  repository.failNextCommit = true;
  await assert.rejects(repository.transaction(async tx => {
    const product = await tx.get('products', 'bread');
    await tx.set('products', 'bread', { ...product, onHand: 3 });
    await tx.set('orders', 'o1', { _id: 'o1' });
  }), /INJECTED_COMMIT_FAILURE/);
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().orders, undefined);
  repository.close();
});

test('SQLite 仓储：事务内异常回滚且抛出的业务错误不被吞掉', async () => {
  const repository = open();
  await assert.rejects(repository.transaction(async tx => {
    await tx.set('orders', 'o1', { _id: 'o1' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(repository.snapshot().orders, undefined);
  repository.close();
});

test('SQLite 仓储：eq / ne 对缺失字段的处理与内存一致', async () => {
  const repository = open({
    addresses: {
      a1: { _id: 'a1', ownerOpenid: 'u1', deleted: false },
      a2: { _id: 'a2', ownerOpenid: 'u1' },
      a3: { _id: 'a3', ownerOpenid: 'u1', deleted: true }
    }
  });
  const notDeleted = await repository.transaction(tx => tx.query('addresses', {
    filters: [{ field: 'ownerOpenid', value: 'u1' }, { field: 'deleted', op: 'ne', value: true }],
    orderBy: [{ field: '_id', direction: 'asc' }], limit: 10
  }));
  assert.deepEqual(notDeleted.map(row => row._id), ['a1', 'a2']);
  repository.close();
});

test('SQLite 仓储：gte/lt/lte/in/contains 与布尔值筛选', async () => {
  const repository = open({
    products: {
      a: { _id: 'a', name: 'Berry Scone', isOnSale: true, priceCents: 1000 },
      b: { _id: 'b', name: 'butter cookie', isOnSale: true, priceCents: 500 },
      c: { _id: 'c', name: 'Milk Toast', isOnSale: false, priceCents: 2000 }
    }
  });
  const query = (filters) => repository.transaction(tx => tx.query('products', {
    filters, orderBy: [{ field: '_id', direction: 'asc' }], limit: 10
  }));
  assert.deepEqual((await query([{ field: 'isOnSale', value: true }])).map(r => r._id), ['a', 'b']);
  assert.deepEqual((await query([{ field: 'priceCents', op: 'gte', value: 1000 }])).map(r => r._id), ['a', 'c']);
  assert.deepEqual((await query([{ field: 'priceCents', op: 'lt', value: 1000 }])).map(r => r._id), ['b']);
  assert.deepEqual((await query([{ field: 'priceCents', op: 'lte', value: 1000 }])).map(r => r._id), ['a', 'b']);
  assert.deepEqual((await query([{ field: '_id', op: 'in', value: ['a', 'c'] }])).map(r => r._id), ['a', 'c']);
  // contains 大小写不敏感，且 % 与 _ 不当通配符
  assert.deepEqual((await query([{ field: 'name', op: 'contains', value: 'SCONE' }])).map(r => r._id), ['a']);
  assert.deepEqual((await query([{ field: 'name', op: 'contains', value: '%' }])).map(r => r._id), []);
  repository.close();
});

test('SQLite 仓储：多字段排序与复合游标分页不重复不遗漏', async () => {
  const seed = { orders: {} };
  for (let index = 0; index < 7; index += 1) {
    seed.orders['o' + index] = { _id: 'o' + index, createdAt: 100 + (index % 3), status: 'NEW' };
  }
  const repository = open(seed);
  const orderBy = [{ field: 'createdAt', direction: 'desc' }, { field: '_id', direction: 'desc' }];
  const collected = [];
  let after = null;
  for (let page = 0; page < 5; page += 1) {
    const rows = await repository.transaction(tx => tx.query('orders', { filters: [], orderBy, after, limit: 3 }));
    collected.push(...rows.map(row => row._id));
    if (rows.length < 3) break;
    const last = rows[rows.length - 1];
    after = { createdAt: last.createdAt, _id: last._id };
  }
  assert.equal(collected.length, 7);
  assert.equal(new Set(collected).size, 7);
  const sorted = await repository.transaction(tx => tx.query('orders', { filters: [], orderBy, limit: 10 }));
  assert.deepEqual(collected, sorted.map(row => row._id));
  repository.close();
});

test('SQLite 仓储：查询参数受白名单与上限保护', async () => {
  const repository = open();
  await assert.rejects(repository.transaction(tx => tx.query('products', { limit: 0 })), /INVALID_QUERY_LIMIT/);
  await assert.rejects(repository.transaction(tx => tx.query('products', { limit: 101 })), /INVALID_QUERY_LIMIT/);
  await assert.rejects(repository.transaction(tx => tx.query('products', {
    filters: [{ field: "name') OR 1=1 --", value: 'x' }], limit: 1
  })), /INVALID_QUERY_FIELD/);
  await assert.rejects(repository.transaction(tx => tx.query('products', {
    filters: [{ field: 'name', op: 'regex', value: 'x' }], limit: 1
  })), /INVALID_QUERY_OPERATOR/);
  await assert.rejects(repository.transaction(tx => tx.query('no_such_table', { limit: 1 })), /UNKNOWN_COLLECTION/);
  repository.close();
});

test('SQLite 仓储：超时订单候选按到期时间与订单号递增分页', async () => {
  const seed = { orders: {} };
  for (let index = 0; index < 5; index += 1) {
    seed.orders['o' + index] = { _id: 'o' + index, status: 'PENDING_PAYMENT', expiresAt: 200 + index };
  }
  seed.orders.paid = { _id: 'paid', status: 'COMPLETED', expiresAt: 100 };
  const repository = open(seed);
  const first = await repository.findExpiredOrders({ dueAt: 300, after: null, limit: 2 });
  assert.deepEqual(first, [{ orderId: 'o0', expiresAt: 200 }, { orderId: 'o1', expiresAt: 201 }]);
  const second = await repository.findExpiredOrders({ dueAt: 300, after: first[1], limit: 10 });
  assert.deepEqual(second.map(row => row.orderId), ['o2', 'o3', 'o4']);
  repository.close();
});

test('SQLite 仓储：数据落盘后重开进程仍可读（真实文件持久化）', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bakery-db-')), 'test.sqlite');
  const repository = new SqliteRepository({ products: { bread: { _id: 'bread', onHand: 9 } } }, { file });
  await repository.transaction(tx => tx.set('orders', 'ord1', { _id: 'ord1', totalCents: 1250 }));
  repository.close();

  const reopened = new SqliteRepository({}, { file });
  assert.equal((await reopened.transaction(tx => tx.get('orders', 'ord1'))).totalCents, 1250);
  assert.equal((await reopened.transaction(tx => tx.get('products', 'bread'))).onHand, 9);
  reopened.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('SQLite 仓储：用户名唯一约束在数据库层生效', async () => {
  const repository = open();
  await repository.transaction(tx => tx.set('users', 'u1', { openid: 'u1', username: 'alice' }));
  await repository.transaction(tx => tx.set('users', 'u2', { openid: 'u2', role: 'staff' }));
  await repository.transaction(tx => tx.set('users', 'u3', { openid: 'u3', role: 'staff' }));
  await assert.rejects(
    repository.transaction(tx => tx.set('users', 'u4', { openid: 'u4', username: 'alice' })),
    /UNIQUE|constraint/i
  );
  repository.close();
});
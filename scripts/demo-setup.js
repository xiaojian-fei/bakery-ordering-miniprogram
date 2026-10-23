'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { prepareLegacyMigration } = require('../cloudfunctions/api/setup/legacy-migration');
const { OwnerBootstrap } = require('../cloudfunctions/api/setup/owner-bootstrap');
const { createApplication } = require('../cloudfunctions/api/application');
const { createTradeClient } = require('../services/trade-client');
const { MemoryRepository } = require('../test/support/memory-repository');
const { legacyFixture } = require('../test/support/legacy-fixture');

async function main() {
  console.log('部署准备演示：虚构旧数据、盘点库存、内存事务；不连接真实数据库。');
  const plan = prepareLegacyMigration(legacyFixture(), {
    mode: 'fresh-test-environment', inventoryByProductId: { bread: 12 }
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.prepared.products[0].priceCents, 1190);
  console.log('1. 旧价格11.9元→1190分；显式盘点库存12件，历史销量不作为库存。');
  console.log('2. 历史订单', plan.excludedLegacyOrderCount, '单保留原导出归档，不生成成功收款。');
  const repository = new MemoryRepository({
    products: Object.fromEntries(plan.prepared.products.map(row => [row._id, row])),
    addresses: Object.fromEntries(plan.prepared.addresses.map(row => [row._id, row]))
  });
  const password = randomBytes(24).toString('hex');
  const bootstrap = new OwnerBootstrap(repository);
  assert.equal((await bootstrap.initialize({ ownerOpenid: 'owner-demo', password })).changed, true);
  assert.equal((await bootstrap.initialize({ ownerOpenid: 'owner-demo', password })).changed, false);
  console.log('3. 初始店主原子创建，重复初始化不重设口令或角色；不输出身份/口令/哈希。');
  const application = createApplication({ repository,
    resolveIdentity: async context => ({ openid: context.demoSubject }) });
  const clientFor = demoSubject => createTradeClient({
    send: request => application.handle(request, { demoSubject })
  });
  const owner = clientFor('owner-demo');
  assert.equal((await owner.staff.login(password)).role, 'owner');
  const buyer = clientFor('buyer-demo');
  const attempt = await buyer.prepareCheckout({ requestId: 'setup-demo-checkout-001',
    deliveryType: 'delivery', addressId: 'home', items: [{ productId: 'bread', quantity: 2 }] });
  assert.equal(attempt.quote.totalCents, 3380);
  const order = await attempt.submit();
  assert.equal(order.addressSnapshot.province, '内蒙古');
  assert.equal(repository.snapshot().products.bread.reserved, 2);
  console.log('4. 新模型贯通报价与下单：商品2380分+运费1000分=3380分，预留2件。');
  console.log('演示完成；真实初始化、导入与权限验收仍需部署管理员在测试环境完成。');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

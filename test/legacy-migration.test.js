'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { yuanToCents, prepareLegacyMigration } = require('../cloudfunctions/api/setup/legacy-migration');
const { legacyFixture } = require('./support/legacy-fixture');

const options = () => ({ mode: 'fresh-test-environment', inventoryByProductId: { bread: 12 } });
const has = (plan, code) => plan.blockers.some(issue => issue.code === code);

test('迁移金额：十进制元精确转换整数分，兼容数字和两位小数字符串', () => {
  for (const [value, expected] of [[11.9, 1190], ['0.01', 1], ['88.00', 8800], [' 12.5 ', 1250],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER]]) assert.equal(yuanToCents(value), expected);
});

test('迁移金额：三位小数、浮点残差、科学计数、负数与溢出不自动取整', () => {
  for (const value of ['1.005', 0.1 + 0.2, '1e2', '-1', 0, NaN, null, '90071992547409.92']) {
    assert.throws(() => yuanToCents(value), error => error.code === 'INVALID_LEGACY_PRICE');
  }
});

test('迁移商品：只用人工盘点库存，不把旧销量/未知字段当库存或权限', () => {
  const source = legacyFixture();
  source.products[0].adminPassword = 'discard-this-field';
  const plan = prepareLegacyMigration(source, options());
  assert.equal(plan.ready, true);
  assert.equal(plan.prepared.products[0].priceCents, 1190);
  assert.equal(plan.prepared.products[0].onHand, 12);
  assert.equal(plan.prepared.products[0].reserved, 0);
  assert.equal(plan.prepared.products[0].inventoryVersion, 0);
  assert.equal(plan.prepared.products[0].monthSales, undefined);
  assert.equal(plan.prepared.products[0].adminPassword, undefined);
});

test('迁移商品：缺盘点库存与未清预留阻断，不静默清空活动库存', () => {
  assert.equal(has(prepareLegacyMigration(legacyFixture(), { mode: 'fresh-test-environment' }), 'EXPLICIT_STOCK_REQUIRED'), true);
  const source = legacyFixture();
  source.products[0].reserved = 2;
  const plan = prepareLegacyMigration(source, options());
  assert.equal(plan.ready, false);
  assert.equal(has(plan, 'ACTIVE_RESERVATIONS_REQUIRE_RECONCILIATION'), true);
  assert.equal(plan.prepared.products.length, 0);
});

test('迁移商品：新旧价格矛盾、非法上下架状态与重复ID被阻断', () => {
  const source = legacyFixture();
  source.products[0].priceCents = 1;
  source.products[0].isOnSale = 'true';
  source.products.push({ ...source.products[0] });
  const plan = prepareLegacyMigration(source, options());
  assert.equal(has(plan, 'AMBIGUOUS_PRICE'), true);
  assert.equal(has(plan, 'INVALID_SALE_FLAG'), true);
  assert.equal(has(plan, 'DUPLICATE_RECORD_ID'), true);
});

test('迁移地址：归属字段统一、默认地址指针唯一，不生成角色或口令', () => {
  const source = legacyFixture();
  source.users = [{ openid: 'buyer-demo', role: 'owner', password: 'untrusted' }];
  const plan = prepareLegacyMigration(source, options());
  assert.equal(plan.prepared.addresses[0].ownerOpenid, 'buyer-demo');
  assert.equal(plan.prepared.addresses[0].openid, undefined);
  assert.equal(plan.prepared.addresses[0].isDefault, undefined);
  assert.deepEqual(plan.prepared.userDefaults, [{ openid: 'buyer-demo', defaultAddressId: 'home' }]);
  assert.equal(plan.prepared.users, undefined);
  assert.ok(!JSON.stringify(plan).includes('untrusted'));
  assert.equal(plan.warnings.some(issue => issue.code === 'UNSUPPORTED_COLLECTION_SKIPPED'), true);
});

test('迁移地址：多个默认地址阻断，不擅自选择其中一个', () => {
  const source = legacyFixture();
  source.addresses.push({ ...source.addresses[0], _id: 'home-two' });
  const plan = prepareLegacyMigration(source, options());
  assert.equal(plan.ready, false);
  assert.equal(has(plan, 'MULTIPLE_DEFAULT_ADDRESSES'), true);
  assert.equal(plan.prepared.userDefaults.length, 0);
});

test('迁移地址：冲突归属、缺失地址字段与非法默认标志阻断', () => {
  const source = legacyFixture();
  source.addresses[0].ownerOpenid = 'other-user';
  source.addresses[0].detail = '';
  source.addresses[0].isDefault = 'yes';
  const plan = prepareLegacyMigration(source, options());
  assert.equal(has(plan, 'INVALID_OR_CONFLICTING_OWNER'), true);
  assert.equal(has(plan, 'INVALID_ADDRESS_FIELD'), true);
  assert.equal(has(plan, 'INVALID_DEFAULT_FLAG'), true);
});

test('迁移订单：旧已完成状态和客户端总价不生成新支付、订单或退款', () => {
  const plan = prepareLegacyMigration(legacyFixture(), options());
  assert.equal(plan.excludedLegacyOrderCount, 1);
  assert.equal(plan.warnings.some(issue => issue.code === 'LEGACY_ORDERS_ARCHIVED_ONLY'), true);
  for (const key of ['orders', 'payments', 'refunds']) assert.equal(plan.prepared[key], undefined);
});

test('迁移预检：不更改输入，也不把错误记录的个人字段写入诊断', () => {
  const source = legacyFixture();
  source.addresses[0].detail = '';
  const before = structuredClone(source);
  const plan = prepareLegacyMigration(source, options());
  assert.deepEqual(source, before);
  assert.ok(!JSON.stringify(plan.blockers).includes('00000000000'));
  assert.ok(!JSON.stringify(plan.blockers).includes('测试顾客'));
});

test('迁移预检：原地迁移模式、非数组集合与非法记录ID不能通过', () => {
  assert.throws(() => prepareLegacyMigration(legacyFixture()), error => error.code === 'INVALID_CONFIG');
  assert.throws(() => prepareLegacyMigration(legacyFixture(), { ...options(), mode: 'in-place' }), error => error.code === 'INVALID_CONFIG');
  const plan = prepareLegacyMigration({ products: {}, addresses: [{ _id: '../bad' }] }, options());
  assert.equal(has(plan, 'COLLECTION_MUST_BE_ARRAY'), true);
  assert.equal(has(plan, 'INVALID_RECORD_ID'), true);
});

test('迁移提醒：未指定上下架默认下架，旧云图片保留但提示核对访问权', () => {
  const source = legacyFixture();
  delete source.products[0].isOnSale;
  source.products[0].image = 'cloud://demo-only/product.png';
  source.addresses[0].isDefault = false;
  const plan = prepareLegacyMigration(source, options());
  assert.equal(plan.ready, true);
  assert.equal(plan.prepared.products[0].isOnSale, false);
  assert.equal(plan.prepared.products[0].image, source.products[0].image);
  assert.equal(plan.prepared.userDefaults[0].defaultAddressId, null);
  assert.deepEqual(plan.warnings.map(issue => issue.code), ['MISSING_SALE_STATUS_DISABLED',
    'CLOUD_IMAGE_REVIEW_REQUIRED', 'LEGACY_ORDERS_ARCHIVED_ONLY']);
});

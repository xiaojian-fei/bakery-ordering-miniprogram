'use strict';
const { ensure } = require('../domain/errors');
const { validId } = require('../domain/pricing');

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// 精确按十进制转换，不四舍五入三位小数，也不从旧总价推断成功付款。
function yuanToCents(value) {
  ensure(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
    'INVALID_LEGACY_PRICE', '旧价格需为十进制金额');
  const text = String(value).trim();
  ensure(/^\d{1,14}(?:\.\d{1,2})?$/.test(text), 'INVALID_LEGACY_PRICE', '旧价格仅支持最多两位小数');
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  ensure(cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_LEGACY_PRICE', '旧价格超出有效范围');
  return Number(cents);
}

function prepareLegacyMigration(source, { mode, inventoryByProductId = {} } = {}) {
  ensure(mode === 'fresh-test-environment', 'INVALID_CONFIG', '仅准备全新测试环境迁移，不支持原库原地覆盖');
  ensure(plain(source) && plain(inventoryByProductId), 'INVALID_REQUEST', '迁移输入需为对象');
  const blockers = [];
  const warnings = [];
  const prepared = { products: [], addresses: [], userDefaults: [] };
  const add = (target, collection, index, code) => target.push({ collection, index, code });
  const input = {};
  for (const collection of ['products', 'addresses', 'orders']) {
    input[collection] = source[collection] === undefined ? [] : source[collection];
    if (!Array.isArray(input[collection])) {
      add(blockers, collection, null, 'COLLECTION_MUST_BE_ARRAY');
      input[collection] = [];
    }
  }
  for (const key of Object.keys(source)) {
    if (!['products', 'addresses', 'orders'].includes(key)) add(warnings, key, null, 'UNSUPPORTED_COLLECTION_SKIPPED');
  }
  const seen = { products: new Set(), addresses: new Set() };
  const validRecord = (record, collection, index) => {
    if (!plain(record) || !validId(record._id)) { add(blockers, collection, index, 'INVALID_RECORD_ID'); return false; }
    if (seen[collection].has(record._id)) { add(blockers, collection, index, 'DUPLICATE_RECORD_ID'); return false; }
    seen[collection].add(record._id);
    return true;
  };
  input.products.forEach((record, index) => {
    if (!validRecord(record, 'products', index)) return;
    const before = blockers.length;
    let priceCents;
    try {
      if (record.priceCents !== undefined) {
        ensure(Number.isSafeInteger(record.priceCents) && record.priceCents > 0,
          'INVALID_LEGACY_PRICE', '整数分价格不合法');
        priceCents = record.priceCents;
        if (record.price !== undefined) ensure(yuanToCents(record.price) === priceCents,
          'AMBIGUOUS_PRICE', '新旧价格字段不一致');
      } else priceCents = yuanToCents(record.price);
    } catch (error) { add(blockers, 'products', index, error.code || 'INVALID_LEGACY_PRICE'); }
    if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 100) {
      add(blockers, 'products', index, 'INVALID_PRODUCT_NAME');
    }
    const onHand = Object.hasOwn(inventoryByProductId, record._id) ? inventoryByProductId[record._id] : undefined;
    if (!Number.isSafeInteger(onHand) || onHand < 0) add(blockers, 'products', index, 'EXPLICIT_STOCK_REQUIRED');
    if (record.reserved !== undefined && record.reserved !== 0) {
      add(blockers, 'products', index, 'ACTIVE_RESERVATIONS_REQUIRE_RECONCILIATION');
    }
    if (record.isOnSale !== undefined && typeof record.isOnSale !== 'boolean') {
      add(blockers, 'products', index, 'INVALID_SALE_FLAG');
    }
    for (const field of ['desc', 'category', 'image']) {
      if (record[field] !== undefined && typeof record[field] !== 'string') add(blockers, 'products', index, 'INVALID_DISPLAY_FIELD');
    }
    if (blockers.length !== before) return;
    if (record.isOnSale === undefined) add(warnings, 'products', index, 'MISSING_SALE_STATUS_DISABLED');
    if (record.image?.startsWith('cloud://')) add(warnings, 'products', index, 'CLOUD_IMAGE_REVIEW_REQUIRED');
    prepared.products.push({ _id: record._id, name: record.name.trim(), priceCents,
      desc: record.desc || '', category: record.category || '', image: record.image || '',
      isOnSale: record.isOnSale === true, isFeatured: record.isFeatured === true,
      onHand, reserved: 0, inventoryVersion: 0 });
  });

  const addressesByOwner = new Map();
  input.addresses.forEach((record, index) => {
    if (!validRecord(record, 'addresses', index)) return;
    const before = blockers.length;
    const owners = ['ownerOpenid', 'openid', '_openid'].filter(key => record[key] !== undefined).map(key => record[key]);
    if (owners.length === 0 || !owners.every(value => identity(value) && value === owners[0])) {
      add(blockers, 'addresses', index, 'INVALID_OR_CONFLICTING_OWNER');
    }
    const limits = { name: 80, phone: 40, province: 80, city: 80, district: 80, detail: 300 };
    for (const [field, limit] of Object.entries(limits)) {
      if (typeof record[field] !== 'string' || !record[field].trim() || record[field].length > limit) {
        add(blockers, 'addresses', index, 'INVALID_ADDRESS_FIELD');
      }
    }
    if (record.isDefault !== undefined && typeof record.isDefault !== 'boolean') add(blockers, 'addresses', index, 'INVALID_DEFAULT_FLAG');
    if (blockers.length !== before) return;
    const address = { _id: record._id, ownerOpenid: owners[0] };
    for (const field of Object.keys(limits)) address[field] = record[field].trim();
    prepared.addresses.push(address);
    if (!addressesByOwner.has(address.ownerOpenid)) addressesByOwner.set(address.ownerOpenid, []);
    addressesByOwner.get(address.ownerOpenid).push({ id: address._id, isDefault: record.isDefault === true });
  });
  for (const [openid, addresses] of addressesByOwner) {
    const defaults = addresses.filter(address => address.isDefault);
    if (defaults.length > 1) { add(blockers, 'addresses', null, 'MULTIPLE_DEFAULT_ADDRESSES'); continue; }
    // 只提供默认地址映射，不导入角色/口令，也不覆盖店主或员工的现有权限。
    prepared.userDefaults.push({ openid, defaultAddressId: defaults[0]?.id || null });
  }
  if (input.orders.length > 0) add(warnings, 'orders', null, 'LEGACY_ORDERS_ARCHIVED_ONLY');
  return { schemaVersion: 'trade-core-v1', mode, ready: blockers.length === 0,
    sourceCounts: Object.fromEntries(Object.entries(input).map(([key, rows]) => [key, rows.length])),
    excludedLegacyOrderCount: input.orders.length, blockers, warnings, prepared };
}

module.exports = { yuanToCents, prepareLegacyMigration };

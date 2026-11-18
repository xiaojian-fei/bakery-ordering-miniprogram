'use strict';
const { ensure } = require('./errors');
const { requireCustomer, requireRole } = require('./auth');
const { requireMoney } = require('./pricing');
const { validateInventory } = require('./inventory');
const { id, text, version, once, page } = require('./service-utils');

function productView(product, managed = false) {
  validateInventory(product);
  requireMoney(product.priceCents, '商品价格', 1);
  const result = { _id: product._id, name: product.name, priceCents: product.priceCents,
    desc: product.desc || '', category: product.category || '', image: product.image || '',
    isOnSale: product.isOnSale === true, isFeatured: product.isFeatured === true,
    available: product.onHand - product.reserved, catalogVersion: product.catalogVersion ?? 0 };
  if (managed) Object.assign(result, { onHand: product.onHand, reserved: product.reserved,
    inventoryVersion: product.inventoryVersion ?? 0 });
  return result;
}

class CatalogService {
  constructor(repository, { clock = Date.now } = {}) { this.repository = repository; this.clock = clock; }

  async list(actor, input = {}) {
    requireCustomer(actor);
    const managed = input.includeUnavailable === true;
    if (managed) requireRole(actor, ['owner']);
    const filters = managed ? [] : [{ field: 'isOnSale', value: true }];
    if (input.category !== undefined) filters.push({ field: 'category', value: text(input.category, '分类', 60) });
    if (input.keyword !== undefined) filters.push({ field: 'name', op: 'contains', value: text(input.keyword, '关键字', 60, true) });
    return this.repository.transaction(async tx => {
      const result = await page(tx, 'products', { filters, scope: managed ? actor.openid + ':owner' : 'public',
        cursor: input.cursor, limit: input.limit, sortBy: '_id', desc: false });
      return { ...result, items: result.items.map(product => productView(product, managed)) };
    });
  }

  async get(actor, productId, { includeUnavailable = false } = {}) {
    requireCustomer(actor); id(productId);
    if (includeUnavailable) requireRole(actor, ['owner']);
    return this.repository.transaction(async tx => {
      const product = await tx.get('products', productId);
      ensure(product, 'PRODUCT_NOT_FOUND', '商品不存在');
      ensure(includeUnavailable || product.isOnSale === true, 'PRODUCT_UNAVAILABLE', '商品未上架');
      return productView(product, includeUnavailable);
    });
  }

  async save(actor, input) {
    requireRole(actor, ['owner']);
    const normalized = { productId: id(input.productId), expectedVersion: version(input.expectedVersion),
      name: text(input.name, '商品名称', 100), priceCents: requireMoney(input.priceCents, '商品价格', 1),
      desc: text(input.desc ?? '', '描述', 1000, true), category: text(input.category ?? '', '分类', 60, true),
      image: text(input.image ?? '', '图片', 1000, true), isOnSale: input.isOnSale, isFeatured: input.isFeatured ?? false };
    ensure(typeof normalized.isOnSale === 'boolean' && typeof normalized.isFeatured === 'boolean', 'INVALID_REQUEST', '商品标记需为布尔值');
    // 禁止悄悄忽略库存写入意图，库存必须调用InventoryService。
    ensure(!['onHand', 'reserved', 'inventoryVersion'].some(key => Object.hasOwn(input, key)),
      'INVALID_REQUEST', '商品编辑不能直接修改库存');
    return this.repository.transaction(tx => once(tx, actor, 'catalog_save', input.requestId, normalized, async () => {
      const existing = await tx.get('products', normalized.productId);
      ensure((existing?.catalogVersion ?? 0) === normalized.expectedVersion, 'VERSION_CONFLICT', '商品已更新，请刷新');
      if (!existing) ensure(normalized.expectedVersion === 0, 'VERSION_CONFLICT', '新商品版本必须为0');
      const now = this.clock();
      const { productId, expectedVersion, ...fields } = normalized;
      const product = { ...(existing || { onHand: 0, reserved: 0, inventoryVersion: 0 }), ...fields,
        _id: productId, catalogVersion: expectedVersion + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
      validateInventory(product);
      await tx.set('products', productId, product);
      await tx.set('catalog_events', productId + '_v' + product.catalogVersion,
        { productId, operatorOpenid: actor.openid, action: existing ? 'UPDATE' : 'CREATE', createdAt: now });
      return productView(product, true);
    }));
  }
}

module.exports = { CatalogService, productView };

'use strict';
const { ensure } = require('./errors');
const { requireCustomer } = require('./auth');
const { validateInventory } = require('./inventory');
const { requireMoney } = require('./pricing');
const { id, version, digest, once } = require('./service-utils');

class CartService {
  constructor(repository, { clock = Date.now } = {}) { this.repository = repository; this.clock = clock; }
  key(actor) { return 'cart_' + digest(actor.openid); }

  async get(actor) {
    requireCustomer(actor);
    return this.repository.transaction(async tx => {
      const cart = await tx.get('carts', this.key(actor));
      const items = [];
      let estimatedSubtotalCents = 0;
      for (const item of cart?.items || []) {
        const product = await tx.get('products', item.productId);
        let issue = null;
        if (!product) issue = 'PRODUCT_NOT_FOUND';
        else {
          validateInventory(product); requireMoney(product.priceCents, '商品价格', 1);
          if (product.isOnSale !== true) issue = 'PRODUCT_UNAVAILABLE';
          else if (product.onHand - product.reserved < item.quantity) issue = 'OUT_OF_STOCK';
        }
        const lineTotalCents = product ? requireMoney(product.priceCents * item.quantity, '小计', 1) : 0;
        estimatedSubtotalCents = requireMoney(estimatedSubtotalCents + lineTotalCents, '购物车估算金额');
        items.push({ ...item, name: product?.name || '商品已不存在', unitPriceCents: product?.priceCents ?? null,
          lineTotalCents, available: product ? product.onHand - product.reserved : 0, issue });
      }
      return { version: cart?.version ?? 0, items, estimatedSubtotalCents,
        canCheckout: items.length > 0 && items.every(item => !item.issue) };
    });
  }

  async setLine(actor, input) {
    requireCustomer(actor);
    const normalized = { productId: id(input.productId), quantity: input.quantity, expectedVersion: version(input.expectedVersion) };
    ensure(Number.isInteger(normalized.quantity) && normalized.quantity >= 0 && normalized.quantity <= 99,
      'INVALID_QUANTITY', '购物车数量需为0～99的整数');
    return this.repository.transaction(tx => once(tx, actor, 'cart_line', input.requestId, normalized, async () => {
      const key = this.key(actor);
      const cart = await tx.get('carts', key) || { _id: key, ownerOpenid: actor.openid, items: [], version: 0 };
      ensure(cart.version === normalized.expectedVersion, 'VERSION_CONFLICT', '购物车已更新');
      if (normalized.quantity > 0) {
        const product = await tx.get('products', normalized.productId);
        ensure(product, 'PRODUCT_NOT_FOUND', '商品不存在');
        ensure(product.isOnSale === true, 'PRODUCT_UNAVAILABLE', '商品未上架');
        validateInventory(product);
        ensure(product.onHand - product.reserved >= normalized.quantity, 'OUT_OF_STOCK', '可售库存不足');
      }
      const items = cart.items.filter(item => item.productId !== normalized.productId);
      if (normalized.quantity > 0) items.push({ productId: normalized.productId, quantity: normalized.quantity });
      ensure(items.length <= 20, 'INVALID_ITEMS', '购物车最多20种商品');
      cart.items = items.sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
      cart.version += 1; cart.updatedAt = this.clock();
      await tx.set('carts', key, cart);
      return { version: cart.version, items: cart.items };
    }));
  }

  async clear(actor, input) {
    requireCustomer(actor);
    const normalized = { expectedVersion: version(input.expectedVersion) };
    return this.repository.transaction(tx => once(tx, actor, 'cart_clear', input.requestId, normalized, async () => {
      const key = this.key(actor);
      const cart = await tx.get('carts', key) || { _id: key, ownerOpenid: actor.openid, items: [], version: 0 };
      ensure(cart.version === normalized.expectedVersion, 'VERSION_CONFLICT', '购物车已更新，不能清除其他修改');
      cart.items = []; cart.version += 1; cart.updatedAt = this.clock();
      await tx.set('carts', key, cart);
      return { version: cart.version, items: [] };
    }));
  }
}

module.exports = { CartService };

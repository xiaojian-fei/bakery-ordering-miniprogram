'use strict';
const { createHash } = require('node:crypto');
const { ensure } = require('./errors');
const { requireRole } = require('./auth');
const { validId } = require('./pricing');
const { validateInventory, bumpInventoryVersion } = require('./inventory');
const hash = value => createHash('sha256').update(value).digest('hex');

class InventoryService {
  constructor(repository, { clock = Date.now } = {}) {
    ensure(repository && typeof repository.transaction === 'function', 'INVALID_CONFIG', '缺少事务适配器');
    this.repository = repository;
    this.clock = clock;
  }

  async adjust(actor, input) {
    requireRole(actor, ['owner']);
    ensure(input && validId(input.productId) && validId(input.requestId) && input.requestId.length >= 8,
      'INVALID_REQUEST', '商品ID或请求ID不合法');
    ensure(Number.isSafeInteger(input.onHand) && input.onHand >= 0, 'INVALID_INVENTORY', '目标实物库存必须为非负整数');
    ensure(Number.isSafeInteger(input.expectedVersion) && input.expectedVersion >= 0,
      'INVALID_REQUEST', '必须提供当前库存版本');
    ensure(typeof input.reason === 'string' && input.reason.trim() && input.reason.length <= 200,
      'INVALID_REQUEST', '必须填写1～200字的调整原因');
    const change = { productId: input.productId, onHand: input.onHand,
      expectedVersion: input.expectedVersion, reason: input.reason.trim() };
    const requestKey = 'stock_' + hash(actor.openid + '\0' + input.requestId);
    const fingerprint = hash(JSON.stringify(change));
    return this.repository.transaction(async tx => {
      const previous = await tx.get('request_keys', requestKey);
      const product = await tx.get('products', input.productId);
      if (previous) {
        ensure(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', '同一请求不能更改库存调整参数');
        const record = await tx.get('stock_adjustments', requestKey);
        ensure(record, 'INVALID_INVENTORY', '库存调整记录不完整');
        return record;
      }
      ensure(product, 'PRODUCT_NOT_FOUND', '商品不存在');
      validateInventory(product);
      ensure((product.inventoryVersion ?? 0) === input.expectedVersion, 'VERSION_CONFLICT', '库存已变化，请刷新');
      ensure(input.onHand >= product.reserved, 'RESERVED_STOCK_CONFLICT', '实物库存不能低于已预留数量');
      const before = product.onHand;
      product.onHand = input.onHand;
      bumpInventoryVersion(product);
      const record = { _id: requestKey, productId: input.productId, before, after: input.onHand,
        reserved: product.reserved, inventoryVersion: product.inventoryVersion, reason: change.reason,
        operatorOpenid: actor.openid, createdAt: this.clock() };
      await tx.set('products', input.productId, product);
      await tx.set('stock_adjustments', requestKey, record);
      await tx.set('request_keys', requestKey, { fingerprint, productId: input.productId });
      await tx.set('inventory_movements', requestKey, { productId: input.productId, action: 'adjust',
        onHandDelta: input.onHand - before, reservedDelta: 0, operatorOpenid: actor.openid,
        reason: change.reason, createdAt: record.createdAt });
      return record;
    });
  }
}

module.exports = { InventoryService };

'use strict';
const { createHash } = require('node:crypto');
const { ensure } = require('./errors');
const { requireCustomer, requireOwner, requireRole } = require('./auth');
const { DEFAULT_SHIPPING, validId, requireMoney, normalizeItems, calculateQuote } = require('./pricing');
const { STATUS, nextStatus } = require('./order-state');
const { writeOrderEvent, writeInventoryMovement } = require('./transaction-log');
const { validateInventory: inventory, bumpInventoryVersion } = require('./inventory');

const hash = value => createHash('sha256').update(value).digest('hex');

class OrderService {
  constructor(repository, { clock = Date.now, shipping = DEFAULT_SHIPPING, paymentWindowMs = 15 * 60 * 1000 } = {}) {
    ensure(repository && typeof repository.transaction === 'function', 'INVALID_CONFIG', '缺少事务适配器');
    ensure(Number.isSafeInteger(paymentWindowMs) && paymentWindowMs > 0, 'INVALID_CONFIG', '支付窗口不合法');
    this.repository = repository;
    this.clock = clock;
    this.shipping = structuredClone(shipping);
    this.paymentWindowMs = paymentWindowMs;
  }

  async create(actor, input) {
    requireCustomer(actor);
    ensure(input && validId(input.requestId) && input.requestId.length >= 8,
      'INVALID_REQUEST', 'requestId需为8～80位字母、数字、下划线或连字符');
    const items = normalizeItems(input.items);
    ensure(['pickup', 'delivery'].includes(input.deliveryType), 'INVALID_DELIVERY', '配送方式不合法');
    if (input.deliveryType === 'delivery') ensure(validId(input.addressId), 'INVALID_ADDRESS', '需要有效的地址ID');
    if (input.expectedTotalCents !== undefined) requireMoney(input.expectedTotalCents, '预期总额', 1);
    ensure(input.remark === undefined || (typeof input.remark === 'string' && input.remark.length <= 200),
      'INVALID_REQUEST', '备注最多200字');
    const normalized = { items, deliveryType: input.deliveryType,
      addressId: input.deliveryType === 'delivery' ? input.addressId : null,
      expectedTotalCents: input.expectedTotalCents ?? null, remark: input.remark || '' };
    const fingerprint = hash(JSON.stringify(normalized));
    const requestKey = hash(actor.openid + '\0' + input.requestId);
    const orderId = 'ord_' + requestKey.slice(0, 40);

    return this.repository.transaction(async tx => {
      const previous = await tx.get('request_keys', requestKey);
      if (previous) {
        ensure(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', '同一requestId不能更改订单参数');
        const order = await tx.get('orders', previous.orderId);
        requireOwner(actor, order);
        return order;
      }
      const { quote, products, addressSnapshot } = await this.prepareCheckout(tx, actor, normalized);
      if (normalized.expectedTotalCents !== null) {
        ensure(quote.totalCents === normalized.expectedTotalCents, 'PRICE_CHANGED', '价格或运费已变化，请重新确认');
      }
      const now = this.clock();
      const order = { _id: orderId, ownerOpenid: actor.openid, requestId: input.requestId,
        items: quote.items, amounts: { subtotalCents: quote.subtotalCents, shippingCents: quote.shippingCents,
          totalCents: quote.totalCents }, shippingRuleVersion: quote.shippingRuleVersion,
        deliveryType: normalized.deliveryType, addressSnapshot, remark: normalized.remark,
        status: STATUS.PENDING_PAYMENT, paymentStatus: 'UNPAID',
        createdAt: now, expiresAt: now + this.paymentWindowMs, version: 1 };
      for (const item of items) {
        const product = products.get(item.productId);
        inventory(product);
        ensure(product.onHand - product.reserved >= item.quantity, 'OUT_OF_STOCK', '商品可售库存不足');
        product.reserved += item.quantity;
        bumpInventoryVersion(product);
        await tx.set('products', item.productId, product);
        await this.movement(tx, order, item, 'reserve', 0, item.quantity, now);
      }
      await tx.set('orders', orderId, order);
      await tx.set('request_keys', requestKey, { orderId, fingerprint });
      await this.event(tx, order, actor, 'create', null, now);
      return order;
    });
  }

  async prepareCheckout(tx, actor, { items, deliveryType, addressId }) {
    const products = new Map();
    for (const item of items) products.set(item.productId, await tx.get('products', item.productId));
    let addressSnapshot = null;
    if (deliveryType === 'delivery') {
      const address = await tx.get('addresses', addressId);
      requireOwner(actor, address);
      ensure(!address.deleted, 'INVALID_ADDRESS', '地址已删除，请重新选择');
      for (const field of ['name', 'phone', 'province', 'city', 'district', 'detail']) {
        ensure(typeof address[field] === 'string' && address[field].trim(), 'INVALID_ADDRESS', '地址信息不完整');
      }
      addressSnapshot = Object.fromEntries(['name', 'phone', 'province', 'city', 'district', 'detail']
        .map(field => [field, address[field]]));
    }
    const configured = await tx.get('shop_config', 'shipping_rules');
    return { products, addressSnapshot,
      quote: calculateQuote(items, products, deliveryType, addressSnapshot, configured?.rules || this.shipping) };
  }

  async quote(actor, input) {
    requireCustomer(actor);
    ensure(input && ['pickup', 'delivery'].includes(input.deliveryType), 'INVALID_DELIVERY', '配送方式不合法');
    const items = normalizeItems(input.items);
    if (input.deliveryType === 'delivery') ensure(validId(input.addressId), 'INVALID_ADDRESS', '需要有效的地址ID');
    return this.repository.transaction(async tx => {
      const { quote, products } = await this.prepareCheckout(tx, actor, { items,
        deliveryType: input.deliveryType, addressId: input.addressId });
      for (const item of items) {
        const product = products.get(item.productId);
        inventory(product);
        ensure(product.onHand - product.reserved >= item.quantity, 'OUT_OF_STOCK', '商品可售库存不足');
      }
      // 只读预览不承诺锁定价格或库存，创建订单时仍需重新校验。
      return quote;
    });
  }

  // 此处只有课程模拟支付，不调用实际支付接口，也不代表真实到账。
  async simulatePay(actor, orderId, options = {}) {
    ensure(options && typeof options === 'object' && !Array.isArray(options), 'INVALID_REQUEST', '支付选项不合法');
    ensure(!Object.hasOwn(options, 'success'), 'INVALID_REQUEST', '请使用outcome指定模拟结果');
    const outcome = options.outcome ?? 'success';
    ensure(['success', 'failure'].includes(outcome), 'INVALID_REQUEST', '模拟支付结果不合法');
    if (outcome === 'failure') return this.recordPaymentFailure(actor, orderId, options);
    return this.change(actor, orderId, 'pay', options);
  }
  cancel(actor, orderId, options) { return this.change(actor, orderId, 'cancel', options); }
  expire(actor, orderId, options) { return this.change(actor, orderId, 'expire', options); }

  async get(actor, orderId) {
    requireCustomer(actor);
    ensure(validId(orderId), 'INVALID_REQUEST', '订单ID不合法');
    return this.repository.transaction(async tx => {
      const order = await tx.get('orders', orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在');
      requireOwner(actor, order);
      return order;
    });
  }

  async recordPaymentFailure(actor, orderId, { attemptId, reasonCode = 'DECLINED', expectedVersion }) {
    requireCustomer(actor);
    ensure(validId(orderId) && validId(attemptId) && attemptId.length >= 8,
      'INVALID_REQUEST', '失败支付需要有效的订单ID和8～80位attemptId');
    ensure(['DECLINED', 'NETWORK_ERROR', 'USER_CANCELLED'].includes(reasonCode), 'INVALID_REQUEST', '失败原因不合法');
    if (expectedVersion !== undefined) ensure(Number.isSafeInteger(expectedVersion) && expectedVersion >= 1,
      'INVALID_REQUEST', '订单版本不合法');
    const attemptKey = hash(actor.openid + '\0' + attemptId);
    return this.repository.transaction(async tx => {
      const order = await tx.get('orders', orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在');
      requireOwner(actor, order);
      const previous = await tx.get('payment_attempts', attemptKey);
      if (previous) {
        ensure(previous.orderId === orderId && previous.reasonCode === reasonCode,
          'IDEMPOTENCY_CONFLICT', '同一attemptId不能用于不同的失败支付');
        return order;
      }
      if (expectedVersion !== undefined) ensure(order.version === expectedVersion, 'VERSION_CONFLICT', '订单已更新，请刷新');
      const now = this.clock();
      nextStatus(order, 'pay', actor, now);
      order.version += 1;
      order.updatedAt = now;
      await tx.set('payment_attempts', attemptKey, { orderId, attemptId, ownerOpenid: actor.openid,
        outcome: 'FAILED', reasonCode, amountCents: order.amounts.totalCents, mode: 'SIMULATED', createdAt: now });
      await tx.set('orders', orderId, order);
      await writeOrderEvent(tx, order, actor, 'paymentFailed', order.status, now, { reasonCode });
      return order;
    });
  }

  async change(actor, orderId, action, { expectedVersion } = {}) {
    ensure(['pay', 'cancel', 'expire'].includes(action), 'INVALID_ACTION', '交易操作不能用于修改履约状态');
    ensure(validId(orderId), 'INVALID_REQUEST', '订单ID不合法');
    if (action === 'expire') requireRole(actor, ['system']); else requireCustomer(actor);
    if (expectedVersion !== undefined) ensure(Number.isSafeInteger(expectedVersion) && expectedVersion >= 1,
      'INVALID_REQUEST', '订单版本不合法');
    return this.repository.transaction(async tx => {
      const order = await tx.get('orders', orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在');
      if (action !== 'expire') requireOwner(actor, order);
      // 重试只返回既有结果，不重复扣减或释放；先检查身份，再检查重试。
      if ((action === 'pay' && order.paymentStatus === 'PAID')
        || (action === 'cancel' && order.status === STATUS.CANCELLED)
        || (action === 'expire' && order.status !== STATUS.PENDING_PAYMENT)) return order;
      if (expectedVersion !== undefined) ensure(order.version === expectedVersion, 'VERSION_CONFLICT', '订单已更新，请刷新');
      const now = this.clock();
      const status = nextStatus(order, action, actor, now);
      const products = new Map();
      for (const item of order.items) products.set(item.productId, await tx.get('products', item.productId));
      for (const item of order.items) {
        const product = products.get(item.productId);
        inventory(product);
        ensure(product.reserved >= item.quantity, 'INVALID_INVENTORY', '订单预留库存不足');
        product.reserved -= item.quantity;
        if (action === 'pay') product.onHand -= item.quantity;
        inventory(product);
        bumpInventoryVersion(product);
        await tx.set('products', item.productId, product);
        await this.movement(tx, order, item, action, action === 'pay' ? -item.quantity : 0, -item.quantity, now);
      }
      const previousStatus = order.status;
      order.status = status;
      order.version += 1;
      order.updatedAt = now;
      if (action === 'pay') {
        order.paymentStatus = 'PAID';
        await tx.set('payments', 'pay_' + orderId, { orderId, amountCents: order.amounts.totalCents,
          status: 'SUCCEEDED', mode: 'SIMULATED', createdAt: now });
      }
      await tx.set('orders', orderId, order);
      await this.event(tx, order, actor, action, previousStatus, now);
      return order;
    });
  }

  async event(tx, order, actor, action, previousStatus, now) {
    await writeOrderEvent(tx, order, actor, action, previousStatus, now);
  }

  async movement(tx, order, item, action, onHandDelta, reservedDelta, now) {
    await writeInventoryMovement(tx, order, item, action, onHandDelta, reservedDelta, now);
  }
}

module.exports = { OrderService };

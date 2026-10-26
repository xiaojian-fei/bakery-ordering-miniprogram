'use strict';
const { TradeApiError, pickData } = require('./trade-errors');
const { prepareCheckout } = require('./checkout-attempt');

// 仅依赖注入的send，不导入wx、Node模块或数据库。send必须返回统一业务响应包。
function createTradeClient({ send, clock = Date.now } = {}) {
  if (typeof send !== 'function' || typeof clock !== 'function') throw new TradeApiError('INVALID_REQUEST');
  let session = null;
  let generation = 0;
  const clearSession = () => { generation += 1; session = null; };
  const currentSession = () => {
    if (session && session.expiresAt <= clock()) clearSession();
    return session;
  };

  async function request(action, data, { write = false, employee = false, useSession = true,
    capturedSession } = {}) {
    const snapshot = capturedSession === undefined ? (useSession ? currentSession() : null) : capturedSession;
    if (employee && !snapshot) throw new TradeApiError('UNAUTHENTICATED');
    let response;
    try {
      response = await send({ action, data, ...(snapshot ? { staffToken: snapshot.token } : {}) });
    } catch (_) {
      // 不自动重试：网络断开可能发生在服务端提交之后。
      throw new TradeApiError('NETWORK_ERROR', { uncertain: write });
    }
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || typeof response.success !== 'boolean') throw new TradeApiError('PROTOCOL_ERROR', { uncertain: write });
    if (response.success) {
      if (!Object.prototype.hasOwnProperty.call(response, 'data') || response.data === undefined) {
        throw new TradeApiError('PROTOCOL_ERROR', { uncertain: write });
      }
      return response.data;
    }
    const code = response.error?.code;
    if (typeof code !== 'string' || !/^[A-Z][A-Z_]{1,63}$/.test(code)) {
      throw new TradeApiError('PROTOCOL_ERROR', { uncertain: write });
    }
    if (['UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(code) && snapshot && session === snapshot) clearSession();
    // INTERNAL_ERROR也可能来自提交结果不明，不能把它当作业务肯定失败。
    throw new TradeApiError(code, { uncertain: write && code === 'INTERNAL_ERROR' });
  }

  const call = async (action, input, fields, options) => request(action, pickData(input, fields), options);
  const orders = Object.freeze({
    list: (input = {}) => call('orders.list', input, ['manage', 'status', 'cursor', 'limit']),
    timeline: input => call('orders.timeline', input, ['orderId', 'manage', 'cursor', 'limit']),
    pickupCode: orderId => call('orders.pickupCode', { orderId }, ['orderId']),
    quote: input => call('orders.quote', input, ['items', 'deliveryType', 'addressId']),
    create: input => call('orders.create', input,
      ['requestId', 'items', 'deliveryType', 'addressId', 'expectedTotalCents', 'remark'], { write: true }),
    get: orderId => call('orders.get', { orderId }, ['orderId']),
    pay: (orderId, options = {}) => call('orders.pay', { ...options, orderId },
      ['orderId', 'outcome', 'success', 'attemptId', 'reasonCode', 'expectedVersion'], { write: true }),
    cancel: (orderId, options = {}) => call('orders.cancel', { ...options, orderId },
      ['orderId', 'expectedVersion'], { write: true }),
    reject: input => call('orders.reject', input,
      ['orderId', 'requestId', 'expectedVersion', 'reason'], { write: true, employee: true })
  });

  const staff = Object.freeze({
    async login(password) {
      clearSession();
      const expectedGeneration = generation;
      const result = await call('staff.login', { password }, ['password'], { write: true, useSession: false });
      if (expectedGeneration !== generation) throw new TradeApiError('SESSION_CHANGED');
      if (!result || typeof result.token !== 'string' || !/^[0-9a-f]{64}$/.test(result.token)
        || !['staff', 'owner'].includes(result.role) || !Number.isSafeInteger(result.expiresAt)
        || result.expiresAt <= clock()) throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
      session = { token: result.token, role: result.role, expiresAt: result.expiresAt };
      return { role: session.role, expiresAt: session.expiresAt };
    },
    async logout() {
      const previous = session;
      clearSession();
      if (!previous) return { cleared: true, remoteRevoked: false };
      const result = await request('staff.logout', {}, { write: true, capturedSession: previous });
      if (!result || result.revoked !== true) throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
      return { cleared: true, remoteRevoked: true };
    },
    setAccess: input => call('staff.setAccess', input, ['targetOpenid', 'enabled'], { write: true, employee: true }),
    setPassword: input => call('staff.setPassword', input, ['targetOpenid', 'password'], { write: true, employee: true })
  });

  return Object.freeze({
    identity: Object.freeze({ me: () => request('identity.me', {}) }),
    staff, orders,
    shop: Object.freeze({
      get: () => request('shop.get', {}),
      save: input => call('shop.save', input, ['requestId', 'expectedVersion', 'name', 'phone', 'wechat',
        'address', 'deliveryNote', 'shipping', 'banners'], { write: true, employee: true })
    }),
    notifications: Object.freeze({ list: (input = {}) => call('notifications.list', input, ['manage', 'limit', 'cursor']) }),
    catalog: Object.freeze({
      list: (input = {}) => call('catalog.list', input, ['category', 'keyword', 'includeUnavailable', 'cursor', 'limit']),
      get: (productId, options = {}) => call('catalog.get', { ...options, productId }, ['productId', 'includeUnavailable']),
      save: input => call('catalog.save', input, ['productId', 'requestId', 'expectedVersion', 'name', 'priceCents',
        'desc', 'category', 'image', 'isOnSale', 'isFeatured', 'onHand', 'reserved', 'inventoryVersion'], { write: true, employee: true })
    }),
    addresses: Object.freeze({
      get: addressId => call('addresses.get', { addressId }, ['addressId']),
      list: (input = {}) => call('addresses.list', input, ['cursor', 'limit']),
      save: input => call('addresses.save', input, ['addressId', 'requestId', 'expectedVersion', 'name', 'phone',
        'province', 'city', 'district', 'detail', 'makeDefault'], { write: true }),
      remove: input => call('addresses.remove', input, ['addressId', 'requestId', 'expectedVersion'], { write: true })
    }),
    cart: Object.freeze({
      get: () => request('cart.get', {}),
      setLine: input => call('cart.setLine', input, ['productId', 'quantity', 'requestId', 'expectedVersion'], { write: true }),
      clear: input => call('cart.clear', input, ['requestId', 'expectedVersion'], { write: true })
    }),
    fulfillment: Object.freeze(Object.fromEntries(['accept', 'ship', 'readyForPickup', 'complete'].map(action =>
      [action, input => call('fulfillment.' + action, input, ['orderId', 'requestId', 'expectedVersion',
        'carrier', 'trackingNo', 'pickupCode'], { write: true, employee: true })]))),
    afterSales: Object.freeze({
      apply: input => call('afterSales.apply', input, ['orderId', 'requestId', 'reason'], { write: true }),
      review: input => call('afterSales.review', input, ['afterSaleId', 'requestId', 'expectedVersion', 'decision', 'reason'],
        { write: true, employee: true }),
      get: (afterSaleId, options = {}) => call('afterSales.get', { ...options, afterSaleId }, ['afterSaleId', 'manage']),
      list: (input = {}) => call('afterSales.list', input, ['manage', 'status', 'cursor', 'limit'])
    }),
    statistics: Object.freeze({ summary: input => call('statistics.summary', input, ['startAt', 'endAt'], { employee: true }) }),
    inventory: Object.freeze({ adjust: input => call('inventory.adjust', input,
      ['requestId', 'productId', 'onHand', 'expectedVersion', 'reason'], { write: true, employee: true }) }),
    refunds: Object.freeze({ executeApproved: input => call('refunds.executeApproved', input,
      ['afterSaleId', 'expectedOrderVersion'], { write: true, employee: true }) }),
    prepareCheckout(input) {
      const expectedGeneration = generation;
      return prepareCheckout(orders, input, { isCurrent: () => generation === expectedGeneration });
    },
    getSession() {
      const active = currentSession();
      return active ? { role: active.role, expiresAt: active.expiresAt } : null;
    },
    // 切换可信顾客身份时调用，并丢弃旧身份的结算意图；这不会注销服务器会话。
    clearSession
  });
}

module.exports = { createTradeClient, TradeApiError };

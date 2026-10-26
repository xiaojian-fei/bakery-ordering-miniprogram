'use strict';
const { TradeApiError, copyData, pickData } = require('./trade-errors');

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const states = ['PREPARED', 'SUBMITTING', 'UNCERTAIN', 'CONFIRMED', 'REJECTED'];
const unresolved = record => record && ['SUBMITTING', 'UNCERTAIN'].includes(record.state);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function selection(input) {
  const value = pickData(input, ['requestId', 'items', 'deliveryType', 'addressId', 'remark']);
  if (!validId(value.requestId) || value.requestId.length < 8 || !['pickup', 'delivery'].includes(value.deliveryType)
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 20
    || value.items.some(item => !validId(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)
    || (value.deliveryType === 'delivery' && !validId(value.addressId))
    || (value.remark !== undefined && (typeof value.remark !== 'string' || value.remark.length > 200))) {
    throw new TradeApiError('INVALID_CHECKOUT_DRAFT');
  }
  if (value.deliveryType === 'pickup') delete value.addressId;
  value.remark = value.remark || '';
  return value;
}

function quoteView(quote) {
  const value = pickData(quote, ['items', 'subtotalCents', 'shippingCents', 'totalCents', 'shippingRuleVersion']);
  if (![value.subtotalCents, value.shippingCents, value.totalCents].every(n => Number.isSafeInteger(n) && n >= 0)
    || value.totalCents < 1 || value.subtotalCents + value.shippingCents !== value.totalCents
    || !Array.isArray(value.items)) throw new TradeApiError('INVALID_CHECKOUT_DRAFT');
  value.items = value.items.map(item => pickData(item, ['productId', 'name', 'quantity', 'unitPriceCents', 'lineTotalCents']));
  return value;
}

// 单客户端实例的持久化恢复协议。storage可接本地文件/小程序存储，但不在此模块引入平台API。
function createCheckoutRecovery({ client, storage, subjectId, namespace = 'bakery.checkout.v1' } = {}) {
  if (typeof client?.identity?.me !== 'function' || typeof client?.orders?.create !== 'function'
    || typeof client?.orders?.get !== 'function' || typeof client?.prepareCheckout !== 'function'
    || !storage || !['get', 'set', 'remove'].every(method => typeof storage[method] === 'function')
    || typeof subjectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(subjectId)
    || typeof namespace !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(namespace)) throw new TradeApiError('INVALID_REQUEST');
  const key = namespace + ':' + subjectId;
  let queue = Promise.resolve();
  const exclusive = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  async function sameSubject() {
    const actor = await client.identity.me();
    if (actor?.openid !== subjectId) throw new TradeApiError('CHECKOUT_IDENTITY_MISMATCH');
  }
  async function read() {
    let raw;
    try { raw = await storage.get(key); } catch (_) { throw new TradeApiError('CHECKOUT_STORAGE_ERROR'); }
    if (raw === undefined || raw === null) return null;
    if (raw.schemaVersion !== 1 || raw.subjectId !== subjectId || !states.includes(raw.state)) throw new TradeApiError('INVALID_CHECKOUT_DRAFT');
    try {
      const payload = { ...selection(raw.payload), expectedTotalCents: raw.payload.expectedTotalCents };
      const quote = quoteView(raw.quote);
      if (payload.expectedTotalCents !== quote.totalCents || (raw.state === 'CONFIRMED' && !validId(raw.orderId))) {
        throw new TradeApiError('INVALID_CHECKOUT_DRAFT');
      }
      return { schemaVersion: 1, subjectId, state: raw.state, payload, quote,
        orderId: validId(raw.orderId) ? raw.orderId : null };
    } catch (_) {
      throw new TradeApiError('INVALID_CHECKOUT_DRAFT');
    }
  }
  async function write(record) {
    try { await storage.set(key, copyData(record)); } catch (_) { throw new TradeApiError('CHECKOUT_STORAGE_ERROR'); }
  }
  function attemptFor(initial, restored) {
    const payload = freeze(copyData(initial.payload)), quote = freeze(copyData(initial.quote));
    let storageWarning = false, inFlight = null, latestState = initial.state;
    const submit = () => {
      if (inFlight) return inFlight.then(copyData);
      inFlight = exclusive(async () => {
        await sameSubject();
        const record = await read();
        if (!record || JSON.stringify(record.payload) !== JSON.stringify(payload)) throw new TradeApiError('STALE_CHECKOUT_DRAFT');
        if (record.state === 'CONFIRMED') {
          const order = await client.orders.get(record.orderId);
          if (order.ownerOpenid !== subjectId || order.requestId !== payload.requestId) throw new TradeApiError('CHECKOUT_IDENTITY_MISMATCH');
          latestState = 'CONFIRMED';
          return order;
        }
        record.state = 'SUBMITTING';
        // 保存成功后才发送创建：存储失败不能偷偷产生无法恢复的新请求。
        await write(record);
        latestState = record.state;
        let order;
        try {
          order = await client.orders.create(payload);
          if (order?.ownerOpenid !== subjectId || order.requestId !== payload.requestId
            || order.amounts?.totalCents !== payload.expectedTotalCents || !validId(order._id)) {
            throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
          }
        } catch (rawError) {
          const error = rawError instanceof TradeApiError ? rawError : new TradeApiError('NETWORK_ERROR', { uncertain: true });
          record.state = error.uncertain ? 'UNCERTAIN' : 'REJECTED'; latestState = record.state;
          try { await write(record); } catch (_) { storageWarning = true; }
          throw error;
        }
        record.state = 'CONFIRMED'; record.orderId = order._id; latestState = record.state;
        // 已知订单成功时，不因本地确认记录写失败而把成功订单报成失败。
        try { await write(record); } catch (_) { storageWarning = true; }
        return order;
      }).finally(() => { inFlight = null; });
      return inFlight.then(copyData);
    };
    return Object.freeze({ requestId: payload.requestId, payload, quote, restored, submit, retry: submit,
      getRecoveryStatus: () => ({ state: latestState, storageWarning }) });
  }
  return Object.freeze({
    prepare: input => exclusive(async () => {
      await sameSubject();
      const selected = selection(input);
      const previous = await read();
      if (previous?.payload.requestId === selected.requestId) {
        if (JSON.stringify(selection(previous.payload)) !== JSON.stringify(selected)) throw new TradeApiError('IDEMPOTENCY_CONFLICT');
        return attemptFor(previous, true);
      }
      if (unresolved(previous)) throw new TradeApiError('CHECKOUT_RECOVERY_REQUIRED');
      const prepared = await client.prepareCheckout(selected);
      const record = { schemaVersion: 1, subjectId, state: 'PREPARED', payload: {
        ...selected, expectedTotalCents: prepared.quote.totalCents }, quote: quoteView(prepared.quote), orderId: null };
      await write(record);
      return attemptFor(record, false);
    }),
    restore: () => exclusive(async () => { await sameSubject(); const record = await read(); return record ? attemptFor(record, true) : null; }),
    inspect: () => exclusive(async () => {
      await sameSubject(); const record = await read();
      return record ? { state: record.state, requestId: record.payload.requestId,
        orderId: record.orderId, totalCents: record.payload.expectedTotalCents } : null;
    }),
    discard: ({ acknowledgeUncertain = false } = {}) => exclusive(async () => {
      await sameSubject();
      let record;
      try { record = await read(); } catch (error) {
        if (error.code !== 'INVALID_CHECKOUT_DRAFT' || acknowledgeUncertain !== true) throw error;
      }
      if (unresolved(record) && acknowledgeUncertain !== true) throw new TradeApiError('CHECKOUT_RECOVERY_REQUIRED');
      try { await storage.remove(key); } catch (_) { throw new TradeApiError('CHECKOUT_STORAGE_ERROR'); }
      return { discarded: true, cancelledOrder: false };
    })
  });
}
module.exports = { createCheckoutRecovery };

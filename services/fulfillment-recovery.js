'use strict';
const { TradeApiError, copyData } = require('./trade-errors');

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const targetStatus = { accept: 'ACCEPTED', ship: 'SHIPPING', readyForPickup: 'READY_FOR_PICKUP', complete: 'COMPLETED' };
const authLost = error => ['UNAUTHENTICATED', 'FORBIDDEN', 'SESSION_CHANGED', 'ACCOUNT_DISABLED'].includes(error?.code);

function command(input) {
  const action = input?.action, data = input?.payload;
  if (!data || !['accept', 'ship', 'readyForPickup', 'complete', 'reject'].includes(action)
    || !validId(data.orderId) || !validId(data.requestId) || data.requestId.length < 8
    || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 1) {
    throw new TradeApiError('INVALID_FULFILLMENT_RECORD');
  }
  const payload = { orderId: data.orderId, requestId: data.requestId, expectedVersion: data.expectedVersion };
  if (action === 'ship') {
    if (typeof data.carrier !== 'string' || !data.carrier.trim() || data.carrier.length > 60
      || typeof data.trackingNo !== 'string' || !/^[A-Za-z0-9_-]{4,80}$/.test(data.trackingNo)) {
      throw new TradeApiError('INVALID_FULFILLMENT_RECORD');
    }
    payload.carrier = data.carrier; payload.trackingNo = data.trackingNo;
  }
  if (action === 'complete' && data.pickupCode !== undefined) {
    if (typeof data.pickupCode !== 'string' || !/^[A-F0-9]{12}$/.test(data.pickupCode)) throw new TradeApiError('INVALID_FULFILLMENT_RECORD');
    payload.pickupCode = data.pickupCode;
  }
  if (action === 'reject') {
    if (typeof data.reason !== 'string' || !data.reason.trim() || data.reason.length > 200) {
      throw new TradeApiError('INVALID_FULFILLMENT_RECORD');
    }
    payload.reason = data.reason;
  }
  return { action, payload };
}

function createFulfillmentRecovery({ runtime, wx }) {
  let key;
  async function identify() {
    await runtime.assertIdentity();
    const expected = runtime.checkoutNamespace + ':fulfillment:' + runtime.subjectId;
    if (key && key !== expected) throw new TradeApiError('SESSION_CHANGED');
    key = expected;
  }
  function storage(work) {
    try { return work(); }
    catch (_) { throw new TradeApiError('FULFILLMENT_STORAGE_ERROR'); }
  }
  function read() {
    const keys = storage(() => wx.getStorageInfoSync().keys);
    if (!Array.isArray(keys)) throw new TradeApiError('FULFILLMENT_STORAGE_ERROR');
    if (!keys.includes(key)) return null;
    const record = storage(() => wx.getStorageSync(key));
    if (record?.schema !== 1 || record.subjectId !== runtime.subjectId) throw new TradeApiError('INVALID_FULFILLMENT_RECORD');
    return command(record.command);
  }
  function remove(original) {
    const current = read();
    if (!current || JSON.stringify(current) !== JSON.stringify(original)) throw new TradeApiError('FULFILLMENT_RECOVERY_REQUIRED');
    storage(() => wx.removeStorageSync(key));
  }
  return {
    async inspect() { await identify(); return read(); },
    async prepare(input) {
      await identify();
      if (read()) throw new TradeApiError('FULFILLMENT_RECOVERY_REQUIRED');
      const original = command(input);
      storage(() => wx.setStorageSync(key, { schema: 1, subjectId: runtime.subjectId, command: copyData(original) }));
      return original;
    },
    async submit() {
      await identify();
      const original = read();
      if (!original) throw new TradeApiError('INVALID_FULFILLMENT_RECORD');
      let result;
      try {
        result = original.action === 'reject'
          ? await runtime.client.orders.reject(original.payload)
          : await runtime.client.fulfillment[original.action](original.payload);
        const valid = original.action === 'reject'
          ? result?.orderId === original.payload.orderId && result.status === 'SUCCEEDED' && result.mode === 'SIMULATED'
          : result?._id === original.payload.orderId && result.version === original.payload.expectedVersion + 1
            && result.status === targetStatus[original.action];
        if (!valid) throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
      } catch (error) {
        if (error instanceof TradeApiError && !error.uncertain && !authLost(error)) remove(original);
        throw error;
      }
      await identify();
      let storageWarning = false;
      try { remove(original); } catch (_) { storageWarning = true; }
      return { result, storageWarning };
    }
  };
}

module.exports = { createFulfillmentRecovery };

'use strict';
const { TradeApiError } = require('./trade-errors');
const { createOperationRecovery } = require('./operation-recovery');

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const targetStatus = { accept: 'ACCEPTED', ship: 'SHIPPING', readyForPickup: 'READY_FOR_PICKUP', complete: 'COMPLETED' };

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
  return createOperationRecovery({
    runtime, wx, scope: 'fulfillment', normalize: command,
    errors: { invalid: 'INVALID_FULFILLMENT_RECORD', storage: 'FULFILLMENT_STORAGE_ERROR', pending: 'FULFILLMENT_RECOVERY_REQUIRED' },
    send: original => original.action === 'reject'
      ? runtime.client.orders.reject(original.payload)
      : runtime.client.fulfillment[original.action](original.payload),
    validResult: (original, result) => original.action === 'reject'
      ? result?.orderId === original.payload.orderId && result.status === 'SUCCEEDED' && result.mode === 'SIMULATED'
      : result?._id === original.payload.orderId && result.version === original.payload.expectedVersion + 1
        && result.status === targetStatus[original.action]
  });
}

module.exports = { createFulfillmentRecovery };

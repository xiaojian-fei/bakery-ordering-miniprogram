'use strict';
const { TradeApiError } = require('./trade-errors');
const { createOperationRecovery } = require('./operation-recovery');

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const requestId = value => id(value) && value.length >= 8;
const reason = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 200;
const invalid = () => { throw new TradeApiError('INVALID_AFTER_SALE_RECORD'); };

function normalize(input) {
  const type = input?.type, data = input?.payload;
  if (!data || !['apply', 'review', 'refund'].includes(type)) return invalid();
  let payload;
  if (type === 'apply') {
    if (!id(data.orderId) || !requestId(data.requestId) || !reason(data.reason)) return invalid();
    payload = { orderId: data.orderId, requestId: data.requestId, reason: data.reason };
  } else if (type === 'review') {
    if (!id(data.afterSaleId) || !requestId(data.requestId) || !reason(data.reason)
      || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 1 || !['approve', 'reject'].includes(data.decision)) return invalid();
    payload = { afterSaleId: data.afterSaleId, requestId: data.requestId, expectedVersion: data.expectedVersion,
      decision: data.decision, reason: data.reason };
  } else {
    if (!id(data.afterSaleId)) return invalid();
    payload = { afterSaleId: data.afterSaleId };
  }
  return { type, payload };
}

function createAfterSaleRecovery({ runtime, storage, owner = false }) {
  return createOperationRecovery({
    runtime, storage, scope: owner ? 'owner-after-sale' : 'customer-after-sale',
    errors: { invalid: 'INVALID_AFTER_SALE_RECORD', storage: 'AFTER_SALE_STORAGE_ERROR', pending: 'AFTER_SALE_RECOVERY_REQUIRED' },
    normalize(input) {
      const command = normalize(input);
      if (owner ? command.type === 'apply' : command.type !== 'apply') return invalid();
      return command;
    },
    send: command => command.type === 'refund' ? runtime.client.refunds.executeApproved(command.payload)
      : runtime.client.afterSales[command.type](command.payload),
    validResult(command, result) {
      if (!result || !id(result._id)) return false;
      if (command.type === 'apply') {
        return result.ownerOpenid === runtime.subjectId && result.orderId === command.payload.orderId
          && result.reason === command.payload.reason && result.status === 'REQUESTED';
      }
      if (command.type === 'review') {
        return result._id === command.payload.afterSaleId && result.version === command.payload.expectedVersion + 1
          && result.status === (command.payload.decision === 'approve' ? 'APPROVED' : 'REJECTED');
      }
      return result.afterSaleId === command.payload.afterSaleId && result.status === 'SUCCEEDED' && result.mode === 'SIMULATED';
    }
  });
}

module.exports = { createAfterSaleRecovery };

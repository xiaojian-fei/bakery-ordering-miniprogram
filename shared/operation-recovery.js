'use strict';
const { TradeApiError, copyData } = require('./trade-errors');

const authLost = error => ['UNAUTHENTICATED', 'FORBIDDEN', 'SESSION_CHANGED', 'ACCOUNT_DISABLED'].includes(error?.code);

function createOperationRecovery({ runtime, wx, scope, normalize, send, validResult, errors }) {
  let key;
  async function identify() {
    await runtime.assertIdentity();
    const expected = runtime.checkoutNamespace + ':' + scope + ':' + runtime.subjectId;
    if (key && key !== expected) throw new TradeApiError('SESSION_CHANGED');
    key = expected;
  }
  function storage(work) {
    try { return work(); }
    catch (_) { throw new TradeApiError(errors.storage); }
  }
  function read() {
    const keys = storage(() => wx.getStorageInfoSync().keys);
    if (!Array.isArray(keys)) throw new TradeApiError(errors.storage);
    if (!keys.includes(key)) return null;
    const record = storage(() => wx.getStorageSync(key));
    if (record?.schema !== 1 || record.subjectId !== runtime.subjectId) throw new TradeApiError(errors.invalid);
    return normalize(record.command);
  }
  function remove(original) {
    const current = read();
    if (!current || JSON.stringify(current) !== JSON.stringify(original)) throw new TradeApiError(errors.pending);
    storage(() => wx.removeStorageSync(key));
  }
  return {
    async inspect() { await identify(); return read(); },
    async prepare(input) {
      await identify();
      if (read()) throw new TradeApiError(errors.pending);
      const original = normalize(input);
      storage(() => wx.setStorageSync(key, { schema: 1, subjectId: runtime.subjectId, command: copyData(original) }));
      return original;
    },
    async submit() {
      await identify();
      const original = read();
      if (!original) throw new TradeApiError(errors.invalid);
      let result;
      try {
        result = await send(original);
        if (!validResult(original, result)) throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
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

module.exports = { createOperationRecovery };

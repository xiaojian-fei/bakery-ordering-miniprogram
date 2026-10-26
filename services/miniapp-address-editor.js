'use strict';
const { TradeApiError, copyData, pickData } = require('./trade-errors');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const fields = { name: 80, phone: 40, province: 80, city: 80, district: 80, detail: 300 };

// 仅运行时内存中的保存恢复；不写本地缓存，不导入wx或云SDK。
function createMiniappAddressEditor({ client, assertIdentity, requestId }) {
  let pending = null, busy = false;
  function newId() {
    const value = requestId();
    if (!validId(value) || value.length < 8) throw new TradeApiError('INVALID_REQUEST');
    return value;
  }
  async function exclusive(work) {
    if (busy) throw new TradeApiError('ADDRESS_WRITE_BUSY');
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  async function sendPending() {
    const payload = pending.payload;
    try {
      const result = await client.addresses.save(copyData(payload));
      if (result?._id !== payload.addressId || result.version !== payload.expectedVersion + 1
        || typeof result.isDefault !== 'boolean'
        || Object.keys(fields).some(field => result[field] !== payload[field])
        || (payload.makeDefault !== undefined && result.isDefault !== payload.makeDefault)) {
        throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
      }
      pending = null;
      return result;
    } catch (rawError) {
      const error = rawError instanceof TradeApiError ? rawError : new TradeApiError('NETWORK_ERROR', { uncertain: true });
      if (!error.uncertain) pending = null;
      throw error;
    }
  }
  return Object.freeze({
    newId, hasPending: () => pending !== null,
    async getPending() { await assertIdentity(); return pending ? copyData(pending) : null; },
    async read(addressId) {
      if (!validId(addressId)) throw new TradeApiError('INVALID_REQUEST');
      await assertIdentity();
      return client.addresses.get(addressId);
    },
    save(input, { displayedDefault = false } = {}) {
      // 在任何等待之前冻结白名单表单副本，页面改动不能改变正在发送的意图。
      let payload;
      try {
        payload = pickData(input, ['addressId', 'expectedVersion', ...Object.keys(fields), 'makeDefault']);
        if (!validId(payload.addressId) || !Number.isSafeInteger(payload.expectedVersion)
          || payload.expectedVersion < 0 || payload.expectedVersion >= Number.MAX_SAFE_INTEGER
          || (payload.makeDefault !== undefined && typeof payload.makeDefault !== 'boolean')
          || typeof displayedDefault !== 'boolean') throw new TradeApiError('INVALID_REQUEST');
        for (const [field, maximum] of Object.entries(fields)) {
          if (typeof payload[field] !== 'string' || !payload[field].trim() || payload[field].length > maximum) {
            throw new TradeApiError('INVALID_REQUEST');
          }
          payload[field] = payload[field].trim();
        }
      } catch (error) { return Promise.reject(error); }
      return exclusive(async () => {
        if (pending) throw new TradeApiError('ADDRESS_RECOVERY_REQUIRED');
        await assertIdentity();
        payload.requestId = newId();
        pending = { payload, displayedDefault: payload.makeDefault ?? displayedDefault };
        return sendPending();
      });
    },
    retry: () => exclusive(async () => {
      await assertIdentity();
      if (!pending) throw new TradeApiError('INVALID_STATE');
      return sendPending();
    })
  });
}
module.exports = { createMiniappAddressEditor };

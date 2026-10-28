'use strict';
const { TradeApiError, copyData, pickData } = require('./trade-errors');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const fields = { name: 80, phone: 40, province: 80, city: 80, district: 80, detail: 300 };

// 仅运行时内存中的地址保存/删除恢复；不写本地缓存，不导入wx或云SDK。
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
    const { kind, payload } = pending;
    try {
      const result = await (kind === 'remove' ? client.addresses.remove(copyData(payload)) : client.addresses.save(copyData(payload)));
      const valid = kind === 'remove' ? result?.removed === true && result.version === payload.expectedVersion + 1
        : result?._id === payload.addressId && result.version === payload.expectedVersion + 1
        && typeof result.isDefault === 'boolean'
        && Object.keys(fields).every(field => result[field] === payload[field])
        && (payload.makeDefault === undefined || result.isDefault === payload.makeDefault);
      if (!valid) {
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
  const recoveryError = () => new TradeApiError(pending?.kind === 'remove'
    ? 'ADDRESS_DELETE_RECOVERY_REQUIRED' : 'ADDRESS_RECOVERY_REQUIRED');
  const retry = kind => exclusive(async () => {
    await assertIdentity();
    if (!pending) throw new TradeApiError('INVALID_STATE');
    if (pending.kind !== kind) throw recoveryError();
    return sendPending();
  });
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
        if (pending) throw recoveryError();
        await assertIdentity();
        payload.requestId = newId();
        pending = { kind: 'save', payload, displayedDefault: payload.makeDefault ?? displayedDefault };
        return sendPending();
      });
    },
    remove(input) {
      let payload;
      try {
        payload = pickData(input, ['addressId', 'expectedVersion']);
        if (!validId(payload.addressId) || !Number.isSafeInteger(payload.expectedVersion)
          || payload.expectedVersion < 0 || payload.expectedVersion >= Number.MAX_SAFE_INTEGER) throw new TradeApiError('INVALID_REQUEST');
      } catch (error) { return Promise.reject(error); }
      return exclusive(async () => {
        if (pending) throw recoveryError();
        await assertIdentity();
        payload.requestId = newId();
        pending = { kind: 'remove', payload };
        return sendPending();
      });
    },
    retry: () => retry('save'),
    retryRemove: () => retry('remove')
  });
}
module.exports = { createMiniappAddressEditor };

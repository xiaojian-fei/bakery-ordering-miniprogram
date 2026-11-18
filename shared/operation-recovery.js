'use strict';
const { TradeApiError, copyData } = require('./trade-errors');

const authLost = error => ['UNAUTHENTICATED', 'FORBIDDEN', 'SESSION_CHANGED', 'ACCOUNT_DISABLED'].includes(error?.code);

/**
 * 一次性写操作的“先记录后发送”恢复协议。
 *
 * 与 checkout-recovery 共用同一个平台无关的存储契约：storage.get / storage.set / storage.remove，
 * 可以是同步实现也可以是 Promise（这里统一 await）。浏览器侧由 web/storage.js 提供 localStorage 实现，
 * 测试注入内存实现——本模块不引入任何平台 API。
 */
function createOperationRecovery({ runtime, storage, scope, normalize, send, validResult, errors }) {
  if (!runtime || typeof runtime.assertIdentity !== 'function' || typeof runtime.checkoutNamespace !== 'string'
    || typeof runtime.subjectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(runtime.subjectId)) {
    throw new TradeApiError('INVALID_REQUEST');
  }
  if (typeof scope !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(scope)) throw new TradeApiError('INVALID_REQUEST');
  if (!storage || !['get', 'set', 'remove'].every(method => typeof storage[method] === 'function')
    || typeof normalize !== 'function' || typeof send !== 'function' || typeof validResult !== 'function'
    || !errors || !['invalid', 'storage', 'pending'].every(key => typeof errors[key] === 'string')) {
    throw new TradeApiError('INVALID_REQUEST');
  }
  let key;
  async function identify() {
    await runtime.assertIdentity();
    const expected = runtime.checkoutNamespace + ':' + scope + ':' + runtime.subjectId;
    if (key && key !== expected) throw new TradeApiError('SESSION_CHANGED');
    key = expected;
  }
  async function guard(work) {
    try { return await work(); } catch (_) { throw new TradeApiError(errors.storage); }
  }
  async function read() {
    const record = await guard(() => storage.get(key));
    if (record === undefined || record === null || record === '') return null;
    if (record?.schema !== 1 || record.subjectId !== runtime.subjectId) throw new TradeApiError(errors.invalid);
    return normalize(record.command);
  }
  async function remove(original) {
    const current = await read();
    if (!current || JSON.stringify(current) !== JSON.stringify(original)) throw new TradeApiError(errors.pending);
    await guard(() => storage.remove(key));
  }
  return {
    async inspect() { await identify(); return read(); },
    async prepare(input) {
      await identify();
      if (await read()) throw new TradeApiError(errors.pending);
      const original = normalize(input);
      await guard(() => storage.set(key, { schema: 1, subjectId: runtime.subjectId, command: copyData(original) }));
      return original;
    },
    async submit() {
      await identify();
      const original = await read();
      if (!original) throw new TradeApiError(errors.invalid);
      let result;
      try {
        result = await send(original);
        if (!validResult(original, result)) throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
      } catch (error) {
        if (error instanceof TradeApiError && !error.uncertain && !authLost(error)) await remove(original);
        throw error;
      }
      await identify();
      let storageWarning = false;
      try { await remove(original); } catch (_) { storageWarning = true; }
      return { result, storageWarning };
    }
  };
}

module.exports = { createOperationRecovery };
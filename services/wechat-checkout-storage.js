'use strict';
const { TradeApiError, copyData } = require('./trade-errors');

// 只封装本地缓存，不初始化云环境，也不在模块加载时访问全局wx。
// 一份适配器只允许访问一个环境命名空间下的一名顾客的结算草稿。
function createWechatCheckoutStorage({ wx, subjectId, namespace = 'bakery.checkout.v1' } = {}) {
  if (!wx || !['getStorageInfoSync', 'getStorageSync', 'setStorageSync', 'removeStorageSync']
    .every(method => typeof wx[method] === 'function')
    || typeof subjectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(subjectId)
    || typeof namespace !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(namespace)) {
    throw new TradeApiError('INVALID_REQUEST');
  }
  const allowedKey = namespace + ':' + subjectId;
  function checkKey(key) {
    if (key !== allowedKey) throw new TradeApiError('CHECKOUT_IDENTITY_MISMATCH');
  }
  function localOperation(work) {
    try { return work(); } catch (_) { throw new TradeApiError('CHECKOUT_STORAGE_ERROR'); }
  }
  return Object.freeze({
    get(key) {
      checkKey(key);
      return localOperation(() => {
        const info = wx.getStorageInfoSync();
        if (!Array.isArray(info?.keys) || info.keys.some(item => typeof item !== 'string')) {
          throw new Error('INVALID_STORAGE_INFO');
        }
        if (!info.keys.includes(key)) return null;
        const value = wx.getStorageSync(key);
        // 已存在的空值是损坏记录，不能当作无草稿，进而覆盖未知结果。
        return value === null || value === undefined ? {} : copyData(value);
      });
    },
    set(key, record) {
      checkKey(key);
      const value = copyData(record);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.subjectId !== subjectId) {
        throw new TradeApiError('INVALID_CHECKOUT_DRAFT');
      }
      localOperation(() => wx.setStorageSync(key, value));
    },
    remove(key) {
      checkKey(key);
      localOperation(() => wx.removeStorageSync(key));
    }
  });
}

module.exports = { createWechatCheckoutStorage };

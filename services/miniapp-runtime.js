'use strict';
const { TradeApiError, copyData } = require('./trade-errors');

const routes = Object.freeze(['/pages/index/index', '/pages/detail/detail', '/pages/cart/cart', '/pages/address/address']);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

// 平台无关的页面运行时。client使用可信send；requestId由调用方提供，不能在失败重试时重建。
function createMiniappRuntime({ client, subjectId = null, requestId } = {}) {
  if (!client || !['me'].every(method => typeof client.identity?.[method] === 'function')
    || !['get', 'setLine'].every(method => typeof client.cart?.[method] === 'function')
    || typeof client.catalog?.list !== 'function' || typeof client.catalog?.get !== 'function'
    || typeof client.shop?.get !== 'function' || typeof requestId !== 'function'
    || (subjectId !== null && (typeof subjectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(subjectId)))) {
    throw new TradeApiError('INVALID_REQUEST');
  }
  let pending = null, busy = false;
  async function assertIdentity() {
    const actor = await client.identity.me();
    if (subjectId === null && typeof actor?.openid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(actor.openid)) subjectId = actor.openid;
    if (subjectId === null || actor?.openid !== subjectId) throw new TradeApiError('SESSION_CHANGED');
  }
  async function exclusive(work) {
    if (busy) throw new TradeApiError('CART_WRITE_BUSY');
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  async function sendPending() {
    try {
      const result = await client.cart.setLine(copyData(pending));
      if (!Number.isSafeInteger(result?.version) || result.version !== pending.expectedVersion + 1
        || !Array.isArray(result.items) || result.items.length > 20
        || result.items.some(item => !validId(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)
        || new Set(result.items.map(item => item.productId)).size !== result.items.length
        || (result.items.find(item => item.productId === pending.productId)?.quantity || 0) !== pending.quantity) {
        throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
      }
      pending = null;
      return result;
    } catch (rawError) {
      const error = rawError instanceof TradeApiError ? rawError : new TradeApiError('NETWORK_ERROR', { uncertain: true });
      // 写结果未知时保留原绝对数量、版本与requestId，阻止新的加购意图覆盖它。
      if (error.uncertain !== true) pending = null;
      throw error;
    }
  }
  function command(productId, quantity, expectedVersion) {
    if (!validId(productId) || !Number.isInteger(quantity) || quantity < 0 || quantity > 99
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TradeApiError('INVALID_REQUEST');
    const id = requestId();
    if (!validId(id) || id.length < 8) throw new TradeApiError('INVALID_REQUEST');
    return { productId, quantity, expectedVersion, requestId: id };
  }
  return Object.freeze({
    client, get subjectId() { return subjectId; }, assertIdentity,
    isRouteAvailable: path => routes.includes(path),
    hasPendingCartWrite: () => pending !== null,
    async readCart() { await assertIdentity(); return client.cart.get(); },
    async readAddresses(input = {}) { await assertIdentity(); return client.addresses.list(input); },
    addProduct: productId => exclusive(async () => {
      if (pending) throw new TradeApiError('CART_RECOVERY_REQUIRED');
      await assertIdentity();
      const cart = await client.cart.get();
      const quantity = (cart.items.find(item => item.productId === productId)?.quantity || 0) + 1;
      pending = command(productId, quantity, cart.version);
      return sendPending();
    }),
    setCartQuantity: input => exclusive(async () => {
      if (pending) throw new TradeApiError('CART_RECOVERY_REQUIRED');
      await assertIdentity();
      pending = command(input.productId, input.quantity, input.expectedVersion);
      return sendPending();
    }),
    retryCartWrite: () => exclusive(async () => {
      await assertIdentity();
      if (!pending) throw new TradeApiError('INVALID_STATE');
      return sendPending();
    })
  });
}
module.exports = { createMiniappRuntime };

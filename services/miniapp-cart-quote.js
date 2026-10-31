'use strict';
const { TradeApiError } = require('./trade-errors');
const money = value => (value / 100).toFixed(2);
const linesKey = items => JSON.stringify(items.map(({ productId, quantity }) => ({ productId, quantity }))
  .sort((a, b) => a.productId.localeCompare(b.productId)));
const addressFields = ['name', 'phone', 'province', 'city', 'district', 'detail'];
const invalidAddress = ['ADDRESS_NOT_FOUND', 'FORBIDDEN', 'SESSION_CHANGED', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED'];
function addressView(saved, id) {
  if (saved?._id !== id || !Number.isSafeInteger(saved.version) || saved.version < 0
    || typeof saved.isDefault !== 'boolean' || addressFields.some(field => typeof saved[field] !== 'string')) {
    throw new TradeApiError('PROTOCOL_ERROR');
  }
  return { _id: id, version: saved.version, isDefault: saved.isDefault,
    ...Object.fromEntries(addressFields.map(field => [field, saved[field]])) };
}

// 报价只用于本次页面预览，不生成下单意图、不锁价或预留库存。
function quoteView(quote, items) {
  const amount = value => Number.isSafeInteger(value) && value >= 0;
  if (!quote || !Array.isArray(quote.items) || quote.items.length !== items.length
    || linesKey(quote.items) !== linesKey(items)
    || new Set(quote.items.map(row => row.productId)).size !== items.length
    || ![quote.subtotalCents, quote.shippingCents, quote.totalCents].every(amount)
    || quote.totalCents < 1 || quote.totalCents !== quote.subtotalCents + quote.shippingCents
    || quote.items.some(row => typeof row.name !== 'string' || !amount(row.unitPriceCents) || row.unitPriceCents < 1
      || !amount(row.lineTotalCents) || row.lineTotalCents !== row.unitPriceCents * row.quantity)
    || quote.items.reduce((sum, row) => sum + row.lineTotalCents, 0) !== quote.subtotalCents) {
    throw new TradeApiError('PROTOCOL_ERROR');
  }
  return { items: quote.items.map(row => ({ productId: row.productId, name: row.name, quantity: row.quantity,
    price: money(row.unitPriceCents), total: money(row.lineTotalCents) })),
  subtotal: money(quote.subtotalCents), shipping: money(quote.shippingCents), total: money(quote.totalCents) };
}

function createCartQuote({ runtime }) {
  return {
    invalidateQuote() {
      this._quoteEpoch = (this._quoteEpoch || 0) + 1;
      this._quoteRequest = null;
      // 隐藏页面不调用setData；下次onShow/loadCart会清理展示状态。
      if (this._active) this.setData({ checkoutQuote: null, quoteLoading: false, quoteError: '' });
    },
    async goToOrder() {
      if (!this._active || (this._quoteRequest !== null && this._quoteRequest !== undefined)
        || this.data.loading || this.data.cartBusy || this._adding || this.data.addressLoading) return;
      this.invalidateQuote();
      if (runtime.hasPendingCartWrite()) {
        this.setData({ quoteError: new TradeApiError('CART_RECOVERY_REQUIRED').message }); return;
      }
      if (!this.data.canCheckout || !this.data.cartItems.length) {
        this.setData({ quoteError: '请先加载并检查购物车商品' }); return;
      }
      const deliveryType = this.data.deliveryType, addressId = this._selectedAddressId;
      if (deliveryType === 'delivery' && (!addressId || this.data.selectedAddress?._id !== addressId || this.data.addressError)) {
        this.setData({ quoteError: '请先选择并核对收货地址' }); return;
      }
      const epoch = this._quoteEpoch, version = this.data.version, key = linesKey(this.data.cartItems);
      const current = () => this._active && this._quoteEpoch === epoch
        && this.data.deliveryType === deliveryType && this._selectedAddressId === addressId
        && this.data.version === version && linesKey(this.data.cartItems) === key;
      this._quoteRequest = epoch; this.setData({ quoteLoading: true });
      try {
        const cart = await runtime.readCart();
        if (!current()) return;
        if (cart.version !== version || linesKey(cart.items) !== key || !cart.canCheckout) {
          const refresh = this.loadCart(), refreshEpoch = this._quoteEpoch;
          await refresh;
          if (this._active && this._quoteEpoch === refreshEpoch) this.setData({ quoteError: '购物车已变化，请检查商品后重新报价' });
          return;
        }
        let address = null, savedAddress = null;
        if (deliveryType === 'delivery') {
          const pending = await runtime.addressEditor.getPending();
          if (!current()) return;
          if (pending) throw new TradeApiError(pending.kind === 'remove' ? 'ADDRESS_DELETE_RECOVERY_REQUIRED' : 'ADDRESS_RECOVERY_REQUIRED');
          savedAddress = await runtime.addressEditor.read(addressId);
          if (!current()) return;
          const selectedAddress = addressView(savedAddress, addressId);
          address = Object.fromEntries(addressFields.map(field => [field, selectedAddress[field]]));
          this.setData({ selectedAddress, addressError: '' });
        }
        if (!current()) return;
        if (runtime.hasPendingCartWrite()) throw new TradeApiError('CART_RECOVERY_REQUIRED');
        const items = cart.items.map(({ productId, quantity }) => ({ productId, quantity }));
        const result = await runtime.client.orders.quote({ items, deliveryType,
          ...(deliveryType === 'delivery' ? { addressId } : {}) });
        if (!current()) return;
        const view = quoteView(result, items);
        if (deliveryType === 'pickup' && result.shippingCents !== 0) throw new TradeApiError('PROTOCOL_ERROR');
        if (deliveryType === 'delivery') {
          const latest = await runtime.addressEditor.read(addressId);
          if (!current()) return;
          const selectedAddress = addressView(latest, addressId);
          if (latest.version !== savedAddress.version || addressFields.some(field => latest[field] !== address[field])) {
            this.setData({ selectedAddress, quoteError: '收货地址已变化，请核对后重新报价' }); return;
          }
        }
        await runtime.assertIdentity();
        if (!current()) return;
        if (runtime.hasPendingCartWrite()) throw new TradeApiError('CART_RECOVERY_REQUIRED');
        this.setData({ checkoutQuote: { ...view, deliveryType, address } });
      } catch (error) {
        if (!current()) return;
        if (invalidAddress.includes(error?.code)) {
          this._selectedAddressId = null;
          this.setData({ selectedAddress: null, addressError: error instanceof TradeApiError ? error.message : '请重新核对收货地址' });
        }
        this.setData({ checkoutQuote: null, quoteError: error instanceof TradeApiError && error.code !== 'NETWORK_ERROR'
          ? error.message : '报价加载失败，请重试' });
      } finally {
        if (this._quoteEpoch === epoch) {
          this._quoteRequest = null;
          if (this._active) this.setData({ quoteLoading: false });
        }
      }
    }
  };
}
module.exports = { createCartQuote };

'use strict';
const { TradeApiError } = require('./trade-errors');
const { createWechatCheckoutStorage } = require('./wechat-checkout-storage');
const { quoteView, addressView, linesKey } = require('./miniapp-cart-quote');
const unresolved = state => ['SUBMITTING', 'UNCERTAIN'].includes(state);
const message = error => error instanceof TradeApiError ? error.message : '操作未完成，请核对本次订单后重试';
const signature = quote => {
  quoteView(quote, quote.items);
  return JSON.stringify({ subtotalCents: quote.subtotalCents, shippingCents: quote.shippingCents, totalCents: quote.totalCents,
    items: quote.items.map(({ productId, name, quantity, unitPriceCents, lineTotalCents }) =>
      ({ productId, name, quantity, unitPriceCents, lineTotalCents })).sort((a, b) => a.productId.localeCompare(b.productId)) });
};
const addressFields = ['name', 'phone', 'province', 'city', 'district', 'detail'];
const identityError = error => ['SESSION_CHANGED', 'CHECKOUT_IDENTITY_MISMATCH', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(error?.code);

// 创建订单之前持久化原请求。只在人工点击时提交/重试；onShow不自动补发写请求。
function createCheckoutSubmission({ runtime, wx }) {
  async function recovery() {
    await runtime.assertIdentity();
    return runtime.getCheckoutRecovery(createWechatCheckoutStorage({ wx, subjectId: runtime.subjectId,
      namespace: runtime.checkoutNamespace }));
  }
  function orderView(order, attempt) {
    if (!order || typeof order._id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(order._id)
      || order.ownerOpenid !== runtime.subjectId || order.requestId !== attempt.requestId
      || typeof order.status !== 'string' || !Number.isSafeInteger(order.amounts?.totalCents)
      || order.amounts.totalCents !== attempt.payload.expectedTotalCents) throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
    return { id: order._id, status: order.status, total: (order.amounts.totalCents / 100).toFixed(2) };
  }
  return {
    async syncCheckout() {
      const epoch = this._checkoutEpoch = (this._checkoutEpoch || 0) + 1;
      const current = () => this._active && this._checkoutEpoch === epoch;
      this.setData({ checkoutReady: false, checkoutBusy: Boolean(this._checkoutBusy), checkoutError: '', placedOrder: null });
      try {
        const store = await recovery(), attempt = await store.restore();
        if (!current()) return;
        const status = attempt?.getRecoveryStatus().state || '';
        let placedOrder = null;
        if (status === 'CONFIRMED') {
          const order = await attempt.retry(); // 已确认记录只读订单，不再创建。
          await runtime.assertIdentity();
          if (!current()) return;
          placedOrder = orderView(order, attempt);
        }
        if (current()) this.setData({ checkoutReady: true, checkoutState: status, placedOrder,
          checkoutDraftTotal: attempt ? (attempt.payload.expectedTotalCents / 100).toFixed(2) : '' });
      } catch (error) {
        if (current()) {
          if (identityError(error)) { this.invalidateQuote(); this._selectedAddressId = null; this.setData({ selectedAddress: null }); }
          this.setData({ checkoutState: 'BLOCKED', checkoutError: message(error) });
        }
      }
    },
    pauseCheckout() { this._checkoutEpoch = (this._checkoutEpoch || 0) + 1; },
    async submitQuotedOrder() {
      if (!this._active || this._checkoutBusy || !this.data.checkoutReady || this.data.loading
        || this.data.cartBusy || this.data.addressLoading || !this._quoteSelection) return;
      if (unresolved(this.data.checkoutState) || this.data.checkoutState === 'CONFIRMED') return;
      const selected = this._quoteSelection, quoteEpoch = this._quoteEpoch;
      const epoch = this._checkoutEpoch = (this._checkoutEpoch || 0) + 1;
      const current = () => this._active && this._checkoutEpoch === epoch;
      const unchanged = () => current() && this._quoteSelection === selected && this._quoteEpoch === quoteEpoch;
      this._checkoutBusy = true; this.setData({ checkoutBusy: true, checkoutError: '', placedOrder: null });
      let attempt = null;
      try {
        const store = await recovery(), status = await store.inspect();
        if (!unchanged()) return;
        if (unresolved(status?.state) || status?.state === 'CONFIRMED') {
          this.setData({ checkoutState: status.state, checkoutDraftTotal: (status.totalCents / 100).toFixed(2),
            checkoutError: '请先核对已有结算记录' }); return;
        }
        if (runtime.hasPendingCartWrite()) throw new TradeApiError('CART_RECOVERY_REQUIRED');
        const cart = await runtime.readCart();
        if (!unchanged()) return;
        if (!cart.canCheckout || cart.version !== selected.cartVersion || linesKey(cart.items) !== linesKey(selected.input.items)) {
          this.invalidateQuote(); this.setData({ checkoutError: '购物车已变化，请刷新并重新报价' }); return;
        }
        if (selected.input.deliveryType === 'delivery') {
          const pending = await runtime.addressEditor.getPending();
          if (!unchanged()) return;
          if (pending) throw new TradeApiError(pending.kind === 'remove' ? 'ADDRESS_DELETE_RECOVERY_REQUIRED' : 'ADDRESS_RECOVERY_REQUIRED');
          const address = addressView(await runtime.addressEditor.read(selected.input.addressId), selected.input.addressId);
          if (!unchanged()) return;
          if (address.version !== selected.addressVersion || addressFields.some(field => address[field] !== selected.address[field])) {
            this.invalidateQuote(); this.setData({ selectedAddress: address, checkoutError: '收货地址已变化，请重新报价确认' }); return;
          }
        }
        attempt = await store.prepare({ ...selected.input, requestId: runtime.newCheckoutRequestId() });
        if (!unchanged()) return;
        this.setData({ checkoutDraftTotal: (attempt.payload.expectedTotalCents / 100).toFixed(2) });
        // prepare会重新报价；任何逐行价格或费用变化都要再次人工确认，不能默默采用新金额。
        if (signature(attempt.quote) !== signature(selected.quote)) {
          this.invalidateQuote(); this.setData({ checkoutState: 'PREPARED', checkoutError: '价格或运费已变化，请重新预览并确认' }); return;
        }
        if (selected.input.deliveryType === 'delivery') {
          const address = addressView(await runtime.addressEditor.read(selected.input.addressId), selected.input.addressId);
          if (!unchanged()) return;
          if (address.version !== selected.addressVersion || addressFields.some(field => address[field] !== selected.address[field])) {
            this.invalidateQuote(); this.setData({ selectedAddress: address, checkoutState: 'PREPARED',
              checkoutError: '收货地址已变化，请重新报价确认' }); return;
          }
        }
        await runtime.assertIdentity();
        if (!unchanged()) return;
        const order = await attempt.submit();
        await runtime.assertIdentity();
        if (!current()) return;
        const placedOrder = orderView(order, attempt);
        this.invalidateQuote();
        this.setData({ checkoutState: 'CONFIRMED', placedOrder,
          checkoutError: attempt.getRecoveryStatus().storageWarning ? '订单已创建，本地确认记录保存失败；请保留订单号并核对原订单' : '' });
      } catch (error) {
        if (!current()) return;
        if (identityError(error)) {
          this.invalidateQuote(); this._selectedAddressId = null;
          this.setData({ selectedAddress: null, checkoutReady: false, checkoutState: 'BLOCKED', checkoutError: message(error) }); return;
        }
        if (['ADDRESS_NOT_FOUND', 'INVALID_ADDRESS', 'FORBIDDEN'].includes(error?.code)) {
          this.invalidateQuote(); this._selectedAddressId = null; this.setData({ selectedAddress: null, addressError: message(error) });
        }
        const state = attempt?.getRecoveryStatus().state;
        if (state) this.setData({ checkoutState: state });
        if (['REJECTED', 'SUBMITTING', 'UNCERTAIN'].includes(state)) this.invalidateQuote();
        this.setData({ checkoutError: message(error) });
      } finally {
        this._checkoutBusy = false;
        if (this._active) this.setData({ checkoutBusy: false });
      }
    },
    async retryCheckoutOrder() {
      if (!this._active || this._checkoutBusy || !this.data.checkoutReady
        || !unresolved(this.data.checkoutState)) return;
      const epoch = this._checkoutEpoch = (this._checkoutEpoch || 0) + 1;
      const current = () => this._active && this._checkoutEpoch === epoch;
      this._checkoutBusy = true; this.setData({ checkoutBusy: true, checkoutError: '' });
      let attempt = null;
      try {
        const store = await recovery(); attempt = await store.restore();
        if (!current()) return;
        const state = attempt?.getRecoveryStatus().state;
        if (!attempt || (!unresolved(state) && state !== 'CONFIRMED')) throw new TradeApiError('STALE_CHECKOUT_DRAFT');
        const order = await attempt.retry();
        await runtime.assertIdentity();
        if (!current()) return;
        const placedOrder = orderView(order, attempt);
        this.invalidateQuote(); this.setData({ checkoutState: 'CONFIRMED', placedOrder,
          checkoutError: attempt.getRecoveryStatus().storageWarning ? '订单已创建，本地确认记录保存失败；请保留订单号并核对原订单' : '' });
      } catch (error) {
        if (current()) {
          if (identityError(error)) {
            this.invalidateQuote(); this._selectedAddressId = null;
            this.setData({ selectedAddress: null, checkoutReady: false, checkoutState: 'BLOCKED', checkoutError: message(error) });
          } else {
            if (attempt?.getRecoveryStatus().state === 'REJECTED') this.invalidateQuote();
            this.setData({ checkoutState: attempt?.getRecoveryStatus().state || this.data.checkoutState, checkoutError: message(error) });
          }
        }
      } finally {
        this._checkoutBusy = false;
        if (this._active) this.setData({ checkoutBusy: false });
      }
    }
  };
}
module.exports = { createCheckoutSubmission };

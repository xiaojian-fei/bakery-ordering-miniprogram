'use strict';
const { TradeApiError } = require('./trade-errors');
const money = cents => (cents / 100).toFixed(2);
const notice = '新接口接入中：商品和购物车可用，结算及订单页待接入。';
function productView(item) {
  return { ...item, price: money(item.priceCents), emoji: item.category.includes('膏') ? '🍯' : '🍪',
    hasImage: typeof item.image === 'string' && /^(https:\/\/|cloud:\/\/|\/images\/)/.test(item.image) };
}
const errorText = error => error instanceof TradeApiError ? error.message : '加载或操作失败，请重试';
function deactivate(page) { page._active = false; page._epoch = (page._epoch || 0) + 1; }
function applyCount(app, cart) {
  const count = cart.items.reduce((total, item) => total + item.quantity, 0);
  app.globalData.cartCount = count; app.notifyTabBarUpdate(count);
}
function base({ runtime, wx, app }) {
  return {
    onHide() { deactivate(this); }, onUnload() { deactivate(this); },
    async addToCart(event) {
      if (this._adding) return;
      const id = event?.currentTarget?.dataset?.id || this.data.id;
      if (!id) return;
      this._adding = true; this.setData({ cartBusy: true });
      try {
        const result = await runtime.addProduct(id); applyCount(app, result);
        if (this._active) wx.showToast({ title: '已加入购物车', icon: 'success' });
      } catch (error) {
        if (this._active) wx.showToast({ title: errorText(error), icon: 'none' });
      } finally {
        this._adding = false;
        if (this._active) this.setData({ cartBusy: false, cartWritePending: runtime.hasPendingCartWrite() });
      }
    },
    async retryCartWrite() {
      if (this._adding) return;
      this._adding = true; this.setData({ cartBusy: true });
      try {
        const result = await runtime.retryCartWrite(); applyCount(app, result);
        if (this._active) wx.showToast({ title: '已确认上次修改', icon: 'success' });
      } catch (error) {
        if (this._active) wx.showToast({ title: errorText(error), icon: 'none' });
      } finally {
        this._adding = false;
        if (this._active) this.setData({ cartBusy: false, cartWritePending: runtime.hasPendingCartWrite() });
      }
    },
    goToAdmin() { wx.showToast({ title: '管理页尚未接入新接口', icon: 'none' }); },
    goToOrder() { wx.showToast({ title: '结算页尚未接入新接口', icon: 'none' }); },
    makePhoneCall(event) {
      const value = event.currentTarget.dataset.phone;
      if (typeof value === 'string' && value) wx.makePhoneCall({ phoneNumber: value });
    },
    copyWechat(event) {
      const value = event.currentTarget.dataset.wechat;
      if (typeof value === 'string' && value) wx.setClipboardData({ data: value });
    }
  };
}

function createCatalogPage(dependencies) {
  const { runtime, wx, app } = dependencies;
  return {
    ...base(dependencies),
    data: { unifiedMode: true, runtimeNotice: notice, products: [], loading: false, loadingMore: false,
      error: '', keyword: '', cursor: null, cartBusy: false, cartWritePending: false,
      categories: ['全部', '冰乳酪司康', '酥性饼干', '养生膏体'], currentCategory: '全部',
      shopInfo: { address: '', wechatList: [], phoneList: [], deliveryTimeList: [] }, banners: [] },
    onLoad() {},
    async onShow() {
      this._active = true; this.setData({ cartBusy: Boolean(this._adding), cartWritePending: runtime.hasPendingCartWrite() });
      return Promise.all([this.loadProducts(), this.loadShopInfo(),
        app.updateCartCount().catch(() => {})]);
    },
    onCategoryChange(event) {
      this.setData({ currentCategory: event.currentTarget.dataset.category });
      return this.loadProducts();
    },
    onSearchInput(event) { this.setData({ keyword: event.detail.value }); },
    onSearchConfirm() { return this.loadProducts(); },
    async loadProducts(more = false) {
      if (!this._active || (more && (this.data.loading || this.data.loadingMore || !this.data.cursor))) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      const category = this.data.currentCategory, keyword = this.data.keyword.trim();
      const cursor = more ? this.data.cursor : null;
      this.setData(more ? { loadingMore: true, error: '' }
        : { loading: true, loadingMore: false, products: [], cursor: null, error: '' });
      try {
        await runtime.assertIdentity();
        const result = await runtime.client.catalog.list({ limit: 20,
          ...(category !== '全部' ? { category } : {}), ...(keyword ? { keyword } : {}), ...(cursor ? { cursor } : {}) });
        if (!this._active || this._epoch !== epoch) return;
        const items = (more ? this.data.products : []).concat(result.items.map(productView));
        this.setData({ products: [...new Map(items.map(item => [item._id, item])).values()], cursor: result.nextCursor });
      } catch (error) {
        if (this._active && this._epoch === epoch) this.setData({ error: errorText(error) });
      } finally {
        if (this._active && this._epoch === epoch) this.setData({ loading: false, loadingMore: false });
      }
    },
    loadMore() { return this.loadProducts(true); },
    async loadShopInfo() {
      const epoch = this._shopEpoch = (this._shopEpoch || 0) + 1;
      try {
        await runtime.assertIdentity();
        const shop = await runtime.client.shop.get();
        if (!this._active || this._shopEpoch !== epoch) return;
        this.setData({ shopInfo: { address: shop.address, wechatList: shop.wechat ? [shop.wechat] : [],
          phoneList: shop.phone ? [shop.phone] : [], deliveryTimeList: shop.deliveryNote ? [shop.deliveryNote] : [] }, banners: shop.banners });
      } catch (_) { /* 商品区仍可独立加载；不显示原始接口异常。 */ }
    },
    goDetail(event) {
      const id = event.currentTarget.dataset.id;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
    }
  };
}

function createDetailPage(dependencies) {
  const { runtime, wx } = dependencies;
  return {
    ...base(dependencies),
    data: { unifiedMode: true, runtimeNotice: notice, product: null, id: '', loading: false, error: '', cartBusy: false, cartWritePending: false },
    onLoad(options = {}) { this.setData({ id: options.id || '' }); },
    onShow() {
      this._active = true; this.setData({ cartBusy: Boolean(this._adding), cartWritePending: runtime.hasPendingCartWrite() });
      return this.loadProduct();
    },
    async loadProduct() {
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '', product: null });
      try {
        await runtime.assertIdentity();
        const product = await runtime.client.catalog.get(this.data.id);
        if (this._active && this._epoch === epoch) this.setData({ product: productView(product) });
      } catch (error) {
        if (this._active && this._epoch === epoch) this.setData({ error: errorText(error) });
      } finally {
        if (this._active && this._epoch === epoch) this.setData({ loading: false });
      }
    }
  };
}

function createCartPage(dependencies) {
  const { runtime, wx, app } = dependencies;
  return {
    ...base(dependencies),
    data: { unifiedMode: true, runtimeNotice: notice, cartItems: [], totalPrice: '0.00', version: 0,
      loading: false, cartBusy: false, cartWritePending: false, error: '', canCheckout: false },
    onShow() { this._active = true; this.setData({ cartBusy: Boolean(this._adding) }); return this.loadCart(); },
    async loadCart() {
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '', cartWritePending: runtime.hasPendingCartWrite() });
      try {
        const cart = await runtime.readCart();
        if (!this._active || this._epoch !== epoch) return;
        applyCount(app, cart);
        this.setData({ version: cart.version, cartItems: cart.items.map(item => ({ ...item,
          price: item.unitPriceCents === null ? '—' : money(item.unitPriceCents), emoji: '🛒',
          issueText: item.issue ? errorText(new TradeApiError(item.issue)) : '' })),
        totalPrice: money(cart.estimatedSubtotalCents), canCheckout: cart.canCheckout });
      } catch (error) {
        if (this._active && this._epoch === epoch) this.setData({ error: errorText(error), canCheckout: false });
      } finally {
        if (this._active && this._epoch === epoch) this.setData({ loading: false });
      }
    },
    async changeQuantity(event) {
      if (this._adding || this.data.loading) return;
      const { id, op } = event.currentTarget.dataset;
      const item = this.data.cartItems.find(row => row.productId === id);
      if (!item || !['plus', 'minus'].includes(op)) return;
      const quantity = item.quantity + (op === 'plus' ? 1 : -1);
      this._adding = true; this.setData({ cartBusy: true });
      try {
        const cart = await runtime.setCartQuantity({ productId: id, quantity, expectedVersion: this.data.version });
        applyCount(app, cart);
      } catch (error) {
        if (this._active) wx.showToast({ title: errorText(error), icon: 'none' });
      } finally {
        this._adding = false;
        if (this._active) { this.setData({ cartBusy: false }); await this.loadCart(); }
      }
    },
    async retryCartWrite() {
      await base(dependencies).retryCartWrite.call(this);
      if (this._active) await this.loadCart();
    }
  };
}
module.exports = { createCatalogPage, createDetailPage, createCartPage };

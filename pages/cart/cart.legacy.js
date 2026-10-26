// pages/cart/cart.js
const db = wx.cloud.database();

module.exports = {
  data: {
    cartItems: [],
    totalPrice: '0.00',
    deliveryType: 'pickup',
    selectedAddress: null,
    openid: ''
  },

  onShow() {
    this.init();
  },

  async init() {
    const openid = getApp().globalData.openid;
    if (!openid) {
      wx.showToast({ title: '请稍后重试', icon: 'none' });
      return;
    }
    this.setData({ openid });
    await this.loadCart();
    await this.loadDefaultAddress();
  },

  async loadCart() {
    try {
      const res = await db.collection('carts').where({ openid: this.data.openid }).get();
      const cart = res.data[0];
      const items = cart ? cart.items : [];
      this.setData({ cartItems: items });
      this.calcTotal();
    } catch (err) {
      console.error('加载购物车失败', err);
    }
  },

  calcTotal() {
    let total = 0;
    this.data.cartItems.forEach(item => {
      const price = Number(item.price);
      const qty = Number(item.quantity);
      if (!isNaN(price) && !isNaN(qty)) {
        total += price * qty;
      }
    });
    this.setData({ totalPrice: total.toFixed(2) });
  },

  async changeQuantity(e) {
    const { id, op } = e.currentTarget.dataset;
    let items = [...this.data.cartItems];
    const index = items.findIndex(i => i.productId === id);
    if (index === -1) return;

    if (op === 'plus') {
      items[index].quantity += 1;
    } else {
      items[index].quantity -= 1;
      if (items[index].quantity <= 0) items.splice(index, 1);
    }
    this.setData({ cartItems: items });
    this.calcTotal();

    await db.collection('carts').where({ openid: this.data.openid }).update({
      data: { items, updatedAt: new Date() }
    });
    const app = getApp();
    await app.updateCartCount();
  },

  onDeliveryTypeChange(e) {
    this.setData({ deliveryType: e.detail.value });
    if (e.detail.value === 'delivery' && !this.data.selectedAddress) {
      this.loadDefaultAddress();
    }
  },

  async loadDefaultAddress() {
    try {
      const res = await db.collection('addresses').where({
        openid: this.data.openid,
        isDefault: true
      }).get();
      if (res.data.length) {
        this.setData({ selectedAddress: res.data[0] });
      }
    } catch (err) {
      console.error('加载默认地址失败', err);
    }
  },

  selectAddress() {
    wx.navigateTo({
      url: '/pages/address/address?selectMode=true',
      events: {
        addressSelected: (data) => {
          this.setData({ selectedAddress: data });
        }
      }
    });
  },

  goToOrder() {
    if (this.data.deliveryType === 'delivery' && !this.data.selectedAddress) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' });
      return;
    }
    if (this.data.cartItems.length === 0) {
      wx.showToast({ title: '购物车为空', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/order/order',
      success: (res) => {
        res.eventChannel.emit('orderData', {
          items: this.data.cartItems,
          totalPrice: this.data.totalPrice,
          deliveryType: this.data.deliveryType,
          address: this.data.selectedAddress
        });
      }
    });
  },

  async clearCart() {
    await db.collection('carts').where({ openid: this.data.openid }).update({
      data: { items: [] }
    });
    this.setData({ cartItems: [], totalPrice: '0.00' });
    const app = getApp();
    await app.updateCartCount();
  },

  async submitOrder() {
    this.goToOrder();
  }
};

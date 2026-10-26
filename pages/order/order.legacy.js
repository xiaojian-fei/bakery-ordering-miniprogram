// pages/order/order.js
const db = wx.cloud.database();

// 北方省份列表（可根据需要调整）
const northernProvinces = [
  '黑龙江', '吉林', '辽宁', '内蒙古', '河北', '北京', '天津', '山西',
];

module.exports = {
  data: {
    items: [],
    originalTotal: 0,      // 商品原总价
    totalPrice: 0,         // 最终总价（含运费）
    deliveryType: '',
    address: null,
    remark: '',
    shippingFee: 0,        // 运费金额
    showShippingTip: false, // 运费规则弹窗
    // 支付码相关
    showPaymentModal: false,
    paymentCodeUrl: '',
    orderNo: ''
  },

  onLoad() {
    const eventChannel = this.getOpenerEventChannel();
    eventChannel.on('orderData', (data) => {
      const originalTotal = Number(data.totalPrice);
      this.setData({
        items: data.items,
        originalTotal: originalTotal,
        deliveryType: data.deliveryType,
        address: data.address
      });
      this.calcShippingFee();
    });
  },

  // 计算运费
  calcShippingFee() {
    const { deliveryType, address, originalTotal } = this.data;
    if (deliveryType !== 'delivery' || !address || !address.province) {
      this.setData({ shippingFee: 0, totalPrice: originalTotal });
      return;
    }

    const province = address.province;
    const isNorthern = northernProvinces.some(p => province.includes(p));
    let fee = 0;
    let threshold = isNorthern ? 88 : 108;
    const total = Number(originalTotal);
    if (total < threshold) {
      fee = isNorthern ? 10 : 13;
    }
    this.setData({
      shippingFee: fee,
      totalPrice: total + fee
    });
  },

  // 显示运费规则弹窗
  showShippingTip() {
    this.setData({ showShippingTip: true });
  },

  closeShippingTip() {
    this.setData({ showShippingTip: false });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  async submitOrder() {
    if (this.data.deliveryType === 'delivery' && !this.data.address) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' });
      return;
    }
    if (this.data.items.length === 0) {
      wx.showToast({ title: '购物车为空', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中' });
    try {
      const result = await wx.cloud.callFunction({
        name: 'createorder',
        data: {
          items: this.data.items,
          totalPrice: this.data.totalPrice,
          originalTotal: this.data.originalTotal,
          shippingFee: this.data.shippingFee,
          deliveryType: this.data.deliveryType,
          address: this.data.address,
          remark: this.data.remark
        }
      });

      if (result.result.success) {
        this.setData({ orderNo: result.result.orderNo });
        wx.hideLoading();

        // 加载支付码并弹出弹窗
        await this.loadPaymentCode();
        this.openPaymentModal();

        // 清空购物车
        const pages = getCurrentPages();
        const cartPage = pages.find(p => p.route === 'pages/cart/cart');
        if (cartPage && cartPage.clearCart) {
          await cartPage.clearCart();
        }
        const app = getApp();
        await app.updateCartCount();
      } else {
        wx.hideLoading();
        wx.showToast({ title: result.result.error || '下单失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('提交订单失败', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
    }
  },

  // 加载支付码
  async loadPaymentCode() {
    try {
      const res = await db.collection('payment_config').doc('payment_code').get();
      this.setData({ paymentCodeUrl: res.data.imageUrl || '' });
    } catch (err) {
      console.error('加载支付码失败', err);
    }
  },

  openPaymentModal() {
    this.setData({ showPaymentModal: true });
  },

  closePaymentModal() {
    this.setData({ showPaymentModal: false });
    wx.showModal({
      title: '提示',
      content: '订单已创建，您可以在订单列表中继续支付',
      showCancel: false,
      success: () => {
        wx.switchTab({ url: '/pages/orders/orders' });
      }
    });
  },

  previewPaymentCode() {
    if (this.data.paymentCodeUrl) {
      wx.previewImage({
        urls: [this.data.paymentCodeUrl],
        current: this.data.paymentCodeUrl
      });
    }
  },

  confirmPayment() {
    const orderNo = this.data.orderNo;
    if (!orderNo) {
      wx.showToast({ title: '订单信息错误', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '处理中' });
    db.collection('orders').where({ orderNo }).update({
      data: { status: '待确认' }
    }).then(res => {
      if (res.stats && res.stats.updated === 1) {
        wx.showToast({ title: '已通知商家', icon: 'success' });
        this.setData({ showPaymentModal: false });
        setTimeout(() => {
          wx.switchTab({ url: '/pages/orders/orders' });
        }, 1500);
      } else {
        wx.showToast({ title: '订单更新失败', icon: 'none' });
      }
    }).catch(err => {
      console.error('更新订单失败', err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }).finally(() => {
      wx.hideLoading();
    });
  }
};

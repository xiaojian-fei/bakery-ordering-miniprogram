// pages/pay/pay.js
const db = wx.cloud.database();

module.exports = {
  data: {
    order: null,
    paymentCodeUrl: '',
    totalPrice: 0
  },

  onLoad() {
    const order = wx.getStorageSync('continuePayOrder');
    if (order) {
      this.setData({ order, totalPrice: order.totalPrice });
      this.loadPaymentCode();
    } else {
      wx.showToast({ title: '订单不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    }
  },

  async loadPaymentCode() {
    try {
      const res = await db.collection('payment_config').doc('payment_code').get();
      this.setData({ paymentCodeUrl: res.data.imageUrl || '' });
    } catch (err) {
      console.error('加载支付码失败', err);
    }
  },

  previewPaymentCode() {
    if (this.data.paymentCodeUrl) {
      wx.previewImage({
        urls: [this.data.paymentCodeUrl],
        current: this.data.paymentCodeUrl
      });
    }
  },

 // 在 pages/pay/pay.js 中，替换 confirmPayment 方法
async confirmPayment() {
  const order = this.data.order;
  if (!order || !order._id) {
    wx.showToast({ title: '订单信息错误', icon: 'none' });
    return;
  }
  wx.showLoading({ title: '处理中' });
  try {
    const res = await db.collection('orders').doc(order._id).update({
      data: { status: '待确认' }
    });
    if (res.stats && res.stats.updated === 1) {
      // 改用 wx.showModal 确保文字完整显示
      wx.showModal({
        title: '支付成功',
        content: '您已完成付款，待商家确认中',
        showCancel: false,
        success: () => {
          wx.removeStorageSync('continuePayOrder');
          setTimeout(() => {
            wx.switchTab({ url: '/pages/orders/orders' });
          }, 500);
        }
      });
    } else {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  } catch (err) {
    console.error(err);
    wx.showToast({ title: '操作失败', icon: 'none' });
  } finally {
    wx.hideLoading();
  }
},

  cancelPay() {
    wx.navigateBack();
  }
};

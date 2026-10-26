// pages/orders/orders.js
const db = wx.cloud.database();

module.exports = {
  data: {
    orders: []
  },

  onShow() {
    this.loadOrders();
  },

  async loadOrders() {
    const openid = getApp().globalData.openid;
    if (!openid) {
      wx.showToast({ title: '请稍后重试', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '加载中' });
    try {
      const res = await db.collection('orders')
        .where({ openid })
        .orderBy('createTime', 'desc')
        .get();
      // 格式化时间
      const orders = res.data.map(order => ({
        ...order,
        createTime: this.formatDateTime(order.createTime)
      }));
      this.setData({ orders });
    } catch (err) {
      console.error('加载订单失败', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  formatDateTime(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const hour = d.getHours().toString().padStart(2, '0');
    const minute = d.getMinutes().toString().padStart(2, '0');
    const second = d.getSeconds().toString().padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  },

  // 继续支付（仅当状态为待支付或待处理时显示）
  continuePay(e) {
    const order = e.currentTarget.dataset.order;
    wx.setStorageSync('continuePayOrder', order);
    wx.navigateTo({
      url: '/pages/pay/pay'
    });
  },

  // 取消订单
  async cancelOrder(e) {
    const order = e.currentTarget.dataset.order;
    wx.showModal({
      title: '提示',
      content: '确定要取消该订单吗？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中' });
          try {
            await db.collection('orders').doc(order._id).update({
              data: { status: '已取消' }
            });
            wx.showToast({ title: '订单已取消', icon: 'success' });
            this.loadOrders(); // 刷新列表
          } catch (err) {
            console.error('取消订单失败', err);
            wx.showToast({ title: '操作失败', icon: 'none' });
          } finally {
            wx.hideLoading();
          }
        }
      }
    });
  }
};

// pages/admin/admin.js
const db = wx.cloud.database();

module.exports = {
  data: {
    activeTab: 'orders',
    orders: [],
    products: [],
    todayTotal: 0,
    todayCount: 0,
    monthTotal: 0,
    totalOrders: 0,
    statusFilter: 'all',
    // 订单数量统计
    countPendingPay: 0,
    countPendingConfirm: 0,
    countConfirmed: 0,
    countCompleted: 0,
    countCancelled: 0,
    shopInfo: {
      address: '',
      wechatList: ['', ''],
      phoneList: ['', ''],
      deliveryTimeList: ['', '', '']
    },
    editShopInfo: {
      address: '',
      wechatList: ['', ''],
      phoneList: ['', ''],
      deliveryTimeList: ['', '', '']
    },
    showShopEditModal: false,
    paymentCodeUrl: '',
    banners: [],
    editBanners: [],
    showBannersModal: false
  },

  onLoad() {
    const isLogin = wx.getStorageSync('adminLogin');
    if (!isLogin) {
      wx.redirectTo({ url: '/pages/admin-login/admin-login' });
      return;
    }
    this.loadOrders();
    this.loadProducts();
    this.loadShopInfo();
    this.loadPaymentCode();
    this.loadBanners();
  },

  onShow() {
    if (this.data.activeTab === 'products') {
      this.loadProducts();
    }
    if (this.data.activeTab === 'shop') {
      this.loadShopInfo();
      this.loadBanners();
    }
    if (this.data.activeTab === 'payment') {
      this.loadPaymentCode();
    }
    if (this.data.activeTab === 'orders') {
      this.loadOrders();
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });
    if (tab === 'orders') {
      this.loadOrders();
    } else if (tab === 'products') {
      this.loadProducts();
    } else if (tab === 'shop') {
      this.loadShopInfo();
      this.loadBanners();
    } else if (tab === 'payment') {
      this.loadPaymentCode();
    }
  },

  async loadOrders() {
    wx.showLoading({ title: '加载中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getallorders' });
      if (!res.result || !res.result.success) {
        wx.showToast({ title: res.result?.error || '加载失败', icon: 'none' });
        return;
      }
      let orders = res.result.data;
      orders = orders.map(order => ({
        ...order,
        createTime: this.formatDateTime(order.createTime)
      }));

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayOrders = orders.filter(o => new Date(o.createTime) >= todayStart);
      const todayTotal = todayOrders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthOrders = orders.filter(o => new Date(o.createTime) >= monthStart);
      const monthTotal = monthOrders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);

      // 统计各状态订单数量
      const countPendingPay = orders.filter(o => o.status === '待支付' || o.status === '待处理').length;
      const countPendingConfirm = orders.filter(o => o.status === '待确认').length;
      const countConfirmed = orders.filter(o => o.status === '已确认').length;
      const countCompleted = orders.filter(o => o.status === '已完成').length;
      const countCancelled = orders.filter(o => o.status === '已取消').length;

      if (this.data.statusFilter !== 'all') {
        orders = orders.filter(o => o.status === this.data.statusFilter);
      }

      this.setData({
        orders,
        todayTotal: todayTotal.toFixed(2),
        todayCount: todayOrders.length,
        monthTotal: monthTotal.toFixed(2),
        totalOrders: res.result.data.length,
        countPendingPay,
        countPendingConfirm,
        countConfirmed,
        countCompleted,
        countCancelled
      });
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '加载订单失败', icon: 'none' });
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

  async updateOrderStatus(e) {
    const { id, currentStatus } = e.currentTarget.dataset;
    let newStatus = '';
    if (currentStatus === '待支付' || currentStatus === '待处理') {
      newStatus = '已确认';
    } else if (currentStatus === '待确认') {
      newStatus = '已确认';
    } else if (currentStatus === '已确认') {
      newStatus = '已完成';
    } else {
      wx.showToast({ title: '订单已完成或已取消，不可修改', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认',
      content: `将订单状态从“${currentStatus}”改为“${newStatus}”？`,
      success: async (res) => {
        if (res.confirm) {
          await db.collection('orders').doc(id).update({ data: { status: newStatus } });
          wx.showToast({ title: '更新成功', icon: 'success' });
          this.loadOrders();
        }
      }
    });
  },

  onFilterChange(e) {
    const filter = e.currentTarget.dataset.filter;
    this.setData({ statusFilter: filter }, () => this.loadOrders());
  },

  async loadProducts() {
    try {
      const res = await db.collection('products').get();
      let products = res.data;
      products = products.map(p => ({
        ...p,
        emoji: p.category === '冰乳酪司康' ? '🍪' : (p.category === '酥性饼干' ? '🍪' : '🍯')
      }));
      this.setData({ products });
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '加载商品失败', icon: 'none' });
    }
  },

  async deleteProduct(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认删除',
      content: `确定要删除商品“${name}”吗？`,
      success: async (res) => {
        if (res.confirm) {
          await db.collection('products').doc(id).remove();
          wx.showToast({ title: '删除成功', icon: 'success' });
          this.loadProducts();
        }
      }
    });
  },

  editProduct(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/product-edit/product-edit${id ? `?id=${id}` : ''}` });
  },

  async toggleSale(e) {
    const { id, current } = e.currentTarget.dataset;
    await db.collection('products').doc(id).update({
      data: { isOnSale: !current }
    });
    wx.showToast({ title: !current ? '已上架' : '已下架', icon: 'success' });
    this.loadProducts();
  },

  async loadShopInfo() {
    try {
      const res = await db.collection('shop_config').doc('shop_info').get();
      const data = res.data;
      let wechatList = data.wechatList;
      let phoneList = data.phoneList;
      let deliveryTimeList = data.deliveryTimeList;
      if (!wechatList || wechatList.length === 0) {
        if (data.wechat) wechatList = [data.wechat, ''];
        else wechatList = ['', ''];
      }
      if (!phoneList || phoneList.length === 0) {
        if (data.phone) phoneList = [data.phone, ''];
        else phoneList = ['', ''];
      }
      if (!deliveryTimeList || deliveryTimeList.length === 0) {
        if (data.deliveryTime) deliveryTimeList = [data.deliveryTime, '', ''];
        else deliveryTimeList = ['', '', ''];
      }
      while (wechatList.length < 2) wechatList.push('');
      while (phoneList.length < 2) phoneList.push('');
      while (deliveryTimeList.length < 3) deliveryTimeList.push('');
      this.setData({
        shopInfo: {
          address: data.address || '',
          wechatList,
          phoneList,
          deliveryTimeList
        }
      });
    } catch (err) {
      console.error('加载店铺信息失败', err);
      if (err.errMsg && err.errMsg.includes('cannot find document')) {
        wx.showModal({
          title: '提示',
          content: '请在云开发控制台创建 shop_config 集合，并添加 _id 为 shop_info 的文档',
          showCancel: false
        });
      }
    }
  },

  openShopEditModal() {
    this.setData({
      editShopInfo: {
        address: this.data.shopInfo.address,
        wechatList: [...this.data.shopInfo.wechatList],
        phoneList: [...this.data.shopInfo.phoneList],
        deliveryTimeList: [...this.data.shopInfo.deliveryTimeList]
      },
      showShopEditModal: true
    });
  },

  closeShopEditModal() {
    this.setData({ showShopEditModal: false });
  },

  onShopAddressInput(e) { this.setData({ 'editShopInfo.address': e.detail.value }); },
  onWechat1Input(e) { this.setData({ 'editShopInfo.wechatList[0]': e.detail.value }); },
  onWechat2Input(e) { this.setData({ 'editShopInfo.wechatList[1]': e.detail.value }); },
  onPhone1Input(e) { this.setData({ 'editShopInfo.phoneList[0]': e.detail.value }); },
  onPhone2Input(e) { this.setData({ 'editShopInfo.phoneList[1]': e.detail.value }); },
  onDeliveryTime1Input(e) { this.setData({ 'editShopInfo.deliveryTimeList[0]': e.detail.value }); },
  onDeliveryTime2Input(e) { this.setData({ 'editShopInfo.deliveryTimeList[1]': e.detail.value }); },
  onDeliveryTime3Input(e) { this.setData({ 'editShopInfo.deliveryTimeList[2]': e.detail.value }); },

  async saveShopInfo() {
    const { address, wechatList, phoneList, deliveryTimeList } = this.data.editShopInfo;
    if (!address || wechatList.every(v => !v) || phoneList.every(v => !v) || deliveryTimeList.every(v => !v)) {
      wx.showToast({ title: '请至少填写一项微信号、电话和配送时间', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '保存中' });
    try {
      await db.collection('shop_config').doc('shop_info').update({
        data: { address, wechatList, phoneList, deliveryTimeList, updateTime: new Date() }
      });
      this.setData({
        shopInfo: { address, wechatList, phoneList, deliveryTimeList },
        showShopEditModal: false
      });
      wx.showToast({ title: '保存成功', icon: 'success' });
    } catch (err) {
      console.error('保存店铺信息失败', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async loadBanners() {
    try {
      const res = await db.collection('shop_config').doc('shop_info').get();
      const banners = res.data.banners || [];
      this.setData({ banners });
    } catch (err) {
      console.error('加载轮播图失败', err);
    }
  },

  openBannersModal() {
    this.setData({
      editBanners: [...this.data.banners],
      showBannersModal: true
    });
  },

  closeBannersModal() {
    this.setData({ showBannersModal: false });
  },

  chooseBannerImage() {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        this.uploadBannerImage(tempFilePath);
      }
    });
  },

  async uploadBannerImage(filePath) {
    wx.showLoading({ title: '上传中' });
    try {
      const cloudPath = `banners/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath
      });
      const newBanners = [...this.data.editBanners, uploadRes.fileID];
      this.setData({ editBanners: newBanners });
      wx.showToast({ title: '上传成功', icon: 'success' });
    } catch (err) {
      console.error('上传失败', err);
      wx.showToast({ title: '上传失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  deleteBannerImage(e) {
    const index = e.currentTarget.dataset.index;
    const newBanners = [...this.data.editBanners];
    newBanners.splice(index, 1);
    this.setData({ editBanners: newBanners });
  },

  async saveBanners() {
    wx.showLoading({ title: '保存中' });
    try {
      await db.collection('shop_config').doc('shop_info').update({
        data: { banners: this.data.editBanners, updateTime: new Date() }
      });
      this.setData({
        banners: this.data.editBanners,
        showBannersModal: false
      });
      wx.showToast({ title: '保存成功', icon: 'success' });
    } catch (err) {
      console.error('保存轮播图失败', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
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

  uploadPaymentCode() {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const tempFilePath = res.tempFilePaths[0];
        wx.showLoading({ title: '上传中...' });
        try {
          const cloudPath = `payment_code/${Date.now()}.jpg`;
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath,
            filePath: tempFilePath
          });
          await db.collection('payment_config').doc('payment_code').set({
            data: {
              imageUrl: uploadRes.fileID,
              updateTime: new Date()
            }
          });
          this.setData({ paymentCodeUrl: uploadRes.fileID });
          wx.showToast({ title: '上传成功', icon: 'success' });
        } catch (err) {
          console.error('上传失败', err);
          wx.showToast({ title: '上传失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
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

  logout() {
    wx.showModal({
      title: '提示',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('adminLogin');
          wx.removeStorageSync('adminAccount');
          wx.redirectTo({ url: '/pages/admin-login/admin-login' });
        }
      }
    });
  },

  onPullDownRefresh() {
    if (this.data.activeTab === 'orders') {
      this.loadOrders().then(() => wx.stopPullDownRefresh());
    } else if (this.data.activeTab === 'products') {
      this.loadProducts().then(() => wx.stopPullDownRefresh());
    } else if (this.data.activeTab === 'shop') {
      Promise.all([this.loadShopInfo(), this.loadBanners()]).then(() => wx.stopPullDownRefresh());
    } else if (this.data.activeTab === 'payment') {
      this.loadPaymentCode().then(() => wx.stopPullDownRefresh());
    }
  }
};

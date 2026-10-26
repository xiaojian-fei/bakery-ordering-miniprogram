// pages/index/index.js
const db = wx.cloud.database();

module.exports = {
  data: {
    products: [],
    shopInfo: {
      address: '',
      wechatList: ['', ''],
      phoneList: ['', ''],
      deliveryTimeList: ['', '', '']
    },
    banners: [],
    categories: ['冰乳酪司康', '酥性饼干', '养生膏体'],
    currentCategory: '冰乳酪司康'
  },

  onLoad() {
    this.loadProducts();
    this.loadShopInfo();
    this.showShopIntro();
  },

  onShow() {
    this.loadProducts();
    this.loadShopInfo();
    const tabBar = this.getTabBar();
    if (tabBar) tabBar.updateCartCount();
  },

  showShopIntro() {
    const hasShown = wx.getStorageSync('hasShownShopIntro');
    if (!hasShown) {
      wx.showModal({
        title: '欢迎光临',
        content: '各位小主！欢迎来到面包脑袋爱包包滴店铺喔~从热爱出发，以品质坚守，我们坚持选用新鲜食材，手工制作每一份甜蜜。愿每一口甜都能治愈你的疲惫，点亮平凡日常里的小美好。',
        showCancel: false,
        confirmText: '确定',
        success: () => {
          wx.setStorageSync('hasShownShopIntro', true);
        }
      });
    }
  },

  onCategoryChange(e) {
    const category = e.currentTarget.dataset.category;
    this.setData({ currentCategory: category });
    this.loadProducts();
  },

  async loadProducts() {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getproducts' });
      if (res.result.success) {
        let products = res.result.data;
        // 过滤下架商品
        products = products.filter(p => p.isOnSale !== false);
        // 按当前分类筛选
        products = products.filter(p => p.category === this.data.currentCategory);
        // 招牌商品优先排序（true 在前）
        products.sort((a, b) => (b.isFeatured === true) - (a.isFeatured === true));
        // 添加展示字段
        products = products.map(p => ({
          ...p,
          emoji: p.category === '冰乳酪司康' ? '🍪' : (p.category === '酥性饼干' ? '🍪' : '🍯'),
          image: p.image || '',
          hasImage: typeof p.image === 'string' && /^(https?:\/\/|cloud:\/\/|\/images\/)/.test(p.image),
          isFeatured: p.isFeatured === true,
          monthSales: p.monthSales || 0
        }));
        this.setData({ products });
      } else {
        wx.showToast({ title: res.result.error || '加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('加载商品失败', err);
      wx.showToast({ title: '网络错误，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
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
        },
        banners: data.banners || []
      });
    } catch (err) {
      console.error('加载店铺信息失败', err);
    }
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  async addToCart(e) {
    const product = e.currentTarget.dataset.item;
    const openid = getApp().globalData.openid;
    if (!openid) {
      wx.showToast({ title: '请稍后重试', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '添加中' });
    try {
      const cartRes = await db.collection('carts').where({ openid }).get();
      let cart = cartRes.data[0];
      if (!cart) {
        await db.collection('carts').add({
          data: {
            openid,
            items: [{
              productId: product._id,
              name: product.name,
              price: Number(product.price),
              quantity: 1,
              emoji: product.emoji,
              image: product.image,
              isFeatured: product.isFeatured,
              monthSales: product.monthSales
            }],
            updatedAt: new Date()
          }
        });
      } else {
        const items = cart.items;
        const idx = items.findIndex(i => i.productId === product._id);
        if (idx !== -1) {
          items[idx].quantity += 1;
        } else {
          items.push({
            productId: product._id,
            name: product.name,
            price: Number(product.price),
            quantity: 1,
            emoji: product.emoji,
            image: product.image,
            isFeatured: product.isFeatured,
            monthSales: product.monthSales
          });
        }
        await db.collection('carts').doc(cart._id).update({
          data: { items, updatedAt: new Date() }
        });
      }
      wx.showToast({ title: '已加入购物车', icon: 'success' });
      const app = getApp();
      await app.updateCartCount();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '添加失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  makePhoneCall(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) {
      wx.makePhoneCall({ phoneNumber: phone });
    }
  },

  copyWechat(e) {
    const wechat = e.currentTarget.dataset.wechat;
    if (wechat) {
      wx.setClipboardData({
        data: wechat,
        success: () => {
          wx.showToast({ title: '微信号已复制', icon: 'success' });
        },
        fail: () => {
          wx.showToast({ title: '复制失败', icon: 'none' });
        }
      });
    }
  },

  goToAdmin() {
    wx.navigateTo({ url: '/pages/admin-login/admin-login' });
  }
};

// app.js
const tradeRuntime = require('./services/miniapp-config');
App({
  tradeRuntime,
  onLaunch() {
    this.globalData.tabBarInstances = [];
    if (this.tradeRuntime) {
      // 新模式只通过统一客户端访问数据，不初始化或降级到旧云数据库。
      return this.getUserOpenId();
    }
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上基础库');
      return;
    } else {
      wx.cloud.init({
        env: 'YOUR_CLOUD_ENV_ID', // 替换为你的云环境ID
        traceUser: true,
      });
    }
    this.getUserOpenId();
  },

  async getUserOpenId() {
    try {
      if (this.tradeRuntime) {
        await this.tradeRuntime.assertIdentity();
        this.globalData.openid = this.tradeRuntime.subjectId;
        await this.updateCartCount();
        return;
      }
      const { result } = await wx.cloud.callFunction({ name: 'login' });
      this.globalData.openid = result.openid;
      wx.setStorageSync('openid', result.openid);
      console.log('openid 获取成功:', result.openid);
      await this.updateCartCount();
    } catch (err) {
      console.error('获取 openid 失败', err);
    }
  },

  async updateCartCount() {
    if (this.tradeRuntime) {
      const cart = await this.tradeRuntime.readCart();
      const count = cart.items.reduce((total, item) => total + item.quantity, 0);
      this.globalData.cartCount = count;
      this.notifyTabBarUpdate(count);
      return count;
    }
    const openid = this.globalData.openid;
    if (!openid) return this.globalData.cartCount;
    const db = wx.cloud.database();
    try {
      const res = await db.collection('carts').where({ openid }).get();
      const cart = res.data[0];
      let total = 0;
      if (cart && cart.items) {
        total = cart.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
      }
      this.globalData.cartCount = total;
      this.notifyTabBarUpdate(total);
      return total;
    } catch (err) {
      console.error('更新购物车数量失败', err);
      return this.globalData.cartCount;
    }
  },

  notifyTabBarUpdate(count) {
    const instances = this.globalData.tabBarInstances || [];
    instances.forEach(instance => {
      if (instance && typeof instance.setCartCount === 'function') {
        instance.setCartCount(count);
      }
    });
  },

  registerTabBar(instance) {
    if (!this.globalData.tabBarInstances.includes(instance)) {
      this.globalData.tabBarInstances.push(instance);
    }
  },

  unregisterTabBar(instance) {
    const index = this.globalData.tabBarInstances.indexOf(instance);
    if (index !== -1) {
      this.globalData.tabBarInstances.splice(index, 1);
    }
  },

  globalData: {
    openid: null,
    cartCount: 0,
    tabBarInstances: []
  }
});

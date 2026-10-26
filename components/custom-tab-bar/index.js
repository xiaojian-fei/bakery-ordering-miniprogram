// components/custom-tab-bar/index.js
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "/pages/index/index", text: "首页", icon: "🍞", selectedIcon: "🍞" },
      { pagePath: "/pages/cart/cart", text: "购物车", icon: "🛒", selectedIcon: "🛒" },
      { pagePath: "/pages/orders/orders", text: "订单", icon: "📋", selectedIcon: "📋" }
    ],
    cartCount: 0
  },

  lifetimes: {
    attached() {
      this.updateSelected();
      this.updateCartCount();
      const app = getApp();
      app.registerTabBar(this);
    },
    detached() {
      const app = getApp();
      app.unregisterTabBar(this);
    }
  },

  pageLifetimes: {
    show() {
      this.updateCartCount();
    }
  },

  methods: {
    switchTab(e) {
      const path = e.currentTarget.dataset.path;
      const runtime = getApp().tradeRuntime;
      if (runtime && !runtime.isRouteAvailable(path)) {
        wx.showToast({ title: '此页面尚未接入新接口', icon: 'none' });
        return;
      }
      wx.switchTab({ url: path });
    },
    updateSelected() {
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      const url = currentPage.route;
      const index = this.data.list.findIndex(item => item.pagePath === `/${url}`);
      if (index !== -1) {
        this.setData({ selected: index });
      }
    },
    updateCartCount() {
      const app = getApp();
      const count = app.globalData.cartCount || 0;
      if (this.data.cartCount !== count) {
        this.setData({ cartCount: count });
      }
    },
    setCartCount(count) {
      if (this.data.cartCount !== count) {
        this.setData({ cartCount: count });
      }
    }
  }
});

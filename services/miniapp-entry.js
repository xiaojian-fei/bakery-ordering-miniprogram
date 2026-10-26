'use strict';
// 旧模式只加载旧页面；新模式不加载含wx.cloud.database()的旧模块。
function registerMiniappPage({ legacy, createPage } = {}) {
  const app = getApp(), runtime = app.tradeRuntime;
  if (!runtime) return Page(legacy());
  if (createPage) return Page(createPage({ runtime, wx, app }));
  return Page({
    data: { unifiedMode: true },
    onLoad() {
      wx.showModal({ title: '页面待接入', content: '此页面尚未切换到新接口，请先使用首页和购物车。',
        showCancel: false, success: () => wx.switchTab({ url: '/pages/index/index' }) });
    }
  });
}
module.exports = { registerMiniappPage };

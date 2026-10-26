// pages/admin-login/admin-login.js
module.exports = {
  data: {
    account: '',
    password: '',
    showPassword: false
  },

  onLoad() {
    const isLogin = wx.getStorageSync('adminLogin');
    if (isLogin) {
      wx.redirectTo({ url: '/pages/admin/admin' });
    }
  },

  onAccountInput(e) {
    this.setData({ account: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  login() {
    const { account, password } = this.data;
    if (!account || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' });
      return;
    }

    const ADMIN_ACCOUNT = 'admin';
    const ADMIN_PASSWORD = ''; // 公开基线禁用硬编码登录，后续改为服务端认证

    if (account === ADMIN_ACCOUNT && password === ADMIN_PASSWORD) {
      wx.setStorageSync('adminLogin', true);
      wx.setStorageSync('adminAccount', account);
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/admin/admin' });
      }, 1000);
    } else {
      wx.showToast({ title: '账号或密码错误', icon: 'none' });
    }
  },

  forgetPassword() {
    wx.showModal({
      title: '提示',
      content: '请联系管理员获取账号密码',
      showCancel: false
    });
  }
};

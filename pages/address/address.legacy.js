// pages/address/address.js
const db = wx.cloud.database();

module.exports = {
  data: {
    addresses: [],
    selectMode: false
  },

  onLoad(options) {
    if (options.selectMode === 'true') {
      this.setData({ selectMode: true });
    }
    this.loadAddresses();
  },

  onShow() {
    this.loadAddresses();
  },

  async loadAddresses() {
    const openid = getApp().globalData.openid;
    if (!openid) return;
    const res = await db.collection('addresses').where({ openid }).get();
    this.setData({ addresses: res.data });
  },

  selectAddress(e) {
    if (!this.data.selectMode) return;
    const address = e.currentTarget.dataset.item;
    const eventChannel = this.getOpenerEventChannel();
    if (eventChannel) {
      eventChannel.emit('addressSelected', address);
    }
    wx.navigateBack();
  },

  addAddress() {
    wx.navigateTo({ url: '/pages/add-address/add-address' });
  },

  editAddress(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/add-address/add-address?id=${id}` });
  },

  async deleteAddress(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '提示',
      content: '确定删除该地址吗？',
      success: async (res) => {
        if (res.confirm) {
          await db.collection('addresses').doc(id).remove();
          this.loadAddresses();
          wx.showToast({ title: '删除成功', icon: 'success' });
        }
      }
    });
  }
};

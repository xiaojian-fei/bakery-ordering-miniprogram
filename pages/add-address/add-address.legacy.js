// pages/add-address/add-address.js
const db = wx.cloud.database();

module.exports = {
  data: {
    id: null,
    name: '',
    phone: '',
    province: '',
    city: '',
    district: '',
    detail: '',
    isDefault: false,
    region: ['', '', '']  // 默认空数组，显示"请选择"
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ id: options.id });
      this.loadAddress();
    }
  },

  async loadAddress() {
    const res = await db.collection('addresses').doc(this.data.id).get();
    const addr = res.data;
    this.setData({
      name: addr.name,
      phone: addr.phone,
      province: addr.province || '',
      city: addr.city || '',
      district: addr.district || '',
      detail: addr.detail,
      isDefault: addr.isDefault || false,
      region: addr.province ? [addr.province, addr.city, addr.district] : ['', '', '']
    });
  },

  onRegionChange(e) {
    const region = e.detail.value;
    this.setData({
      region: region,
      province: region[0],
      city: region[1],
      district: region[2]
    });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },
  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },
  onDetailInput(e) {
    this.setData({ detail: e.detail.value });
  },
  onDefaultChange(e) {
    this.setData({ isDefault: e.detail.value });
  },

  async submit() {
    const { name, phone, province, city, district, detail, isDefault, id } = this.data;
    if (!name || !phone || !province || !city || !district || !detail) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }
    const openid = getApp().globalData.openid;
    wx.showLoading({ title: '保存中' });
    try {
      const addressData = {
        name,
        phone,
        province,
        city,
        district,
        detail,
        isDefault,
        fullAddress: `${province}${city}${district}${detail}`,
        updateTime: new Date()
      };
      if (id) {
        await db.collection('addresses').doc(id).update({ data: addressData });
      } else {
        if (isDefault) {
          const { data } = await db.collection('addresses').where({ openid }).get();
          for (let addr of data) {
            if (addr.isDefault) {
              await db.collection('addresses').doc(addr._id).update({ data: { isDefault: false } });
            }
          }
        }
        await db.collection('addresses').add({
          data: {
            openid,
            ...addressData,
            createTime: new Date()
          }
        });
      }
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  }
};

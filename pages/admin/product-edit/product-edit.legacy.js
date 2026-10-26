// pages/admin/product-edit/product-edit.js
const db = wx.cloud.database();

module.exports = {
  data: {
    id: null,
    name: '',
    price: '',
    desc: '',
    category: '冰乳酪司康',
    isOnSale: true,
    isFeatured: false,
    monthSales: 0,
    categories: ['冰乳酪司康', '酥性饼干', '养生膏体'],
    imageUrl: '',
    tempImageUrl: '',
    isUploading: false
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ id: options.id });
      this.loadProduct();
    }
  },

  async loadProduct() {
    const res = await db.collection('products').doc(this.data.id).get();
    const product = res.data;
    this.setData({
      name: product.name,
      price: product.price.toString(),
      desc: product.desc,
      category: product.category || '冰乳酪司康',
      isOnSale: product.isOnSale !== false,
      isFeatured: product.isFeatured === true,
      monthSales: product.monthSales || 0,
      imageUrl: product.image || ''
    });
  },

  chooseImage() {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        this.setData({ tempImageUrl: tempFilePath });
      }
    });
  },

  async uploadImage() {
    if (!this.data.tempImageUrl) return this.data.imageUrl;
    if (this.data.isUploading) return this.data.imageUrl;
    this.setData({ isUploading: true });
    wx.showLoading({ title: '上传中...' });
    try {
      const cloudPath = `products/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const res = await wx.cloud.uploadFile({
        cloudPath,
        filePath: this.data.tempImageUrl
      });
      wx.hideLoading();
      wx.showToast({ title: '上传成功', icon: 'success' });
      this.setData({ imageUrl: res.fileID, tempImageUrl: '', isUploading: false });
      return res.fileID;
    } catch (err) {
      console.error('上传失败', err);
      wx.hideLoading();
      wx.showToast({ title: '图片上传失败', icon: 'none' });
      this.setData({ isUploading: false });
      return this.data.imageUrl;
    }
  },

  previewImage() {
    if (this.data.imageUrl) {
      wx.previewImage({
        urls: [this.data.imageUrl],
        current: this.data.imageUrl
      });
    } else if (this.data.tempImageUrl) {
      wx.previewImage({
        urls: [this.data.tempImageUrl],
        current: this.data.tempImageUrl
      });
    }
  },

  deleteImage() {
    wx.showModal({
      title: '提示',
      content: '确定要删除图片吗？',
      success: (res) => {
        if (res.confirm) {
          this.setData({ imageUrl: '', tempImageUrl: '' });
        }
      }
    });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },
  onPriceInput(e) {
    this.setData({ price: e.detail.value });
  },
  onDescInput(e) {
    this.setData({ desc: e.detail.value });
  },
  onCategoryChange(e) {
    this.setData({ category: this.data.categories[e.detail.value] });
  },
  onSaleChange(e) {
    this.setData({ isOnSale: e.detail.value });
  },
  onFeaturedChange(e) {
    this.setData({ isFeatured: e.detail.value });
  },

  async submit() {
    const { name, price, desc, category, isOnSale, isFeatured, id, imageUrl, tempImageUrl } = this.data;
    if (!name || !price || !desc) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '保存中' });
    try {
      let finalImageUrl = imageUrl;
      if (tempImageUrl) {
        finalImageUrl = await this.uploadImage();
        if (!finalImageUrl) {
          wx.hideLoading();
          return;
        }
      }
      const data = {
        name,
        price: Number(price),
        desc,
        category,
        isOnSale,
        isFeatured,
        image: finalImageUrl || '',
        updateTime: new Date()
      };
      if (id) {
        await db.collection('products').doc(id).update({ data });
      } else {
        await db.collection('products').add({ data });
      }
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err) {
      console.error('保存失败', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  }
};

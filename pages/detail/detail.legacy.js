// pages/detail/detail.js
const db = wx.cloud.database();

module.exports = {
  data: {
    product: null,
    id: ''
  },

  onLoad(options) {
    this.setData({ id: options.id });
    this.loadProduct();
  },

  async loadProduct() {
    wx.showLoading({ title: '加载中' });
    try {
      const res = await db.collection('products').doc(this.data.id).get();
      const product = res.data;
      product.emoji = product.category === '面包' ? '🥐' : '🍰';
      product.image = product.image || '';
      this.setData({ product });
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  addToCart() {
    const product = this.data.product;
    const openid = getApp().globalData.openid;
    if (!openid) {
      wx.showToast({ title: '请稍后重试', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '添加中' });
    this.addToCartDB(product).finally(() => wx.hideLoading());
  },

  async addToCartDB(product) {
    try {
      const cartRes = await db.collection('carts').where({ openid: getApp().globalData.openid }).get();
      let cart = cartRes.data[0];
      if (!cart) {
        await db.collection('carts').add({
          data: {
            openid: getApp().globalData.openid,
            items: [{
              productId: product._id,
              name: product.name,
              price: Number(product.price),
              quantity: 1,
              emoji: product.emoji,
              image: product.image
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
            image: product.image
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
    }
  }
};

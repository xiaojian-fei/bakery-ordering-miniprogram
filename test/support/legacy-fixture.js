'use strict';

function legacyFixture() {
  return { products: [{ _id: 'bread', name: '测试司康', price: 11.9, desc: '测试商品', category: '冰乳酪司康',
    isOnSale: true, monthSales: 999, image: '' }],
  addresses: [{ _id: 'home', openid: 'buyer-demo', name: '测试顾客', phone: '00000000000',
    province: '内蒙古', city: '测试市', district: '测试区', detail: '虚构地址', isDefault: true }],
  orders: [{ _id: 'old-order', openid: 'buyer-demo', totalPrice: 0.01, status: '已完成' }] };
}

module.exports = { legacyFixture };

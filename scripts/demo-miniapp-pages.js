'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createLocalDemo } = require('./local-demo-fixture');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { miniappHarness } = require('../test/support/miniapp-harness');

async function main() {
  const demo = await createLocalDemo();
  const client = await demo.client('buyer');
  const runtime = createMiniappRuntime({ client, requestId: () => 'cart-' + randomUUID() });
  const { app, loadPage, cloudReads } = miniappHarness(runtime);
  await app.onLaunch();
  const home = loadPage('pages/index/index'); await home.onShow();
  assert.equal(home.data.products.length, 2);
  const detail = loadPage('pages/detail/detail'); detail.onLoad({ id: 'bread' }); await detail.onShow();
  await detail.addToCart();
  const cart = loadPage('pages/cart/cart'); await cart.onShow();
  await cart.changeQuantity({ currentTarget: { dataset: { id: 'bread', op: 'plus' } } });
  assert.equal(cart.data.cartItems[0].quantity, 2);
  assert.equal(cart.data.totalPrice, '25.00'); assert.equal(app.globalData.cartCount, 2);
  // 显式准备虚构内存地址；只读地址页本身不执行save/remove。
  await client.addresses.save({ addressId: 'demo-home', requestId: 'seed-' + randomUUID(), expectedVersion: 0,
    name: '演示顾客', phone: '00000000000', province: '测试省', city: '测试市', district: '测试区',
    detail: '虚构演示地址', makeDefault: true });
  cart.openAddresses();
  const addresses = loadPage('pages/address/address'); await addresses.onShow();
  assert.equal(addresses.data.addresses.length, 1); assert.equal(addresses.data.addresses[0].isDefault, true);
  assert.equal(cloudReads(), 0);
  console.log('原App/Page入口本地执行：商品2种 → 详情加购 → 购物车2件，估算25.00元。');
  console.log('购物车 → 只读地址列表：本人虚构地址1条，默认标记正确。');
  console.log('wx.cloud访问0次；未迁移页面已隔离。虚构数据、内存服务，未执行微信编译或WXML渲染。');
}
main().catch(() => { console.error('原页面本地贯通失败，请运行npm test查看具体用例。'); process.exitCode = 1; });

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
  assert.equal(cloudReads(), 0);
  console.log('原App/Page入口本地执行：商品2种 → 详情加购 → 购物车2件，估算25.00元。');
  console.log('wx.cloud访问0次；未迁移页面已隔离。虚构数据、内存服务，未执行微信编译或WXML渲染。');
}
main().catch(() => { console.error('原页面本地贯通失败，请运行npm test查看具体用例。'); process.exitCode = 1; });

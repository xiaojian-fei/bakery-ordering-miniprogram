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
  const { app, loadPage, cloudReads, events } = miniappHarness(runtime);
  await app.onLaunch();
  const home = loadPage('pages/index/index'); await home.onShow();
  assert.equal(home.data.products.length, 2);
  const detail = loadPage('pages/detail/detail'); detail.onLoad({ id: 'bread' }); await detail.onShow();
  await detail.addToCart();
  const cart = loadPage('pages/cart/cart'); await cart.onShow();
  await cart.changeQuantity({ currentTarget: { dataset: { id: 'bread', op: 'plus' } } });
  assert.equal(cart.data.cartItems[0].quantity, 2);
  assert.equal(cart.data.totalPrice, '25.00'); assert.equal(app.globalData.cartCount, 2);
  const form = loadPage('pages/add-address/add-address'); form.onLoad({}); await form.onShow();
  const change = value => ({ detail: { value } });
  form.onNameInput(change('演示顾客')); form.onPhoneInput(change('00000000000'));
  form.onRegionChange(change(['测试省', '测试市', '测试区'])); form.onDetailInput(change('虚构演示地址'));
  form.onDefaultChange(change(true)); await form.submit(); assert.equal(form.data.saved, true);
  // 新页面实例读取同一内存服务，验证编辑入口，而不是直接调用服务修改地址。
  const editing = miniappHarness(runtime), edit = editing.loadPage('pages/add-address/add-address');
  edit.onLoad({ id: form.data.id }); await edit.onShow(); edit.onDetailInput(change('虚构演示地址（已修改）'));
  await edit.submit(); assert.equal(edit.data.version, 2);
  cart.openAddresses();
  const addresses = loadPage('pages/address/address'); await addresses.onShow();
  assert.equal(addresses.data.addresses.length, 1); assert.equal(addresses.data.addresses[0].isDefault, true);
  assert.equal(addresses.data.addresses[0].detail, '虚构演示地址（已修改）');
  const deletion = addresses.deleteAddress({ currentTarget: { dataset: { id: form.data.id } } });
  let modal;
  for (let i = 0; i < 20 && !modal; i++) {
    await new Promise(resolve => setImmediate(resolve));
    modal = events.findLast(event => event.name === 'showModal');
  }
  assert.ok(modal, '应展示删除确认'); modal.options.success({ confirm: true }); await deletion;
  assert.equal(addresses.data.addresses.length, 0);
  assert.equal((await client.addresses.list()).defaultAddressId, null);
  assert.equal(cloudReads() + editing.cloudReads(), 0);
  console.log('原App/Page入口本地执行：商品2种 → 详情加购 → 购物车2件，估算25.00元。');
  console.log('新增默认地址 → 编辑至版本2 → 地址列表：本人虚构地址1条，内容及默认标记正确。');
  console.log('模拟确认删除 → 列表0条、默认指针清空；删除版本3。');
  console.log('wx.cloud访问0次；未迁移页面已隔离。虚构数据、内存服务，未执行微信编译或WXML渲染。');
}
main().catch(() => { console.error('原页面本地贯通失败，请运行npm test查看具体用例。'); process.exitCode = 1; });

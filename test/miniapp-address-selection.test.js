'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { shopFixture, buyer, other, addressInput } = require('./support/shop-fixture');
const { miniappHarness } = require('./support/miniapp-harness');

function fixture() {
  const base = shopFixture(), requests = [];
  let subject = buyer.openid, sequence = 0, failRead = false, drop = null;
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const client = createTradeClient({ clock: base.clock, send: async request => {
    requests.push(structuredClone(request));
    if (failRead && request.action === 'addresses.get') throw new Error('private-transport-detail');
    const result = await application.handle(request, { subject });
    if (drop === request.action) { drop = null; throw new Error('LOST_RESPONSE'); }
    return result;
  } });
  const runtime = createMiniappRuntime({ client, subjectId: buyer.openid, requestId: () => 'address-select-' + (++sequence) });
  const harness = () => miniappHarness(runtime);
  return { ...base, runtime, client, requests, harness,
    switchSubject: value => { subject = value; }, failRead: value => { failRead = value; }, dropNext: action => { drop = action; } };
}
const change = value => ({ detail: { value } });
const click = id => ({ currentTarget: { dataset: { id } } });
const latestPicker = ui => ui.events.findLast(event => event.name === 'navigateTo' && event.options.url.includes('selectMode=true')).options;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function waitFor(check) {
  for (let i = 0; i < 20 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(check(), '预期本地异步步骤未完成');
}
async function cartFixture(base) {
  const ui = base.harness(), cart = ui.loadPage('pages/cart/cart'); await cart.onShow();
  cart.onDeliveryTypeChange(change('delivery')); return { ui, cart };
}
async function pickerFixture(base, cart, ui) {
  cart.openAddressPicker(); const navigation = latestPicker(ui), emitted = [];
  cart.onHide();
  const page = ui.loadPage('pages/address/address', { eventChannel: { emit(name, value) {
    emitted.push({ name, value }); return navigation.events[name](value);
  } } });
  page.onLoad({ selectMode: 'true' }); await page.onShow(); return { page, emitted, navigation };
}

test('购物车选址：真实页面只回传ID，返回后读取本人最新地址，不写默认或订单', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const { ui, cart } = await cartFixture(base), picker = await pickerFixture(base, cart, ui);
  const updates = cart.updates.length; await picker.page.selectAddress(click('home'));
  assert.deepEqual(picker.emitted, [{ name: 'addressSelected', value: { addressId: 'home' } }]);
  assert.equal(cart.updates.length, updates); assert.equal(cart.data.selectedAddress, null);
  picker.page.onHide(); await cart.onShow();
  assert.equal(cart.data.selectedAddress._id, 'home'); assert.equal(cart.data.selectedAddress.detail, '虚构地址');
  assert.equal(base.repository.snapshot().addresses.home.version, 1);
  assert.equal(base.repository.snapshot().users[buyer.openid].defaultAddressId, 'home');
  assert.ok(base.requests.every(row => ['identity.me', 'addresses.list', 'addresses.get', 'cart.get'].includes(row.action)));
  assert.equal(ui.cloudReads(), 0);
});

test('购物车选址：管理模式不回传，直接打开选择页缺少来源通道时提示重开', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const ui = base.harness(), page = ui.loadPage('pages/address/address'); page.onLoad({}); await page.onShow();
  await page.selectAddress(click('home')); assert.equal(ui.events.some(event => event.name === 'navigateBack'), false);
  page.onLoad({ selectMode: 'true' }); await page.selectAddress(click('home'));
  assert.equal(page.data.error, '请选择从购物车打开地址列表后重试');
  assert.equal(ui.events.some(event => event.name === 'navigateBack'), false);
});

test('购物车选址：不自动采用默认地址，自取清空选择并拒绝旧选择回调', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const { ui, cart } = await cartFixture(base);
  assert.equal(cart.data.selectedAddress, null);
  assert.equal(base.requests.some(row => row.action === 'addresses.get'), false);
  cart.openAddressPicker(); const navigation = latestPicker(ui);
  await navigation.events.addressSelected({ addressId: 'home' }); assert.ok(cart.data.selectedAddress);
  cart.onDeliveryTypeChange(change('pickup')); assert.equal(cart.data.selectedAddress, null);
  cart.onDeliveryTypeChange(change('delivery')); await navigation.events.addressSelected({ addressId: 'home' });
  assert.equal(cart.data.selectedAddress, null); assert.equal(cart._selectedAddressId, null);
});

test('购物车选址：返回页面重读编辑后的地址，地址删除后清空且不改选其他默认地址', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'seed-work-select', makeDefault: false }));
  const { ui, cart } = await cartFixture(base); cart.openAddressPicker(); await latestPicker(ui).events.addressSelected({ addressId: 'home' });
  cart.onHide(); await base.addresses.save(buyer, addressInput({ requestId: 'edit-selected-home', expectedVersion: 1, detail: '已更新的虚构地址' }));
  await cart.onShow(); assert.equal(cart.data.selectedAddress.detail, '已更新的虚构地址');
  await base.addresses.remove(buyer, { addressId: 'home', requestId: 'delete-selected-home', expectedVersion: 2 });
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'default-work-select', expectedVersion: 1 }));
  await cart.onShow(); assert.equal(cart.data.selectedAddress, null); assert.equal(cart._selectedAddressId, null);
  assert.equal(cart.data.addressError, '地址不存在或已删除，请重新选择');
});

test('购物车选址：伪造事件正文和他人ID无效，身份变化清空原地址', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  await base.addresses.save(other, addressInput({ addressId: 'foreign-home' }));
  const { ui, cart } = await cartFixture(base); cart.openAddressPicker();
  await latestPicker(ui).events.addressSelected({ addressId: 'foreign-home', name: '伪造', ownerOpenid: buyer.openid });
  assert.equal(cart.data.selectedAddress, null); assert.equal(cart.data.addressError, '当前身份没有此操作权限');
  cart._pickerOpening = false; cart.openAddressPicker();
  await latestPicker(ui).events.addressSelected({ addressId: 'home', detail: '伪造详情', role: 'owner' });
  assert.equal(cart.data.selectedAddress.detail, '虚构地址');
  base.switchSubject(other.openid); await cart.onShow();
  assert.equal(cart.data.selectedAddress, null); assert.equal(cart._selectedAddressId, null);
  assert.equal(cart.data.addressError, '登录状态已变化，请重新操作');
});

test('购物车选址：网络失败不继续显示旧地址，保留ID供重新核对且不泄露异常', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const { ui, cart } = await cartFixture(base);
  cart.openAddressPicker(); await latestPicker(ui).events.addressSelected({ addressId: 'home' });
  base.failRead(true); await cart.refreshSelectedAddress();
  assert.equal(cart.data.selectedAddress, null); assert.equal(cart._selectedAddressId, 'home');
  assert.equal(cart.data.addressError.includes('private-transport'), false);
  base.failRead(false); await cart.refreshSelectedAddress(); assert.equal(cart.data.selectedAddress._id, 'home');
});

test('购物车选址：乱序响应不覆盖新选择，隐藏或卸载后不更新页面', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const tasks = [], original = await base.client.addresses.get('home');
  const editor = { ...base.runtime.addressEditor, read: id => { const task = deferred(); tasks.push({ ...task, id }); return task.promise; } };
  const ui = miniappHarness({ ...base.runtime, addressEditor: editor }), cart = ui.loadPage('pages/cart/cart');
  await cart.onShow(); cart.onDeliveryTypeChange(change('delivery')); cart.openAddressPicker();
  const first = latestPicker(ui).events.addressSelected({ addressId: 'home' }); await waitFor(() => tasks.length === 1);
  cart._pickerOpening = false; cart.openAddressPicker();
  const second = latestPicker(ui).events.addressSelected({ addressId: 'work' }); await waitFor(() => tasks.length === 2);
  tasks[1].resolve({ ...original, _id: 'work' }); await second;
  tasks[0].resolve(original); await first; assert.equal(cart.data.selectedAddress._id, 'work');
  const third = cart.refreshSelectedAddress(); await waitFor(() => tasks.length === 3); cart.onHide(); const count = cart.updates.length;
  tasks[2].resolve({ ...original, _id: 'work' }); await third; assert.equal(cart.updates.length, count);
  cart.onUnload(); await latestPicker(ui).events.addressSelected({ addressId: 'home' }); assert.equal(cart._selectedAddressId, null);
});

test('购物车选址：待确认保存或删除时不回传选择，不绕过原操作恢复', async () => {
  for (const kind of ['save', 'remove']) {
    const base = fixture();
    if (kind === 'remove') await base.addresses.save(buyer, addressInput());
    base.dropNext(kind === 'save' ? 'addresses.save' : 'addresses.remove');
    await assert.rejects(kind === 'save' ? base.runtime.addressEditor.save(addressInput())
      : base.runtime.addressEditor.remove({ addressId: 'home', expectedVersion: 1 }), error => error.uncertain);
    // 删除后目标已经不在列表，另备一条用于检验不会选择其他地址绕过待确认操作。
    await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'seed-recovery-work', makeDefault: false }));
    const { ui, cart } = await cartFixture(base), picker = await pickerFixture(base, cart, ui);
    await picker.page.selectAddress(click('work')); assert.equal(picker.emitted.length, 0);
    assert.equal(base.runtime.addressEditor.hasPending(), true); assert.equal(cart._selectedAddressId, null);
  }
});

test('购物车选址：重复点击仅返回一次，旧选择器与重复事件不能覆盖新选择', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'seed-work-once', makeDefault: false }));
  const { ui, cart } = await cartFixture(base), picker = await pickerFixture(base, cart, ui);
  await Promise.all([picker.page.selectAddress(click('home')), picker.page.selectAddress(click('home'))]);
  assert.equal(picker.emitted.length, 1); await picker.page.selectAddress(click('work')); assert.equal(picker.emitted.length, 1);
  await cart.onShow(); cart.openAddressPicker(); const next = latestPicker(ui);
  await next.events.addressSelected({ addressId: 'work' }); await picker.navigation.events.addressSelected({ addressId: 'home' });
  await next.events.addressSelected({ addressId: 'home' }); assert.equal(cart.data.selectedAddress._id, 'work');
});

test('购物车选址：点选前地址已删除或隐藏页面时不回传，选择期间不能交叉删除', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const { ui, cart } = await cartFixture(base), picker = await pickerFixture(base, cart, ui);
  await base.addresses.remove(buyer, { addressId: 'home', requestId: 'delete-before-select', expectedVersion: 1 });
  await picker.page.selectAddress(click('home')); assert.equal(picker.emitted.length, 0); assert.match(picker.page.data.error, /地址不存在/);
  const gate = deferred(), original = { _id: 'home' };
  const editor = { ...base.runtime.addressEditor, read: () => gate.promise };
  const nextUi = miniappHarness({ ...base.runtime, addressEditor: editor });
  const next = nextUi.loadPage('pages/address/address', { eventChannel: { emit() { assert.fail('隐藏页不应回传'); } } });
  next.onLoad({ selectMode: 'true' }); await next.onShow(); next.setData({ addresses: [original] });
  const selecting = next.selectAddress(click('home')); await waitFor(() => next._selecting);
  await next.deleteAddress(click('home')); assert.equal(nextUi.events.some(event => event.name === 'showModal'), false);
  next.onHide(); const updates = next.updates.length; gate.resolve(original); await selecting;
  assert.equal(next.updates.length, updates);
});

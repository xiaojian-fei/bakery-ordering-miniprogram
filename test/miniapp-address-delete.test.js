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
  let subject = buyer.openid, sequence = 0, drop = null, malformed = false, gate = null;
  const app = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const client = createTradeClient({ clock: base.clock, send: async request => {
    requests.push(structuredClone(request));
    const result = structuredClone(await app.handle(request, { subject }));
    if (drop === request.action) { drop = null; throw new Error('LOST_AFTER_COMMIT'); }
    if (request.action === 'addresses.remove') {
      if (malformed && result.success) { malformed = false; result.data.version = 999; }
      if (gate) { const wait = gate; gate = null; await wait; }
    }
    return result;
  } });
  const runtime = createMiniappRuntime({ client, requestId: () => 'address-delete-' + (++sequence) });
  const harness = () => miniappHarness(runtime);
  const list = async () => { const ui = harness(), page = ui.loadPage('pages/address/address'); await page.onShow(); return { ...ui, page }; };
  return { ...base, client, runtime, harness, list, requests,
    switchSubject: value => { subject = value; }, dropNext: (action = 'addresses.remove') => { drop = action; },
    malformedNext: () => { malformed = true; },
    holdNextRemove: () => { let release; gate = new Promise(resolve => { release = resolve; }); return release; } };
}
const click = id => ({ currentTarget: { dataset: { id } } });
const removals = base => base.requests.filter(row => row.action === 'addresses.remove');
const modals = ui => ui.events.filter(event => event.name === 'showModal');
async function waitFor(check) {
  for (let i = 0; i < 20 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(check(), '预期的本地异步步骤未完成');
}
async function start(ui, id = 'home') {
  const count = modals(ui).length;
  const operation = ui.page.deleteAddress(click(id));
  await waitFor(() => modals(ui).length > count);
  return { operation, modal: modals(ui).at(-1).options };
}

test('地址删除：实际页面确认后软删除默认地址，清指针且保留历史订单快照', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const order = await base.orders.create(buyer, { requestId: 'order-before-delete', deliveryType: 'delivery',
    addressId: 'home', items: [{ productId: 'bread', quantity: 1 }] });
  const ui = await base.list(), { operation, modal } = await start(ui);
  assert.match(modal.content, /历史订单地址保持不变/); modal.success({ confirm: true }); await operation;
  assert.equal(ui.page.data.addresses.length, 0); assert.equal(ui.page.data.addressDeletePending, false);
  const state = base.repository.snapshot();
  assert.equal(state.addresses.home.deleted, true); assert.equal(state.addresses.home.version, 2);
  assert.equal(state.users[buyer.openid].defaultAddressId, null);
  assert.equal((await base.orders.get(buyer, order._id)).addressSnapshot.detail, '虚构地址');
  assert.equal(removals(base).length, 1); assert.equal(ui.cloudReads(), 0);
});

test('地址删除：取消或确认框失败时不发送删除，不改变默认指针', async () => {
  for (const response of ['cancel', 'fail']) {
    const base = fixture(); await base.addresses.save(buyer, addressInput());
    const ui = await base.list(), { operation, modal } = await start(ui);
    if (response === 'cancel') modal.success({ confirm: false }); else modal.fail();
    await operation;
    assert.equal(removals(base).length, 0); assert.equal(ui.page.data.deleteBusy, false);
    assert.equal(base.repository.snapshot().users[buyer.openid].defaultAddressId, 'home');
  }
});

test('地址删除：连续点击只出现一个确认框，并仅执行一次删除', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const ui = await base.list();
  const first = ui.page.deleteAddress(click('home')), second = ui.page.deleteAddress(click('home'));
  await waitFor(() => modals(ui).length === 1); modals(ui)[0].options.success({ confirm: true });
  await Promise.all([first, second]); assert.equal(removals(base).length, 1); assert.equal(modals(ui).length, 1);
});

test('地址删除：确认期间地址被编辑则拒绝旧版本，刷新后需要重新确认', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const ui = await base.list();
  const first = await start(ui);
  await base.addresses.save(buyer, addressInput({ requestId: 'edit-during-confirm', expectedVersion: 1, detail: '新版本地址' }));
  first.modal.success({ confirm: true }); await first.operation;
  assert.equal(ui.page.data.error, '数据已更新，请刷新后重新确认');
  assert.equal(ui.page.data.addresses[0].detail, '新版本地址');
  assert.equal(base.repository.snapshot().addresses.home.deleted, false); assert.equal(removals(base).length, 1);
  const second = await start(ui); second.modal.success({ confirm: true }); await second.operation;
  assert.equal(base.repository.snapshot().addresses.home.version, 3);
  assert.deepEqual(removals(base).map(row => row.data.expectedVersion), [1, 2]);
  assert.notEqual(removals(base)[0].data.requestId, removals(base)[1].data.requestId);
});

test('地址删除：确认期间默认地址改为另一条，删除旧地址不清除新默认', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'seed-work', makeDefault: false }));
  const ui = await base.list(), { operation, modal } = await start(ui);
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'new-default-work', expectedVersion: 1 }));
  modal.success({ confirm: true }); await operation;
  assert.equal(ui.page.data.addresses[0]._id, 'work'); assert.equal(ui.page.data.addresses[0].isDefault, true);
  assert.equal(base.repository.snapshot().users[buyer.openid].defaultAddressId, 'work');
});

test('地址删除：成功丢响应后即使列表已无目标，仍能按原命令确认且不再次修改版本', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'seed-work', makeDefault: false }));
  const ui = await base.list(); base.dropNext(); const { operation, modal } = await start(ui);
  modal.success({ confirm: true }); await operation;
  assert.equal(ui.page.data.addressDeletePending, true); assert.deepEqual(ui.page.data.addresses.map(row => row._id), ['work']);
  await ui.page.deleteAddress(click('work')); assert.equal(modals(ui).length, 1); assert.equal(removals(base).length, 1);
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'default-after-unknown', expectedVersion: 1 }));
  await ui.page.retryAddressDelete();
  assert.equal(ui.page.data.addressDeletePending, false); assert.equal(base.repository.snapshot().addresses.home.version, 2);
  assert.equal(base.repository.snapshot().addresses.work.deleted, false);
  assert.equal(base.repository.snapshot().users[buyer.openid].defaultAddressId, 'work');
  assert.deepEqual(removals(base)[0].data, removals(base)[1].data); assert.equal(modals(ui).length, 1);
});

test('地址删除：重建列表可恢复；保存表单不会把待确认删除当成保存重试', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const ui = await base.list();
  base.dropNext(); const first = await start(ui); first.modal.success({ confirm: true }); await first.operation; ui.page.onUnload();
  const next = await base.list(); assert.equal(next.page.data.addresses.length, 0); assert.equal(next.page.data.addressDeletePending, true);
  const formUi = base.harness(), form = formUi.loadPage('pages/add-address/add-address'); form.onLoad({}); await form.onShow();
  assert.equal(form.data.deletionPending, true); assert.equal(form.data.formReady, false);
  await form.restorePending(); await form.retrySave(); await form.submit(); assert.equal(form.data.saved, false);
  await assert.rejects(base.runtime.addressEditor.retry(), error => error.code === 'ADDRESS_DELETE_RECOVERY_REQUIRED');
  assert.equal(removals(base).length, 1); await next.page.retryAddressDelete(); assert.equal(removals(base).length, 2);
});

test('地址删除：待确认保存阻止删除和删除重试，恢复按钮不会调用错误动作', async () => {
  const base = fixture(); base.dropNext('addresses.save');
  await assert.rejects(base.runtime.addressEditor.save(addressInput()), error => error.uncertain);
  const ui = await base.list(); assert.equal(ui.page.data.addressWritePending, true); assert.equal(ui.page.data.addressDeletePending, false);
  await ui.page.deleteAddress(click('home')); await ui.page.retryAddressDelete();
  assert.equal(modals(ui).length, 0); assert.equal(removals(base).length, 0);
  await assert.rejects(base.runtime.addressEditor.retryRemove(), error => error.code === 'ADDRESS_RECOVERY_REQUIRED');
  await base.runtime.addressEditor.retry(); assert.equal((await base.client.addresses.list()).items.length, 1);
});

test('地址删除：主体变化或伪造其他地址ID不能删除他人数据', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  await base.addresses.save(other, addressInput({ addressId: 'others-home' }));
  const ui = await base.list(); await ui.page.deleteAddress(click('others-home')); assert.equal(modals(ui).length, 0);
  const first = await start(ui); base.switchSubject(other.openid); first.modal.success({ confirm: true }); await first.operation;
  assert.equal(removals(base).length, 0); assert.equal(ui.page.data.addresses.length, 0);
  base.switchSubject(buyer.openid);
  await assert.rejects(base.runtime.addressEditor.remove({ addressId: 'others-home', expectedVersion: 1 }), error => error.code === 'FORBIDDEN');
  assert.equal(base.repository.snapshot().addresses['others-home'].deleted, false);
});

test('地址删除：畸形成功响应保留原操作，恢复后只发生一次软删除', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const ui = await base.list();
  base.malformedNext(); const first = await start(ui); first.modal.success({ confirm: true }); await first.operation;
  assert.equal(ui.page.data.addressDeletePending, true); assert.match(ui.page.data.error, /服务响应异常/);
  await ui.page.retryAddressDelete(); assert.equal(ui.page.data.addressDeletePending, false);
  assert.equal(base.repository.snapshot().addresses.home.version, 2);
});

test('地址删除：页面隐藏后即使确认回调到达，也不发送删除或更新隐藏页面', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const ui = await base.list();
  const first = await start(ui); ui.page.onHide(); const count = ui.page.updates.length;
  first.modal.success({ confirm: true }); await first.operation;
  assert.equal(removals(base).length, 0); assert.equal(ui.page.updates.length, count);
});

test('地址删除：删除在途阻止交叉保存，隐藏后的成功回包不更新页面', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput()); const ui = await base.list();
  const release = base.holdNextRemove(), first = await start(ui); first.modal.success({ confirm: true });
  await waitFor(() => removals(base).length === 1);
  await assert.rejects(base.runtime.addressEditor.save(addressInput({ addressId: 'work' })), error => error.code === 'ADDRESS_WRITE_BUSY');
  await assert.rejects(base.runtime.addressEditor.retryRemove(), error => error.code === 'ADDRESS_WRITE_BUSY');
  ui.page.onHide(); const count = ui.page.updates.length; release(); await first.operation;
  assert.equal(ui.page.updates.length, count); assert.equal(base.runtime.addressEditor.hasPending(), false);
  const next = await base.list(); assert.equal(next.page.data.addresses.length, 0); assert.equal(next.page.data.addressDeletePending, false);
});

test('地址删除：冻结ID和版本白名单，拒绝非法版本，不保存联系人或权限字段', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  for (const expectedVersion of [-1, NaN, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(base.runtime.addressEditor.remove({ addressId: 'home', expectedVersion }), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal(removals(base).length, 0);
  base.dropNext(); const input = { addressId: 'home', expectedVersion: 1, role: 'owner', phone: 'must-not-store' };
  const pending = base.runtime.addressEditor.remove(input); input.addressId = 'another'; input.expectedVersion = 999;
  await assert.rejects(pending, error => error.uncertain);
  assert.equal(removals(base)[0].data.addressId, 'home'); assert.equal(removals(base)[0].data.expectedVersion, 1);
  assert.deepEqual(Object.keys(removals(base)[0].data).sort(), ['addressId', 'expectedVersion', 'requestId']);
  const record = await base.runtime.addressEditor.getPending(); assert.equal(record.kind, 'remove');
  assert.equal(JSON.stringify(record).includes('must-not-store'), false);
});

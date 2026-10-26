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
  let subject = buyer.openid, sequence = 0, drop = false, malformed = false;
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.subject }) });
  const client = createTradeClient({ clock: base.clock, send: async request => {
    requests.push(structuredClone(request));
    const result = structuredClone(await application.handle(request, { subject }));
    if (request.action === 'addresses.save') {
      if (drop) { drop = false; throw new Error('LOST_AFTER_SAVE'); }
      if (malformed && result.success) { malformed = false; result.data.version = 999; }
    }
    return result;
  } });
  const runtime = createMiniappRuntime({ client, requestId: () => 'form-address-' + (++sequence) });
  const harness = () => miniappHarness(runtime);
  async function form(id) {
    const ui = harness(), page = ui.loadPage('pages/add-address/add-address');
    page.onLoad(id ? { id } : {}); await page.onShow();
    return { ...ui, page };
  }
  return { ...base, client, runtime, application, requests, harness, form,
    dropNext: () => { drop = true; }, malformedNext: () => { malformed = true; }, switchSubject: value => { subject = value; } };
}
const change = value => ({ detail: { value } });
const writes = base => base.requests.filter(request => request.action === 'addresses.save');
function fill(page, { isDefault } = {}) {
  page.onNameInput(change(' 测试顾客 ')); page.onPhoneInput(change('00000000000'));
  page.onRegionChange(change(['测试省', '测试市', '测试区'])); page.onDetailInput(change(' 虚构新地址 '));
  if (isDefault !== undefined) page.onDefaultChange(change(isDefault));
}

test('地址表单：真实页面新增、去空格、设默认并返回列表，全程不访问云SDK', async () => {
  const base = fixture(), { page, events, cloudReads } = await base.form(); fill(page, { isDefault: true });
  await page.submit();
  assert.equal(page.data.saved, true); assert.equal(page.data.version, 1); assert.equal(page.data.isDefault, true);
  const result = await base.client.addresses.get(page.data.id);
  assert.equal(result.name, '测试顾客'); assert.equal(result.detail, '虚构新地址');
  assert.equal(result.isDefault, true); assert.equal(cloudReads(), 0);
  page.backToAddresses(); assert.ok(events.some(event => event.name === 'navigateBack'));
  const ui = base.harness(), list = ui.loadPage('pages/address/address'); await list.onShow();
  assert.equal(list.data.addresses[0]._id, result._id); assert.equal(list.data.addresses[0].isDefault, true);
});

test('地址表单：读取指定地址不扫描列表，编辑保持原ID和版本，后端重读归属', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const { page } = await base.form('home');
  assert.equal(page.data.name, '测试顾客'); assert.equal(page.data.version, 1);
  assert.equal(base.requests.some(request => request.action === 'addresses.list'), false);
  page.onDetailInput(change('修改后的虚构地址')); await page.submit();
  assert.equal(page.data.id, 'home'); assert.equal(page.data.version, 2);
  assert.equal((await base.client.addresses.get('home')).detail, '修改后的虚构地址');
  assert.deepEqual(base.requests.find(request => request.action === 'addresses.get').data, { addressId: 'home' });
});

test('地址表单：默认开关未动时不重设默认，保留其他页面新选的默认地址', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'seed-work-001', makeDefault: false }));
  const { page } = await base.form('home'); assert.equal(page.data.isDefault, true);
  await base.addresses.save(buyer, addressInput({ addressId: 'work', requestId: 'default-work-002', expectedVersion: 1, makeDefault: true }));
  page.onDetailInput(change('仅修改内容')); await page.submit();
  assert.equal(Object.hasOwn(writes(base)[0].data, 'makeDefault'), false);
  assert.equal((await base.client.addresses.list()).defaultAddressId, 'work');
  assert.equal(page.data.isDefault, false);
});

test('地址表单：主动切换默认开关生效，关闭当前默认后清除指针', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const { page } = await base.form('home'); page.onDefaultChange(change(false)); await page.submit();
  assert.equal(writes(base)[0].data.makeDefault, false);
  assert.equal((await base.client.addresses.list()).defaultAddressId, null);
});

test('地址表单：连续点击只保存一次，成功后不再重复提交', async () => {
  const base = fixture(), { page } = await base.form(); fill(page);
  await Promise.all([page.submit(), page.submit()]); await page.submit();
  assert.equal(writes(base).length, 1);
  assert.equal(Object.keys(base.repository.snapshot().addresses).length, 1);
});

test('地址表单：必填、长度和地区校验在发送前完成，修正后可保存', async () => {
  const base = fixture(), { page } = await base.form();
  await page.submit(); assert.equal(writes(base).length, 0); assert.ok(page.data.error);
  fill(page); page.onNameInput(change('x'.repeat(81))); await page.submit();
  assert.equal(writes(base).length, 0);
  page.onNameInput(change('合法测试姓名')); await page.submit(); assert.equal(page.data.saved, true);
});

test('地址表单：版本冲突不覆盖，先显式重载服务器数据再允许保存', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const { page } = await base.form('home'); page.onDetailInput(change('本地尚未保存'));
  await base.addresses.save(buyer, addressInput({ expectedVersion: 1, requestId: 'external-edit-002', detail: '另一个页面已保存' }));
  await page.submit(); assert.equal(page.data.reloadRequired, true); assert.equal(page.data.formReady, false);
  assert.equal(page.data.detail, '本地尚未保存'); await page.submit(); assert.equal(writes(base).length, 1);
  await page.loadAddress(); assert.equal(page.data.detail, '另一个页面已保存'); assert.equal(page.data.version, 2);
  page.onDetailInput(change('重新确认后修改')); await page.submit(); assert.equal(page.data.version, 3);
});

test('地址表单：保存成功丢响应后锁定原表单，原请求重试不新增第二条地址', async () => {
  const base = fixture(), { page } = await base.form(); fill(page, { isDefault: true }); base.dropNext();
  await page.submit(); assert.equal(page.data.writePending, true);
  const original = page.data.detail; page.onDetailInput(change('不能替换原意图')); assert.equal(page.data.detail, original);
  await page.submit(); assert.equal(writes(base).length, 1);
  await page.retrySave(); assert.equal(page.data.saved, true);
  assert.deepEqual(writes(base)[0].data, writes(base)[1].data);
  assert.equal(Object.keys(base.repository.snapshot().addresses).length, 1);
});

test('地址表单：离开后重建页面可恢复原保存，重试不覆盖随后完成的新编辑', async () => {
  const base = fixture(), first = await base.form(); fill(first.page, { isDefault: true }); base.dropNext();
  await first.page.submit(); const id = first.page.data.id; first.page.onUnload();
  await base.addresses.save(buyer, addressInput({ addressId: id, requestId: 'later-edit-002', expectedVersion: 1,
    name: '测试顾客', detail: '后续已保存的新版本', makeDefault: false }));
  const second = await base.form('another-address');
  assert.equal(second.page.data.pendingNeedsRestore, true); assert.equal(second.page.data.formReady, false);
  await second.page.restorePending();
  assert.equal(second.page.data.id, id); assert.equal(second.page.data.isDefault, true);
  await second.page.retrySave(); assert.equal(second.page.data.saved, true);
  assert.deepEqual(writes(base)[0].data, writes(base)[1].data);
  const latest = await base.client.addresses.get(id);
  assert.equal(latest.detail, '后续已保存的新版本'); assert.equal(latest.version, 2);
});

test('地址接口：指定读取仅本人可用，已删除地址不可读，不返回内部字段', async () => {
  const base = fixture(); await base.addresses.save(buyer, addressInput());
  const address = await base.client.addresses.get('home');
  assert.equal(Object.hasOwn(address, 'ownerOpenid'), false); assert.equal(Object.hasOwn(address, 'createdAt'), false);
  const forged = await base.application.handle({ action: 'addresses.get', data: { addressId: 'home', openid: buyer.openid, role: 'owner' } }, { subject: other.openid });
  assert.equal(forged.error.code, 'FORBIDDEN');
  await base.addresses.remove(buyer, { addressId: 'home', expectedVersion: 1, requestId: 'remove-home-001' });
  await assert.rejects(base.client.addresses.get('home'), error => error.code === 'ADDRESS_NOT_FOUND');
});

test('地址表单：主体变化清空未保存个人信息，不能继续提交或读取原待确认意图', async () => {
  const base = fixture(), { page } = await base.form(); fill(page);
  base.switchSubject(other.openid); await page.onShow();
  assert.equal(page.data.name, ''); assert.equal(page.data.phone, ''); assert.equal(page.data.formReady, false);
  await page.submit(); assert.equal(writes(base).length, 0);
  await assert.rejects(base.runtime.addressEditor.getPending(), error => error.code === 'SESSION_CHANGED');
});

test('地址表单：越权或已删除地址加载失败，保存入口保持禁用', async () => {
  const base = fixture(); await base.addresses.save(other, addressInput({ addressId: 'others-home' }));
  const foreign = await base.form('others-home'); assert.equal(foreign.page.data.formReady, false);
  assert.equal(foreign.page.data.error, '当前身份没有此操作权限'); await foreign.page.submit();
  const missing = await base.form('missing-home'); assert.equal(missing.page.data.formReady, false);
  assert.equal(writes(base).length, 0);
});

test('地址表单：异常成功响应按未知结果保留，确认重试后才解锁', async () => {
  const base = fixture(), { page } = await base.form(); fill(page); base.malformedNext(); await page.submit();
  assert.equal(page.data.writePending, true); assert.equal(page.data.saved, false);
  await page.retrySave(); assert.equal(page.data.saved, true); assert.equal(page.data.version, 1);
});

test('地址编辑器：等待期间冻结白名单，未知结果阻止另一个保存意图覆盖', async () => {
  const base = fixture(), input = addressInput({ ownerOpenid: 'forged', role: 'owner', password: 'must-not-store' });
  base.dropNext(); const result = base.runtime.addressEditor.save(input); input.detail = '等待期间被改写';
  await assert.rejects(result, error => error.uncertain);
  assert.equal(writes(base)[0].data.detail, '虚构地址');
  assert.equal(Object.hasOwn(writes(base)[0].data, 'role'), false);
  const pending = await base.runtime.addressEditor.getPending(); assert.ok(!JSON.stringify(pending).includes('must-not-store'));
  await assert.rejects(base.runtime.addressEditor.save(addressInput({ addressId: 'work' })), error => error.code === 'ADDRESS_RECOVERY_REQUIRED');
  await base.runtime.addressEditor.retry(); assert.equal(writes(base).length, 2);
});

test('地址表单：隐藏期间加载结果不写页面，旧模式仍加载原表单', async () => {
  const base = fixture(); let resolve, requested;
  const gate = new Promise(yes => { resolve = yes; }), started = new Promise(yes => { requested = yes; });
  const editor = { ...base.runtime.addressEditor, read: () => { requested(); return gate; } };
  const ui = miniappHarness({ ...base.runtime, addressEditor: editor });
  const page = ui.loadPage('pages/add-address/add-address'); page.onLoad({ id: 'home' });
  const loading = page.onShow(); await started; page.onHide(); const count = page.updates.length;
  resolve({ ...addressInput(), _id: 'home', version: 1, isDefault: true }); await loading;
  assert.equal(page.updates.length, count);
  const legacy = miniappHarness(null, { legacyCloud: true });
  const old = legacy.loadPage('pages/add-address/add-address'); assert.equal(old.data.unifiedMode, undefined);
  assert.equal(legacy.cloudReads(), 1);
});

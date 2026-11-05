'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../cloudfunctions/api/application');
const { createTradeClient } = require('../services/trade-client');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { authFixture, DEMO_PASSWORD } = require('./support/auth-fixture');
const { addressInput } = require('./support/shop-fixture');
const { miniappHarness } = require('./support/miniapp-harness');

const input = value => ({ detail: { value } });
async function fixture(deliveryType = 'pickup', staffId = 'staff-demo') {
  const base = await authFixture();
  const app = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async openid => ({ openid }) });
  let seq = 0, drop = '';
  const requests = [];
  const runtime = (subjectId, checkoutNamespace) => createMiniappRuntime({ subjectId, checkoutNamespace, requestId: () => 'staff-page-' + (++seq),
    client: createTradeClient({ clock: base.clock, send: async request => {
      requests.push({ action: request.action, ...(request.action.startsWith('fulfillment.') ? { data: request.data } : {}) });
      const result = await app.handle(request, subjectId);
      if (drop === request.action) { drop = ''; throw new Error('lost response'); }
      return result;
    } }) });
  const staff = runtime(staffId), buyer = runtime('buyer-demo');
  if (deliveryType === 'delivery') await buyer.client.addresses.save(addressInput());
  const order = await buyer.client.orders.create({ requestId: 'staff-page-order', deliveryType,
    ...(deliveryType === 'delivery' ? { addressId: 'home' } : {}), items: [{ productId: 'bread', quantity: 1 }] });
  await buyer.client.orders.pay(order._id);
  const ui = miniappHarness(staff);
  const login = ui.loadPage('pages/admin-login/admin-login'), admin = ui.loadPage('pages/admin/admin');
  const customer = miniappHarness(buyer).loadPage('pages/orders/orders');
  async function signIn() {
    login.onShow();
    login.enterPassword(input(DEMO_PASSWORD));
    await login.loginStaff();
    await admin.onShow();
  }
  async function submit() {
    const previous = ui.events.filter(row => row.name === 'showModal').length;
    const work = admin.submitFulfillment();
    for (let i = 0; i < 20 && ui.events.filter(row => row.name === 'showModal').length === previous; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const dialogs = ui.events.filter(row => row.name === 'showModal');
    assert.equal(dialogs.length, previous + 1);
    dialogs.at(-1).options.success({ confirm: true });
    await work;
  }
  const rowEvent = { currentTarget: { dataset: { id: order._id } } };
  return { admin, login, customer, staff, requests, signIn, submit, rowEvent, ui, runtime, drop: action => { drop = action; } };
}

test('履约恢复：响应丢失后重建运行时不自动写入，登录后重试原请求', async () => {
  const base = await fixture();
  await base.signIn();
  base.admin.openFulfillment(base.rowEvent);
  base.drop('fulfillment.accept');
  await base.submit();
  const nextRuntime = base.runtime('staff-demo');
  const nextUi = miniappHarness(nextRuntime, { storage: base.ui.storage });
  const next = nextUi.loadPage('pages/admin/admin');
  await next.onShow();
  assert.equal(next.data.loginRequired, true);
  await nextRuntime.client.staff.login(DEMO_PASSWORD);
  await next.onShow();
  assert.equal(next.data.pending, true);
  assert.equal(next.data.pendingOrderId, base.rowEvent.currentTarget.dataset.id);
  const before = base.requests.filter(row => row.action === 'fulfillment.accept');
  assert.equal(before.length, 1);
  await next.retryFulfillment();
  const after = base.requests.filter(row => row.action === 'fulfillment.accept');
  assert.deepEqual(after[1].data, after[0].data);
  assert.equal(next.data.pending, false);
  assert.equal(next.data.rows[0].status, '已接单');
});

test('履约恢复：缓存写入失败阻止接单，损坏记录阻止新意图覆盖', async () => {
  const base = await fixture();
  await base.signIn();
  base.admin.openFulfillment(base.rowEvent);
  base.ui.wx.setStorageSync = () => { throw new Error('disk full'); };
  await base.submit();
  assert.equal(base.requests.some(row => row.action === 'fulfillment.accept'), false);
  assert.ok(base.admin.data.error);
  base.ui.storage.set(base.staff.checkoutNamespace + ':fulfillment:staff-demo', { corrupt: true });
  await base.admin.refreshStaffOrders();
  assert.equal(base.admin.data.recoveryReady, false);
  base.admin.openFulfillment(base.rowEvent);
  assert.equal(base.admin.data.form, null);
});

test('履约恢复：成功后清理缓存失败仍显示成功，重试不重复变更订单版本', async () => {
  const base = await fixture();
  await base.signIn();
  base.admin.openFulfillment(base.rowEvent);
  const remove = base.ui.wx.removeStorageSync;
  base.ui.wx.removeStorageSync = () => { throw new Error('locked'); };
  await base.submit();
  assert.match(base.admin.data.notice, /操作已成功/);
  const version = base.admin.data.rows[0].version;
  assert.equal(base.admin.data.pending, true);
  base.ui.wx.removeStorageSync = remove;
  await base.admin.retryFulfillment();
  assert.equal(base.admin.data.rows[0].version, version);
  assert.equal(base.admin.data.pending, false);
});

test('履约恢复：不同主体与环境只读取自己的恢复记录', async () => {
  const base = await fixture();
  await base.signIn();
  base.admin.openFulfillment(base.rowEvent);
  base.drop('fulfillment.accept');
  await base.submit();
  const owner = base.runtime('owner-demo');
  await owner.client.staff.login(DEMO_PASSWORD);
  const other = miniappHarness(owner, { storage: base.ui.storage }).loadPage('pages/admin/admin');
  await other.onShow();
  assert.equal(other.data.pending, false);
  const environment = base.runtime('staff-demo', 'bakery.test.another-environment');
  await environment.client.staff.login(DEMO_PASSWORD);
  const isolated = miniappHarness(environment, { storage: base.ui.storage }).loadPage('pages/admin/admin');
  await isolated.onShow();
  assert.equal(isolated.data.pending, false);
  assert.equal(base.ui.storage.size, 1);
});

test('商家履约：登录前不可看订单，退出后清除列表和会话', async () => {
  const { admin, login, staff, requests, signIn, ui } = await fixture();
  await admin.onShow();
  assert.equal(admin.data.loginRequired, true);
  assert.equal(requests.some(row => row.action === 'orders.list'), false);
  await signIn();
  assert.equal(login.data.password, '');
  assert.ok(ui.events.some(row => row.options.url === '/pages/admin/admin'));
  assert.equal(admin.data.rows[0].action, 'accept');
  await admin.logoutStaff();
  assert.equal(staff.client.getSession(), null);
  assert.equal(admin.data.rows.length, 0);
  assert.equal(ui.cloudReads(), 0);
});

test('商家履约：接单、校验运单、发货和完成，顾客看到同一运单及完成状态', async () => {
  const { admin, customer, signIn, rowEvent, submit } = await fixture('delivery');
  await signIn();
  admin.openFulfillment(rowEvent);
  await submit();
  assert.equal(admin.data.rows[0].action, 'ship');
  admin.openFulfillment(rowEvent);
  await admin.submitFulfillment();
  assert.match(admin.data.error, /运单号/);
  admin.enterCarrier(input('测试物流'));
  admin.enterTracking(input('TRACK1234'));
  await submit();
  await customer.onShow();
  assert.equal(customer.data.orderRows[0].trackingNo, 'TRACK1234');
  admin.openFulfillment(rowEvent);
  await submit();
  await customer.onShow();
  assert.equal(customer.data.orderRows[0].status, '已完成');
});

test('商家履约：接单响应丢失后原请求重试，自取核销后顾客看到完成', async () => {
  const { admin, customer, requests, signIn, rowEvent, submit, drop } = await fixture();
  await signIn();
  admin.openFulfillment(rowEvent);
  drop('fulfillment.accept');
  await submit();
  assert.equal(admin.data.pending, true);
  await admin.retryFulfillment();
  assert.equal(admin.data.pending, false);
  const attempts = requests.filter(row => row.action === 'fulfillment.accept');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].data, attempts[1].data);
  admin.openFulfillment(rowEvent);
  await submit();
  await customer.onShow();
  await customer.revealPickup(rowEvent);
  admin.openFulfillment(rowEvent);
  assert.equal(admin.data.form.needsCode, true);
  const wrongCode = (customer.data.pickup.code[0] === '0' ? '1' : '0') + customer.data.pickup.code.slice(1);
  admin.enterPickupCode(input(wrongCode));
  await submit();
  assert.equal(admin.data.rows[0].status, '待自取');
  assert.ok(admin.data.error);
  admin.enterPickupCode(input(customer.data.pickup.code));
  await submit();
  await customer.onShow();
  assert.equal(customer.data.orderRows[0].status, '已完成');
  assert.equal(admin.data.pickupCode, '');
});

test('商家履约：会话失效后刷新清除商家订单并要求重新登录', async () => {
  const { admin, staff, signIn } = await fixture();
  await signIn();
  assert.equal(admin.data.rows.length, 1);
  staff.client.clearSession();
  await admin.refreshStaffOrders();
  assert.equal(admin.data.rows.length, 0);
  assert.equal(admin.data.loginRequired, true);
});

test('商家拒单：店主填写原因并退款，顾客可查看退款和拒单原因', async () => {
  const { admin, customer, signIn, rowEvent, submit } = await fixture('pickup', 'owner-demo');
  await signIn();
  admin.openRejection(rowEvent);
  await admin.submitFulfillment();
  assert.match(admin.data.error, /拒单原因/);
  admin.enterRejectionReason(input('门店临时停业'));
  await submit();
  await customer.onShow();
  assert.equal(customer.data.orderRows[0].status, '已取消');
  assert.equal(customer.data.orderRows[0].refunded, true);
  assert.equal(customer.data.orderRows[0].rejectionReason, '门店临时停业');
});

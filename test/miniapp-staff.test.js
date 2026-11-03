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
async function fixture(deliveryType = 'pickup') {
  const base = await authFixture();
  const app = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async openid => ({ openid }) });
  let seq = 0, drop = '';
  const requests = [];
  const runtime = subjectId => createMiniappRuntime({ subjectId, requestId: () => 'staff-page-' + (++seq),
    client: createTradeClient({ clock: base.clock, send: async request => {
      requests.push({ action: request.action, ...(request.action.startsWith('fulfillment.') ? { data: request.data } : {}) });
      const result = await app.handle(request, subjectId);
      if (drop === request.action) { drop = ''; throw new Error('lost response'); }
      return result;
    } }) });
  const staff = runtime('staff-demo'), buyer = runtime('buyer-demo');
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
  return { admin, login, customer, staff, requests, signIn, submit, rowEvent, ui, drop: action => { drop = action; } };
}

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

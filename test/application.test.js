'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../cloudfunctions/api/application');
const { STATUS } = require('../cloudfunctions/api/domain/order-state');
const { authFixture, DEMO_PASSWORD } = require('./support/auth-fixture');

async function fixture() {
  const base = await authFixture();
  // 假身份解析仅在测试存在；真实传输适配器必须验证微信上下文或服务端会话。
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context?.verifiedSubject, role: 'owner' }) });
  const call = (action, data, openid = 'buyer-demo', staffToken) => application.handle(
    { action, data, staffToken }, { verifiedSubject: openid });
  return { ...base, application, call };
}

test('统一入口：身份解析器和请求体里的角色都不能取代员工会话', async () => {
  const { call, application } = await fixture();
  const identity = await call('identity.me', { role: 'owner', actor: { staffVerified: true } });
  assert.deepEqual(identity.data, { openid: 'buyer-demo', role: 'customer' });
  const response = await application.handle({ action: 'inventory.adjust', role: 'owner', actor: { role: 'owner' },
    data: { productId: 'bread', onHand: 999, requestId: 'adjust-001', expectedVersion: 0, reason: '演示' } },
  { verifiedSubject: 'buyer-demo' });
  assert.equal(response.error.code, 'FORBIDDEN');
});

test('统一入口：可贯通下单、失败支付、成功支付和本人订单查询', async () => {
  const { call } = await fixture();
  const created = await call('orders.create', { requestId: 'checkout-001', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 2 }], totalPrice: 0.01, openid: 'owner-demo' });
  assert.equal(created.success, true);
  assert.equal(created.data.amounts.totalCents, 2500);
  assert.equal(created.data.ownerOpenid, 'buyer-demo');
  const orderId = created.data._id;
  const failed = await call('orders.pay', { orderId, outcome: 'failure', attemptId: 'attempt-001' });
  assert.equal(failed.data.status, STATUS.PENDING_PAYMENT);
  const paid = await call('orders.pay', { orderId });
  assert.equal(paid.data.paymentStatus, 'PAID');
  assert.equal((await call('orders.get', { orderId })).data._id, orderId);
  assert.equal((await call('orders.get', { orderId }, 'other-customer')).error.code, 'FORBIDDEN');
});

test('统一入口：员工登录身份取可信上下文，而非表单中的目标身份', async () => {
  const { call } = await fixture();
  const forged = await call('staff.login', { password: DEMO_PASSWORD, openid: 'owner-demo' });
  assert.equal(forged.error.code, 'AUTH_FAILED');
  const login = await call('staff.login', { password: DEMO_PASSWORD }, 'owner-demo');
  assert.equal(login.success, true);
  const adjustment = { productId: 'bread', onHand: 15, requestId: 'adjust-001', expectedVersion: 0, reason: '演示补货' };
  assert.equal((await call('inventory.adjust', adjustment, 'owner-demo', login.data.token)).success, true);
  assert.equal((await call('inventory.adjust', adjustment, 'buyer-demo', login.data.token)).error.code, 'UNAUTHENTICATED');
  await call('staff.logout', {}, 'owner-demo', login.data.token);
  assert.equal((await call('identity.me', {}, 'owner-demo', login.data.token)).error.code, 'UNAUTHENTICATED');
});

test('统一入口：店员即使登录也不能退款或调整库存', async () => {
  const { call } = await fixture();
  const login = await call('staff.login', { password: DEMO_PASSWORD }, 'staff-demo');
  const result = await call('inventory.adjust', { productId: 'bread', onHand: 15,
    requestId: 'adjust-001', expectedVersion: 0, reason: '演示' }, 'staff-demo', login.data.token);
  assert.equal(result.error.code, 'FORBIDDEN');
  const refund = await call('refunds.executeApproved', { afterSaleId: 'after-sale-001' }, 'staff-demo', login.data.token);
  assert.equal(refund.error.code, 'FORBIDDEN');
});

test('统一入口：后台超时处理不暴露为客户端操作', async () => {
  const { call, application, setTime } = await fixture();
  const created = await call('orders.create', { requestId: 'checkout-001', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 2 }] });
  assert.equal((await call('orders.expire', { orderId: created.data._id, trustedSystem: true })).error.code, 'INVALID_ACTION');
  setTime(created.data.expiresAt);
  const expired = await application.expireOrder(created.data._id);
  assert.equal(expired.status, STATUS.EXPIRED);
});

test('统一入口：不通过默认身份降级掩盖错误，不泄露内部异常内容', async () => {
  const { application, repository } = await fixture();
  assert.equal((await application.handle({ action: 'identity.me' }, {})).error.code, 'UNAUTHENTICATED');
  assert.equal((await application.handle({ action: 'constructor' }, {})).error.code, 'INVALID_ACTION');
  assert.equal((await application.handle({ action: 'identity.me', data: null }, {})).error.code, 'INVALID_REQUEST');
  assert.throws(() => createApplication({ repository }), error => error.code === 'INVALID_CONFIG');
  const broken = createApplication({ repository, resolveIdentity: async () => { throw new Error('internal-sensitive-detail'); } });
  const response = await broken.handle({ action: 'identity.me' }, {});
  assert.equal(response.error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(response).includes('internal-sensitive-detail'));
});

test('统一入口：店主授权和设置口令后，新员工只能得到店员权限', async () => {
  const { call } = await fixture();
  const ownerLogin = await call('staff.login', { password: DEMO_PASSWORD }, 'owner-demo');
  const token = ownerLogin.data.token;
  assert.equal((await call('staff.setAccess', { targetOpenid: 'new-staff', enabled: true }, 'owner-demo', token)).success, true);
  assert.equal((await call('staff.setPassword', { targetOpenid: 'new-staff', password: DEMO_PASSWORD }, 'owner-demo', token)).success, true);
  const staffLogin = await call('staff.login', { password: DEMO_PASSWORD }, 'new-staff');
  assert.equal(staffLogin.data.role, 'staff');
  assert.equal((await call('staff.setAccess', { targetOpenid: 'third-person', enabled: true }, 'new-staff', staffLogin.data.token)).error.code, 'FORBIDDEN');
});

test('统一入口：结算先读取可信报价再按该金额提交订单', async () => {
  const { call } = await fixture();
  const input = { items: [{ productId: 'bread', quantity: 2 }], deliveryType: 'pickup' };
  const quote = await call('orders.quote', input);
  assert.equal(quote.success, true);
  assert.equal(quote.data.totalCents, 2500);
  const created = await call('orders.create', { ...input, requestId: 'checkout-quoted', expectedTotalCents: quote.data.totalCents });
  assert.equal(created.data.amounts.totalCents, quote.data.totalCents);
});

test('统一入口：拒单必须有店主会话，成功后顾客查询显示取消与已退款', async () => {
  const { call, repository } = await fixture();
  const created = await call('orders.create', { requestId: 'checkout-rejection', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 2 }] });
  const orderId = created.data._id;
  const paid = await call('orders.pay', { orderId });
  const input = { orderId, expectedVersion: paid.data.version, requestId: 'reject-app-001', reason: '原料不足' };
  assert.equal((await call('orders.reject', { ...input, role: 'owner' })).error.code, 'FORBIDDEN');
  assert.equal((await call('orders.reject', input, 'owner-demo')).error.code, 'FORBIDDEN');
  const staffLogin = await call('staff.login', { password: DEMO_PASSWORD }, 'staff-demo');
  assert.equal((await call('orders.reject', input, 'staff-demo', staffLogin.data.token)).error.code, 'FORBIDDEN');
  const ownerLogin = await call('staff.login', { password: DEMO_PASSWORD }, 'owner-demo');
  const refund = await call('orders.reject', input, 'owner-demo', ownerLogin.data.token);
  assert.equal(refund.success, true);
  assert.equal(refund.data.amountCents, 2500);
  assert.equal((await call('orders.reject', input, 'owner-demo', ownerLogin.data.token)).data._id, refund.data._id);
  const result = await call('orders.get', { orderId });
  assert.equal(result.data.status, STATUS.CANCELLED);
  assert.equal(result.data.paymentStatus, 'REFUNDED');
  assert.equal(repository.snapshot().products.bread.onHand, 10);
});

test('统一入口：批量到期处理不可被客户端伪造系统身份调用', async () => {
  const { call } = await fixture();
  for (const action of ['orders.expireBatch', 'jobs.expireOrders', 'orders.runExpiry']) {
    const result = await call(action, { trustedSystem: true, role: 'system' });
    assert.equal(result.error.code, 'INVALID_ACTION');
  }
});
